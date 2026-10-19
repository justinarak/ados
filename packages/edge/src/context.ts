import {
  type ClickContext,
  type ConsentEnvelope,
  generateUuidV7,
  resolveEffectiveConsent,
} from "@ados/schemas";
import { formatFbcCookie, parseCookies, serializeFirstPartyCookie } from "./cookies.js";

export interface ExtractedEdgeContext {
  ados_session_id: string;
  ados_dedup_id: string;
  click_context: ClickContext;
  consent: ConsentEnvelope;
  setCookieHeaders: string[];
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inspects an incoming Edge Request, extracts click parameters (`_fbp`, `_fbc`, `fbclid`, `gclid`,
 * `gbraid`, `wbraid`, `ttclid`, `rdt_cid`), sniffs `Sec-GPC: 1`, hydrates first-party ITP-resistant
 * cookies, and stamps `ados_session_id` + `ados_dedup_id`.
 */
export function extractEdgeContext(
  request: Request,
  cookieDomain?: string,
  nowMs: number = Date.now()
): ExtractedEdgeContext {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get("cookie"));

  // 1. Sniff Global Privacy Control (Sec-GPC: 1) & Consent query/headers
  const gpcHeader = request.headers.get("sec-gpc");
  const gpcDetected = gpcHeader === "1" || gpcHeader?.toLowerCase() === "true";

  const rawAdUserData =
    url.searchParams.get("ad_user_data") ??
    request.headers.get("x-ados-ad-user-data") ??
    cookies["ados_consent_ad_user_data"];
  const rawAdStorage =
    url.searchParams.get("ad_storage") ??
    request.headers.get("x-ados-ad-storage") ??
    cookies["ados_consent_ad_storage"];
  const rawAdPersonalization =
    url.searchParams.get("ad_personalization") ??
    request.headers.get("x-ados-ad-personalization") ??
    cookies["ados_consent_ad_personalization"];
  const tcString = url.searchParams.get("tc_string") ?? cookies["euconsent-v2"] ?? undefined;

  const consent = resolveEffectiveConsent({
    ad_storage: rawAdStorage === "granted" ? "granted" : "denied",
    analytics_storage: rawAdStorage === "granted" ? "granted" : "denied",
    ad_user_data: rawAdUserData === "granted" ? "granted" : "denied",
    ad_personalization: rawAdPersonalization === "granted" ? "granted" : "denied",
    tc_string: tcString,
    gpc_detected: gpcDetected,
    consent_timestamp: Math.floor(nowMs / 1000),
  });

  // 2. Mint or reuse `ados_session_id` (1-2h session stitcher key) and per-hit `ados_dedup_id`
  const existingSessionId = cookies["ados_session_id"];
  const ados_session_id =
    existingSessionId && UUID_REGEX.test(existingSessionId)
      ? existingSessionId
      : generateUuidV7(nowMs);
  const ados_dedup_id = generateUuidV7(nowMs);

  // 3. Extract Click IDs from URL params or existing first-party cookies
  const fbclid = url.searchParams.get("fbclid") ?? undefined;
  const gclid = url.searchParams.get("gclid") ?? cookies["_ados_gclid"] ?? undefined;
  const gbraid = url.searchParams.get("gbraid") ?? cookies["_ados_gbraid"] ?? undefined;
  const wbraid = url.searchParams.get("wbraid") ?? cookies["_ados_wbraid"] ?? undefined;
  const ttclid = url.searchParams.get("ttclid") ?? cookies["_ados_ttclid"] ?? undefined;
  const rdt_cid = url.searchParams.get("rdt_cid") ?? cookies["_ados_rdt_cid"] ?? undefined;

  const fbp = cookies["_fbp"] ?? undefined;
  const fbc = fbclid ? formatFbcCookie(fbclid, nowMs) : cookies["_fbc"] ?? undefined;

  const click_context: ClickContext = {
    ados_session_id,
    fbp,
    fbc,
    fbclid,
    gclid,
    gbraid,
    wbraid,
    ttclid,
    rdt_cid,
    client_pixel_fired: true,
    client_pixel_fired_at: Math.floor(nowMs / 1000),
  };

  // 4. Construct Safari ITP first-party Set-Cookie headers (only if ad_storage is not denied & GPC is not active)
  const setCookieHeaders: string[] = [];
  if (!consent.gpc_detected && consent.ad_storage === "granted") {
    // Session stitcher cookie (2 hour TTL = 7200s)
    setCookieHeaders.push(
      serializeFirstPartyCookie("ados_session_id", ados_session_id, {
        domain: cookieDomain,
        maxAgeSeconds: 7200,
        httpOnly: true,
      })
    );

    if (fbc) {
      setCookieHeaders.push(
        serializeFirstPartyCookie("_fbc", fbc, {
          domain: cookieDomain,
          maxAgeSeconds: 7776000, // 90d
          httpOnly: false, // Accessible to hybrid Meta Pixel if present
        })
      );
    }
    if (fbp) {
      setCookieHeaders.push(
        serializeFirstPartyCookie("_fbp", fbp, {
          domain: cookieDomain,
          maxAgeSeconds: 7776000,
          httpOnly: false,
        })
      );
    }
    if (gclid) {
      setCookieHeaders.push(
        serializeFirstPartyCookie("_ados_gclid", gclid, {
          domain: cookieDomain,
          maxAgeSeconds: 7776000,
          httpOnly: true,
        })
      );
    }
    if (ttclid) {
      setCookieHeaders.push(
        serializeFirstPartyCookie("_ados_ttclid", ttclid, {
          domain: cookieDomain,
          maxAgeSeconds: 2419200, // 28d
          httpOnly: true,
        })
      );
    }
  }

  return {
    ados_session_id,
    ados_dedup_id,
    click_context,
    consent,
    setCookieHeaders,
  };
}
