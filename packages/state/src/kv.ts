import type { StateDriver } from "./interfaces.js";

export interface CloudflareKVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Pluggable Cloudflare KV StateDriver for edge session stitching.
 */
export class CloudflareKVStateDriver implements StateDriver {
  constructor(private readonly kv: CloudflareKVNamespaceLike) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number = 7200): Promise<void> {
    // Cloudflare KV minimum expirationTtl is 60 seconds, AdOS max ephemeral TTL is 7200 seconds
    const clampedTtl = Math.min(Math.max(ttlSeconds, 60), 7200);
    await this.kv.put(key, value, { expirationTtl: clampedTtl });
  }

  async del(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
