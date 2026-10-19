import { z } from "zod";
import { PlatformDestinationSchema } from "./events.js";

/**
 * Quadrant 1: Core + Extension Common Data Model (CDM) for Reporting
 */
export const CDMRecordSchema = z.object({
  // Invariant Core Dimensions
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  platform: PlatformDestinationSchema,
  account_id: z.string().min(1),
  campaign_id: z.string().min(1),
  campaign_name: z.string().optional(),
  ad_group_id: z.string().min(1),
  ad_group_name: z.string().optional(),
  ad_id: z.string().min(1),
  placement: z.string().default("ALL"),

  // Invariant Core Metrics
  cost_micros: z.number().int().nonnegative(),
  currency: z.string().length(3).toUpperCase().default("USD"),
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  conversions: z.number().nonnegative(),
  conversion_value: z.number().nonnegative(),

  // Typed JSON-B Platform Extensions
  _meta: z.record(z.unknown()).optional(),
  _google: z.record(z.unknown()).optional(),
  _tiktok: z.record(z.unknown()).optional(),
  _reddit: z.record(z.unknown()).optional(),
});
export type CDMRecord = z.infer<typeof CDMRecordSchema>;

export const CustomFieldDeclarationSchema = z.object({
  source: z.string().min(1),
  alias: z.string().min(1),
  type: z.enum(["STRING", "INTEGER", "FLOAT", "BOOLEAN"]),
});

export const DeclarativeIngestionConfigSchema = z.object({
  lookback_window_days: z.enum(["7", "14", "30"]).default("30"),
  custom_fields: z.record(PlatformDestinationSchema, z.array(CustomFieldDeclarationSchema)).default({}),
});
export type DeclarativeIngestionConfig = z.infer<typeof DeclarativeIngestionConfigSchema>;
