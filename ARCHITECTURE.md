# Context & Master Architecture Specification: AdOS (Ad Operating System)

## 1. Executive Summary, Core Thesis & Architectural Invariants

* **The Project:** **AdOS (Ad Operating System)** — an open-core, developer-native runtime engine, narrow-waist API proxy, first-party Tag Gateway, and Model Context Protocol (MCP) server for programmatic advertising infrastructure.
* **The Problem:** Direct integrations with fragmented ad networks (Meta Graph/CAPI, Google Ads/Enhanced Conversions & YouTube, TikTok Events API, Reddit CAPI) suffer from incompatible identity contracts, divergent deduplication windows (Meta/TikTok 48h first-in-wins/signal-merge vs. Google 90d action lookback vs. Reddit quality-density scoring), brittle OAuth lifecycles, coarse "god-mode" admin permissions, and zero runtime guardrails. Generic data movers (Fivetran, Census, Segment, Hightouch) are batch-scheduled, UI-locked, or one-way, forcing growth engineering teams to build brittle, bespoke glue code.
* **The Solution:** A unified, closed-loop runtime providing a strongly typed, observable, and governed execution layer over ad platforms without vendor lock-in.
* **The Paradigm:** Bring-Your-Own-Infrastructure (BYO-Infra) / Open-Core, with a seamless path to a Managed Cloud Proxy. AdOS ships portable pipeline logic, resilience state machines, protocol specifications, and adapter drivers (Cloudflare Workers, Docker, AWS ECS, GCP Cloud Run, Kubernetes) rather than requiring a bloated multi-tenant CDP SaaS.

### The Three Architectural Invariants

1. **The Narrow Waist Over Point-to-Point Wrappers:** Upstream systems (browsers, mobile apps, microservices, data warehouses, AI agents) interact exclusively with AdOS canonical schemas. Downstream ad platforms receive payloads tailored by platform adapters. Internal systems are decoupled from vendor API lifecycles, deprecation timelines, and payload eccentricities.
2. **Inline Execution Over Post-Hoc Audits:** Observability, Event Match Quality (EMQ) grading, statistical anomaly circuit breaking, deduplication tracking, and budget blast-radius safety checks occur **synchronously in-flight at the proxy layer**. Post-hoc warehouse assertions (e.g., dbt tests, Great Expectations, Monte Carlo) operate as lagging post-mortems that fail to prevent irreversible conversion corruption (since ad APIs lack `DELETE /conversions`) or real-time bidding algorithm degradation.
3. **Data Plane Isolation (Zero External PII Residency):** Customer PII, click IDs, and corporate platform tokens remain inside the customer's infrastructure perimeter (or strictly isolated tenant boundaries). The data plane executes locally within client-owned VPCs or edge runtimes; any optional control plane manages only telemetry metadata, policy distributions, and schema contracts.

---

## 2. The Four-Quadrant System Architecture

AdOS unifies the four distinct domains of ad engineering—spanning the **Data Plane** (Quadrants 1 & 2) and the **Action Plane** (Quadrants 3 & 4)—into a single closed loop:

```text
                    ┌─────────────────────────────────────────────────────────────────────┐
                    │                          UPSTREAM CLIENTS                           │
                    │  Browser / Mobile Apps │ Microservices │ Warehouse / dbt │ AI Agents│
                    └──────────────────────────────────┬──────────────────────────────────┘
                                                       │
                                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         THE AdOS RUNTIME GATEWAY                                        │
│                                                                                                         │
│  ┌──────────────────────────────────────────────┐    ┌──────────────────────────────────────────────┐  │
│  │       QUADRANT 1: INGESTION (Data Plane)     │    │    QUADRANT 2: AUDIENCE EGRESS (Data Plane)  │  │
│  │            (Ad APIs -> Warehouse)            │    │             (Warehouse -> Ad APIs)           │  │
│  │ - Common Data Model (CDM) for Spend/Metrics  │    │ - Customer Match & CRM segment syncs         │  │
│  │ - Core + Extension (Typed JSON-B) schema     │    │ - Local state delta sync (add/remove/purge)  │  │
│  │ - Config-as-Code YAML custom field mapping   │    │ - Consent flag mapping (TCF v2.2, DMA, GPC)  │  │
│  │ - Rolling lookback MERGE upserts (T-7/T-30d) │    │ - GDPR Art. 17 cross-platform user erasure   │  │
│  └──────────────────────────────────────────────┘    └──────────────────────────────────────────────┘  │
│                                                                                                         │
│  ┌──────────────────────────────────────────────┐    ┌──────────────────────────────────────────────┐  │
│  │     QUADRANT 3: SIGNALS / CAPI (Action Plane)│    │      QUADRANT 4: MUTATIONS (Action Plane)    │  │
│  │       (Edge / Backend -> Conversion APIs)    │    │          (Campaigns, Creative, Bids)         │  │
│  │ - 1st-Party Tag Gateway & ITP cookie extender│    │ - Unified tree (Campaign->Group->Binding)    │  │
│  │ - Session stitching (ados_session_id -> PII) │    │ - BYO-Storage Creative Spec Linter           │  │
│  │ - Pre-flight EMQ linter & dedup arbitration  │    │ - Async 6-state asset lifecycle machine      │  │
│  │ - Statistical outage breakers & paced replay │    │ - Algorithmic pacing & bid controllers       │  │
│  └──────────────────────────────────────────────┘    └──────────────────────────────────────────────┘  │
│                                                                                                         │
│  ═════════════════════════════════════════════════════════════════════════════════════════════════════  │
│                              THE NARROW WAIST: AUTH VAULT & POLICY ENGINE                               │
│   - Two-Sided Token Broker: Translates micro-scoped AdOS keys to encrypted vendor "God Tokens"          │
│   - Unified Role Granularity: Separates defensive actions (pause/decrease) from live spend activation   │
│   - Blast-Radius Guardrails: Max delta % limits (<=15%), daily spend caps, cooldowns, dry_run mode      │
│   - Full-Duplex Audit Wire: Captures outbound payload + raw vendor HTTP response + consent receipt      │
│   - AI-Native Interface: Native Model Context Protocol (MCP) tool server for governed agentic execution │
└──────────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         AD PLATFORM ADAPTERS                                            │
│         Meta Graph / CAPI  │  Google Ads / YouTube  │  TikTok Events API  │  Reddit CAPI v3  │  +More   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Quadrant 1: The Ingestion Engine (Closing the Reporting Loop)
* **The Structural Failure:** Generalist ETL tools extract ad spend on rigid 1-to-6-hour polling schedules into raw JSON schemas, ignoring that ad networks adjust historical conversions, spend attribution, and modeled metrics for up to 30–90 days in arrears.
* **The Mechanism:**
  * **Core + Extension CDM:** Enforces an invariant normalized schema across platforms (`Dimensions`: `date`, `platform`, `account_id`, `campaign_id`, `ad_group_id`, `ad_id`; `Metrics`: `cost_micros`, `currency`, `impressions`, `clicks`, `conversions`, `conversion_value`). Platform-specific metrics (e.g., Meta Frequency, Google Search Impression Share) stream into typed extension `JSON-B` objects (`_meta`, `_google`, `_tiktok`, `_reddit`).
  * **Config-as-Code Declarative Field Extraction:** Teams add unmapped platform fields via YAML declarations without fork-modifying adapter source code:
    ```yaml
    ingest:
      google_ads:
        custom_fields:
          - source: "metrics.video_quartile_p50_rate"
            alias: "video_50pct_completion_rate"
            type: "FLOAT"
    ```
  * **Lookback-Aware Upserts (`MERGE`):** Replaces destructive truncations or naive daily appends with rolling lookback window extractions (`T-7`, `T-14`, `T-30` days), emitting Arrow/Parquet/JSON-L streams or performing deterministic `MERGE` statements on primary keys (`date + platform + account_id + ad_id + placement`).

### Quadrant 2: The Audience & Identity Egress Engine
* **The Structural Failure:** Pushing user segments from warehouses to ad networks is treated as batch Reverse-ETL. Teams lack uniform canonical hashing pipelines and struggle to reconcile platform-specific consent declarations (Google Consent Mode v2, Meta Limited Data Use, TikTok DMA compliance) and GDPR Art. 17 erasure propagation.
* **The Mechanism:**
  * **Canonical Member Contract:** Accepts normalized arrays of user identifiers (`email`, `phone`, `external_id`, `mobile_advertising_id`, `postal_address`). The engine cleanses whitespace, forces lowercase normalization, maps ISO country codes, normalizes E.164 phone numbers, and applies SHA-256 / UID2 formatting.
  * **Local State Delta Computation:** Computes set differences against the previous sync state (via embedded DuckDB or `@ados/state` drivers) to avoid transmitting massive redundant lists:
    $$\Delta_{\text{egress}} = S_{\text{target}} \setminus S_{\text{synced}}$$
    Transmits only incremental `ADD` and `REMOVE` operations while respecting platform-specific bulk chunk limits.
  * **Regulatory Flag Synthesis:** Ingests regional consent parameters and translates them into downstream headers (`consent.ad_user_data = GRANTED`, `data_processing_options = ['LDU', 1, 1000]`).
  * **Cross-Platform Right to Erasure (`compliance:purge`):** A single CLI/API invocation (`ados privacy purge-user --identifier sha256:... --all-platforms`) flushes the user from ephemeral caches and synchronously removes them across Meta Custom Audiences, Google Customer Match, TikTok, and Reddit, returning an immutable compliance receipt.

### Quadrant 3: Signals & Measurement (The Edge-to-CAPI & Tag Gateway Pipeline)
* **The Structural Failure:** Edge tracking and server-side egress are disconnected. Safari ITP trims client-set cookie expiration to 24 hours or 7 days; server pipelines omit client-side context; and platforms like YouTube/Google benefit from hybrid first-party client pings paired with server-side Enhanced Conversions.
* **Three Composable Operating Modes:**
  1. **Mode A: First-Party Tag Gateway Proxy:** `@ados/edge` routes first-party subdomain paths (e.g., `data.brand.com/ados/gtag/*`, `/ados/meta/*`, `/ados/tiktok/*`) through the advertiser's own edge infrastructure (similar to Google Tag Gateway, Meta CAPI Gateway, and TikTok Events Gateway), preserving first-party cookie context and view-through/engaged-view signals for platforms like YouTube while enforcing `ConsentEnvelope` stripping rules at the edge.
  2. **Mode B: Hybrid Client + Server CAPI (Maximum EMQ):** Client-side tags and server-side conversion pipelines emit coordinated events sharing a deterministic per-event `event_id` (`ados_dedup_id`), while `@ados/edge` caches click context under a session cookie (`ados_session_id`) for server-side hydration.
  3. **Mode C: Pure Server-Side / Headless CAPI:** `@ados/edge` captures click parameters (`gclid`, `fbclid`, `ttclid`, `rdt_cid`, `_fbp`, `_fbc`) on landing, sets `HttpOnly, Secure, SameSite=Lax` first-party cookies (`ados_session_id`), and writes to the ephemeral stitcher; backend checkout services emit conversions purely server-to-server.
* **Pre-Flight EMQ Scorer:** Inspects conversion payloads synchronously in-flight before wire dispatch, evaluating weighted match-key density:
  $$\text{Score} = w_1(\text{email}) + w_2(\text{phone}) + w_3(\text{click\_id}) + w_4(\text{client\_context})$$
  Flags, enriches, or routes payloads with missing or malformed identifiers to quarantine queues before ad networks ingest low-quality signals.
* **Full-Duplex Wire Logging:** Records the outbound JSON payload alongside raw downstream HTTP status codes, headers, vendor diagnostic warnings, and a `compliance_snapshot`, streaming telemetry via OpenTelemetry (OTel) or JSON-L/Parquet to BYO storage.

### Quadrant 4: The Mutation Engine (Campaigns, Creative, Bids & Budgets)
* **The Structural Failure:** Programmatic campaign orchestration tools feature complex UIs designed for human media buyers, locking out developers and AI agents who need typed, safe, headless execution interfaces.
* **The Mechanism:**
  * **Declarative Entity Orchestration:** Normalizes divergent platform hierarchies (e.g., Meta `Campaign -> AdSet -> Ad` vs. Google `Customer -> Campaign -> AdGroup -> AssetGroup`) into a unified canonical tree: `Campaign -> TargetingGroup -> CreativeBinding`.
  * **BYO-Storage Creative Spec Linter:** Avoids hosting media files by accepting signed URLs or bucket URIs (S3, Cloudflare R2, GCS). Inspects file headers/metadata via headless validation (dimensions, aspect ratios like `9:16` vs. `1:1`, durations, bitrates) and verifies ad copy character limits prior to triggering upload pipelines.
  * **Asynchronous 6-State Asset Machine:** Tracks the lifecycle of uploaded media assets across networks:
    $$\text{QUEUED} \longrightarrow \text{UPLOADING} \longrightarrow \text{PROCESSING} \longrightarrow \text{AUDITING} \longrightarrow \text{READY} \mid \text{REJECTED}$$
    Resolves programmatically only after the network approves asset binding.
  * **Bid & Budget Pacing Controllers:** Executes programmatic budget and bid target mutations governed by the Narrow-Waist Policy Engine, supporting native `dry_run` / `validate_only` pre-flight validation.

---

## 3. Core Architectural Boundaries & Invariant Protocols

### A. Consent: Invariant Protocol Header, Never a CMP
* **Boundary:** AdOS is **not** a Consent Management Platform (CMP). It generates no cookie banners, manages no legal text, and assumes zero regulatory liability as a Data Controller (operating strictly as self-hosted software or a GDPR Art. 28 Data Processor).
* **Mechanism:** Consent is an immutable protocol header (`ConsentEnvelope`) attached to every incoming event and identity mutation.

#### The Multi-Platform Consent Translation Matrix

| Platform | Required Consent Protocol | What AdOS Translates It Into | Behavior If Consent = `denied` |
| :--- | :--- | :--- | :--- |
| **Google Ads / YouTube (EC)** | Google Consent Mode v2 | `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`: `"granted" \| "denied"` | **Cookieless Modeling Ping:** Strips all PII (`email`, `phone`, `ip`) & click IDs (`gclid`), passing only aggregate timestamp/value for Google ML conversion modeling (or drops if configured in `hard` mode). |
| **Meta CAPI** | Limited Data Use (LDU) & IAB TCF v2.2 | `data_processing_options: ["LDU"]`, `data_processing_options_country: 1`, `data_processing_options_state: 1000` or `tc_string` | Restricts attribution/optimization in regulated jurisdictions or suppresses egress entirely if `ad_user_data == "denied"`. |
| **TikTok Events API** | Limited Data Use (LDU) & TCF | `limited_data_use: true \| false` | Disables targeted ad optimization for that user or suppresses egress. |
| **Reddit CAPI v3** | Reddit LDU / Consent Flags | `opt_out: true \| false` | Suppresses user matching and retargeting optimization. |
| **US State Laws (CCPA/CPRA)** | Global Privacy Control (GPC) | Sniffs `Sec-GPC: 1` HTTP header at `@ados/edge` | Automatically enforces opt-out (`ad_personalization: "denied"`, Meta/TikTok LDU enabled) across all downstream adapters without waiting for client JS. |

* **Consent-Gated Session Joining:** If a server-side purchase event arrives with `consent.ad_user_data === "denied"`, the Gateway immediately purges (`stateDriver.del(ados_session_id)`) any cached click IDs from the ephemeral stitcher and refuses to join the browser session to the server conversion.
* **Immutable Compliance Audit Receipt:** Every wire log captures a `compliance_snapshot` (`consent_state`, `tc_string`, `gpc_detected`, `ip_anonymized`, `cmp_vendor`, `consent_timestamp`) in the customer's S3/GCS bucket to provide subpoena-ready proof of consent at the exact millisecond of egress.

### B. Identity: Ephemeral Session Stitching, Never a Stateful Graph
* **Boundary:** AdOS does **not** build a persistent, multi-year cross-device identity graph (avoiding CDP database bloat, graph traversal overhead, and GDPR Art. 17 cascading graph-deletion liability).
* **Session ID vs. Event Dedup ID Separation:**
  * **`ados_session_id` (UUIDv7 Session Key):** Minted by `@ados/edge` on landing when click IDs (`_fbp`, `_fbc`, `gclid`, `ttclid`, `rdt_cid`) are captured. Stored as a first-party `HttpOnly, Secure, SameSite=Lax` cookie and keys the **1–2 hour TTL** ephemeral cache in `@ados/state`.
  * **`ados_dedup_id` / `event_id` (Per-Event Deduplication Key):** Unique to each conversion event instance (e.g., `AddToCart` vs. `Purchase #1` vs. `Purchase #2`). Either passed from the client tag (for Hybrid Client+Server deduplication) or generated deterministically via UUIDv5/SHA-256 from `(tenant_id, event_name, order_id / transaction_id)` so retries and warehouse backfills always produce the exact same deduplication key.
* **Execution:** When a server-side conversion arrives within the 1–2h TTL window carrying `ados_session_id`, the Gateway fetches the cached click context, verifies consent, enriches the conversion's `click_context`, fans out to target adapters, and lets the session state expire cleanly.

### C. Creative: Spec Linter & State Machine, Never Media Hosting
* **Boundary:** AdOS does **not** store video blobs, host transcode clusters, or build a DAM/media library.
* **Mechanism:** Accepts signed URLs/URIs from BYO storage (S3, Cloudflare R2, GCS), performs pre-flight header/metadata linting against placement specs (`meta_reels`, `meta_feed`, `tiktok_feed`, `google_pmax`, `youtube_shorts`), and orchestrates the 6-state async binding machine.

### D. Ingestion: Core + Extension CDM, Never a Generic Scraper
* **Boundary:** AdOS does **not** build 300+ generic SaaS connectors to compete with Fivetran on CRM/ERP tables.
* **Mechanism:** Standardizes strictly on the typed Marketing CDM (`cost_micros`, `impressions`, `clicks`, `conversions`, `conversion_value`) plus declarative YAML-configured JSON-B extensions.

### E. Built-In Pipeline Engine on a Pluggable Substrate (`@ados/state`)
* **"BYO-Infra" Does Not Mean "BYO-Pipeline":** AdOS implements 100% of the hard pipeline orchestration in application code—OAuth single-flight token refresh, rate-limit token buckets, partial-batch response unrolling, statistical circuit breaking, paced backfill draining, and audience delta diffing.
* **Two Deployment Profiles via `@ados/state` Interfaces (`StateDriver`, `QuarantineBufferDriver`, `TelemetryDriver`):**
  * **Profile A (Zero-Config Single-Node / Local Default):** Uses in-memory / embedded SQLite (WAL mode) + local filesystem. Runs out-of-the-box via a single Docker container or Node process with zero external cloud dependencies.
  * **Profile B (Horizontally Scaled BYO-Infra & Managed Cloud):** Plugs into Redis / Upstash, Cloudflare KV / D1, DynamoDB, Postgres, and S3 / GCS / R2 via environment configuration without changing a single line of pipeline code.

---

## 4. Platform Idiosyncrasy, Deduplication Engine & Adapter Roadmap

```text
                       [ UNIFIED CANONICAL CONVERSION ]
               ados_dedup_id: "01946a48-73b2-7c30-9b62-fa81023a4921"
               timestamp:     1776092400 (T_0)
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
      META CAPI                 GOOGLE ADS (EC)             REDDIT CAPI v3
- Dedup Key: event_id      - Dedup Key: transaction_id - Dedup Key: conversion_id
- Window: 48 Hours         - Window: Up to 90 Days     - Window: 48 Hours
- Conflict Rule: First-In  - Conflict Rule: Action ID  - Conflict Rule: Highest-Key
  Wins (Drops 2nd payload)   reconciliation              Density Wins
```

| Platform | Dedup Key Identifier | Dedup Time Window | Tie-Breaker / Merge Logic | Lookback & Postback Limits |
| :--- | :--- | :--- | :--- | :--- |
| **Meta** (CAPI v21+) | `event_id` + `event_name` (exact match) | **48 Hours** | **First-In Wins:** Discards the second payload received. Does not merge match keys retroactively if browser fires bare event first. | 7-day default attribution window. Hard **7-day** server postback window. |
| **Google Ads & YouTube** (Enhanced Conversions) | `transaction_id` (or `order_id`) | **Conversion Window** (30–90 days) | **Action Reconciled:** Matches conversions across click parameters (`gclid`, `gbraid`, `wbraid`) or hashed PII asynchronously. | Accepted up to **55–90 days** post-click; bidding model weighting decays after 7 days. |
| **TikTok** (Events API) | `event_id` + `event` | **48 Hours** | **Signal Merged:** Merges client and server signals if `event_id` matches within the window. | Hard **7-day** postback window. |
| **Reddit** (CAPI v3) | `conversion_id` | **48 Hours** (1h batch cycles) | **Signal-Density Wins:** Evaluates payload completeness; preserves the record containing richer match keys. | Hard **7-day** postback window (`event_at`). |

### AdOS Resolution Rules
1. **Deterministic Key Mapping:** Maps `ados_dedup_id` (`event_id`) automatically to Meta/TikTok `event_id`, Google `transaction_id`/`order_id`, and Reddit `conversion_id`.
2. **Window-Aware Egress Suppression ($T > 48\text{h}$):** If a server-side or warehouse backfill arrives at $T > 48\text{h}$ (`now - event.timestamp > 48h`) and telemetry/payload metadata (`client_pixel_fired: true`) records that an edge pixel already fired at $T_0$, AdOS **suppresses Meta and TikTok egress** to prevent double-counting after their 48h dedup windows expire, while **routing to Google Ads safely** within its 90-day window. Events older than 7 days (`> 168h`) are automatically blocked for Meta, TikTok, and Reddit to prevent hard API rejections.
3. **Payload Enrichment Priority:** For Meta, AdOS ensures edge click identifiers (`_fbp`, `_fbc`) are hydrated into the earliest possible payload to survive the "First-In Wins" rule. For Reddit, AdOS supports micro-buffering to maximize match-key density before dispatch.
4. **Inline PII Canonicalization:** Trims whitespace, lowercases emails, strips formatting from phone numbers and normalizes to E.164, normalizes postal addresses, and computes SHA-256 hashes inline prior to egress.

### 5-Tier Platform Adapter Roadmap

| Tier | Platforms | Core Technical Primitives |
| :--- | :--- | :--- |
| **Tier 1: Core Performance 4** *(Phase 1–2)* | **Meta** (Graph + CAPI v21+), **Google Ads & YouTube** (Enhanced Conv, GAQL, Tag Gateway), **TikTok** (Events API), **Reddit** (CAPI v3) | Exercises all 4 dedup models, hybrid Tag Gateway routing, and ~80% of growth media spend. |
| **Tier 2: High-Intent B2B, Visual & Search** *(Phase 3)* | **LinkedIn** (CAPI + Marketing API), **Pinterest** (CAPI v5), **Snapchat** (CAPI), **Microsoft / Bing Ads** (UET + Offline Conv), **X / Twitter** | Reuses 90% of Tier 1 CAPI/Audience schemas; adds B2B company-level attribution for LinkedIn. |
| **Tier 3: AI-Native Ad Networks** *(Strategic Wedge)* | **OpenAI** (Search/Chat Sponsored Units & Attribution), **Perplexity**, **Brave Ads** | Conversational context attribution, intent postbacks, and AI-native MCP bidding integration. |
| **Tier 4: Enterprise DSPs & Programmatic** *(Up-Market)* | **Google Marketing Platform (GMP):** CM360 (Floodlight), DV360, SA360; **The Trade Desk (TTD)** | Adds **Unified ID 2.0 (UID2)** identity transformation in `@ados/gateway` and Floodlight tag/server mapping. |
| **Tier 5: Audio, CTV/Streaming & Retail Media** | **Audio:** Spotify Ad Studio / Pixel<br>**CTV:** Roku, MNTN, Tatari, Samsung Ads<br>**Retail:** Amazon Ads (AMC / Conversions API) | Household IP (`client_ip_address` / IPv6) + Hashed Email + cross-device view-through window attribution where click IDs do not exist. |

---

## 5. The Data Outage & Backfill Orchestration Engine

When an upstream dbt model, Kafka consumer, or microservice deployment breaks, conversion events are either delayed in bulk or emitted with corrupted/missing PII. Direct ingestion by ad networks in this state permanently degrades attribution and poisons automated bidding models.

```text
                          [ INCOMING CONVERSION STREAM ]
                                        │
                                        ▼
        ┌───────────────────────────────────────────────────────────────┐
        │     1. STATISTICAL ANOMALY & CIRCUIT BREAKER MONITOR          │
        │  - Evaluates rolling 15-minute / 500-event sliding window     │
        │  - Baseline EMQ density check: (email_present / total)        │
        │  - Volume delta check: abs(current_rate - moving_avg)         │
        │  - Value bound check: flag conversion value > 5σ from mean    │
        └───────────────────────────────┬───────────────────────────────┘
                                        │
                   ┌────────────────────┴────────────────────┐
              [ HEALTHY ]                               [ ANOMALY ]
                   │                                         │
                   ▼                                         ▼
        ┌──────────────────────┐                  ┌──────────────────────────┐
        │ Immediate Wire Egress│                  │ 2. CIRCUIT BREAKER: OPEN │
        │ Normal dispatch +    │                  │ - Halt live egress       │
        │ Partial-Batch Unroll │                  │ - Route to Quarantine    │
        └──────────────────────┘                  │   Buffer (@ados/state)   │
                                                  │ - Fire P1 Telemetry Alert│
                                                  └────────────┬─────────────┘
                                                               │
                                                    [ UPSTREAM RECOVERED ]
                                                               │
                                                               ▼
                                                  ┌──────────────────────────┐
                                                  │ 3. PACED BACKFILL DRIP   │
                                                  │ - Re-hydrate match keys  │
                                                  │ - Throttle replay (30%)  │
                                                  │ - Filter >48h expired    │
                                                  └──────────────────────────┘
```

### The Four Outage Failure Modes & Built-In Mitigations

1. **Failure Mode 1: PII Dropped, Bare Conversions Dispatched (EMQ Density Collapse)**
   * *The Failure:* Order events fire (`value: 150.00, currency: "USD"`), but `user_data.email` resolves to `null` due to an upstream regression.
   * *The Problem:* Meta ingests the bare event and fails to attribute it. Because Meta's `event_id` deduplication is **First-In Wins**, re-uploading the conversion later with hydrated PII is permanently blocked.
   * *AdOS Mitigation:* The inline circuit breaker monitors a rolling window (e.g., 500 events or 15 minutes). If the email presence ratio drops below a configured threshold relative to historical baseline (e.g., `94% -> 10%`), AdOS trips the circuit breaker (`AUTO-HOLD`), halts egress, and diverts events to the **Quarantine Holding Pen** until match keys are re-hydrated.
2. **Failure Mode 2: Upstream ETL Delays & Batch Stampedes**
   * *The Failure:* An upstream pipeline stalls for 18 hours and then dumps 50,000 delayed conversions in a 10-minute burst.
   * *The Problem:* Real-time bidding algorithms (Meta Advantage+, Google Performance Max) interpret a sudden 50,000-conversion spike as an immediate demand surge and aggressively over-bid, or throttle the account with HTTP 429 rate limits.
   * *AdOS Mitigation:* The **Paced Backfill Controller** intercepts burst queues and meters out egress via an adaptive token bucket (reserving 70% of rate-limit quota for live traffic and 30% for backfill replay), preserving original historical `timestamp` (`event_time`) values and filtering out any records that crossed the 48h dedup window where client pixels already fired.
3. **Failure Mode 3: Poisoned Data Egress (Bad Conversion Multipliers / Cents-vs-Dollars Bug)**
   * *The Failure:* An upstream bug emits purchase values in cents (`15000`) instead of dollars (`150.00`), or routes `staging` traffic to production endpoints.
   * *The Problem:* Ad platforms have no `DELETE /conversions` rollback API; bidding models immediately retrain on inflated ROAS.
   * *AdOS Mitigation:* Inline value-bounding rules (quarantining any event whose `value` deviates $> 5\sigma$ from the trailing mean or exceeds `max_single_conversion_value`), synthetic canary detection, and strict `environment: "production"` tag enforcement.
4. **Failure Mode 4: HTTP 200 Partial-Batch Rejections**
   * *The Failure:* A batch request of 500 conversions returns `HTTP 200 OK`, but 15 records inside the batch failed due to transient vendor locks and 5 failed due to invalid formatting.
   * *AdOS Mitigation:* Adapter-level **Batch Response Unrollers** parse per-index vendor responses, marking successes as delivered, routing transient 5xx/429 items to the retry buffer with their original `ados_dedup_id`, and isolating malformed items in the Dead-Letter Quarantine.

---

## 6. Security, Auth Vault, Unified Role Granularity & Blast-Radius Engine

Native ad network permissions (e.g., Meta `ads_management`, Google Ads Standard/Admin) are "God Tokens" designed for human media buyers, granting broad control over campaigns, billing, and account settings. AdOS isolates these tokens inside an encrypted **Auth Vault** and exposes a **Two-Sided Token Broker** with fine-grained, cross-platform role and action granularity.

```text
              ┌────────────────────────────────────────────────────────┐
              │              INTERNAL SQUAD / AI AGENT CALL            │
              │  AdOS Scoped Key: ados_live_sec_991823ab...            │
              │  Role: "agent:pacing-optimizer"                        │
              │  Action: "campaigns.budget:increase" (act_1029384756)  │
              └───────────────────────────┬────────────────────────────┘
                                          │
                                          ▼
              ┌────────────────────────────────────────────────────────┐
              │                    AdOS AUTH BROKER                    │
              │  1. Cryptographic Key & Role Signature Validation      │
              │  2. Granular Action & Target Account Check             │
              │  3. Algorithmic Guardrail Verification:                │
              │     - delta_percent: +12% (Limit: <= 15%)     --> PASS │
              │     - new_daily:     $4,200 (Cap: $5,000)     --> PASS │
              │     - cooldown:      Last call 90m ago (>=60m)--> PASS │
              └───────────────────────────┬────────────────────────────┘
                                          │
                                          ▼ [ Approved ]
              ┌────────────────────────────────────────────────────────┐
              │                   SECURE TOKEN VAULT                   │
              │  - Envelope Decryption (AES-256-GCM)                   │
              │  - Single-Flight OAuth2 Refresh Coordinator            │
              │  - Injects Native God Token + HMAC appsecret_proof     │
              └───────────────────────────┬────────────────────────────┘
                                          │
                                          ▼
                             [ Downstream Platform Mutation ]
```

### 1. Artificial Engineering Scopes & Asymmetric Action Granularity
To make autonomous agent interaction safe, AdOS decouples **defensive / staging actions** from **live spend-expansion actions**:

* `analytics:read`: Read-only extraction of CDM costs, metrics, campaign structures, and signal health diagnostics.
* `signals:write`: Stream conversion events and CAPI payloads through the linter and deduplication engine.
* `audiences:sync`: Append or remove hashed identifiers from customer match lists.
* `compliance.consent:override`: Segregated permission required to mint or override upstream consent states.
* `compliance:purge`: Execute cross-platform GDPR Art. 17 / CCPA user erasure across ephemeral caches and audience lists.
* `creative:lint` & `creative:deploy`: Validate media specs against placement rules and upload/stage creative bindings.
* `campaigns.status:pause`: **Defensive emergency stop** — allows an agent or alert daemon to pause a bleeding campaign or ad set immediately.
* `campaigns.status:activate`: **Spend activation** — required to unpause or launch a campaign into `ACTIVE` billing state.
* `campaigns.entity:create_draft`: Allows an agent to scaffold full `Campaign -> TargetingGroup -> CreativeBinding` trees, but **hard-enforces `status: PAUSED`** at the adapter wire layer until promoted by a principal with `campaigns.status:activate`.
* `campaigns.pacing:mutate` (`budget:decrease` / `budget:increase`): Alter daily/lifetime budgets and bid multipliers within configured guardrail bounds.

### 2. Unified Cross-Platform Role Presets

| Unified AdOS Role | Assigned Scopes & Capabilities | Explicitly Blocked By Default |
| :--- | :--- | :--- |
| **`agent:analyst`** | `analytics:read`, `creative:lint` | All write, signal, audience, and mutation tools. |
| **`agent:pacing-optimizer`** | `analytics:read`, `campaigns.pacing:mutate`, `campaigns.status:pause` | **Cannot** `campaigns.status:activate` (unpause), create campaigns, or exceed YAML budget delta/cap guardrails. |
| **`agent:campaign-builder`** | `analytics:read`, `creative:lint`, `creative:deploy`, `campaigns.entity:create_draft` | **Forced into `PAUSED` state** on creation; cannot activate live spend or mutate existing active budgets. |
| **`service:signal-pipe`** | `signals:write`, `audiences:sync` | Cannot read financial/ROAS reports or mutate campaigns. |
| **`human:growth-governor`** | All scopes + `campaigns.status:activate` + manual approval authority | Subject to absolute organizational caps and full-duplex wire audit logging. |

### 3. Machine-Enforced Guardrail Schema (YAML)
Guardrails support **Tier 1 (Stateless payload bounds)** for zero-latency enforcement and **Tier 2 (Stateful read-before-write delta % and cooldown counters)** backed by `@ados/state`:

```yaml
version: "1.0"
policies:
  - id: "policy-autonomous-pacing-prod"
    description: "Guardrails for AI agent budget pacing service"
    subject: "agent:pacing-optimizer-v2"
    role: "agent:pacing-optimizer"
    allowed_scopes:
      - "campaigns.pacing:mutate"
      - "campaigns.status:pause"
      - "analytics:read"
    target_accounts:
      meta: ["act_1029384756"]
      google: ["customers/9876543210"]
      tiktok: ["adv_5544332211"]
      reddit: ["t2_99887766"]
    guardrails:
      # Tier 1: Stateless Payload Bounds (Enforced inline without external state)
      budget_bounds:
        min_daily_budget_micros: 10000000          # $10 USD Min
        absolute_daily_cap_micros: 5000000000      # $5,000 USD Max
        require_rationale_min_length: 15
      protected_entities:
        blocked_campaign_ids: ["cmp_core_brand_evergreen_01"]
        require_manual_approval_tags: ["tier1-unlimited"]
      # Tier 2: Stateful Delta & Cooldown Limits (Backed by @ados/state + Read-Before-Write)
      budget_delta_limits:
        max_increase_percent_per_call: 15.0
        max_decrease_percent_per_call: 30.0
      rate_limits:
        min_cooldown_minutes: 60
        max_mutations_per_day: 12
```

---

## 7. Model Context Protocol (MCP) & AI Integration

AdOS provides a native Model Context Protocol (`@ados/mcp-server`) implementation over `stdio` and HTTP/SSE, enabling AI agents in Cursor, Claude Code, or autonomous background daemons to interact with ad platforms safely.

### The Core AdOS MCP Tool Registry

1. **`ados_lint_conversion`**: Pre-flight validation for conversion signals. Validates payload against `CanonicalConversionEvent`, normalizes PII (E.164 phone, lowercase trimmed email), checks `ConsentEnvelope` routing consequences, and calculates predicted Event Match Quality (EMQ `0.0–10.0`) with actionable remediation warnings—without dispatching data.
2. **`ados_dispatch_conversion`**: Pushes a conversion event through the gateway. Enforces `signals:write` scope, hydrates first-party click context from `@ados/state` via `ados_session_id`, evaluates statistical circuit breakers and 48h/90d deduplication windows, applies consent transformations, and fans out across designated platform adapters (`meta`, `google`, `tiktok`, `reddit`).
3. **`ados_mutate_budget`**: Executes daily budget or bid adjustments against specified campaigns or targeting groups (`platform`, `account_id`, `campaign_id`, `current_daily_budget_micros`, `new_daily_budget_micros`, `rationale`, `dry_run`). Evaluates Tier 1 & Tier 2 blast-radius guardrails and rejects out-of-policy calls with structured remediation context.
4. **`ados_lint_creative`**: Performs pre-flight inspection of a BYO-storage asset (`asset_url`, `media_type`, `dimensions`, `duration_seconds`, `target_placements` such as `meta_reels`, `meta_feed`, `tiktok_feed`, `google_pmax`, and `copy_variations`) against destination ad network specifications before creating campaign bindings.
5. **`ados_query_signal_health`**: Retrieves live observability metrics (`account_id`, `platform`, `lookback_hours`), including rolling EMQ health grades, email/phone/click-ID match density, client-vs-server deduplication percentages, and active circuit breaker / quarantine states.

---

## 8. Competitive Differentiation & Open-Core Commercialization

### Competitive Differentiation Matrix

| Dimension | Fivetran / Airbyte | Segment / Hightouch | Stape / Native CAPI-G | Smartly.io / Skai | **AdOS (This Platform)** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Primary Domain** | Batch Ingestion (ETL) | Audience / Reverse-ETL | Edge Tagging / Pass-Through | Campaign UI Ad Ops | **Unified Ad Operating System** |
| **Execution Direction** | Inbound Only (Read-Only) | Outbound (Warehouse $\rightarrow$ API) | Outbound (Client $\rightarrow$ CAPI) | Bi-directional (UI-locked) | **Closed Loop (Read, Signal, Audience, Mutate)** |
| **Data Plane Location** | Multi-Tenant SaaS | Multi-Tenant SaaS | Cloud Container | Multi-Tenant SaaS | **VPC-Native / Self-Hosted / Edge (or Managed Cloud)** |
| **Real-Time Signal Linting** | None (Post-hoc errors) | Basic schema check | None (Pass-through) | None | **Inline EMQ Scorer & PII Canonicalizer** |
| **Outage Circuit Breakers** | None (Retries fail/halt) | Basic batch retries | None (Passes bad data) | None | **Statistical Auto-Quarantine & Paced Backfill** |
| **API Auth Architecture** | Raw OAuth / Service Accts | Raw OAuth connections | Platform Access Tokens | Enterprise SSO for Humans | **Two-Sided Token Broker & Agent Guardrails** |
| **AI Ergonomics** | None | None | None | Proprietary UI Chatbots | **Native Model Context Protocol (MCP) Server** |

### Open-Core vs. Commercial Monetization Tiers

1. **Tier 1: Open-Core Runtime (Free — Apache 2.0)**
   * **Target:** Growth engineers, platform engineers, AI agent builders.
   * **Included:** Canonical Zod schemas (`@ados/schemas`), Edge Worker & Tag Gateway (`@ados/edge`), Core Narrow-Waist Gateway (`@ados/gateway`), Memory/SQLite/Redis/KV state drivers (`@ados/state`), Core Platform Adapters (`@ados/adapters`), CLI & MCP Server (`@ados/mcp-server`).
2. **Tier 2: Managed AdOS Cloud Proxy ($500 – $3,000/mo usage-based)**
   * **Target:** Mid-market brands & performance agencies managing 10–100 client ad accounts who want a zero-infrastructure "easy button."
   * **Included:** Hosted multi-tenant Control Plane UI (`apps/control-plane`), 1-click OAuth Token Broker, CNAME managed edge Tag Gateway, hosted Redis stitcher & outage replay queues, and client EMQ health scorecards.
3. **Tier 3: Enterprise Self-Hosted VPC License ($36k – $120k/yr flat license)**
   * **Target:** Enterprises spending $20M–$100M+/yr on paid media whose CISOs forbid unhashed PII or god-tokens from leaving their VPC.
   * **Included:** Terraform/Helm VPC deployment modules, Enterprise DSP & CTV adapters (GMP/DV360/CM360, The Trade Desk UID2, Amazon AMC), Human-in-the-Loop Slack/Teams approval workflows for out-of-bounds agent budget mutations, SAML/SSO, and guaranteed adapter SLAs.

---

## 9. Monorepo Structure & Phase 1 Execution Plan

```text
ados/
├── apps/
│   ├── control-plane/             # Policy distribution, telemetry dashboard, & OAuth admin UI
│   └── docs/                      # OpenAPI specifications, SDK guides, MCP references
│
├── packages/
│   ├── schemas/                   # Zod & JSON Schema Single Sources of Truth (@ados/schemas)
│   │   ├── src/
│   │   │   ├── consent.ts         # ConsentEnvelope, GCM v2, Meta LDU, TCF v2.2, GPC contracts
│   │   │   ├── events.ts          # CanonicalConversionEvent, UserData, ClickContext, EMQ types
│   │   │   ├── audiences.ts       # Customer Match, delta operations, & GDPR purge schemas
│   │   │   ├── mutations.ts       # Campaign tree, budget mutation, creative lint, & policy YAML schemas
│   │   │   ├── cdm.ts             # Core + Extension Common Data Model for reporting
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── state/                     # Pluggable BYO-Infra Storage & Pipeline Drivers (@ados/state)
│   │   ├── src/
│   │   │   ├── interfaces.ts      # StateDriver, QuarantineBufferDriver, TelemetryDriver contracts
│   │   │   ├── memory.ts          # In-memory TTL & quarantine driver (testing & single-node default)
│   │   │   ├── redis.ts           # Redis / Upstash driver for distributed stitching & rate limits
│   │   │   ├── kv.ts              # Cloudflare KV driver for edge session stitching
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── edge/                      # First-Party Edge Runtime & Tag Gateway (@ados/edge)
│   │   ├── src/
│   │   │   ├── cookies.ts         # Safari ITP cookie hydration, HttpOnly/Secure session manager
│   │   │   ├── context.ts         # _fbp, _fbc, gclid, ttclid, rdt_cid capture & UUIDv7 stamping
│   │   │   ├── worker.ts          # Cloudflare Worker handler (Context capture + Tag Gateway proxy)
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── adapters/                  # Downstream Platform Integration Drivers (@ados/adapters)
│   │   ├── src/
│   │   │   ├── interface.ts       # PlatformAdapter contract & batch unroller types
│   │   │   ├── meta.ts            # Meta Graph / CAPI (v21+), 48h First-In-Wins dedup & LDU mapper
│   │   │   ├── google.ts          # Google Ads (Enhanced Conversions, 90d window, cookieless ping)
│   │   │   ├── tiktok.ts          # TikTok Events API, 48h Signal-Merge & LDU mapper
│   │   │   ├── reddit.ts          # Reddit CAPI v3, 48h Signal-Density resolver
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── gateway/                   # Core Narrow-Waist Engine (@ados/gateway — Hono)
│   │   ├── src/
│   │   │   ├── auth/              # Scoped Token Broker, role granularity & guardrail evaluator
│   │   │   ├── linter/            # Pre-flight PII canonicalizer (E.164, SHA-256), creative & EMQ scorer
│   │   │   ├── outage/            # Statistical anomaly circuit breaker, quarantine & paced backfill
│   │   │   ├── wire/              # Full-duplex audit logger + compliance snapshot emitter
│   │   │   ├── app.ts             # Hono HTTP application & route handlers
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── mcp-server/                # Model Context Protocol Server (@ados/mcp-server)
│   │   ├── src/
│   │   │   ├── tools.ts           # All 5 core MCP tools (lint/dispatch conversion, mutate budget, etc.)
│   │   │   └── index.ts           # MCP Server stdio / transport entrypoint
│   │   └── package.json
│   │
│   └── sdk/                       # Unified TypeScript Client Library (@ados/sdk)
│
├── deploy/
│   ├── terraform/                 # VPC modules for AWS (ECS/SQS) and GCP (CloudRun/PubSub)
│   ├── helm/                      # Kubernetes charts for self-hosted data plane
│   └── docker-compose.yml         # Local development sandbox
│
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── LICENSE                        # Apache 2.0 (Core Engine)
└── README.md
```

### Phase 1 Implementation Spine (Immediate Build Target)
1. **`@ados/schemas`**: Strict Zod schemas for `ConsentEnvelope`, `CanonicalConversionEvent`, `BudgetMutationRequest`, `CreativeLintRequest`, `GuardrailPolicy`, and `CDMRecord`, plus deterministic UUIDv7 (`ados_session_id`) and UUIDv5/SHA-256 (`ados_dedup_id`) utilities.
2. **`@ados/state`**: Pluggable `StateDriver`, `QuarantineBufferDriver`, and `TelemetryDriver` contracts with production-ready In-Memory, Redis, and Cloudflare KV implementations, including consent-gated session join and GDPR Art. 17 `purgeUser` support.
3. **`@ados/edge`**: Cloudflare Worker handling Safari ITP first-party cookie extension (`ados_session_id`, `_fbp`, `_fbc`), click-ID extraction (`gclid`, `fbclid`, `ttclid`, `rdt_cid`), `Sec-GPC: 1` header sniffing, and first-party Tag Gateway routing.
4. **`@ados/adapters` & `@ados/gateway`**: Hono gateway with the PII Canonicalizer (email normalization, E.164 phone formatting, SHA-256 hashing), weighted Pre-Flight EMQ Scorer, Creative Spec Linter, 3-Failure-Mode Statistical Outage Circuit Breaker, Role & Guardrail Policy Evaluator, Full-Duplex Wire Audit Logger, and adapters for Meta, Google Ads, TikTok, and Reddit (including the $T > 48\text{h}$ backfill suppression arbiter).
5. **`@ados/mcp-server`**: Full MCP server exposing all 5 core tools (`ados_lint_conversion`, `ados_dispatch_conversion`, `ados_mutate_budget`, `ados_lint_creative`, `ados_query_signal_health`) backed by the Gateway engine, verified by comprehensive automated tests.
