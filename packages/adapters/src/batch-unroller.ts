import type { CanonicalConversionEvent } from "@ados/schemas";

export interface VendorBatchItemStatus {
  index: number;
  code: number; // e.g. 200 = success, 429/500/503 = transient retryable, 400/422 = permanent schema error
  error_message?: string;
}

export interface BatchUnrollResult {
  delivered: CanonicalConversionEvent[];
  retryable: Array<{
    event: CanonicalConversionEvent;
    code: number;
    error_message?: string;
  }>;
  dead_letter_quarantined: Array<{
    event: CanonicalConversionEvent;
    code: number;
    error_message?: string;
  }>;
}

/**
 * Section 5, Failure Mode 4: HTTP 200 Partial-Batch Response Unroller
 * Ad platforms (Meta CAPI batch, Google Ads `partial_failure: true`, TikTok batch) often return
 * `HTTP 200 OK` at the transport level while rejecting a subset of events inside the JSON body.
 *
 * This unroller inspects per-index status codes and splits the batch into:
 * 1. `delivered` (2xx)
 * 2. `retryable` (429 rate-limit, 5xx transient vendor error) — preserving original `event_id`
 * 3. `dead_letter_quarantined` (4xx validation/formatting error) — isolated so bad rows never poison retries
 */
export function unrollPartialBatchResponse(
  batchEvents: readonly CanonicalConversionEvent[],
  itemStatuses: readonly VendorBatchItemStatus[]
): BatchUnrollResult {
  const statusByIndex = new Map<number, VendorBatchItemStatus>();
  for (const item of itemStatuses) {
    statusByIndex.set(item.index, item);
  }

  const delivered: CanonicalConversionEvent[] = [];
  const retryable: BatchUnrollResult["retryable"] = [];
  const dead_letter_quarantined: BatchUnrollResult["dead_letter_quarantined"] = [];

  batchEvents.forEach((event, index) => {
    const item = statusByIndex.get(index);
    if (!item || (item.code >= 200 && item.code < 300)) {
      delivered.push(event);
      return;
    }

    if (item.code === 429 || item.code >= 500) {
      retryable.push({
        event,
        code: item.code,
        error_message: item.error_message,
      });
      return;
    }

    dead_letter_quarantined.push({
      event,
      code: item.code,
      error_message: item.error_message,
    });
  });

  return {
    delivered,
    retryable,
    dead_letter_quarantined,
  };
}
