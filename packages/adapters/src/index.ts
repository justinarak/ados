import type { PlatformDestination } from "@ados/schemas";
import { GoogleAdsAdapter } from "./google.js";
import type { PlatformAdapter } from "./interface.js";
import { MetaAdapter } from "./meta.js";
import { RedditAdapter } from "./reddit.js";
import { TikTokAdapter } from "./tiktok.js";

export * from "./interface.js";
export * from "./transport.js";
export * from "./batch-unroller.js";
export * from "./meta.js";
export * from "./google.js";
export * from "./tiktok.js";
export * from "./reddit.js";

export function createDefaultAdapterRegistry(): Record<PlatformDestination, PlatformAdapter> {
  return {
    meta: new MetaAdapter(),
    google: new GoogleAdsAdapter(),
    tiktok: new TikTokAdapter(),
    reddit: new RedditAdapter(),
  };
}
