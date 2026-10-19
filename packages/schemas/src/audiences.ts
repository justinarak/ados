import { z } from "zod";
import { ConsentEnvelopeSchema } from "./consent.js";
import { PlatformDestinationSchema } from "./events.js";

export const AudienceMemberSchema = z.object({
  email: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  external_id: z.string().min(1).optional(),
  mobile_advertising_id: z.string().min(1).optional(),
  country: z.string().length(2).optional(),
});
export type AudienceMember = z.infer<typeof AudienceMemberSchema>;

export const AudienceSyncOperationSchema = z.enum(["ADD", "REMOVE", "REPLACE"]);
export type AudienceSyncOperation = z.infer<typeof AudienceSyncOperationSchema>;

export const AudienceSyncRequestSchema = z.object({
  audience_id: z.string().min(1),
  audience_name: z.string().min(1),
  operation: AudienceSyncOperationSchema.default("REPLACE"),
  destinations: z.array(PlatformDestinationSchema).min(1),
  members: z.array(AudienceMemberSchema),
  consent: ConsentEnvelopeSchema.default({}),
});
export type AudienceSyncRequest = z.infer<typeof AudienceSyncRequestSchema>;

export const PrivacyPurgeRequestSchema = z.object({
  identifier_sha256: z.string().regex(/^[a-f0-9]{64}$/i, "Must be a valid 64-char SHA-256 hex digest"),
  destinations: z.array(PlatformDestinationSchema).default(["meta", "google", "tiktok", "reddit"]),
  reason: z.enum(["GDPR_ART_17", "CCPA_OPT_OUT", "USER_REQUEST"]).default("GDPR_ART_17"),
});
export type PrivacyPurgeRequest = z.infer<typeof PrivacyPurgeRequestSchema>;

export interface AudienceDeltaResult {
  toAdd: string[];
  toRemove: string[];
  unchangedCount: number;
}

/**
 * Computes Local State Delta for Quadrant 2 Audience Egress:
 * \Delta_add = S_target \setminus S_synced
 * \Delta_remove = S_synced \setminus S_target
 */
export function computeAudienceDelta(
  targetHashes: Iterable<string>,
  previouslySyncedHashes: Iterable<string>
): AudienceDeltaResult {
  const targetSet = new Set(Array.from(targetHashes, (h) => h.toLowerCase()));
  const syncedSet = new Set(Array.from(previouslySyncedHashes, (h) => h.toLowerCase()));

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  let unchangedCount = 0;

  for (const hash of targetSet) {
    if (!syncedSet.has(hash)) {
      toAdd.push(hash);
    } else {
      unchangedCount++;
    }
  }

  for (const hash of syncedSet) {
    if (!targetSet.has(hash)) {
      toRemove.push(hash);
    }
  }

  return { toAdd, toRemove, unchangedCount };
}
