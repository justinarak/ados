import {
  type CDMRecord,
  CDMRecordSchema,
  type DeclarativeIngestionConfig,
  type PlatformDestination,
} from "@ados/schemas";

/**
 * Resolves a dot-separated path (e.g. `"metrics.video_quartile_p50_rate"`) on a nested object.
 */
function getByDotPath(obj: Record<string, unknown>, path: string): unknown {
  if (path in obj) return obj[path];
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function castCustomFieldValue(
  raw: unknown,
  targetType: "STRING" | "INTEGER" | "FLOAT" | "BOOLEAN"
): unknown {
  if (raw === undefined || raw === null) return undefined;
  switch (targetType) {
    case "STRING":
      return String(raw);
    case "INTEGER":
      return Math.trunc(Number(raw));
    case "FLOAT":
      return Number(raw);
    case "BOOLEAN":
      return Boolean(raw);
  }
}

/**
 * Quadrant 1: Core + Extension CDM Normalizer & Config-as-Code Declarative Field Extractor
 * Normalizes raw reporting payloads from Meta Insights, Google Ads GAQL, TikTok, or Reddit into
 * invariant `CDMRecord` objects while extracting YAML-configured `custom_fields` into typed
 * JSON-B extensions (`_meta`, `_google`, `_tiktok`, `_reddit`).
 */
export function normalizePlatformReportToCDM(
  platform: PlatformDestination,
  rawRows: readonly Record<string, unknown>[],
  config?: DeclarativeIngestionConfig
): CDMRecord[] {
  const customDecls = config?.custom_fields?.[platform] ?? [];

  return rawRows.map((row) => {
    const extensionObj: Record<string, unknown> = {};

    // Apply declarative YAML custom_fields extraction
    for (const decl of customDecls) {
      const rawVal = getByDotPath(row, decl.source);
      const casted = castCustomFieldValue(rawVal, decl.type);
      if (casted !== undefined) {
        extensionObj[decl.alias] = casted;
      }
    }

    // Extract standard fields across Google GAQL & Meta Insights conventions
    const date = String(
      row["date"] ?? row["date_start"] ?? getByDotPath(row, "segments.date") ?? "1970-01-01"
    );
    const accountId = String(
      row["account_id"] ?? getByDotPath(row, "customer.id") ?? "default_account"
    );
    const campaignId = String(
      row["campaign_id"] ?? getByDotPath(row, "campaign.id") ?? "unknown_campaign"
    );
    const adGroupId = String(
      row["adset_id"] ?? row["ad_group_id"] ?? getByDotPath(row, "ad_group.id") ?? "unknown_group"
    );
    const adId = String(row["ad_id"] ?? getByDotPath(row, "ad.id") ?? "unknown_ad");

    // Cost in micros: either provided directly (`cost_micros` / `metrics.cost_micros`) or converted from `spend` (decimal currency)
    const rawCostMicros = row["cost_micros"] ?? getByDotPath(row, "metrics.cost_micros");
    const costMicros =
      rawCostMicros !== undefined
        ? Math.round(Number(rawCostMicros))
        : Math.round(Number(row["spend"] ?? 0) * 1_000_000);

    const impressions = Math.round(
      Number(row["impressions"] ?? getByDotPath(row, "metrics.impressions") ?? 0)
    );
    const clicks = Math.round(Number(row["clicks"] ?? getByDotPath(row, "metrics.clicks") ?? 0));
    const conversions = Number(
      row["conversions"] ?? getByDotPath(row, "metrics.conversions") ?? 0
    );
    const conversionValue = Number(
      row["conversion_value"] ??
        row["conversions_value"] ??
        getByDotPath(row, "metrics.conversions_value") ??
        0
    );

    const extensionKey = `_${platform}` as "_meta" | "_google" | "_tiktok" | "_reddit";

    return CDMRecordSchema.parse({
      date,
      platform,
      account_id: accountId,
      campaign_id: campaignId,
      campaign_name: row["campaign_name"] ? String(row["campaign_name"]) : undefined,
      ad_group_id: adGroupId,
      ad_id: adId,
      placement: String(row["placement"] ?? "ALL"),
      cost_micros: costMicros,
      currency: String(row["currency"] ?? "USD").toUpperCase(),
      impressions,
      clicks,
      conversions,
      conversion_value: conversionValue,
      ...(Object.keys(extensionObj).length > 0 ? { [extensionKey]: extensionObj } : {}),
    });
  });
}

/**
 * Generates a deterministic Lookback-Aware SQL `MERGE INTO` statement (Section 2, Quadrant 1)
 * keyed on `(date, platform, account_id, ad_id, placement)` for rolling T-7 / T-14 / T-30 upserts.
 */
export function buildLookbackMergeSql(
  targetTable: string = "analytics.ados_cdm_daily_performance",
  stagingTable: string = "staging.ados_cdm_lookback_window"
): string {
  return [
    `MERGE INTO ${targetTable} AS target`,
    `USING ${stagingTable} AS source`,
    `ON target.date = source.date`,
    `  AND target.platform = source.platform`,
    `  AND target.account_id = source.account_id`,
    `  AND target.ad_id = source.ad_id`,
    `  AND target.placement = source.placement`,
    `WHEN MATCHED THEN UPDATE SET`,
    `  cost_micros = source.cost_micros,`,
    `  impressions = source.impressions,`,
    `  clicks = source.clicks,`,
    `  conversions = source.conversions,`,
    `  conversion_value = source.conversion_value,`,
    `  _meta = source._meta,`,
    `  _google = source._google,`,
    `  _tiktok = source._tiktok,`,
    `  _reddit = source._reddit`,
    `WHEN NOT MATCHED THEN INSERT (`,
    `  date, platform, account_id, campaign_id, ad_group_id, ad_id, placement,`,
    `  cost_micros, currency, impressions, clicks, conversions, conversion_value,`,
    `  _meta, _google, _tiktok, _reddit`,
    `) VALUES (`,
    `  source.date, source.platform, source.account_id, source.campaign_id, source.ad_group_id, source.ad_id, source.placement,`,
    `  source.cost_micros, source.currency, source.impressions, source.clicks, source.conversions, source.conversion_value,`,
    `  source._meta, source._google, source._tiktok, source._reddit`,
    `);`,
  ].join("\n");
}
