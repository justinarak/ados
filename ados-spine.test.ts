import { describe, expect, it } from "vitest";
import {
  computeAudienceDelta,
  deriveDeterministicDedupId,
  generateUuidV7,
  resolveEffectiveConsent,
} from "./packages/schemas/src/index.js";
import { InMemoryStateDriver } from "./packages/state/src/index.js";
import { handleEdgeRequest } from "./packages/edge/src/index.js";
import {
  AdOSGateway,
  EncryptedTokenVault,
  createGatewayApp,
  isRoleAuthorizedForScope,
  normalizeEmail,
  normalizePhoneE164,
} from "./packages/gateway/src/index.js";
import { ADOS_MCP_TOOLS, executeAdOSMcpTool } from "./packages/mcp-server/src/index.js";

describe("AdOS Phase 1 Core Spine", () => {
  describe("1. @ados/schemas & Consent / Identity Invariants", () => {
    it("generates valid time-ordered UUIDv7 and deterministic UUIDv5 dedup IDs", () => {
      const uuidV7 = generateUuidV7(1776092400000);
      expect(uuidV7).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );

      const dedup1 = deriveDeterministicDedupId("Purchase", "ORD-99182", "tenant_a");
      const dedup2 = deriveDeterministicDedupId("purchase ", " ORD-99182 ", "tenant_a");
      const dedupDifferent = deriveDeterministicDedupId("AddToCart", "ORD-99182", "tenant_a");

      expect(dedup1).toBe(dedup2);
      expect(dedup1).not.toBe(dedupDifferent);
    });

    it("enforces Global Privacy Control (Sec-GPC: 1) auto-inheritance on ConsentEnvelope", () => {
      const consent = resolveEffectiveConsent({
        ad_storage: "granted",
        ad_user_data: "granted",
        ad_personalization: "granted",
        gpc_detected: true,
      });

      expect(consent.gpc_detected).toBe(true);
      expect(consent.ad_personalization).toBe("denied");
      expect(consent.limited_data_use).toBe(true);
      expect(consent.ldu_jurisdiction).toEqual({ country: 1, state: 1000 });
    });

    it("computes local state audience deltas (S_target \\ S_synced)", () => {
      const target = ["hash_a", "hash_b", "hash_c"];
      const synced = ["hash_b", "hash_d"];
      const delta = computeAudienceDelta(target, synced);

      expect(delta.toAdd).toEqual(["hash_a", "hash_c"]);
      expect(delta.toRemove).toEqual(["hash_d"]);
      expect(delta.unchangedCount).toBe(1);
    });
  });

  describe("2. @ados/edge & @ados/state Ephemeral Session Stitching", () => {
    it("hydrates Safari ITP first-party cookies, extracts click IDs, and stitches session onto server checkout", async () => {
      const stateDriver = new InMemoryStateDriver();
      const gateway = new AdOSGateway({ stateDriver });

      // Step 1: Browser lands on @ados/edge with fbclid & gclid and granted consent
      const edgeReq = new Request(
        "https://data.brand.com/ados/collect?fbclid=IwAR12345&gclid=EAIaIQobChMI99&ad_storage=granted&ad_user_data=granted&ad_personalization=granted",
        {
          headers: {
            cookie: "_fbp=fb.1.1700000000.998877",
          },
        }
      );

      const edgeRes = await handleEdgeRequest(edgeReq, {
        stateDriver,
        cookieDomain: ".brand.com",
      });
      expect(edgeRes.status).toBe(200);
      const edgeData = (await edgeRes.json()) as {
        ados_session_id: string;
        click_context: { fbc: string; gclid: string; fbp: string };
      };

      expect(edgeData.ados_session_id).toBeTruthy();
      expect(edgeData.click_context.fbc).toMatch(/^fb\.1\.\d+\.IwAR12345$/);
      expect(edgeData.click_context.gclid).toBe("EAIaIQobChMI99");
      expect(edgeRes.headers.get("set-cookie")).toContain("ados_session_id=");
      expect(edgeRes.headers.get("set-cookie")).toContain("HttpOnly");

      // Step 2: Downstream server purchase arrives minutes later with only `ados_session_id` + raw PII
      const dispatchResult = await gateway.dispatchConversion({
        event_name: "Purchase",
        event_id: deriveDeterministicDedupId("Purchase", "ORD-1001"),
        value: 149.99,
        currency: "USD",
        order_id: "ORD-1001",
        user_data: {
          email: "  Alice.Smith@Example.com ",
          phone: "(415) 555-2671",
          client_ip_address: "203.0.113.42",
          client_user_agent: "Mozilla/5.0",
        },
        click_context: {
          ados_session_id: edgeData.ados_session_id,
        },
        consent: {
          ad_storage: "granted",
          ad_user_data: "granted",
          ad_personalization: "granted",
        },
        destinations: ["meta", "google"],
      });

      expect(dispatchResult.status).toBe("DISPATCHED");
      expect(dispatchResult.session_stitched).toBe(true);
      expect(dispatchResult.emq_report.emq_score).toBeGreaterThanOrEqual(9.0);
      expect(dispatchResult.emq_report.grade).toBe("EXCELLENT");
      expect(dispatchResult.emq_report.canonical_event.click_context.gclid).toBe("EAIaIQobChMI99");
      expect(dispatchResult.emq_report.canonical_event.click_context.fbp).toBe(
        "fb.1.1700000000.998877"
      );
      expect(dispatchResult.audit_receipts).toHaveLength(2);
    });

    it("purges cached click IDs immediately if downstream server event has ad_user_data='denied'", async () => {
      const stateDriver = new InMemoryStateDriver();
      const gateway = new AdOSGateway({ stateDriver });

      const edgeReq = new Request(
        "https://data.brand.com/ados/collect?gclid=GCLID_SECRET_123&ad_storage=granted&ad_user_data=granted"
      );
      const edgeRes = await handleEdgeRequest(edgeReq, { stateDriver });
      const { ados_session_id } = (await edgeRes.json()) as { ados_session_id: string };

      // Verify cached before denial
      expect(await stateDriver.get(`ados:session:${ados_session_id}`)).not.toBeNull();

      // Downstream checkout arrives with ad_user_data = "denied"
      const result = await gateway.dispatchConversion({
        event_name: "Purchase",
        event_id: "evt_denied_join_1",
        value: 85.0,
        currency: "USD",
        user_data: {
          email: "user@example.com",
        },
        click_context: {
          ados_session_id,
        },
        consent: {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
        },
        destinations: ["google", "meta"],
      });

      expect(result.purged_due_to_consent_denial).toBe(true);
      expect(result.session_stitched).toBe(false);
      // Session cache must be deleted from StateDriver
      expect(await stateDriver.get(`ados:session:${ados_session_id}`)).toBeNull();

      // Google receives Cookieless Modeling Ping; Meta is suppressed
      const googleDecision = result.adapter_decisions.find((d) => d.platform === "google");
      const metaDecision = result.adapter_decisions.find((d) => d.platform === "meta");
      expect(googleDecision?.status).toBe("COOKIELESS_MODELING_PING");
      expect(metaDecision?.status).toBe("SUPPRESSED_CONSENT");
    });
  });

  describe("3. Platform Deduplication & Window-Aware Backfill Suppression (T > 48h)", () => {
    it("suppresses Meta & TikTok egress at T = 60h when client_pixel_fired=true while allowing Google Ads (90d window)", async () => {
      const gateway = new AdOSGateway();
      const t0 = 1776000000;
      const tPlus60Hours = t0 + 60 * 3600; // 60 hours later (> 48h Meta/TikTok window, < 90d Google window)

      const result = await gateway.dispatchConversion(
        {
          event_name: "Purchase",
          event_id: "evt_backfill_60h",
          timestamp: t0,
          value: 199.0,
          currency: "USD",
          order_id: "ORD-60H",
          user_data: {
            email: "backfill@example.com",
            phone: "+14155550199",
          },
          click_context: {
            gclid: "gclid_60h",
            fbc: "fb.1.1776000000.fbclid_60h",
            ttclid: "ttclid_60h",
            client_pixel_fired: true,
          },
          consent: {
            ad_storage: "granted",
            ad_user_data: "granted",
            ad_personalization: "granted",
          },
          destinations: ["meta", "tiktok", "google"],
        },
        tPlus60Hours
      );

      expect(result.status).toBe("DISPATCHED");
      const meta = result.adapter_decisions.find((d) => d.platform === "meta")!;
      const tiktok = result.adapter_decisions.find((d) => d.platform === "tiktok")!;
      const google = result.adapter_decisions.find((d) => d.platform === "google")!;

      expect(meta.status).toBe("SUPPRESSED_DEDUP_WINDOW");
      expect(tiktok.status).toBe("SUPPRESSED_DEDUP_WINDOW");
      expect(google.status).toBe("DISPATCHED");
    });
  });

  describe("4. Statistical Outage Circuit Breaker (3 Failure Modes)", () => {
    it("quarantines >5-sigma conversion value anomalies (cents-vs-dollars bug) and staging traffic", async () => {
      const gateway = new AdOSGateway();

      // Cents-vs-dollars bug: $150.00 emitted as 15000.00 (> 120 + 5*80 = 520)
      const centsBugResult = await gateway.dispatchConversion({
        event_name: "Purchase",
        event_id: "evt_cents_bug",
        value: 15000,
        currency: "USD",
        user_data: { email: "buyer@example.com" },
        consent: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
        destinations: ["meta"],
      });

      expect(centsBugResult.status).toBe("QUARANTINED");
      expect(centsBugResult.outage_decision.quarantine_reason).toBe("VALUE_ANOMALY_5SIGMA");

      // Staging environment leak
      const stagingLeakResult = await gateway.dispatchConversion({
        event_name: "Purchase",
        event_id: "evt_staging_leak",
        value: 50,
        environment: "staging",
        user_data: { email: "qa@example.com" },
        consent: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
        destinations: ["meta"],
      });

      expect(stagingLeakResult.status).toBe("QUARANTINED");
      expect(stagingLeakResult.outage_decision.quarantine_reason).toBe("ENVIRONMENT_MISMATCH");
      expect(await gateway.quarantineBuffer.size()).toBe(2);
    });

    it("trips circuit breaker (OPEN_AUTO_HOLD) when rolling email presence ratio collapses", async () => {
      const gateway = new AdOSGateway({
        circuitBreakerConfig: {
          minEventsForDensityCheck: 5,
          minEmailDensityRatio: 0.5,
        },
      });

      // Dispatch 5 bare conversions without email
      let lastResult;
      for (let i = 1; i <= 5; i++) {
        lastResult = await gateway.dispatchConversion({
          event_name: "Purchase",
          event_id: `evt_bare_${i}`,
          value: 100,
          user_data: {
            client_ip_address: "198.51.100.1",
          },
          consent: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
          destinations: ["meta"],
        });
      }

      expect(lastResult?.status).toBe("QUARANTINED");
      expect(lastResult?.outage_decision.circuit_state).toBe("OPEN_AUTO_HOLD");
      expect(lastResult?.outage_decision.quarantine_reason).toBe("EMQ_DENSITY_DROP");
    });
  });

  describe("5. Auth Vault, Unified Role Granularity & Blast-Radius Guardrails", () => {
    it("enforces asymmetric role permissions (pause vs activate) and encrypts God Tokens with AES-256-GCM", () => {
      expect(isRoleAuthorizedForScope("agent:pacing-optimizer", "campaigns.status:pause")).toBe(
        true
      );
      expect(isRoleAuthorizedForScope("agent:pacing-optimizer", "campaigns.status:activate")).toBe(
        false
      );
      expect(isRoleAuthorizedForScope("agent:campaign-builder", "campaigns.entity:create_draft")).toBe(
        true
      );
      expect(isRoleAuthorizedForScope("agent:campaign-builder", "campaigns.status:activate")).toBe(
        false
      );
      expect(isRoleAuthorizedForScope("human:growth-governor", "campaigns.status:activate")).toBe(
        true
      );

      const vault = new EncryptedTokenVault("super-secret-master-key-2026");
      const rawGodToken = "EAAGNO_META_SYSTEM_USER_GOD_TOKEN_991823";
      const encrypted = vault.encryptToken(rawGodToken);
      expect(encrypted).not.toContain(rawGodToken);
      expect(vault.decryptToken(encrypted)).toBe(rawGodToken);
    });

    it("approves within-bound budget mutations (<=15%) and blocks >15% hikes, cap breaches, and protected campaigns", async () => {
      const gateway = new AdOSGateway();

      // 1. Valid +10% increase ($1,000 -> $1,100)
      const approved = await gateway.mutateBudget({
        platform: "meta",
        account_id: "act_1029384756",
        campaign_id: "cmp_prospecting_q4",
        current_daily_budget_micros: 1_000_000_000,
        new_daily_budget_micros: 1_100_000_000,
        rationale: "ROAS exceeded target by 22% over trailing 7 days",
        campaign_tags: [],
        dry_run: false,
      });
      expect(approved.guardrail_evaluation.approved).toBe(true);
      expect(approved.guardrail_evaluation.calculated_delta_percent).toBe(10);
      expect(approved.mutation_result?.status).toBe("MUTATED");

      // 2. Rejected +25% hike (> 15% max_increase_percent_per_call)
      const rejectedDelta = await gateway.mutateBudget({
        platform: "meta",
        account_id: "act_1029384756",
        campaign_id: "cmp_prospecting_q4",
        current_daily_budget_micros: 1_000_000_000,
        new_daily_budget_micros: 1_250_000_000,
        rationale: "Aggressive scale attempt by autonomous agent",
        campaign_tags: [],
        dry_run: false,
      });
      expect(rejectedDelta.guardrail_evaluation.approved).toBe(false);
      expect(rejectedDelta.guardrail_evaluation.violations[0]).toContain(
        "exceeds max_increase_percent_per_call"
      );

      // 3. Rejected protected evergreen campaign
      const rejectedProtected = await gateway.mutateBudget({
        platform: "meta",
        account_id: "act_1029384756",
        campaign_id: "cmp_core_brand_evergreen_01",
        current_daily_budget_micros: 1_000_000_000,
        new_daily_budget_micros: 1_050_000_000,
        rationale: "Attempting to modify core brand evergreen campaign",
        campaign_tags: [],
        dry_run: false,
      });
      expect(rejectedProtected.guardrail_evaluation.approved).toBe(false);
      expect(rejectedProtected.guardrail_evaluation.violations[0]).toContain(
        "blocked_campaign_ids"
      );
    });
  });

  describe("6. @ados/mcp-server (All 5 Core Tools) & Hono HTTP Gateway", () => {
    it("exposes all 5 MCP tools and executes them accurately", async () => {
      expect(ADOS_MCP_TOOLS.map((t) => t.name)).toEqual([
        "ados_lint_conversion",
        "ados_dispatch_conversion",
        "ados_mutate_budget",
        "ados_lint_creative",
        "ados_query_signal_health",
      ]);

      const gateway = new AdOSGateway();

      // Tool 4: ados_lint_creative catches aspect ratio and Google PMax headline length violations
      const creativeRes = await executeAdOSMcpTool(gateway, "ados_lint_creative", {
        asset_url: "https://cdn.brand.com/creatives/summer_square.mp4",
        media_type: "video",
        width: 1080,
        height: 1080, // 1:1 square instead of 9:16 vertical for Reels
        duration_seconds: 15,
        target_placements: ["meta_reels", "google_pmax"],
        copy_variations: {
          headlines: ["This headline is way over the thirty character limit for PMax"],
          bodies: ["Short valid body copy."],
        },
      });
      expect(creativeRes.isError).toBe(true);

      // Tool 5: ados_query_signal_health
      const healthRes = await executeAdOSMcpTool(gateway, "ados_query_signal_health", {
        account_id: "act_1029384756",
        platform: "meta",
        lookback_hours: 24,
      });
      expect(healthRes.isError).toBeUndefined();

      // Hono HTTP API smoke check
      const app = createGatewayApp(gateway);
      const httpRes = await app.request("/healthz");
      expect(httpRes.status).toBe(200);

      // PII normalizer unit check
      expect(normalizeEmail("  Test@Domain.COM ").normalized).toBe("test@domain.com");
      expect(normalizePhoneE164("(415) 555-2671").e164).toBe("+14155552671");
    });
  });
});
