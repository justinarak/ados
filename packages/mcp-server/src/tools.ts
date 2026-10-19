import { AdOSGateway } from "@ados/gateway";
import type {
  BudgetMutationRequest,
  CanonicalConversionEventInput,
  CreativeLintRequest,
  PlatformDestination,
} from "@ados/schemas";

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Section 7: The AdOS Core MCP Tool Registry (All 5 Core Tools)
 */
export const ADOS_MCP_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: "ados_lint_conversion",
    description:
      "Pre-flight validation for conversion payloads. Validates PII formats (E.164 phone, email), evaluates consent routing, and calculates predicted Event Match Quality (EMQ 0.0-10.0) without dispatching data.",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description:
            "Canonical AdOS conversion event object (event_name, event_id, value, currency, user_data, click_context, consent, destinations)",
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "ados_dispatch_conversion",
    description:
      "Dispatches a conversion event across target ad networks through the AdOS gateway with policy, consent, circuit breaker, and deduplication window enforcement.",
    inputSchema: {
      type: "object",
      properties: {
        event_name: { type: "string" },
        event_id: { type: "string" },
        timestamp: { type: "integer" },
        value: { type: "number" },
        currency: { type: "string" },
        order_id: { type: "string" },
        environment: { type: "string", enum: ["production", "staging", "development"] },
        user_data: { type: "object" },
        click_context: { type: "object" },
        consent: { type: "object" },
        destinations: {
          type: "array",
          items: { type: "string", enum: ["meta", "google", "tiktok", "reddit"] },
        },
      },
      required: ["event_name", "event_id", "user_data", "destinations"],
    },
  },
  {
    name: "ados_mutate_budget",
    description:
      "Mutates campaign or ad set budgets within safety guardrails (<=15% increase limit, daily spend caps, protected campaign blacklists). Fails with remediation context if out of bounds.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["meta", "google", "tiktok", "reddit"] },
        account_id: { type: "string" },
        campaign_id: { type: "string" },
        current_daily_budget_micros: { type: "integer" },
        new_daily_budget_micros: { type: "integer" },
        rationale: { type: "string" },
        campaign_tags: { type: "array", items: { type: "string" } },
        dry_run: { type: "boolean" },
      },
      required: ["platform", "account_id", "campaign_id", "new_daily_budget_micros", "rationale"],
    },
  },
  {
    name: "ados_lint_creative",
    description:
      "Performs pre-flight inspection of a BYO-storage asset URL against destination ad network creative guidelines (aspect ratios, durations, and headline/body character limits).",
    inputSchema: {
      type: "object",
      properties: {
        asset_url: { type: "string" },
        media_type: { type: "string", enum: ["image", "video"] },
        width: { type: "integer" },
        height: { type: "integer" },
        duration_seconds: { type: "number" },
        target_placements: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "meta_reels",
              "meta_feed",
              "tiktok_feed",
              "google_pmax",
              "youtube_shorts",
              "reddit_feed",
            ],
          },
        },
        copy_variations: {
          type: "object",
          properties: {
            headlines: { type: "array", items: { type: "string" } },
            bodies: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["asset_url", "media_type", "target_placements"],
    },
  },
  {
    name: "ados_query_signal_health",
    description:
      "Fetches real-time signal diagnostics, rolling EMQ match quality scores, email density ratios, and active outage circuit breaker / quarantine states across ad platforms.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        platform: { type: "string", enum: ["meta", "google", "tiktok", "reddit"] },
        lookback_hours: { type: "integer", default: 24 },
      },
      required: ["account_id", "platform"],
    },
  },
];

export async function executeAdOSMcpTool(
  gateway: AdOSGateway,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }>; structuredResult: unknown }> {
  switch (toolName) {
    case "ados_lint_conversion": {
      const payload = (args["payload"] ?? args) as CanonicalConversionEventInput;
      const report = gateway.lintConversion(payload);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        structuredResult: report,
      };
    }

    case "ados_dispatch_conversion": {
      const payload = args as unknown as CanonicalConversionEventInput;
      const result = await gateway.dispatchConversion(payload);
      return {
        isError: result.status === "QUARANTINED",
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredResult: result,
      };
    }

    case "ados_mutate_budget": {
      const payload = args as unknown as BudgetMutationRequest;
      const result = await gateway.mutateBudget(payload);
      return {
        isError: !result.guardrail_evaluation.approved,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredResult: result,
      };
    }

    case "ados_lint_creative": {
      const payload = args as unknown as CreativeLintRequest;
      const report = gateway.lintCreative(payload);
      return {
        isError: !report.valid,
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        structuredResult: report,
      };
    }

    case "ados_query_signal_health": {
      const accountId = String(args["account_id"] ?? "default");
      const platform = (args["platform"] ?? "meta") as PlatformDestination;
      const lookbackHours = Number(args["lookback_hours"] ?? 24);
      const report = await gateway.querySignalHealth(accountId, platform, lookbackHours);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        structuredResult: report,
      };
    }

    default:
      throw new Error(`Unknown AdOS MCP tool: ${toolName}`);
  }
}
