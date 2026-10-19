export interface CookieOptions {
  domain?: string;
  path?: string;
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

/**
 * Parses a raw HTTP `Cookie` request header into a key-value map.
 */
export function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

/**
 * Serializes a first-party cookie for `Set-Cookie` headers to extend expiration under Safari ITP.
 * By default sets `HttpOnly; Secure; SameSite=Lax; Path=/`.
 */
export function serializeFirstPartyCookie(
  name: string,
  value: string,
  options: CookieOptions = {}
): string {
  const {
    domain,
    path = "/",
    maxAgeSeconds = 7776000, // 90 days default for click attribution cookies
    httpOnly = true,
    secure = true,
    sameSite = "Lax",
  } = options;

  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAgeSeconds}`];
  if (domain) segments.push(`Domain=${domain}`);
  if (sameSite) segments.push(`SameSite=${sameSite}`);
  if (secure) segments.push("Secure");
  if (httpOnly) segments.push("HttpOnly");
  return segments.join("; ");
}

/**
 * Formats a raw `fbclid` query parameter into Meta's canonical `_fbc` cookie format:
 * `fb.1.<creationTimeMs>.<fbclid>`
 */
export function formatFbcCookie(fbclid: string, timestampMs: number = Date.now()): string {
  return `fb.1.${timestampMs}.${fbclid}`;
}
