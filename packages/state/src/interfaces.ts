import type {
  CanonicalConversionEvent,
  ClickContext,
  ConsentEnvelope,
  PlatformDestination,
} from "@ados/schemas";

export interface EphemeralSessionRecord {
  ados_session_id: string;
  click_context: ClickContext;
  consent: ConsentEnvelope;
  created_at_ms: number;
}

export interface ComplianceSnapshot {
  consent_state: {
    ad_storage: "granted" | "denied";
    analytics_storage: "granted" | "denied";
    ad_user_data: "granted" | "denied";
    ad_personalization: "granted" | "denied";
  };
  limited_data_use: boolean;
  tc_string?: string;
  gpc_header_present: boolean;
  ip_anonymized: boolean;
  cmp_vendor?: string;
  consent_timestamp: number;
}

export interface WireAuditReceipt {
  receipt_id: string;
  timestamp_iso: string;
  action_type: "SIGNAL_DISPATCH" | "BUDGET_MUTATION" | "AUDIENCE_SYNC" | "PRIVACY_PURGE";
  platform: PlatformDestination;
  account_id: string;
  event_id?: string;
  outbound_payload: unknown;
  http_status: number;
  vendor_response: unknown;
  compliance_snapshot?: ComplianceSnapshot;
  rationale?: string;
}

export interface QuarantinedEventRecord {
  quarantine_id: string;
  event: CanonicalConversionEvent;
  reason: "EMQ_DENSITY_DROP" | "VALUE_ANOMALY_5SIGMA" | "BATCH_STAMPEDE" | "UPSTREAM_5XX" | "ENVIRONMENT_MISMATCH";
  quarantined_at_ms: number;
  target_platforms: PlatformDestination[];
}

/**
 * Pluggable Key-Value & Ephemeral Session Stitching Driver (@ados/state)
 */
export interface StateDriver {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface QuarantineBufferDriver {
  enqueue(record: QuarantinedEventRecord): Promise<void>;
  drain(maxItems: number): Promise<QuarantinedEventRecord[]>;
  size(): Promise<number>;
  list(): Promise<QuarantinedEventRecord[]>;
}

export interface TelemetryDriver {
  emit(receipt: WireAuditReceipt): Promise<void>;
  queryRecent(limit?: number): Promise<WireAuditReceipt[]>;
}

export interface SessionStitchResult {
  mergedClickContext: ClickContext;
  stitched: boolean;
  purgedDueToConsentDenial: boolean;
}

/**
 * Consent-Gated Session Stitching (Section 3A/3B):
 * - Default TTL is 1-2 hours (7200s).
 * - If either the cached session consent OR the incoming server event consent has
 *   `ad_user_data === "denied"`, AdOS immediately purges the cached click IDs from
 *   the state store and refuses to join the session.
 */
export async function stitchEphemeralSession(
  driver: StateDriver,
  adosSessionId: string | undefined,
  incomingClickContext: ClickContext,
  incomingConsent: ConsentEnvelope
): Promise<SessionStitchResult> {
  if (!adosSessionId) {
    return {
      mergedClickContext: incomingClickContext,
      stitched: false,
      purgedDueToConsentDenial: false,
    };
  }

  const sessionKey = `ados:session:${adosSessionId}`;

  // If incoming event denies ad_user_data, immediately purge any cached session click IDs
  if (incomingConsent.ad_user_data === "denied" || incomingConsent.gpc_detected) {
    await driver.del(sessionKey);
    return {
      mergedClickContext: {
        ...incomingClickContext,
        fbp: undefined,
        fbc: undefined,
        fbclid: undefined,
        gclid: undefined,
        gbraid: undefined,
        wbraid: undefined,
        ttclid: undefined,
        rdt_cid: undefined,
      },
      stitched: false,
      purgedDueToConsentDenial: true,
    };
  }

  const raw = await driver.get(sessionKey);
  if (!raw) {
    return {
      mergedClickContext: incomingClickContext,
      stitched: false,
      purgedDueToConsentDenial: false,
    };
  }

  const cached = JSON.parse(raw) as EphemeralSessionRecord;
  if (cached.consent.ad_user_data === "denied" || cached.consent.gpc_detected) {
    await driver.del(sessionKey);
    return {
      mergedClickContext: incomingClickContext,
      stitched: false,
      purgedDueToConsentDenial: true,
    };
  }

  const mergedClickContext: ClickContext = {
    ...cached.click_context,
    ...Object.fromEntries(
      Object.entries(incomingClickContext).filter(([, v]) => v !== undefined)
    ),
    ados_session_id: adosSessionId,
  };

  return {
    mergedClickContext,
    stitched: true,
    purgedDueToConsentDenial: false,
  };
}
