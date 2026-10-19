import { z } from "zod";

export const ConsentStateSchema = z.enum(["granted", "denied"]);
export type ConsentState = z.infer<typeof ConsentStateSchema>;

export const LduJurisdictionSchema = z.object({
  country: z.number().int().default(1), // 1 = US (Meta LDU convention)
  state: z.number().int().default(1000), // 1000 = California
});

export const ConsentEnvelopeSchema = z.object({
  // Google Consent Mode v2 (EEA & Global)
  ad_storage: ConsentStateSchema.default("denied"),
  analytics_storage: ConsentStateSchema.default("denied"),
  ad_user_data: ConsentStateSchema.default("denied"),
  ad_personalization: ConsentStateSchema.default("denied"),

  // Meta & US State Regulations (Limited Data Use)
  limited_data_use: z.boolean().default(false),
  ldu_jurisdiction: LduJurisdictionSchema.optional(),

  // IAB TCF v2.2 pass-through string
  tc_string: z.string().min(1).optional(),

  // Browser-level Global Privacy Control (Sec-GPC: 1) inheritance
  gpc_detected: z.boolean().default(false),

  // ISO-3166-1 alpha-2 country code
  region: z.string().length(2).toUpperCase().optional(),

  // Audit provenance
  cmp_vendor: z.string().optional(),
  consent_timestamp: z.number().int().positive().default(() => Math.floor(Date.now() / 1000)),
});

export type ConsentEnvelope = z.infer<typeof ConsentEnvelopeSchema>;
export type ConsentEnvelopeInput = z.input<typeof ConsentEnvelopeSchema>;

/**
 * Enforces Global Privacy Control (GPC) auto-inheritance:
 * If `gpc_detected` is true, automatically forces `ad_personalization: "denied"`
 * and enables `limited_data_use: true` across downstream adapters.
 */
export function resolveEffectiveConsent(input?: ConsentEnvelopeInput): ConsentEnvelope {
  const parsed = ConsentEnvelopeSchema.parse(input ?? {});
  if (parsed.gpc_detected) {
    return {
      ...parsed,
      ad_personalization: "denied",
      limited_data_use: true,
      ldu_jurisdiction: parsed.ldu_jurisdiction ?? { country: 1, state: 1000 },
    };
  }
  return parsed;
}
