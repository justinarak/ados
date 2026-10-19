import type { StateDriver } from "./interfaces.js";

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Pluggable Redis / Upstash StateDriver for horizontally scaled BYO-Infra deployments.
 * Enforces the 1–2 hour (max 7200s) ephemeral TTL boundary.
 */
export class RedisStateDriver implements StateDriver {
  constructor(private readonly client: RedisClientLike) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number = 7200): Promise<void> {
    const clampedTtl = Math.min(Math.max(ttlSeconds, 1), 7200);
    await this.client.set(key, value, { EX: clampedTtl });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
