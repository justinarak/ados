# AdOS (Ad Operating System)

**AdOS** is an open-core, developer-native runtime engine, narrow-waist API proxy, first-party Tag Gateway, and **Model Context Protocol (MCP)** server for programmatic advertising infrastructure.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the complete system topology, four-quadrant specification, deduplication contracts, statistical outage circuit breakers, and unified role granularity schemas.

## Monorepo Packages

| Package | Description |
| :--- | :--- |
| [`@ados/schemas`](./packages/schemas) | Canonical Zod contracts (`ConsentEnvelope`, `CanonicalConversionEvent`, `BudgetMutationRequest`, `CreativeLintRequest`, `GuardrailPolicy`, `CDMRecord`) & deterministic UUIDv7/UUIDv5 generators. |
| [`@ados/state`](./packages/state) | Pluggable BYO-Infra storage and telemetry drivers (`StateDriver`, `QuarantineBufferDriver`, `TelemetryDriver`) with In-Memory, Redis, and Cloudflare KV drivers, consent-gated session stitching, and GDPR Art. 17 cross-platform purge. |
| [`@ados/edge`](./packages/edge) | First-party Edge Runtime (Cloudflare Worker) for Safari ITP cookie hydration, click-ID extraction (`_fbp`, `_fbc`, `gclid`, `ttclid`, `rdt_cid`), `Sec-GPC: 1` header sniffing, and first-party Tag Gateway routing. |
| [`@ados/adapters`](./packages/adapters) | Downstream platform drivers for **Meta CAPI (v21+)**, **Google Ads Enhanced Conversions**, **TikTok Events API**, and **Reddit CAPI v3** with window-aware ($T > 48\text{h}$) backfill suppression. |
| [`@ados/gateway`](./packages/gateway) | Core Narrow-Waist Hono HTTP Engine: Two-Sided Token Broker, Unified Role Granularity & Blast-Radius Guardrails, Pre-Flight PII Canonicalizer (E.164, SHA-256) & EMQ Scorer, Creative Spec Linter, Statistical Outage Circuit Breaker, and Full-Duplex Wire Logger. |
| [`@ados/mcp-server`](./packages/mcp-server) | Native Model Context Protocol (MCP) server exposing `ados_lint_conversion`, `ados_dispatch_conversion`, `ados_mutate_budget`, `ados_lint_creative`, and `ados_query_signal_health`. |
| [`@ados/sdk`](./packages/sdk) | Unified TypeScript client library for interacting with the AdOS Gateway. |

## Quickstart

```bash
pnpm install
pnpm build
pnpm test
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
