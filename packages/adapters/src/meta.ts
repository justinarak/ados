import type { BudgetMutationRequest } from "@ados/schemas";
import type {
  AdapterDispatchDecision,
  AdapterDispatchInput,
  AdapterMutationResult,
  PlatformAdapter,
} from "./interface.js";

const HOURS_48_SECONDS = 48 * 3600;
const DAYS_7_SECONDS = 7 * 24 * 3600;

/**
 * Meta Graph / Conversions API (v21+) Adapter
 * - Dedup Key: `event_id` + `event_name`
 * - Dedup Window: 48 Hours (First-In Wins)
 * - Postback Limit: Hard 7-day window
 */
export class MetaAdapter implements PlatformAdapter {
  readonly platform = "meta" as const;

  async dispatchConversion(input: AdapterDispatchInput): Promise<AdapterDispatchDecision> {
    const { event, hashedUserData, effectiveConsent } = input;
    const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
    const ageSeconds = Math.max(0, now - event.timestamp);
    const dedupKey = `${event.event_id}:${event.event_name}`;

    // 1. Hard 7-day postback limit check
    if (ageSeconds > DAYS_7_SECONDS) {
      return {
        platform: "meta",
        status: "SUPPRESSED_POSTBACK_EXPIRED",
        dedupKeyUsed: dedupKey,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: { suppressed: true, reason: "Exceeded Meta 7-day CAPI postback limit" },
        reason: "Event age exceeds Meta CAPI 7-day postback limit (168h)",
      };
    }

    // 2. Window-Aware Egress Suppression (Section 4, Rule #2):
    // If T > 48h and an edge pixel already fired at T_0, suppress Meta egress to prevent double-counting.
    if (ageSeconds > HOURS_48_SECONDS && event.click_context.client_pixel_fired) {
      return {
        platform: "meta",
        status: "SUPPRESSED_DEDUP_WINDOW",
        dedupKeyUsed: dedupKey,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: {
          suppressed: true,
          reason: "T > 48h with prior client_pixel_fired; suppressed to prevent Meta double-counting",
        },
        reason:
          "Backfill arrived after Meta's 48h deduplication window while edge pixel already fired at T_0",
      };
    }

    // 3. Consent check: if ad_user_data == "denied" and LDU is not explicitly requested, drop for Meta
    if (effectiveConsent.ad_user_data === "denied" && !effectiveConsent.limited_data_use) {
      return {
        platform: "meta",
        status: "SUPPRESSED_CONSENT",
        dedupKeyUsed: dedupKey,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: { suppressed: true, reason: "ad_user_data denied for Meta CAPI" },
        reason: "Consent ad_user_data is denied",
      };
    }

    // 4. Construct Meta CAPI v21.0 payload, prioritizing _fbp and _fbc for First-In-Wins survival
    const dataProcessingOptions = effectiveConsent.limited_data_use ? ["LDU"] : [];
    const lduCountry = effectiveConsent.limited_data_use
      ? (effectiveConsent.ldu_jurisdiction?.country ?? 1)
      : undefined;
    const lduState = effectiveConsent.limited_data_use
      ? (effectiveConsent.ldu_jurisdiction?.state ?? 1000)
      : undefined;

    const outboundPayload: Record<string, unknown> = {
      data: [
        {
          event_name: event.event_name,
          event_time: event.timestamp,
          event_id: event.event_id,
          action_source: "website",
          user_data: {
            ...hashedUserData,
            fbp: event.click_context.fbp,
            fbc: event.click_context.fbc,
          },
          custom_data: {
            value: event.value,
            currency: event.currency,
            order_id: event.order_id,
            ...event.custom_data,
          },
          data_processing_options: dataProcessingOptions,
          ...(lduCountry !== undefined ? { data_processing_options_country: lduCountry } : {}),
          ...(lduState !== undefined ? { data_processing_options_state: lduState } : {}),
        },
      ],
    };

    return {
      platform: "meta",
      status: "DISPATCHED",
      dedupKeyUsed: dedupKey,
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { events_received: 1, fbtrace_id: `ados_meta_${event.event_id.slice(0, 8)}` },
    };
  }

  async mutateBudget(request: BudgetMutationRequest): Promise<AdapterMutationResult> {
    const outboundPayload = {
      campaign_id: request.campaign_id,
      daily_budget: Math.round(request.new_daily_budget_micros / 10_000), // Meta uses cents
      execution_options: request.dry_run ? ["validate_only"] : [],
    };
    return {
      platform: "meta",
      account_id: request.account_id,
      campaign_id: request.campaign_id,
      status: request.dry_run ? "DRY_RUN_VALIDATED" : "MUTATED",
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { success: true, id: request.campaign_id },
    };
  }
}
