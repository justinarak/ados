import type { BudgetMutationRequest } from "@ados/schemas";
import type {
  AdapterDispatchDecision,
  AdapterDispatchInput,
  AdapterMutationResult,
  PlatformAdapter,
} from "./interface.js";

const DAYS_7_SECONDS = 7 * 24 * 3600;

/**
 * Reddit Conversions API v3 Adapter
 * - Dedup Key: `conversion_id`
 * - Dedup Window: 48 Hours (Signal-Density Wins in 1h batch cycles)
 * - Postback Limit: Hard 7-day window
 */
export class RedditAdapter implements PlatformAdapter {
  readonly platform = "reddit" as const;

  async dispatchConversion(input: AdapterDispatchInput): Promise<AdapterDispatchDecision> {
    const { event, hashedUserData, effectiveConsent } = input;
    const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
    const ageSeconds = Math.max(0, now - event.timestamp);
    const conversionId = event.event_id;

    if (ageSeconds > DAYS_7_SECONDS) {
      return {
        platform: "reddit",
        status: "SUPPRESSED_POSTBACK_EXPIRED",
        dedupKeyUsed: conversionId,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: { suppressed: true, reason: "Exceeded Reddit CAPI 7-day postback limit" },
        reason: "Event age exceeds Reddit CAPI v3 7-day postback limit",
      };
    }

    if (effectiveConsent.ad_user_data === "denied" || effectiveConsent.gpc_detected) {
      return {
        platform: "reddit",
        status: "SUPPRESSED_CONSENT",
        dedupKeyUsed: conversionId,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: { suppressed: true, reason: "ad_user_data denied for Reddit CAPI" },
        reason: "Consent ad_user_data is denied",
      };
    }

    // Calculate signal-density key count for Reddit's Signal-Density-Wins arbiter
    const populatedMatchKeys = [
      hashedUserData.em,
      hashedUserData.ph,
      hashedUserData.external_id,
      event.click_context.rdt_cid,
      hashedUserData.client_ip_address,
      hashedUserData.client_user_agent,
    ].filter(Boolean).length;

    const outboundPayload: Record<string, unknown> = {
      events: [
        {
          event_at: new Date(event.timestamp * 1000).toISOString(),
          event_type: {
            tracking_type: event.event_name,
          },
          click_id: event.click_context.rdt_cid,
          user: {
            email: hashedUserData.em,
            phone_number: hashedUserData.ph,
            external_id: hashedUserData.external_id,
            ip_address: hashedUserData.client_ip_address,
            user_agent: hashedUserData.client_user_agent,
            opt_out: effectiveConsent.limited_data_use,
          },
          event_metadata: {
            conversion_id: conversionId,
            value_decimal: event.value,
            currency: event.currency,
            ados_signal_density_keys: populatedMatchKeys,
          },
        },
      ],
    };

    return {
      platform: "reddit",
      status: "DISPATCHED",
      dedupKeyUsed: conversionId,
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { events_received: 1, signal_density_keys: populatedMatchKeys },
    };
  }

  async mutateBudget(request: BudgetMutationRequest): Promise<AdapterMutationResult> {
    const outboundPayload = {
      account_id: request.account_id,
      campaign_id: request.campaign_id,
      daily_budget_micros: request.new_daily_budget_micros,
    };
    return {
      platform: "reddit",
      account_id: request.account_id,
      campaign_id: request.campaign_id,
      status: request.dry_run ? "DRY_RUN_VALIDATED" : "MUTATED",
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { data: { id: request.campaign_id } },
    };
  }
}
