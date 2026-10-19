# AdOS Model Context Protocol (MCP) & CLI Guide

`@ados/mcp-server` exposes AdOS's governed ad-platform tools to AI agents in **Cursor**, **Claude Code**, **Claude Desktop**, or custom agent daemons.

## 1. Configuring Cursor (`.cursor/mcp.json`)

Add the following to your `.cursor/mcp.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ados": {
      "command": "node",
      "args": ["/path/to/ados/packages/mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

## 2. Available MCP Tools

| Tool Name | Purpose |
| :--- | :--- |
| `ados_lint_conversion` | Pre-flight PII canonicalization (E.164 phone, lowercase email), SHA-256 hashing, and predicted EMQ (`0.0–10.0`) grading without network dispatch. |
| `ados_dispatch_conversion` | Hydrates first-party click context (`ados_session_id`), enforces `ConsentEnvelope` & statistical circuit breakers, and fans out across `meta`, `google`, `tiktok`, and `reddit`. |
| `ados_mutate_budget` | Mutates campaign budgets within blast-radius guardrails (`<=15%` max increase, `$5,000` daily cap, `60m` cooldown, protected campaign blacklists). |
| `ados_lint_creative` | Validates remote creative asset URLs against placement aspect ratios (`9:16` vs `1:1`), video durations, and ad copy character limits (`google_pmax` <= 30 chars). |
| `ados_query_signal_health` | Returns rolling EMQ scores, email match density ratios, and active circuit breaker / quarantine queue metrics. |

## 3. Developer CLI Usage

```bash
# Test and dispatch a sample conversion event
node packages/gateway/dist/cli.js test-event --file deploy/samples/sample_purchase.json --destinations meta,google

# Lint a creative asset specification before upload
node packages/gateway/dist/cli.js lint-creative --file deploy/samples/sample_creative.json

# Execute GDPR Art. 17 cross-platform user erasure
node packages/gateway/dist/cli.js privacy purge-user --identifier sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --all-platforms
```
