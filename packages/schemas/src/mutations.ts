import { z } from "zod";
import { PlatformDestinationSchema } from "./events.js";

/**
 * Artificial Engineering Scopes & Asymmetric Action Granularity (Section 6)
 */
export const AdOSScopeSchema = z.enum([
  "analytics:read",
  "signals:write",
  "audiences:sync",
  "compliance.consent:override",
  "compliance:purge",
  "creative:lint",
  "creative:deploy",
  "campaigns.status:pause",
  "campaigns.status:activate",
  "campaigns.entity:create_draft",
  "campaigns.pacing:mutate",
]);
export type AdOSScope = z.infer<typeof AdOSScopeSchema>;

/**
 * Unified Cross-Platform Role Presets
 */
export const AdOSRoleSchema = z.enum([
  "agent:analyst",
  "agent:pacing-optimizer",
  "agent:campaign-builder",
  "service:signal-pipe",
  "human:growth-governor",
]);
export type AdOSRole = z.infer<typeof AdOSRoleSchema>;

export const ROLE_DEFAULT_SCOPES: Record<AdOSRole, readonly AdOSScope[]> = {
  "agent:analyst": ["analytics:read", "creative:lint"],
  "agent:pacing-optimizer": [
    "analytics:read",
    "campaigns.pacing:mutate",
    "campaigns.status:pause",
  ],
  "agent:campaign-builder": [
    "analytics:read",
    "creative:lint",
    "creative:deploy",
    "campaigns.entity:create_draft",
  ],
  "service:signal-pipe": ["signals:write", "audiences:sync"],
  "human:growth-governor": [
    "analytics:read",
    "signals:write",
    "audiences:sync",
    "compliance.consent:override",
    "compliance:purge",
    "creative:lint",
    "creative:deploy",
    "campaigns.status:pause",
    "campaigns.status:activate",
    "campaigns.entity:create_draft",
    "campaigns.pacing:mutate",
  ],
};

/**
 * Guardrail Policy Schema (Tier 1 Stateless + Tier 2 Stateful)
 */
export const GuardrailPolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  subject: z.string().min(1),
  role: AdOSRoleSchema.optional(),
  allowed_scopes: z.array(AdOSScopeSchema).min(1),
  target_accounts: z.record(PlatformDestinationSchema, z.array(z.string())).default({}),
  guardrails: z.object({
    budget_bounds: z
      .object({
        min_daily_budget_micros: z.number().int().nonnegative().default(10_000_000), // $10 default min
        absolute_daily_cap_micros: z.number().int().positive(), // e.g. 5_000_000_000 ($5,000)
        require_rationale_min_length: z.number().int().nonnegative().default(10),
      })
      .optional(),
    budget_delta_limits: z
      .object({
        max_increase_percent_per_call: z.number().positive().default(15.0),
        max_decrease_percent_per_call: z.number().positive().default(30.0),
      })
      .optional(),
    rate_limits: z
      .object({
        min_cooldown_minutes: z.number().int().nonnegative().default(60),
        max_mutations_per_day: z.number().int().positive().default(12),
      })
      .optional(),
    protected_entities: z
      .object({
        blocked_campaign_ids: z.array(z.string()).default([]),
        require_manual_approval_tags: z.array(z.string()).default([]),
      })
      .default({}),
  }),
});
export type GuardrailPolicyRule = z.infer<typeof GuardrailPolicyRuleSchema>;

export const GuardrailPolicyDocumentSchema = z.object({
  version: z.literal("1.0"),
  policies: z.array(GuardrailPolicyRuleSchema).min(1),
});
export type GuardrailPolicyDocument = z.infer<typeof GuardrailPolicyDocumentSchema>;

/**
 * Quadrant 4: Budget Mutation Contract (`ados_mutate_budget`)
 */
export const BudgetMutationRequestSchema = z.object({
  platform: PlatformDestinationSchema,
  account_id: z.string().min(1),
  campaign_id: z.string().min(1),
  current_daily_budget_micros: z.number().int().positive().optional(),
  new_daily_budget_micros: z.number().int().positive(),
  rationale: z.string().min(1),
  campaign_tags: z.array(z.string()).default([]),
  dry_run: z.boolean().default(false),
});
export type BudgetMutationRequest = z.infer<typeof BudgetMutationRequestSchema>;

/**
 * Quadrant 4: Creative Spec Linter Contract (`ados_lint_creative`) & 6-State Machine
 */
export const AssetLifecycleStateSchema = z.enum([
  "QUEUED",
  "UPLOADING",
  "PROCESSING",
  "AUDITING",
  "READY",
  "REJECTED",
]);
export type AssetLifecycleState = z.infer<typeof AssetLifecycleStateSchema>;

export const TargetPlacementSchema = z.enum([
  "meta_reels",
  "meta_feed",
  "tiktok_feed",
  "google_pmax",
  "youtube_shorts",
  "reddit_feed",
]);
export type TargetPlacement = z.infer<typeof TargetPlacementSchema>;

export const CreativeLintRequestSchema = z.object({
  asset_url: z.string().url(),
  media_type: z.enum(["image", "video"]),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().positive().optional(),
  file_size_bytes: z.number().int().positive().optional(),
  target_placements: z.array(TargetPlacementSchema).min(1),
  copy_variations: z
    .object({
      headlines: z.array(z.string()).default([]),
      bodies: z.array(z.string()).default([]),
    })
    .optional(),
});
export type CreativeLintRequest = z.infer<typeof CreativeLintRequestSchema>;

/**
 * Unified Campaign Entity Tree (Campaign -> TargetingGroup -> CreativeBinding)
 */
export const EntityStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);

export const CreativeBindingNodeSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  asset_url: z.string().url(),
  headline: z.string().min(1),
  primary_text: z.string().min(1),
  call_to_action: z.string().default("LEARN_MORE"),
  destination_url: z.string().url(),
  lifecycle_state: AssetLifecycleStateSchema.default("QUEUED"),
});

export const TargetingGroupNodeSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  daily_budget_micros: z.number().int().positive(),
  bid_strategy: z.enum(["LOWEST_COST", "COST_CAP", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS"]),
  placements: z.array(TargetPlacementSchema).min(1),
  creatives: z.array(CreativeBindingNodeSchema).min(1),
});

export const CampaignTreeSchema = z.object({
  id: z.string().optional(),
  platform: PlatformDestinationSchema,
  account_id: z.string().min(1),
  name: z.string().min(1),
  objective: z.enum(["CONVERSIONS", "TRAFFIC", "AWARENESS", "LEAD_GENERATION"]),
  status: EntityStatusSchema.default("PAUSED"),
  targeting_groups: z.array(TargetingGroupNodeSchema).min(1),
});
export type CampaignTree = z.infer<typeof CampaignTreeSchema>;
