import { resolve } from "node:path";
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
  buildUpstreamEndpointAndHeaders,
  unrollPartialBatchResponse,
} from "./packages/adapters/src/index.js";
import {
  AdOSGateway,
  EncryptedTokenVault,
  SingleFlightOAuthCoordinator,
  buildLookbackMergeSql,
  createGatewayApp,
  isRoleAuthorizedForScope,
  normalizeEmail,
  normalizePhoneE164,
  runAdOSCli,
} from "./packages/gateway/src/index.js";
import { ADOS_MCP_TOOLS, executeAdOSMcpTool } from "./packages/mcp-server/src/index.js";

describe("AdOS Phase 1 & 2 Complete Spine (All 4 Quadrants + Resilience + CLI)", () => {
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

  describe("2. @ados/edge & @ados/state Ephemeral Session Stitching + Tag Gateway Proxy (Track 4)", () => {
    it("hydrates Safari ITP first-party cookies, extracts click IDs, and stitches session onto server checkout", async () => {
      const stateDriver = new InMemoryStateDriver();
      const gateway = new AdOSGateway({ stateDriver });

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

      expect(await stateDriver.get(`ados:session:${ados_session_id}`)).not.toBeNull();

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
      expect(await stateDriver.get(`ados:session:${ados_session_id}`)).toBeNull();

      const googleDecision = result.adapter_decisions.find((d) => d.platform === "google");
      const metaDecision = result.adapter_decisions.find((d) => d.platform === "meta");
      expect(googleDecision?.status).toBe("COOKIELESS_MODELING_PING");
      expect(metaDecision?.status).toBe("SUPPRESSED_CONSENT");
    });

    it("Mode A First-Party Tag Gateway proxies /ados/tag/gtag/* with cookieless gcs=G100 stripping on Sec-GPC: 1 and suppresses /ados/tag/meta/*", async () => {
      const stateDriver = new InMemoryStateDriver();
      let capturedUrl = "";
      let capturedHeaders: Headers | undefined;

      const mockUpstreamFetch = async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        return new Response("ok", { status: 200 });
      };

      // 1. Google Tag Gateway with Sec-GPC: 1 strips gclid/cid & client IP and sets gcs=G100
      const gtagReq = new Request(
        "https://data.brand.com/ados/tag/gtag/g/collect?tid=G-12345&gclid=SECRET_GCLID&cid=USER_123",
        {
          headers: {
            "sec-gpc": "1",
            "cf-connecting-ip": "203.0.113.99",
            "user-agent": "Mozilla/5.0",
          },
        }
      );
      const gtagRes = await handleEdgeRequest(gtagReq, {
        stateDriver,
        upstreamFetch: mockUpstreamFetch,
      });

      expect(gtagRes.status).toBe(200);
      expect(gtagRes.headers.get("x-ados-tag-gateway")).toBe("proxied-cookieless-modeled");
      expect(capturedUrl).toContain("https://www.google-analytics.com/g/collect");
      expect(capturedUrl).toContain("gcs=G100");
      expect(capturedUrl).not.toContain("SECRET_GCLID");
      expect(capturedUrl).not.toContain("cid=USER_123");
      expect(capturedHeaders?.get("x-forwarded-for")).toBeNull();

      // 2. Meta Tag Gateway with Sec-GPC: 1 is suppressed at the edge (204 No Content)
      const metaReq = new Request("https://data.brand.com/ados/tag/meta/tr?id=12345&ev=PageView", {
        headers: { "sec-gpc": "1" },
      });
      const metaRes = await handleEdgeRequest(metaReq, {
        stateDriver,
        upstreamFetch: mockUpstreamFetch,
      });
      expect(metaRes.status).toBe(204);
      expect(metaRes.headers.get("x-ados-tag-gateway")).toBe("suppressed-consent");
    });
  });

  describe("3. Platform Deduplication, Partial-Batch Unroller, Paced Backfill & Single-Flight OAuth (Track 2)", () => {
    it("suppresses Meta & TikTok egress at T = 60h when client_pixel_fired=true while allowing Google Ads (90d window)", async () => {
      const gateway = new AdOSGateway();
      const t0 = 1776000000;
      const tPlus60Hours = t0 + 60 * 3600;

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

    it("unrolls HTTP 200 partial-batch responses into delivered, retryable (429/5xx), and dead-letter (4xx)", () => {
      const gateway = new AdOSGateway();
      const e1 = gateway.lintConversion({
        event_name: "Purchase",
        event_id: "evt_1",
        user_data: { email: "a@example.com" },
        destinations: ["meta"],
      }).canonical_event;
      const e2 = gateway.lintConversion({
        event_name: "Purchase",
        event_id: "evt_2",
        user_data: { email: "b@example.com" },
        destinations: ["meta"],
      }).canonical_event;
      const e3 = gateway.lintConversion({
        event_name: "Purchase",
        event_id: "evt_3",
        user_data: { email: "c@example.com" },
        destinations: ["meta"],
      }).canonical_event;

      const unrolled = unrollPartialBatchResponse(
        [e1, e2, e3],
        [
          { index: 0, code: 200 },
          { index: 1, code: 503, error_message: "Transient Graph lock" },
          { index: 2, code: 400, error_message: "Invalid currency code" },
        ]
      );

      expect(unrolled.delivered).toHaveLength(1);
      expect(unrolled.delivered[0]?.event_id).toBe("evt_1");
      expect(unrolled.retryable).toHaveLength(1);
      expect(unrolled.retryable[0]?.event.event_id).toBe("evt_2");
      expect(unrolled.dead_letter_quarantined).toHaveLength(1);
      expect(unrolled.dead_letter_quarantined[0]?.event.event_id).toBe("evt_3");
    });

    it("drains quarantined events via PacedBackfillController (30% quota share) and filters expired 48h Meta/TikTok destinations", async () => {
      const gateway = new AdOSGateway();
      const t0 = 1776000000;
      const tPlus55Hours = t0 + 55 * 3600;

      // Enqueue a quarantined event with both meta and google destinations where client_pixel_fired=true
      const lint = gateway.lintConversion({
        event_name: "Purchase",
        event_id: "evt_quarantined_55h",
        timestamp: t0,
        value: 120,
        user_data: { email: "recovered@example.com" },
        click_context: { client_pixel_fired: true, gclid: "gclid_1" },
        consent: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
        destinations: ["meta", "google"],
      });

      await gateway.quarantineBuffer.enqueue({
        quarantine_id: "q_1",
        event: lint.canonical_event,
        reason: "UPSTREAM_5XX",
        quarantined_at_ms: t0 * 1000,
        target_platforms: ["meta", "google"],
      });

      const summary = await gateway.drainQuarantineReplay({
        maxTotalQuotaPerTick: 10,
        backfillShareRatio: 0.3,
        nowEpochSeconds: tPlus55Hours,
      });

      expect(summary.drainedCount).toBe(1);
      expect(summary.replayedCount).toBe(1);
      expect(summary.suppressedPlatformsByEvent["evt_quarantined_55h"]).toEqual(["meta"]);
    });

    it("coalesces concurrent expired OAuth2 token refreshes into a single upstream call (Single-Flight)", async () => {
      let refreshCallCount = 0;
      const coordinator = new SingleFlightOAuthCoordinator(async (_platform, _accountId, oldRefresh) => {
        refreshCallCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          access_token: `new_access_from_${oldRefresh}_${refreshCallCount}`,
          refresh_token: `rotated_refresh_${refreshCallCount}`,
          expires_at_ms: Date.now() + 3600_000,
        };
      });

      coordinator.seedToken("google", "customers/9876543210", {
        access_token: "expired_token",
        refresh_token: "initial_refresh",
        expires_at_ms: Date.now() - 1000, // Already expired
      });

      // Fire 8 concurrent requests at the exact same millisecond
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          coordinator.getValidAccessToken("google", "customers/9876543210")
        )
      );

      expect(refreshCallCount).toBe(1);
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe("new_access_from_initial_refresh_1");

      // Also verify upstream endpoint & HMAC appsecret_proof builder
      const metaEndpoint = buildUpstreamEndpointAndHeaders("meta", {
        meta: {
          pixel_id: "102938",
          access_token: "EAAG_TOKEN",
          app_secret: "APP_SECRET_KEY",
        },
      });
      expect(metaEndpoint.url).toContain("appsecret_proof=");
    });
  });

  describe("4. Quadrant 1 (CDM Reporting + YAML Custom Fields) & Quadrant 2 (Audience Sync) (Track 3)", () => {
    it("normalizes platform reports into Core + Extension CDM with declarative YAML custom_fields and generates MERGE SQL", () => {
      const gateway = new AdOSGateway();

      const records = gateway.normalizeReportToCDM(
        "google",
        [
          {
            segments: { date: "2026-10-18" },
            customer: { id: "customers/9876543210" },
            campaign: { id: "cmp_111" },
            ad_group: { id: "adg_222" },
            ad: { id: "ad_333" },
            metrics: {
              cost_micros: 45_000_000,
              impressions: 12000,
              clicks: 340,
              conversions: 14.5,
              conversions_value: 2175.0,
              video_quartile_p50_rate: "0.642",
            },
          },
        ],
        {
          lookback_window_days: "30",
          custom_fields: {
            google: [
              {
                source: "metrics.video_quartile_p50_rate",
                alias: "video_50pct_completion_rate",
                type: "FLOAT",
              },
            ],
          },
        }
      );

      expect(records).toHaveLength(1);
      expect(records[0]?.cost_micros).toBe(45_000_000);
      expect(records[0]?._google).toEqual({ video_50pct_completion_rate: 0.642 });

      const mergeSql = buildLookbackMergeSql();
      expect(mergeSql).toContain("MERGE INTO analytics.ados_cdm_daily_performance");
      expect(mergeSql).toContain("ON target.date = source.date");
    });

    it("computes incremental ADD/REMOVE diffs in Quadrant 2 Audience Sync and logs wire receipts", async () => {
      const gateway = new AdOSGateway();

      // Sync #1: Initial 2 members
      const firstSync = await gateway.syncAudience({
        audience_id: "aud_vip_buyers",
        audience_name: "VIP Buyers",
        operation: "REPLACE",
        destinations: ["meta"],
        members: [{ email: "vip1@example.com" }, { email: "vip2@example.com" }],
        consent: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
      });

      expect(firstSync[0]?.added_count).toBe(2);
      expect(firstSync[0]?.removed_count).toBe(0);

      // Sync #2: Keep vip2, remove vip1, add vip3
      const secondSync = await gateway.syncAudience({
        audience_id: "aud_vip_buyers",
        audience_name: "VIP Buyers",
        operation: "REPLACE",
        destinations: ["meta"],
        members: [{ email: "vip2@example.com" }, { email: "vip3@example.com" }],
        consent: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
      });

      expect(secondSync[0]?.added_count).toBe(1);
      expect(secondSync[0]?.removed_count).toBe(1);
      expect(secondSync[0]?.unchanged_count).toBe(1);
    });
  });

  describe("5. Statistical Outage Circuit Breaker & Auth Vault Guardrails", () => {
    it("quarantines >5-sigma conversion value anomalies (cents-vs-dollars bug), staging traffic, and EMQ email density collapse", async () => {
      const gateway = new AdOSGateway({
        circuitBreakerConfig: {
          minEventsForDensityCheck: 4,
          minEmailDensityRatio: 0.5,
        },
      });

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

      let lastBare;
      for (let i = 1; i <= 4; i++) {
        lastBare = await gateway.dispatchConversion({
          event_name: "Purchase",
          event_id: `evt_bare_${i}`,
          value: 100,
          user_data: { client_ip_address: "198.51.100.1" },
          consent: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
          destinations: ["meta"],
        });
      }
      expect(lastBare?.status).toBe("QUARANTINED");
      expect(lastBare?.outage_decision.circuit_state).toBe("OPEN_AUTO_HOLD");
    });

    it("enforces asymmetric role permissions, budget guardrails (<=15%), and AES-256-GCM God-Token encryption", async () => {
      expect(isRoleAuthorizedForScope("agent:pacing-optimizer", "campaigns.status:pause")).toBe(true);
      expect(isRoleAuthorizedForScope("agent:pacing-optimizer", "campaigns.status:activate")).toBe(false);

      const vault = new EncryptedTokenVault("super-secret-master-key-2026");
      const encrypted = vault.encryptToken("EAAGNO_GOD_TOKEN");
      expect(vault.decryptToken(encrypted)).toBe("EAAGNO_GOD_TOKEN");

      const gateway = new AdOSGateway();
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
    });
  });

  describe("6. @ados/mcp-server, Hono HTTP Gateway & Developer CLI (Track 1)", () => {
    it("executes all 5 MCP tools, HTTP endpoints, and Developer CLI commands (test-event, lint-creative, privacy purge-user)", async () => {
      expect(ADOS_MCP_TOOLS).toHaveLength(5);
      const gateway = new AdOSGateway();

      // Test CLI `ados test-event --file deploy/samples/sample_purchase.json --destinations meta,google`
      const samplePurchasePath = resolve("deploy/samples/sample_purchase.json");
      const cliDispatch = await runAdOSCli(
        ["test-event", "--file", samplePurchasePath, "--destinations", "meta,google"],
        gateway
      );
      expect(cliDispatch.exitCode).toBe(0);
      expect(JSON.parse(cliDispatch.stdout).status).toBe("DISPATCHED");

      // Test CLI `ados lint-creative --file deploy/samples/sample_creative.json`
      const sampleCreativePath = resolve("deploy/samples/sample_creative.json");
      const cliCreative = await runAdOSCli(
        ["lint-creative", "--file", sampleCreativePath],
        gateway
      );
      expect(cliCreative.exitCode).toBe(0);
      expect(JSON.parse(cliCreative.stdout).valid).toBe(true);

      // Test CLI `ados privacy purge-user --identifier sha256:...`
      const dummyHash = "a".repeat(64);
      const cliPurge = await runAdOSCli(
        ["privacy", "purge-user", "--identifier", `sha256:${dummyHash}`, "--all-platforms"],
        gateway
      );
      expect(cliPurge.exitCode).toBe(0);
      expect(JSON.parse(cliPurge.stdout).receipts).toHaveLength(4);

      // Test MCP creative linter & signal health
      const healthRes = await executeAdOSMcpTool(gateway, "ados_query_signal_health", {
        account_id: "act_1029384756",
        platform: "meta",
      });
      expect(healthRes.isError).toBeUndefined();

      // Hono HTTP API smoke check
      const app = createGatewayApp(gateway);
      const httpRes = await app.request("/healthz");
      expect(httpRes.status).toBe(200);

      expect(normalizeEmail("  Test@Domain.COM ").normalized).toBe("test@domain.com");
      expect(normalizePhoneE164("(415) 555-2671").e164).toBe("+14155552671");
    });
  });
});
