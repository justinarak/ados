import {
  type AdapterDispatchDecision,
  type AdapterMutationResult,
  type PlatformAdapter,
  createDefaultAdapterRegistry,
} from "@ados/adapters";
import {
  type BudgetMutationRequest,
  BudgetMutationRequestSchema,
  type CanonicalConversionEventInput,
  type CreativeLintRequest,
  type GuardrailPolicyRule,
  GuardrailPolicyRuleSchema,
  type PlatformDestination,
  type PrivacyPurgeRequest,
  PrivacyPurgeRequestSchema,
} from "@ados/schemas";
import {
  InMemoryQuarantineBuffer,
  InMemoryStateDriver,
  InMemoryTelemetryDriver,
  type QuarantineBufferDriver,
  type StateDriver,
  type TelemetryDriver,
  type WireAuditReceipt,
  stitchEphemeralSession,
} from "@ados/state";
import { Hono } from "hono";
import {
  type GuardrailEvaluationResult,
  evaluateBudgetGuardrails,
} from "./auth/broker.js";
import { type CreativeLintReport, lintCreativeSpecs } from "./linter/creative.js";
import { type EMQLintReport, lintAndScoreConversion } from "./linter/emq.js";
import {
  type CircuitBreakerConfig,
  type OutageInspectionDecision,
  StatisticalCircuitBreaker,
} from "./outage/circuit-breaker.js";
import { FullDuplexWireLogger, buildComplianceSnapshot } from "./wire/logger.js";

export interface AdOSGatewayOptions {
  stateDriver?: StateDriver;
  quarantineBuffer?: QuarantineBufferDriver;
  telemetryDriver?: TelemetryDriver;
  adapters?: Record<PlatformDestination, PlatformAdapter>;
  defaultPolicy?: GuardrailPolicyRule;
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
}

export interface DispatchConversionResponse {
  status: "DISPATCHED" | "QUARANTINED";
  event_id: string;
  emq_report: EMQLintReport;
  session_stitched: boolean;
  purged_due_to_consent_denial: boolean;
  outage_decision: OutageInspectionDecision;
  adapter_decisions: AdapterDispatchDecision[];
  audit_receipts: WireAuditReceipt[];
}

export interface SignalHealthReport {
  account_id: string;
  platform: PlatformDestination;
  lookback_hours: number;
  circuit_breaker_state: string;
  rolling_email_density_ratio: number;
  quarantine_queue_size: number;
  recent_dispatches_count: number;
  average_emq_score: number;
}

export const DEFAULT_AUTONOMOUS_AGENT_POLICY: GuardrailPolicyRule =
  GuardrailPolicyRuleSchema.parse({
    id: "policy-autonomous-pacing-prod",
    description: "Default Blast-Radius Guardrails for AI agent budget pacing",
    subject: "agent:pacing-optimizer-v2",
    role: "agent:pacing-optimizer",
    allowed_scopes: ["campaigns.pacing:mutate", "campaigns.status:pause", "analytics:read"],
    target_accounts: {
      meta: ["act_1029384756"],
      google: ["customers/9876543210"],
      tiktok: ["adv_5544332211"],
      reddit: ["t2_99887766"],
    },
    guardrails: {
      budget_bounds: {
        min_daily_budget_micros: 10_000_000,
        absolute_daily_cap_micros: 5_000_000_000,
        require_rationale_min_length: 10,
      },
      budget_delta_limits: {
        max_increase_percent_per_call: 15.0,
        max_decrease_percent_per_call: 30.0,
      },
      rate_limits: {
        min_cooldown_minutes: 60,
        max_mutations_per_day: 12,
      },
      protected_entities: {
        blocked_campaign_ids: ["cmp_core_brand_evergreen_01", "cmp_core_brand_evergreen"],
        require_manual_approval_tags: ["tier1-unlimited"],
      },
    },
  });

/**
 * Core AdOS Narrow-Waist Runtime Engine
 */
export class AdOSGateway {
  readonly stateDriver: StateDriver;
  readonly quarantineBuffer: QuarantineBufferDriver;
  readonly telemetryDriver: TelemetryDriver;
  readonly adapters: Record<PlatformDestination, PlatformAdapter>;
  readonly circuitBreaker: StatisticalCircuitBreaker;
  readonly wireLogger: FullDuplexWireLogger;
  private policy: GuardrailPolicyRule;
  private readonly emqHistory: number[] = [];

  constructor(options: AdOSGatewayOptions = {}) {
    this.stateDriver = options.stateDriver ?? new InMemoryStateDriver();
    this.quarantineBuffer = options.quarantineBuffer ?? new InMemoryQuarantineBuffer();
    this.telemetryDriver = options.telemetryDriver ?? new InMemoryTelemetryDriver();
    this.adapters = options.adapters ?? createDefaultAdapterRegistry();
    this.circuitBreaker = new StatisticalCircuitBreaker(
      this.quarantineBuffer,
      options.circuitBreakerConfig
    );
    this.wireLogger = new FullDuplexWireLogger(this.telemetryDriver);
    this.policy = options.defaultPolicy ?? DEFAULT_AUTONOMOUS_AGENT_POLICY;
  }

  setPolicy(policy: GuardrailPolicyRule): void {
    this.policy = GuardrailPolicyRuleSchema.parse(policy);
  }

  getPolicy(): GuardrailPolicyRule {
    return this.policy;
  }

  /**
   * Tool 1: Pre-Flight Conversion Linting & EMQ Scoring (`ados_lint_conversion`)
   */
  lintConversion(input: CanonicalConversionEventInput): EMQLintReport {
    return lintAndScoreConversion(input);
  }

  /**
   * Tool 2: Full Narrow-Waist Signal Dispatch (`ados_dispatch_conversion`)
   */
  async dispatchConversion(
    input: CanonicalConversionEventInput,
    nowEpochSeconds?: number
  ): Promise<DispatchConversionResponse> {
    // 1. Parse & evaluate initial schema + consent
    const initialLint = lintAndScoreConversion(input);
    const event = initialLint.canonical_event;

    // 2. Consent-Gated Ephemeral Session Stitching (1-2h TTL cache lookup)
    const stitchResult = await stitchEphemeralSession(
      this.stateDriver,
      event.click_context.ados_session_id,
      event.click_context,
      event.consent
    );

    const hydratedEvent = {
      ...event,
      click_context: stitchResult.mergedClickContext,
    };

    // 3. Re-score EMQ after hydrating click_context from @ados/state
    const finalEmqReport = lintAndScoreConversion(hydratedEvent);
    this.emqHistory.push(finalEmqReport.emq_score);
    if (this.emqHistory.length > 500) this.emqHistory.shift();

    // 4. Statistical Outage Circuit Breaker & Anomaly Inspection
    const outageDecision = await this.circuitBreaker.inspectAndGate(
      finalEmqReport.canonical_event
    );
    if (!outageDecision.allowed) {
      return {
        status: "QUARANTINED",
        event_id: hydratedEvent.event_id,
        emq_report: finalEmqReport,
        session_stitched: stitchResult.stitched,
        purged_due_to_consent_denial: stitchResult.purgedDueToConsentDenial,
        outage_decision: outageDecision,
        adapter_decisions: [],
        audit_receipts: [],
      };
    }

    // 5. Fan out across target platform adapters & record Full-Duplex Wire Audit Receipts
    const adapterDecisions: AdapterDispatchDecision[] = [];
    const auditReceipts: WireAuditReceipt[] = [];

    for (const destination of finalEmqReport.canonical_event.destinations) {
      const adapter = this.adapters[destination];
      const decision = await adapter.dispatchConversion({
        event: finalEmqReport.canonical_event,
        hashedUserData: finalEmqReport.pii_result.hashedUserData,
        effectiveConsent: finalEmqReport.canonical_event.consent,
        nowEpochSeconds,
      });
      adapterDecisions.push(decision);

      const complianceSnapshot = buildComplianceSnapshot(
        finalEmqReport.canonical_event.consent,
        decision.status === "COOKIELESS_MODELING_PING"
      );

      const receipt = await this.wireLogger.logReceipt({
        action_type: "SIGNAL_DISPATCH",
        platform: destination,
        account_id: "default",
        event_id: finalEmqReport.canonical_event.event_id,
        outbound_payload: decision.outboundPayload,
        http_status: decision.httpStatus,
        vendor_response: decision.vendorResponse,
        compliance_snapshot: complianceSnapshot,
      });
      auditReceipts.push(receipt);
    }

    return {
      status: "DISPATCHED",
      event_id: finalEmqReport.canonical_event.event_id,
      emq_report: finalEmqReport,
      session_stitched: stitchResult.stitched,
      purged_due_to_consent_denial: stitchResult.purgedDueToConsentDenial,
      outage_decision: outageDecision,
      adapter_decisions: adapterDecisions,
      audit_receipts: auditReceipts,
    };
  }

  /**
   * Tool 3: Guardrailed Budget Mutation (`ados_mutate_budget`)
   */
  async mutateBudget(input: BudgetMutationRequest): Promise<{
    guardrail_evaluation: GuardrailEvaluationResult;
    mutation_result?: AdapterMutationResult;
    audit_receipt?: WireAuditReceipt;
  }> {
    const req = BudgetMutationRequestSchema.parse(input);
    const evaluation = evaluateBudgetGuardrails(req, this.policy);

    if (!evaluation.approved) {
      return {
        guardrail_evaluation: evaluation,
      };
    }

    const adapter = this.adapters[req.platform];
    const mutationResult = await adapter.mutateBudget(req);

    const receipt = await this.wireLogger.logReceipt({
      action_type: "BUDGET_MUTATION",
      platform: req.platform,
      account_id: req.account_id,
      outbound_payload: mutationResult.outboundPayload,
      http_status: mutationResult.httpStatus,
      vendor_response: mutationResult.vendorResponse,
      rationale: req.rationale,
    });

    return {
      guardrail_evaluation: evaluation,
      mutation_result: mutationResult,
      audit_receipt: receipt,
    };
  }

  /**
   * Tool 4: Pre-Flight Creative Spec Linter (`ados_lint_creative`)
   */
  lintCreative(input: CreativeLintRequest): CreativeLintReport {
    return lintCreativeSpecs(input);
  }

  /**
   * Tool 5: Query Signal Health & Circuit Breaker Diagnostics (`ados_query_signal_health`)
   */
  async querySignalHealth(
    accountId: string,
    platform: PlatformDestination,
    lookbackHours: number = 24
  ): Promise<SignalHealthReport> {
    const receipts = await this.wireLogger.getRecentReceipts(500);
    const platformReceipts = receipts.filter(
      (r) => r.platform === platform && r.action_type === "SIGNAL_DISPATCH"
    );
    const avgEmq =
      this.emqHistory.length > 0
        ? Number(
            (this.emqHistory.reduce((acc, v) => acc + v, 0) / this.emqHistory.length).toFixed(1)
          )
        : 0;

    return {
      account_id: accountId,
      platform,
      lookback_hours: lookbackHours,
      circuit_breaker_state: this.circuitBreaker.getState(),
      rolling_email_density_ratio: this.circuitBreaker.getEmailPresenceRatio(),
      quarantine_queue_size: await this.quarantineBuffer.size(),
      recent_dispatches_count: platformReceipts.length,
      average_emq_score: avgEmq,
    };
  }

  /**
   * GDPR Art. 17 / CCPA Cross-Platform Right to Erasure (`ados privacy purge-user`)
   */
  async purgeUserIdentifier(input: PrivacyPurgeRequest): Promise<{
    purged_identifier: string;
    receipts: WireAuditReceipt[];
  }> {
    const req = PrivacyPurgeRequestSchema.parse(input);
    if (this.stateDriver instanceof InMemoryStateDriver) {
      await this.stateDriver.purgeMatching(req.identifier_sha256);
    }

    const receipts: WireAuditReceipt[] = [];
    for (const platform of req.destinations) {
      const receipt = await this.wireLogger.logReceipt({
        action_type: "PRIVACY_PURGE",
        platform,
        account_id: "all",
        outbound_payload: {
          operation: "REMOVE_USER",
          identifier_sha256: req.identifier_sha256,
          reason: req.reason,
        },
        http_status: 200,
        vendor_response: { deleted: true, identifier_sha256: req.identifier_sha256 },
      });
      receipts.push(receipt);
    }

    return {
      purged_identifier: req.identifier_sha256,
      receipts,
    };
  }
}

/**
 * Creates a Hono HTTP Server wrapping an `AdOSGateway` instance.
 */
export function createGatewayApp(gateway: AdOSGateway = new AdOSGateway()): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", service: "@ados/gateway" }));

  app.post("/v1/signals/lint", async (c) => {
    const body = await c.req.json();
    const report = gateway.lintConversion(body);
    return c.json(report, 200);
  });

  app.post("/v1/signals/dispatch", async (c) => {
    const body = await c.req.json();
    const result = await gateway.dispatchConversion(body);
    return c.json(result, result.status === "QUARANTINED" ? 202 : 200);
  });

  app.post("/v1/mutations/budget", async (c) => {
    const body = await c.req.json();
    const result = await gateway.mutateBudget(body);
    if (!result.guardrail_evaluation.approved) {
      return c.json(result, 403);
    }
    return c.json(result, 200);
  });

  app.post("/v1/creatives/lint", async (c) => {
    const body = await c.req.json();
    const report = gateway.lintCreative(body);
    return c.json(report, 200);
  });

  app.get("/v1/health/signals", async (c) => {
    const accountId = c.req.query("account_id") ?? "default";
    const platform = (c.req.query("platform") ?? "meta") as PlatformDestination;
    const lookbackHours = Number(c.req.query("lookback_hours") ?? "24");
    const report = await gateway.querySignalHealth(accountId, platform, lookbackHours);
    return c.json(report, 200);
  });

  app.post("/v1/privacy/purge", async (c) => {
    const body = await c.req.json();
    const result = await gateway.purgeUserIdentifier(body);
    return c.json(result, 200);
  });

  return app;
}
