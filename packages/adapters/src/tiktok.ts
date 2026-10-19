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
 * TikTok Events API Adapter
 * - Dedup Key: `event_id` + `event`
 * - Dedup Window: 48 Hours (Signal Merged)
 * - Postback Limit: Hard 7-day window
 */
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok" as const;

  async dispatchConversion(input: AdapterDispatchInput): Promise<AdapterDispatchDecision> {
    const { event, hashedUserData, effectiveConsent } = input;
    const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
    const ageSeconds = Math.max(0, now - event.timestamp);
    const dedupKey = `${event.event_id}:${event.event_name}`;

    if (ageSeconds > DAYS_7_SECONDS) {
      return {
        platform: "tiktok",
        status: "SUPPRESSED_POSTBACK_EXPIRED",
        dedupKeyUsed: dedupKey,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: { suppressed: true, reason: "Exceeded TikTok 7-day postback limit" },
        reason: "Event age exceeds TikTok Events API 7-day postback limit",
      };
    }

    if (ageSeconds > HOURS_48_SECONDS && event.click_context.client_pixel_fired) {
      return {
        platform: "tiktok",
        status: "SUPPRESSED_DEDUP_WINDOW",
        dedupKeyUsed: dedupKey,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: {
          suppressed: true,
          reason: "T > 48h with prior client_pixel_fired; suppressed to prevent TikTok double-counting",
        },
        reason:
          "Backfill arrived after TikTok's 48h deduplication window while edge pixel already fired at T_0",
      };
    }

    if (effectiveConsent.ad_user_data === "denied" && !effectiveConsent.limited_data_use) {
      return {
        platform: "tiktok",
        status: "SUPPRESSED_CONSENT",
        dedupKeyUsed: dedupKey,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: { suppressed: true, reason: "ad_user_data denied for TikTok" },
        reason: "Consent ad_user_data is denied",
      };
    }

    const outboundPayload: Record<string, unknown> = {
      event_source: "web",
      data: [
        {
          event: event.event_name,
          event_time: event.timestamp,
          event_id: event.event_id,
          limited_data_use: effectiveConsent.limited_data_use || effectiveConsent.gpc_detected,
          user: {
            email: hashedUserData.em,
            phone: hashedUserData.ph,
            external_id: hashedUserData.external_id,
            ttclid: event.click_context.ttclid,
            ip: hashedUserData.client_ip_address,
            user_agent: hashedUserData.client_user_agent,
          },
          properties: {
            value: event.value,
            currency: event.currency,
            order_id: event.order_id,
          },
        },
      ],
    };

    return {
      platform: "tiktok",
      status: "DISPATCHED",
      dedupKeyUsed: dedupKey,
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { code: 0, message: "OK" },
    };
  }

  async mutateBudget(request: BudgetMutationRequest): Promise<AdapterMutationResult> {
    const outboundPayload = {
      advertiser_id: request.account_id,
      campaign_id: request.campaign_id,
      budget: request.new_daily_budget_micros / 1_000_000,
    };
    return {
      platform: "tiktok",
      account_id: request.account_id,
      campaign_id: request.campaign_id,
      status: request.dry_run ? "DRY_RUN_VALIDATED" : "MUTATED",
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { code: 0, message: "OK", data: { campaign_id: request.campaign_id } },
    };
  }
}
