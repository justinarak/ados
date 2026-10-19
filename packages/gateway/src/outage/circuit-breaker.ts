import {
  type CanonicalConversionEvent,
  type PlatformDestination,
  generateUuidV7,
} from "@ados/schemas";
import type { QuarantineBufferDriver, QuarantinedEventRecord } from "@ados/state";

export interface CircuitBreakerConfig {
  /** Sliding window size for statistical EMQ density & value anomaly checks */
  slidingWindowSize: number;
  /** Minimum events in window before evaluating EMQ email density drop */
  minEventsForDensityCheck: number;
  /** Minimum ratio of events containing email (e.g. 0.35); below this trips AUTO-HOLD */
  minEmailDensityRatio: number;
  /** Trailing mean of conversion value (USD) for 5-sigma anomaly detection */
  baselineValueMean: number;
  /** Trailing standard deviation of conversion value (USD) */
  baselineValueStdDev: number;
  /** Sigma multiplier threshold (default 5.0 for 5-sigma value bounding) */
  sigmaMultiplierThreshold: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  slidingWindowSize: 500,
  minEventsForDensityCheck: 10,
  minEmailDensityRatio: 0.35,
  baselineValueMean: 120.0,
  baselineValueStdDev: 80.0,
  sigmaMultiplierThreshold: 5.0,
};

export type CircuitState = "CLOSED" | "OPEN_AUTO_HOLD" | "PACED_RECOVERY";

export interface OutageInspectionDecision {
  allowed: boolean;
  circuit_state: CircuitState;
  quarantine_reason?: QuarantinedEventRecord["reason"];
  diagnostic_message?: string;
}

/**
 * Section 5: Statistical Anomaly & Circuit Breaker Engine
 * Protects downstream ad platforms against the 3 core outage failure modes:
 * 1. PII Dropped, Bare Conversions Dispatched (EMQ email density collapse)
 * 2. Upstream ETL Delays & Batch Stampedes (Paced backfill drip)
 * 3. Poisoned Data Egress (>5-sigma conversion value spikes / cents-vs-dollars bug / staging leaks)
 */
export class StatisticalCircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly recentEmailPresence: boolean[] = [];
  private circuitState: CircuitState = "CLOSED";

  constructor(
    private readonly quarantineBuffer: QuarantineBufferDriver,
    config?: Partial<CircuitBreakerConfig>
  ) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  getState(): CircuitState {
    return this.circuitState;
  }

  resetCircuit(): void {
    this.circuitState = "CLOSED";
    this.recentEmailPresence.length = 0;
  }

  enterPacedRecovery(): void {
    this.circuitState = "PACED_RECOVERY";
    this.recentEmailPresence.length = 0;
  }

  getEmailPresenceRatio(): number {
    if (this.recentEmailPresence.length === 0) return 1.0;
    const count = this.recentEmailPresence.filter(Boolean).length;
    return Number((count / this.recentEmailPresence.length).toFixed(3));
  }

  async inspectAndGate(event: CanonicalConversionEvent): Promise<OutageInspectionDecision> {
    // 1. Environment Tag Isolation (Failure Mode 3): Block non-production events from live ad APIs
    if (event.environment !== "production") {
      await this.quarantine(event, "ENVIRONMENT_MISMATCH");
      return {
        allowed: false,
        circuit_state: this.circuitState,
        quarantine_reason: "ENVIRONMENT_MISMATCH",
        diagnostic_message: `Blocked ${event.environment} conversion from production ad platform egress`,
      };
    }

    // 2. >5-Sigma Conversion Value Bounding (Failure Mode 3: Cents-vs-Dollars Bug)
    const maxAllowedValue =
      this.config.baselineValueMean +
      this.config.sigmaMultiplierThreshold * this.config.baselineValueStdDev;
    if (event.value > maxAllowedValue) {
      await this.quarantine(event, "VALUE_ANOMALY_5SIGMA");
      return {
        allowed: false,
        circuit_state: this.circuitState,
        quarantine_reason: "VALUE_ANOMALY_5SIGMA",
        diagnostic_message: `Conversion value (${event.value} ${event.currency}) exceeds >${this.config.sigmaMultiplierThreshold}σ bound (${maxAllowedValue}); quarantined to prevent bidding model poisoning`,
      };
    }

    // 3. Sliding Window EMQ Email Density Monitor (Failure Mode 1: Bare Conversions Dispatched)
    const hasEmail = Boolean(event.user_data.email && event.user_data.email.trim().length > 0);
    this.recentEmailPresence.push(hasEmail);
    if (this.recentEmailPresence.length > this.config.slidingWindowSize) {
      this.recentEmailPresence.shift();
    }

    const emailRatio = this.getEmailPresenceRatio();
    if (
      this.recentEmailPresence.length >= this.config.minEventsForDensityCheck &&
      emailRatio < this.config.minEmailDensityRatio
    ) {
      this.circuitState = "OPEN_AUTO_HOLD";
    }

    if (this.circuitState === "OPEN_AUTO_HOLD") {
      await this.quarantine(event, "EMQ_DENSITY_DROP");
      return {
        allowed: false,
        circuit_state: "OPEN_AUTO_HOLD",
        quarantine_reason: "EMQ_DENSITY_DROP",
        diagnostic_message: `Circuit breaker TRIPPED (OPEN_AUTO_HOLD): rolling email density (${(
          emailRatio * 100
        ).toFixed(1)}%) dropped below ${(this.config.minEmailDensityRatio * 100).toFixed(
          1
        )}% floor. Event routed to Quarantine Holding Pen to protect Meta First-In-Wins deduplication.`,
      };
    }

    return {
      allowed: true,
      circuit_state: this.circuitState,
    };
  }

  private async quarantine(
    event: CanonicalConversionEvent,
    reason: QuarantinedEventRecord["reason"]
  ): Promise<void> {
    await this.quarantineBuffer.enqueue({
      quarantine_id: generateUuidV7(),
      event,
      reason,
      quarantined_at_ms: Date.now(),
      target_platforms: event.destinations,
    });
  }
}

export interface PacedBackfillOptions {
  /** Total per-tick API quota across live + replay traffic */
  maxTotalQuotaPerTick?: number;
  /** Fraction of quota reserved for backfill replay (default 0.30 = 30% backfill, 70% live) */
  backfillShareRatio?: number;
  /** Current epoch timestamp in seconds for evaluating the 48h deduplication window */
  nowEpochSeconds?: number;
}

export interface PacedBackfillSummary {
  drainedCount: number;
  replayedCount: number;
  droppedExpiredDedupCount: number;
  suppressedPlatformsByEvent: Record<string, PlatformDestination[]>;
}

const HOURS_48_SECONDS = 48 * 3600;

/**
 * Section 5, Failure Mode 2: Paced Backfill Controller
 * Meters out quarantined/delayed conversion queues using a 70% Live / 30% Backfill token bucket,
 * preserving original historical `timestamp` values and filtering out Meta/TikTok destinations
 * if `now - event.timestamp > 48h` when `client_pixel_fired === true`.
 */
export async function drainQuarantineWithPacing(
  quarantineBuffer: QuarantineBufferDriver,
  replayHandler: (event: CanonicalConversionEvent, nowEpochSeconds: number) => Promise<void>,
  options: PacedBackfillOptions = {}
): Promise<PacedBackfillSummary> {
  const maxQuota = options.maxTotalQuotaPerTick ?? 100;
  const backfillRatio = options.backfillShareRatio ?? 0.3;
  const maxReplayBatch = Math.max(1, Math.floor(maxQuota * backfillRatio));
  const nowSeconds = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

  const drained = await quarantineBuffer.drain(maxReplayBatch);
  let replayedCount = 0;
  let droppedExpiredDedupCount = 0;
  const suppressedPlatformsByEvent: Record<string, PlatformDestination[]> = {};

  for (const record of drained) {
    const { event } = record;
    const ageSeconds = Math.max(0, nowSeconds - event.timestamp);
    const suppressed: PlatformDestination[] = [];
    const remainingDestinations: PlatformDestination[] = [];

    for (const dest of event.destinations) {
      if (
        (dest === "meta" || dest === "tiktok") &&
        ageSeconds > HOURS_48_SECONDS &&
        event.click_context.client_pixel_fired
      ) {
        suppressed.push(dest);
      } else {
        remainingDestinations.push(dest);
      }
    }

    if (suppressed.length > 0) {
      suppressedPlatformsByEvent[event.event_id] = suppressed;
    }

    if (remainingDestinations.length === 0) {
      droppedExpiredDedupCount++;
      continue;
    }

    await replayHandler(
      {
        ...event,
        destinations: remainingDestinations,
      },
      nowSeconds
    );
    replayedCount++;
  }

  return {
    drainedCount: drained.length,
    replayedCount,
    droppedExpiredDedupCount,
    suppressedPlatformsByEvent,
  };
}
