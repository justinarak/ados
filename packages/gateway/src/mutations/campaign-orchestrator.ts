import {
  type AdOSRole,
  type AssetLifecycleState,
  type CampaignTree,
  CampaignTreeSchema,
  generateUuidV7,
} from "@ados/schemas";
import type { WireAuditReceipt } from "@ados/state";
import { isRoleAuthorizedForScope } from "../auth/broker.js";
import { lintCreativeSpecs } from "../linter/creative.js";
import type { FullDuplexWireLogger } from "../wire/logger.js";

const VALID_ASSET_TRANSITIONS: Record<AssetLifecycleState, readonly AssetLifecycleState[]> = {
  QUEUED: ["UPLOADING", "REJECTED"],
  UPLOADING: ["PROCESSING", "REJECTED"],
  PROCESSING: ["AUDITING", "REJECTED"],
  AUDITING: ["READY", "REJECTED"],
  READY: [],
  REJECTED: ["QUEUED"],
};

/**
 * Enforces deterministic state transitions in the 6-State Asynchronous Asset Lifecycle Machine:
 * QUEUED -> UPLOADING -> PROCESSING -> AUDITING -> READY | REJECTED
 */
export function transitionAssetLifecycleState(
  currentState: AssetLifecycleState,
  nextState: AssetLifecycleState
): AssetLifecycleState {
  const allowed = VALID_ASSET_TRANSITIONS[currentState];
  if (!allowed.includes(nextState)) {
    throw new Error(
      `Illegal asset lifecycle transition: ${currentState} -> ${nextState} (allowed: ${allowed.join(", ") || "none"})`
    );
  }
  return nextState;
}

export interface CampaignDraftOrchestrationResult {
  approved: boolean;
  enforced_status: "PAUSED" | "ACTIVE" | "ARCHIVED";
  forced_paused_by_guardrail: boolean;
  campaign_id: string;
  asset_states: Record<string, AssetLifecycleState>;
  lint_violations: string[];
  outbound_hierarchy_payload?: Record<string, unknown>;
  audit_receipt?: WireAuditReceipt;
}

/**
 * Quadrant 4: Declarative Entity Orchestrator (`Campaign -> TargetingGroup -> CreativeBinding`)
 * Normalizes platform hierarchies (Meta Campaign->AdSet->Ad vs Google Campaign->AdGroup->AssetGroup),
 * runs pre-flight creative linting on all bound assets, advances the 6-state asset lifecycle machine,
 * and hard-enforces `status: "PAUSED"` unless the caller role holds `campaigns.status:activate`.
 */
export async function stageCampaignTreeDraft(
  treeInput: CampaignTree,
  callerRole: AdOSRole,
  wireLogger: FullDuplexWireLogger
): Promise<CampaignDraftOrchestrationResult> {
  const tree = CampaignTreeSchema.parse(treeInput);
  const lintViolations: string[] = [];
  const assetStates: Record<string, AssetLifecycleState> = {};

  if (!isRoleAuthorizedForScope(callerRole, "campaigns.entity:create_draft")) {
    return {
      approved: false,
      enforced_status: "PAUSED",
      forced_paused_by_guardrail: true,
      campaign_id: tree.id ?? "unassigned",
      asset_states: {},
      lint_violations: [
        `Role "${callerRole}" lacks required scope "campaigns.entity:create_draft"`,
      ],
    };
  }

  // Validate all creative bindings via pre-flight linter and progress through the 6-state machine
  for (const group of tree.targeting_groups) {
    for (const creative of group.creatives) {
      const creativeKey = creative.id ?? creative.name;
      let state: AssetLifecycleState = "QUEUED";

      const isVideo = /\.(mp4|mov|webm)(\?.*)?$/i.test(creative.asset_url);
      const lintReport = lintCreativeSpecs({
        asset_url: creative.asset_url,
        media_type: isVideo ? "video" : "image",
        target_placements: group.placements,
        copy_variations: {
          headlines: [creative.headline],
          bodies: [creative.primary_text],
        },
      });

      if (!lintReport.valid) {
        state = transitionAssetLifecycleState(state, "REJECTED");
        assetStates[creativeKey] = state;
        for (const pr of lintReport.placement_results) {
          lintViolations.push(...pr.violations);
        }
        lintViolations.push(...lintReport.copy_violations);
      } else {
        state = transitionAssetLifecycleState(state, "UPLOADING");
        state = transitionAssetLifecycleState(state, "PROCESSING");
        state = transitionAssetLifecycleState(state, "AUDITING");
        state = transitionAssetLifecycleState(state, "READY");
        assetStates[creativeKey] = state;
      }
    }
  }

  if (lintViolations.length > 0) {
    return {
      approved: false,
      enforced_status: "PAUSED",
      forced_paused_by_guardrail: true,
      campaign_id: tree.id ?? "unassigned",
      asset_states: assetStates,
      lint_violations: lintViolations,
    };
  }

  // Asymmetric Role Safety Check:
  // If caller requests `ACTIVE` but lacks `campaigns.status:activate`, hard-override to `PAUSED`
  const canActivate = isRoleAuthorizedForScope(callerRole, "campaigns.status:activate");
  const forcedPaused = tree.status === "ACTIVE" && !canActivate;
  const enforcedStatus = forcedPaused ? "PAUSED" : tree.status;
  const campaignId = tree.id ?? `cmp_${generateUuidV7().slice(0, 8)}`;

  const hierarchyLabel =
    tree.platform === "meta"
      ? { level_1: "Campaign", level_2: "AdSet", level_3: "Ad" }
      : tree.platform === "google"
        ? { level_1: "Campaign", level_2: "AdGroup", level_3: "AssetGroup" }
        : { level_1: "Campaign", level_2: "AdGroup", level_3: "Ad" };

  const outboundPayload: Record<string, unknown> = {
    platform: tree.platform,
    account_id: tree.account_id,
    hierarchy_mapping: hierarchyLabel,
    campaign: {
      id: campaignId,
      name: tree.name,
      objective: tree.objective,
      status: enforcedStatus,
      targeting_groups: tree.targeting_groups.map((g) => ({
        name: g.name,
        daily_budget_micros: g.daily_budget_micros,
        bid_strategy: g.bid_strategy,
        placements: g.placements,
        status: enforcedStatus,
        creatives: g.creatives.map((c) => ({
          name: c.name,
          asset_url: c.asset_url,
          headline: c.headline,
          primary_text: c.primary_text,
          lifecycle_state: assetStates[c.id ?? c.name],
        })),
      })),
    },
  };

  const receipt = await wireLogger.logReceipt({
    action_type: "BUDGET_MUTATION",
    platform: tree.platform,
    account_id: tree.account_id,
    outbound_payload: outboundPayload,
    http_status: 201,
    vendor_response: {
      campaign_id: campaignId,
      status: enforcedStatus,
      forced_paused_by_guardrail: forcedPaused,
    },
    rationale: `Staged campaign tree "${tree.name}" by role "${callerRole}" (status=${enforcedStatus})`,
  });

  return {
    approved: true,
    enforced_status: enforcedStatus,
    forced_paused_by_guardrail: forcedPaused,
    campaign_id: campaignId,
    asset_states: assetStates,
    lint_violations: [],
    outbound_hierarchy_payload: outboundPayload,
    audit_receipt: receipt,
  };
}
