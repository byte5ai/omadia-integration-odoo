/**
 * In-memory cache for **stable** Odoo read-only calls, keyed by
 * (scope, model, method, canonical-args). TTL is short (5 min) and the
 * eligibility list is deliberately narrow — only calls we're willing to
 * serve a few minutes stale.
 *
 * This cache lives *above* odooCore.executeOdoo's call to the HTTP client,
 * so red-line stripping and EntityRef publish still happen on every hit —
 * we only skip the network round-trip, not the safety rails.
 *
 * Not shared across machines. Not persisted. Refresh = middleware restart.
 */

export interface OdooResponseCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface CacheEntry {
  result: unknown;
  expiresAt: number;
  accessSeq: number;
}

export interface CacheLookupKey {
  scope: string;
  model: string;
  method: string;
  /** Original request kwargs + positional args. */
  kwargs: Record<string, unknown>;
  positionalArgs: unknown[];
}

/**
 * Whitelist of (model, method) pairs whose results change slowly enough
 * that a 5-minute stale read is acceptable. A call that doesn't match
 * anything here bypasses the cache entirely.
 *
 *   - `fields_get` on any model: schema is stable within an Odoo version.
 *   - `res.currency.*`: currencies barely change.
 *   - `account.journal.{search_read, read, search_count}`: journals are
 *     configuration, not transactional.
 *   - `account.account.{search_read, read}`: chart of accounts is stable.
 *   - `hr.department.{search_read, read}`: org structure changes weeks apart.
 *
 * Anything on `account.move`, `account.move.line`, `account.payment`,
 * `hr.employee`, `res.partner` is NOT cacheable — the whole point of the
 * bot is to show current transactional state for those.
 */
const CACHEABLE: ReadonlyArray<{ model: string | '*'; method: string | '*' }> = [
  { model: '*', method: 'fields_get' },
  { model: 'res.currency', method: '*' },
  { model: 'account.journal', method: 'search_read' },
  { model: 'account.journal', method: 'read' },
  { model: 'account.journal', method: 'search_count' },
  { model: 'account.account', method: 'search_read' },
  { model: 'account.account', method: 'read' },
  // Analytic accounts (Kostenstellen) are dimension-table-like — new ones
  // get created once every few months, the ID→name mapping is stable. Cache
  // lookups so the agent can resolve `analytic_distribution` keys without
  // a round-trip every iteration. `account.analytic.line` stays uncached —
  // it's per-invoice transactional data.
  { model: 'account.analytic.account', method: 'search_read' },
  { model: 'account.analytic.account', method: 'read' },
  { model: 'account.analytic.account', method: 'search_count' },
  { model: 'hr.department', method: 'search_read' },
  { model: 'hr.department', method: 'read' },
];

export function isCacheable(model: string, method: string): boolean {
  for (const rule of CACHEABLE) {
    if ((rule.model === '*' || rule.model === model) &&
        (rule.method === '*' || rule.method === method)) {
      return true;
    }
  }
  return false;
}

export class OdooResponseCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private accessSeq = 0;

  constructor(opts: OdooResponseCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 200;
  }

  /**
   * Returns the cached result if still fresh, else undefined. Callers must
   * check `isCacheable(model, method)` themselves — cache handles lookup
   * only, not eligibility.
   */
  get(key: CacheLookupKey): unknown | undefined {
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

  /** Stores a fresh result. LRU-evicts when the cap is hit. */
  put(key: CacheLookupKey, result: unknown): void {
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

function cacheId(key: CacheLookupKey): string {
  // Sort kwargs keys so semantically identical calls share the cache line.
  // Positional args are used as-is — order is already significant.
  return `${key.scope}|${key.model}|${key.method}|${canonicalJson(key.kwargs)}|${canonicalJson(key.positionalArgs)}`;
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
