import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ConsentEnvelopeSchema } from "./consent.js";

export const PlatformDestinationSchema = z.enum(["meta", "google", "tiktok", "reddit"]);
export type PlatformDestination = z.infer<typeof PlatformDestinationSchema>;

export const EnvironmentTagSchema = z.enum(["production", "staging", "development"]);
export type EnvironmentTag = z.infer<typeof EnvironmentTagSchema>;

export const UserDataSchema = z.object({
  email: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  zip_code: z.string().min(1).optional(),
  country: z.string().length(2).optional(),
  external_id: z.string().min(1).optional(),
  mobile_advertising_id: z.string().min(1).optional(),
  client_ip_address: z.string().min(1).optional(),
  client_user_agent: z.string().min(1).optional(),
});
export type UserData = z.infer<typeof UserDataSchema>;

export const ClickContextSchema = z.object({
  /** Ephemeral 1-2h session cookie ID minted by @ados/edge */
  ados_session_id: z.string().uuid().optional(),
  fbp: z.string().min(1).optional(),
  fbc: z.string().min(1).optional(),
  fbclid: z.string().min(1).optional(),
  gclid: z.string().min(1).optional(),
  gbraid: z.string().min(1).optional(),
  wbraid: z.string().min(1).optional(),
  ttclid: z.string().min(1).optional(),
  rdt_cid: z.string().min(1).optional(),
  /** Indicates whether a browser/edge pixel already fired for this conversion at T_0 */
  client_pixel_fired: z.boolean().default(false),
  client_pixel_fired_at: z.number().int().positive().optional(),
});
export type ClickContext = z.infer<typeof ClickContextSchema>;

export const CanonicalConversionEventSchema = z.object({
  event_name: z.string().min(1),
  /** Per-event deduplication identifier mapped to Meta/TikTok event_id, Google transaction_id, Reddit conversion_id */
  event_id: z.string().min(1),
  /** Unix epoch timestamp in seconds (T_0) */
  timestamp: z.number().int().positive().default(() => Math.floor(Date.now() / 1000)),
  value: z.number().nonnegative().default(0),
  currency: z.string().length(3).toUpperCase().default("USD"),
  order_id: z.string().min(1).optional(),
  environment: EnvironmentTagSchema.default("production"),
  user_data: UserDataSchema,
  click_context: ClickContextSchema.default({}),
  consent: ConsentEnvelopeSchema.default({}),
  destinations: z.array(PlatformDestinationSchema).min(1),
  custom_data: z.record(z.unknown()).optional(),
});

export type CanonicalConversionEvent = z.infer<typeof CanonicalConversionEventSchema>;
export type CanonicalConversionEventInput = z.input<typeof CanonicalConversionEventSchema>;

/**
 * Generates an RFC 9562 time-ordered UUIDv7 string for `ados_session_id` or `ados_dedup_id`.
 */
export function generateUuidV7(timestampMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timeBigInt = BigInt(timestampMs);

  // 48-bit big-endian unix_ts_ms
  bytes[0] = Number((timeBigInt >> 40n) & 0xffn);
  bytes[1] = Number((timeBigInt >> 32n) & 0xffn);
  bytes[2] = Number((timeBigInt >> 24n) & 0xffn);
  bytes[3] = Number((timeBigInt >> 16n) & 0xffn);
  bytes[4] = Number((timeBigInt >> 8n) & 0xffn);
  bytes[5] = Number(timeBigInt & 0xffn);

  // Version 7 (0111)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Variant 10xx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Generates a deterministic UUID-formatted deduplication ID from (event_name, unique_key, timestampBucket)
 * so retries and warehouse backfills resolve to the exact same `event_id` / `ados_dedup_id`.
 */
export function deriveDeterministicDedupId(
  eventName: string,
  uniqueOrderOrEventKey: string,
  tenantId: string = "default"
): string {
  const digest = createHash("sha256")
    .update(`ados:v1:${tenantId}:${eventName.trim().toLowerCase()}:${uniqueOrderOrEventKey.trim()}`)
    .digest();

  digest[6] = (digest[6]! & 0x0f) | 0x50; // Version 5 style deterministic UUID
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
