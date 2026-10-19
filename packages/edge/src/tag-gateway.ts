import { extractEdgeContext } from "./context.js";
import type { EdgeWorkerEnv } from "./worker.js";

export type TagVendor = "gtag" | "meta" | "tiktok";

export interface TagGatewayRouteMatch {
  vendor: TagVendor;
  upstreamPath: string;
}

const UPSTREAM_TAG_ORIGINS: Record<TagVendor, string> = {
  gtag: "https://www.google-analytics.com",
  meta: "https://www.facebook.com",
  tiktok: "https://analytics.tiktok.com",
};

/**
 * Matches first-party Tag Gateway paths:
 * - `/ados/tag/gtag/*`   -> Google Tag Gateway / YouTube / GA4 / AW pings
 * - `/ados/tag/meta/*`   -> Meta First-Party Pixel / CAPI Gateway
 * - `/ados/tag/tiktok/*` -> TikTok Events Gateway
 */
export function matchTagGatewayRoute(pathname: string): TagGatewayRouteMatch | null {
  const match = /^\/ados\/tag\/(gtag|meta|tiktok)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const vendor = match[1] as TagVendor;
  const upstreamPath = match[2] && match[2].length > 0 ? match[2] : "/";
  return { vendor, upstreamPath };
}

export type UpstreamFetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Mode A: First-Party Tag Gateway Proxy Handler
 * Routes browser tag requests through the advertiser's own first-party edge domain while
 * enforcing `ConsentEnvelope` stripping rules (Google Advanced Consent Mode v2 cookieless pings,
 * Meta/TikTok LDU & consent suppression) and extending Safari ITP first-party cookies.
 */
export async function handleTagGatewayProxy(
  request: Request,
  route: TagGatewayRouteMatch,
  env: EdgeWorkerEnv,
  upstreamFetch: UpstreamFetchFn = fetch
): Promise<Response> {
  const extracted = extractEdgeContext(request, env.cookieDomain);
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(route.upstreamPath, UPSTREAM_TAG_ORIGINS[route.vendor]);

  // Copy query parameters from incoming request
  incomingUrl.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

  // Always stamp deterministic/session deduplication headers
  upstreamUrl.searchParams.set("ados_dedup_id", extracted.ados_dedup_id);

  const consentDenied =
    extracted.consent.ad_user_data === "denied" || extracted.consent.gpc_detected;

  // Consent Enforcement at the Edge (Mode A):
  if (consentDenied) {
    if (route.vendor === "meta" || route.vendor === "tiktok") {
      // If LDU is not explicitly requested or ad_user_data is denied, suppress 3rd-party pixel call at the edge
      return new Response(null, {
        status: 204,
        headers: {
          "x-ados-tag-gateway": "suppressed-consent",
          "x-ados-vendor": route.vendor,
          "x-ados-gpc-detected": String(extracted.consent.gpc_detected),
        },
      });
    }

    // For Google / YouTube (`gtag`): Enforce Google Advanced Consent Mode v2 Cookieless Ping
    // `gcs=G100` signals ad_storage=denied & analytics_storage=denied to Google tag collectors
    upstreamUrl.searchParams.set("gcs", "G100");
    upstreamUrl.searchParams.set("npa", "1"); // Non-personalized ads
    upstreamUrl.searchParams.delete("gclid");
    upstreamUrl.searchParams.delete("gbraid");
    upstreamUrl.searchParams.delete("wbraid");
    upstreamUrl.searchParams.delete("cid"); // Strip client identifier
  } else {
    if (route.vendor === "gtag") {
      upstreamUrl.searchParams.set("gcs", "G111");
    }
  }

  // Build sanitized outbound headers (strip client IP & cookies if consent is denied)
  const outboundHeaders = new Headers();
  const userAgent = request.headers.get("user-agent");
  if (userAgent) outboundHeaders.set("user-agent", userAgent);

  if (!consentDenied) {
    const clientIp =
      request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for");
    if (clientIp) outboundHeaders.set("x-forwarded-for", clientIp);
  }

  const upstreamResponse = await upstreamFetch(upstreamUrl.toString(), {
    method: request.method,
    headers: outboundHeaders,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set(
    "x-ados-tag-gateway",
    consentDenied ? "proxied-cookieless-modeled" : "proxied-consented"
  );
  responseHeaders.set("x-ados-vendor", route.vendor);
  responseHeaders.set("x-ados-session-id", extracted.ados_session_id);
  responseHeaders.set("x-ados-dedup-id", extracted.ados_dedup_id);

  for (const cookie of extracted.setCookieHeaders) {
    responseHeaders.append("set-cookie", cookie);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
