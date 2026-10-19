import type { EphemeralSessionRecord, StateDriver } from "@ados/state";
import { extractEdgeContext } from "./context.js";

export interface EdgeWorkerEnv {
  stateDriver: StateDriver;
  cookieDomain?: string;
}

/**
 * Cloudflare Worker / WinterCG Fetch Handler for `@ados/edge`:
 * - Mode A: First-Party Tag Gateway Proxy (`/ados/tag/*`)
 * - Mode B & C: Session Context Hydration (`/ados/collect` or middleware pass-through)
 */
export async function handleEdgeRequest(
  request: Request,
  env: EdgeWorkerEnv
): Promise<Response> {
  const extracted = extractEdgeContext(request, env.cookieDomain);
  const sessionKey = `ados:session:${extracted.ados_session_id}`;

  // Consent-Gated Ephemeral Storage (1-2h TTL = 7200s):
  // If ad_user_data is granted and GPC is not detected, persist click context for downstream server join.
  // Otherwise, immediately purge any existing session entry.
  if (extracted.consent.ad_user_data === "granted" && !extracted.consent.gpc_detected) {
    const record: EphemeralSessionRecord = {
      ados_session_id: extracted.ados_session_id,
      click_context: extracted.click_context,
      consent: extracted.consent,
      created_at_ms: Date.now(),
    };
    await env.stateDriver.set(sessionKey, JSON.stringify(record), 7200);
  } else {
    await env.stateDriver.del(sessionKey);
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-ados-session-id": extracted.ados_session_id,
    "x-ados-dedup-id": extracted.ados_dedup_id,
    "x-ados-gpc-detected": String(extracted.consent.gpc_detected),
  });

  for (const cookie of extracted.setCookieHeaders) {
    headers.append("set-cookie", cookie);
  }

  return new Response(
    JSON.stringify({
      status: "ok",
      ados_session_id: extracted.ados_session_id,
      ados_dedup_id: extracted.ados_dedup_id,
      click_context: extracted.click_context,
      consent: extracted.consent,
    }),
    { status: 200, headers }
  );
}
