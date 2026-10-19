import {
  type CanonicalConversionEvent,
  CanonicalConversionEventSchema,
  type CanonicalConversionEventInput,
  resolveEffectiveConsent,
} from "@ados/schemas";
import { type CanonicalizedPIIResult, canonicalizeAndHashUserData } from "./pii.js";

export interface EMQLintReport {
  valid: boolean;
  emq_score: number; // 0.0 to 10.0
  grade: "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
  populated_match_keys: string[];
  missing_recommended_keys: string[];
  warnings: string[];
  canonical_event: CanonicalConversionEvent;
  pii_result: CanonicalizedPIIResult;
}

/**
 * Evaluates Event Match Quality (EMQ) using the weighted density formula (Section 2, Quadrant 3):
 * Score = w_1(email) + w_2(phone) + w_3(click_id) + w_4(client_context) + w_5(external_id/address)
 * Scaled from 0.0 to 10.0.
 */
export function lintAndScoreConversion(input: CanonicalConversionEventInput): EMQLintReport {
  const event = CanonicalConversionEventSchema.parse(input);
  const effectiveConsent = resolveEffectiveConsent(event.consent);
  const piiResult = canonicalizeAndHashUserData(event.user_data);

  const warnings = [...piiResult.warnings];
  const populatedKeys: string[] = [];
  const missingKeys: string[] = [];

  let rawScore = 0;

  // w_1(email) = 3.5 pts
  if (piiResult.hashedUserData.em) {
    rawScore += 3.5;
    populatedKeys.push("email");
  } else {
    missingKeys.push("email");
    warnings.push("Missing `user_data.email` (highest-weight deterministic match key: +3.5 EMQ)");
  }

  // w_2(phone) = 2.5 pts
  if (piiResult.hashedUserData.ph) {
    rawScore += 2.5;
    populatedKeys.push("phone");
  } else {
    missingKeys.push("phone");
  }

  // w_3(click_id: fbc/fbp/gclid/ttclid/rdt_cid) = 2.5 pts
  const hasClickId = Boolean(
    event.click_context.fbc ||
      event.click_context.fbp ||
      event.click_context.gclid ||
      event.click_context.gbraid ||
      event.click_context.wbraid ||
      event.click_context.ttclid ||
      event.click_context.rdt_cid
  );
  if (hasClickId) {
    rawScore += 2.5;
    populatedKeys.push("click_id");
  } else {
    missingKeys.push("click_id (_fbp/_fbc/gclid/ttclid)");
    warnings.push(
      "No first-party click or browser IDs present in `click_context`; deploy @ados/edge to capture _fbp/_fbc/gclid"
    );
  }

  // w_4(client_context: IP + User-Agent) = 1.0 pt
  if (piiResult.hashedUserData.client_ip_address && piiResult.hashedUserData.client_user_agent) {
    rawScore += 1.0;
    populatedKeys.push("client_ip_address", "client_user_agent");
  } else {
    missingKeys.push("client_ip_address + client_user_agent");
  }

  // w_5(external_id or name/zip) = 0.5 pt
  if (
    piiResult.hashedUserData.external_id ||
    (piiResult.hashedUserData.fn && piiResult.hashedUserData.zp)
  ) {
    rawScore += 0.5;
    populatedKeys.push("external_id");
  }

  if (effectiveConsent.ad_user_data === "denied" || effectiveConsent.gpc_detected) {
    warnings.push(
      "Consent `ad_user_data` is denied or `Sec-GPC: 1` is active: PII will be stripped (Google Cookieless Ping) or suppressed (Meta/TikTok/Reddit)."
    );
  }

  const emqScore = Math.min(10.0, Number(rawScore.toFixed(1)));
  const grade: EMQLintReport["grade"] =
    emqScore >= 8.0 ? "EXCELLENT" : emqScore >= 6.0 ? "GOOD" : emqScore >= 4.0 ? "FAIR" : "POOR";

  return {
    valid: piiResult.warnings.length === 0,
    emq_score: emqScore,
    grade,
    populated_match_keys: populatedKeys,
    missing_recommended_keys: missingKeys,
    warnings,
    canonical_event: {
      ...event,
      consent: effectiveConsent,
    },
    pii_result: piiResult,
  };
}
