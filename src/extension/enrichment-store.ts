// In-memory enrichment accumulator with session storage quota management.
// URL-keyed Map, latest data wins via upsert, LRU eviction when approaching quota.
// chrome.storage.session.QUOTA_BYTES = 10485760

import { urlKey } from "../shared/url-normalize";

// Session storage quota — 10MB
export const SESSION_QUOTA_BYTES = 10_485_760;
// Evict when estimated usage exceeds 80% of quota
export const QUOTA_THRESHOLD = 0.8;
const QUOTA_EVICTION_BYTES = SESSION_QUOTA_BYTES * QUOTA_THRESHOLD;

export interface QuotaStatus {
  estimatedBytes: number;
  quotaBytes: number;
  usageRatio: number;
  entryCount: number;
}

export interface AccumulatedEnrichment {
  url: string;
  title: string;
  framework?: any;
  networkRequests?: any[];
  consoleLogs?: any[];
  domSnapshotJSON?: string;
  screenshot?: string;
  capturedAt: string;
  lastAccess: number;
}

export class EnrichmentAccumulator {
  private store = new Map<string, AccumulatedEnrichment>();
  private maxEntries = 200;
  private cachedSize = 0;

  upsert(url: string, data: Partial<AccumulatedEnrichment>): void {
    const key = urlKey(url);
    const cloned = structuredClone(data);
    const existing = this.store.get(key);
    if (existing) {
      // Subtract old size before merge
      this.cachedSize -= estimateSize(existing);
      Object.assign(existing, cloned);
      existing.lastAccess = Date.now();
      this.cachedSize += estimateSize(existing);
    } else {
      this.evictIfNeeded();
      if (this.store.size >= this.maxEntries) {
        this.evictLRU();
      }
      const entry: AccumulatedEnrichment = {
        url,
        title: "",
        capturedAt: new Date().toISOString(),
        ...cloned,
        lastAccess: Date.now(),
      } as AccumulatedEnrichment;
      this.store.set(key, entry);
      this.cachedSize += estimateSize(entry);
    }
  }

  get(url: string): AccumulatedEnrichment | undefined {
    const entry = this.store.get(urlKey(url));
    if (entry) {
      entry.lastAccess = Date.now();
    }
    return entry;
  }

  getAll(): AccumulatedEnrichment[] {
    return Array.from(this.store.values());
  }

  count(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.cachedSize = 0;
  }

  flush(): AccumulatedEnrichment[] {
    const all = this.getAll();
    this.clear();
    return all;
  }

  getQuotaStatus(): QuotaStatus {
    return {
      estimatedBytes: this.cachedSize,
      quotaBytes: SESSION_QUOTA_BYTES,
      usageRatio: this.cachedSize / SESSION_QUOTA_BYTES,
      entryCount: this.store.size,
    };
  }

  /** Check if a write of the given byte size would exceed the quota threshold. */
  checkQuota(additionalBytes: number): boolean {
    return (this.cachedSize + additionalBytes) <= QUOTA_EVICTION_BYTES;
  }

  /** Pre-write quota check — evicts LRU entries if approaching quota. */
  async ensureQuota(): Promise<void> {
    this.evictIfNeeded();
  }

  /** Evict LRU entries until estimated usage is under the quota threshold. */
  private evictIfNeeded(): void {
    while (this.cachedSize > QUOTA_EVICTION_BYTES && this.store.size > 0) {
      this.evictLRU();
    }
  }

  /** Evict the single least-recently-accessed entry. */
  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestAccess = Infinity;
    for (const [key, entry] of this.store) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      const evicted = this.store.get(oldestKey)!;
      const evictedSize = estimateSize(evicted);
      this.store.delete(oldestKey);
      this.cachedSize -= evictedSize;
      // LRU eviction performed — oldest entry removed to stay under quota
    }
  }
}

/** Estimate byte size of a value for session storage (JSON string length * 2 for UTF-16). */
export function estimateSize(value: unknown): number {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return 0;
  }
}
