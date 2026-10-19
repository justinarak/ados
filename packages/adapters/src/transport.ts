import { createHmac } from "node:crypto";
import type { PlatformDestination } from "@ados/schemas";

export interface HttpTransportResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface AdapterHttpTransport {
  postJson(
    platform: PlatformDestination,
    url: string,
    payload: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<HttpTransportResponse>;
}

export interface UpstreamPlatformCredentials {
  meta?: {
    pixel_id: string;
    access_token: string;
    app_secret?: string;
    test_event_code?: string;
  };
  google?: {
    customer_id: string;
    conversion_action_id?: string;
    developer_token: string;
    access_token: string;
    login_customer_id?: string;
  };
  tiktok?: {
    pixel_code: string;
    access_token: string;
  };
  reddit?: {
    pixel_id: string;
    access_token: string;
  };
}

/**
 * Live HTTP Transport using standard `fetch` to call upstream Ad Platform APIs:
 * - Meta Graph API v21.0 (`https://graph.facebook.com/v21.0/{pixel_id}/events`) with `appsecret_proof`
 * - Google Ads API v18 (`https://googleads.googleapis.com/v18/customers/{id}:uploadClickConversions`)
 * - TikTok Events API v1.3 (`https://business-api.tiktok.com/open_api/v1.3/event/track/`)
 * - Reddit Conversions API v3 (`https://ads-api.reddit.com/api/v3/pixels/{id}/conversion_events`)
 */
export class FetchAdapterHttpTransport implements AdapterHttpTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async postJson(
    _platform: PlatformDestination,
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<HttpTransportResponse> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = (await response.json()) as Record<string, unknown>;
    } catch {
      parsedBody = { raw_status_text: response.statusText };
    }

    return {
      httpStatus: response.status,
      body: parsedBody,
    };
  }
}

/**
 * Builds platform-specific upstream URL and authentication headers (including Meta `appsecret_proof`
 * and Google Ads MCC `login-customer-id` headers).
 */
export function buildUpstreamEndpointAndHeaders(
  platform: PlatformDestination,
  credentials: UpstreamPlatformCredentials
): { url: string; headers: Record<string, string> } {
  switch (platform) {
    case "meta": {
      const cfg = credentials.meta;
      if (!cfg) throw new Error("Missing upstream Meta credentials");
      const url = new URL(`https://graph.facebook.com/v21.0/${cfg.pixel_id}/events`);
      url.searchParams.set("access_token", cfg.access_token);
      if (cfg.app_secret) {
        const proof = createHmac("sha256", cfg.app_secret)
          .update(cfg.access_token)
          .digest("hex");
        url.searchParams.set("appsecret_proof", proof);
      }
      return { url: url.toString(), headers: {} };
    }

    case "google": {
      const cfg = credentials.google;
      if (!cfg) throw new Error("Missing upstream Google Ads credentials");
      const cleanCustomerId = cfg.customer_id.replace(/^customers\//, "").replace(/-/g, "");
      const url = `https://googleads.googleapis.com/v18/customers/${cleanCustomerId}:uploadClickConversions`;
      const headers: Record<string, string> = {
        authorization: `Bearer ${cfg.access_token}`,
        "developer-token": cfg.developer_token,
      };
      if (cfg.login_customer_id) {
        headers["login-customer-id"] = cfg.login_customer_id
          .replace(/^customers\//, "")
          .replace(/-/g, "");
      }
      return { url, headers };
    }

    case "tiktok": {
      const cfg = credentials.tiktok;
      if (!cfg) throw new Error("Missing upstream TikTok credentials");
      return {
        url: "https://business-api.tiktok.com/open_api/v1.3/event/track/",
        headers: {
          "Access-Token": cfg.access_token,
        },
      };
    }

    case "reddit": {
      const cfg = credentials.reddit;
      if (!cfg) throw new Error("Missing upstream Reddit credentials");
      return {
        url: `https://ads-api.reddit.com/api/v3/pixels/${cfg.pixel_id}/conversion_events`,
        headers: {
          Authorization: `Bearer ${cfg.access_token}`,
        },
      };
    }
  }
}
