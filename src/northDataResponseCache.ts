/**
 * In-memory TTL cache for NorthData API responses. Premium quota is the
 * scarce resource, so we default to a long TTL (30 days) — Handelsregister
 * data rarely changes, and the Phase-5 `NorthDataWatcher` will pick up events
 * out-of-band via the change feed.
 *
 * Per-process, same caveat as {@link OdooResponseCache}: lost on restart.
 * That's acceptable — the graph still holds the ingested Company/Person
 * nodes, and the retention trade-off is simpler than wiring Redis just for
 * this.
 */

export interface NorthDataResponseCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface CacheEntry {
  result: unknown;
  expiresAt: number;
  accessSeq: number;
}

export interface NorthDataCacheKey {
  /** Logical endpoint, e.g. `company.search`, `company.get`, `person.get`. */
  endpoint: string;
  /** Canonicalised parameters — usually `{name}` or `{id}`. */
  params: Record<string, unknown>;
}

export class NorthDataResponseCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private accessSeq = 0;

  constructor(opts: NorthDataResponseCacheOptions = {}) {
    // 30-day default. Short enough that a long-running dev box picks up
    // new-year data, long enough to amortise Premium calls.
    this.ttlMs = opts.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 500;
  }

  get(key: NorthDataCacheKey): unknown | undefined {
    const id = cacheId(key);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(id);
      return undefined;
    }
    entry.accessSeq = ++this.accessSeq;
    return entry.result;
  }

  put(key: NorthDataCacheKey, result: unknown): void {
    const id = cacheId(key);
    if (!this.entries.has(id) && this.entries.size >= this.maxEntries) {
      let oldestId: string | undefined;
      let oldestSeq = Infinity;
      for (const [k, v] of this.entries.entries()) {
        if (v.accessSeq < oldestSeq) {
          oldestSeq = v.accessSeq;
          oldestId = k;
        }
      }
      if (oldestId !== undefined) this.entries.delete(oldestId);
    }
    this.entries.set(id, {
      result,
      expiresAt: Date.now() + this.ttlMs,
      accessSeq: ++this.accessSeq,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

function cacheId(key: NorthDataCacheKey): string {
  return `${key.endpoint}|${canonicalJson(key.params)}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>).sort(
        ([a], [b]) => a.localeCompare(b),
      );
      const out: Record<string, unknown> = {};
      for (const [k2, v2] of entries) out[k2] = v2;
      return out;
    }
    return v;
  });
}
