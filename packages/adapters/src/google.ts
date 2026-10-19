import type { BudgetMutationRequest } from "@ados/schemas";
import type {
  AdapterDispatchDecision,
  AdapterDispatchInput,
  AdapterMutationResult,
  PlatformAdapter,
} from "./interface.js";

const DAYS_90_SECONDS = 90 * 24 * 3600;

/**
 * Google Ads Enhanced Conversions & YouTube Adapter
 * - Dedup Key: `transaction_id` (`order_id ?? event_id`)
 * - Dedup Window: Up to 90 Days (Action Reconciled)
 * - Consent Mode v2: Supports Cookieless Modeling Pings when `ad_user_data == "denied"`
 */
export class GoogleAdsAdapter implements PlatformAdapter {
  readonly platform = "google" as const;

  async dispatchConversion(input: AdapterDispatchInput): Promise<AdapterDispatchDecision> {
    const { event, hashedUserData, effectiveConsent } = input;
    const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
    const ageSeconds = Math.max(0, now - event.timestamp);
    const transactionId = event.order_id ?? event.event_id;

    if (ageSeconds > DAYS_90_SECONDS) {
      return {
        platform: "google",
        status: "SUPPRESSED_POSTBACK_EXPIRED",
        dedupKeyUsed: transactionId,
        outboundPayload: null,
        httpStatus: 204,
        vendorResponse: { suppressed: true, reason: "Exceeded Google Ads 90-day conversion window" },
        reason: "Event age exceeds Google Ads 90-day lookback window",
      };
    }

    // Advanced Consent Mode v2 (Section 3A):
    // If ad_user_data === "denied", strip all PII & click IDs and send a Cookieless Modeling Ping.
    if (effectiveConsent.ad_user_data === "denied" || effectiveConsent.gpc_detected) {
      const cookielessPayload: Record<string, unknown> = {
        conversions: [
          {
            transaction_id: transactionId,
            conversion_date_time: new Date(event.timestamp * 1000).toISOString(),
            conversion_value: event.value,
            currency_code: event.currency,
            consent: {
              ad_user_data: "DENIED",
              ad_personalization: "DENIED",
            },
            // PII and gclid explicitly stripped
          },
        ],
        partial_failure: true,
      };

      return {
        platform: "google",
        status: "COOKIELESS_MODELING_PING",
        dedupKeyUsed: transactionId,
        outboundPayload: cookielessPayload,
        httpStatus: 200,
        vendorResponse: {
          modeled_ping_accepted: true,
          transaction_id: transactionId,
        },
        reason: "Sent stripped cookieless modeling ping under Google Advanced Consent Mode v2",
      };
    }

    const userIdentifiers: Record<string, string>[] = [];
    if (hashedUserData.em) userIdentifiers.push({ hashed_email: hashedUserData.em });
    if (hashedUserData.ph) userIdentifiers.push({ hashed_phone_number: hashedUserData.ph });

    const outboundPayload: Record<string, unknown> = {
      conversions: [
        {
          transaction_id: transactionId,
          gclid: event.click_context.gclid,
          gbraid: event.click_context.gbraid,
          wbraid: event.click_context.wbraid,
          conversion_date_time: new Date(event.timestamp * 1000).toISOString(),
          conversion_value: event.value,
          currency_code: event.currency,
          user_identifiers: userIdentifiers,
          consent: {
            ad_user_data: effectiveConsent.ad_user_data.toUpperCase(),
            ad_personalization: effectiveConsent.ad_personalization.toUpperCase(),
          },
        },
      ],
      partial_failure: true,
    };

    return {
      platform: "google",
      status: "DISPATCHED",
      dedupKeyUsed: transactionId,
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { results: [{ transaction_id: transactionId }], partial_failure_error: null },
    };
  }

  async mutateBudget(request: BudgetMutationRequest): Promise<AdapterMutationResult> {
    const outboundPayload = {
      customer_id: request.account_id,
      operations: [
        {
          update: {
            resource_name: `${request.account_id}/campaignBudgets/${request.campaign_id}`,
            amount_micros: request.new_daily_budget_micros,
          },
        },
      ],
      validate_only: request.dry_run,
    };
    return {
      platform: "google",
      account_id: request.account_id,
      campaign_id: request.campaign_id,
      status: request.dry_run ? "DRY_RUN_VALIDATED" : "MUTATED",
      outboundPayload,
      httpStatus: 200,
      vendorResponse: { results: [{ resource_name: outboundPayload.operations[0]!.update.resource_name }] },
    };
  }
}
