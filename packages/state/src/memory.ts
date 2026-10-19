import type {
  QuarantineBufferDriver,
  QuarantinedEventRecord,
  StateDriver,
  TelemetryDriver,
  WireAuditReceipt,
} from "./interfaces.js";

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

/**
 * Default Zero-Config In-Memory StateDriver with strict TTL expiration (1–2h default).
 */
export class InMemoryStateDriver implements StateDriver {
  private readonly store = new Map<string, MemoryEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAtMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number = 7200): Promise<void> {
    const clampedTtl = Math.min(Math.max(ttlSeconds, 1), 7200); // Enforce max 2-hour TTL for ephemeral stitching
    this.store.set(key, {
      value,
      expiresAtMs: Date.now() + clampedTtl * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * Purges any cached entries matching a user identifier or session key (GDPR Art. 17)
   */
  async purgeMatching(substring: string): Promise<number> {
    let purged = 0;
    for (const [key, entry] of this.store.entries()) {
      if (key.includes(substring) || entry.value.includes(substring)) {
        this.store.delete(key);
        purged++;
      }
    }
    return purged;
  }
}

export class InMemoryQuarantineBuffer implements QuarantineBufferDriver {
  private readonly queue: QuarantinedEventRecord[] = [];

  async enqueue(record: QuarantinedEventRecord): Promise<void> {
    this.queue.push(record);
  }

  async drain(maxItems: number): Promise<QuarantinedEventRecord[]> {
    return this.queue.splice(0, Math.max(0, maxItems));
  }

  async size(): Promise<number> {
    return this.queue.length;
  }

  async list(): Promise<QuarantinedEventRecord[]> {
    return [...this.queue];
  }
}

export class InMemoryTelemetryDriver implements TelemetryDriver {
  private readonly receipts: WireAuditReceipt[] = [];

  async emit(receipt: WireAuditReceipt): Promise<void> {
    this.receipts.push(receipt);
  }

  async queryRecent(limit: number = 100): Promise<WireAuditReceipt[]> {
    return this.receipts.slice(-limit);
  }
}
