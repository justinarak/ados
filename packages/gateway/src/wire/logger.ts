import { type ConsentEnvelope, generateUuidV7 } from "@ados/schemas";
import type { ComplianceSnapshot, TelemetryDriver, WireAuditReceipt } from "@ados/state";

/**
 * Builds an immutable ComplianceSnapshot from a resolved `ConsentEnvelope`
 * for Full-Duplex Audit Wire logging (Section 3A).
 */
export function buildComplianceSnapshot(
  consent: ConsentEnvelope,
  ipAnonymized: boolean
): ComplianceSnapshot {
  return {
    consent_state: {
      ad_storage: consent.ad_storage,
      analytics_storage: consent.analytics_storage,
      ad_user_data: consent.ad_user_data,
      ad_personalization: consent.ad_personalization,
    },
    limited_data_use: consent.limited_data_use,
    tc_string: consent.tc_string,
    gpc_header_present: consent.gpc_detected,
    ip_anonymized: ipAnonymized,
    cmp_vendor: consent.cmp_vendor,
    consent_timestamp: consent.consent_timestamp,
  };
}

export class FullDuplexWireLogger {
  constructor(private readonly telemetryDriver: TelemetryDriver) {}

  async logReceipt(
    params: Omit<WireAuditReceipt, "receipt_id" | "timestamp_iso">
  ): Promise<WireAuditReceipt> {
    const receipt: WireAuditReceipt = {
      receipt_id: generateUuidV7(),
      timestamp_iso: new Date().toISOString(),
      ...params,
    };
    await this.telemetryDriver.emit(receipt);
    return receipt;
  }

  async getRecentReceipts(limit: number = 100): Promise<WireAuditReceipt[]> {
    return this.telemetryDriver.queryRecent(limit);
  }
}
