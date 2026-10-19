import {
  type AudienceMember,
  type AudienceSyncRequest,
  AudienceSyncRequestSchema,
  type PlatformDestination,
  computeAudienceDelta,
  resolveEffectiveConsent,
} from "@ados/schemas";
import type { StateDriver, WireAuditReceipt } from "@ados/state";
import { normalizeEmail, normalizePhoneE164, sha256Hex } from "../linter/pii.js";
import { FullDuplexWireLogger, buildComplianceSnapshot } from "../wire/logger.js";

export interface PlatformAudienceSyncSummary {
  platform: PlatformDestination;
  audience_id: string;
  added_count: number;
  removed_count: number;
  unchanged_count: number;
  suppressed_due_to_consent: boolean;
  receipt: WireAuditReceipt;
}

/**
 * Canonicalizes and SHA-256 hashes a single `AudienceMember` into a deterministic member hash.
 */
export function canonicalizeAudienceMemberHash(member: AudienceMember): string | null {
  if (member.email) {
    const { normalized, valid } = normalizeEmail(member.email);
    if (valid) return sha256Hex(normalized);
  }
  if (member.phone) {
    const { digitsOnly, valid } = normalizePhoneE164(member.phone);
    if (valid) return sha256Hex(digitsOnly);
  }
  if (member.external_id) {
    return sha256Hex(member.external_id.trim());
  }
  if (member.mobile_advertising_id) {
    return sha256Hex(member.mobile_advertising_id.trim().toLowerCase());
  }
  return null;
}

/**
 * Quadrant 2: Audience & Identity Egress Engine
 * Computes local state deltas (\Delta_egress = S_target \setminus S_synced), synthesizes
 * regulatory consent flags (GCM v2, Meta LDU, GPC), and dispatches only incremental ADD/REMOVE diffs.
 */
export async function executeAudienceSync(
  input: AudienceSyncRequest,
  stateDriver: StateDriver,
  wireLogger: FullDuplexWireLogger
): Promise<PlatformAudienceSyncSummary[]> {
  const req = AudienceSyncRequestSchema.parse(input);
  const effectiveConsent = resolveEffectiveConsent(req.consent);
  const consentDenied =
    effectiveConsent.ad_user_data === "denied" || effectiveConsent.gpc_detected;

  const targetHashes = new Set<string>();
  for (const member of req.members) {
    const h = canonicalizeAudienceMemberHash(member);
    if (h) targetHashes.add(h);
  }

  const summaries: PlatformAudienceSyncSummary[] = [];

  for (const platform of req.destinations) {
    const stateKey = `ados:audience:${platform}:${req.audience_id}`;
    const rawPrevious = await stateDriver.get(stateKey);
    const previousHashes: string[] = rawPrevious ? (JSON.parse(rawPrevious) as string[]) : [];

    if (consentDenied) {
      const receipt = await wireLogger.logReceipt({
        action_type: "AUDIENCE_SYNC",
        platform,
        account_id: req.audience_id,
        outbound_payload: null,
        http_status: 204,
        vendor_response: { suppressed: true, reason: "ad_user_data denied or Sec-GPC active" },
        compliance_snapshot: buildComplianceSnapshot(effectiveConsent, true),
      });
      summaries.push({
        platform,
        audience_id: req.audience_id,
        added_count: 0,
        removed_count: 0,
        unchanged_count: previousHashes.length,
        suppressed_due_to_consent: true,
        receipt,
      });
      continue;
    }

    let toAdd: string[] = [];
    let toRemove: string[] = [];
    let unchangedCount = 0;
    let nextStateHashes: string[] = [];

    if (req.operation === "REPLACE") {
      const delta = computeAudienceDelta(targetHashes, previousHashes);
      toAdd = delta.toAdd;
      toRemove = delta.toRemove;
      unchangedCount = delta.unchangedCount;
      nextStateHashes = Array.from(targetHashes);
    } else if (req.operation === "ADD") {
      const prevSet = new Set(previousHashes);
      for (const h of targetHashes) {
        if (!prevSet.has(h)) {
          toAdd.push(h);
          prevSet.add(h);
        } else {
          unchangedCount++;
        }
      }
      nextStateHashes = Array.from(prevSet);
    } else {
      // REMOVE
      const prevSet = new Set(previousHashes);
      for (const h of targetHashes) {
        if (prevSet.has(h)) {
          toRemove.push(h);
          prevSet.delete(h);
        }
      }
      unchangedCount = prevSet.size;
      nextStateHashes = Array.from(prevSet);
    }

    await stateDriver.set(stateKey, JSON.stringify(nextStateHashes), 7200);

    const outboundPayload = {
      audience_id: req.audience_id,
      audience_name: req.audience_name,
      append_hashes: toAdd,
      remove_hashes: toRemove,
      consent: {
        ad_user_data: effectiveConsent.ad_user_data,
        ad_personalization: effectiveConsent.ad_personalization,
        limited_data_use: effectiveConsent.limited_data_use,
      },
    };

    const receipt = await wireLogger.logReceipt({
      action_type: "AUDIENCE_SYNC",
      platform,
      account_id: req.audience_id,
      outbound_payload: outboundPayload,
      http_status: 200,
      vendor_response: {
        added: toAdd.length,
        removed: toRemove.length,
        unchanged: unchangedCount,
      },
      compliance_snapshot: buildComplianceSnapshot(effectiveConsent, false),
    });

    summaries.push({
      platform,
      audience_id: req.audience_id,
      added_count: toAdd.length,
      removed_count: toRemove.length,
      unchanged_count: unchangedCount,
      suppressed_due_to_consent: false,
      receipt,
    });
  }

  return summaries;
}
