import type {
  CompanyEnrichmentProvider,
  EnrichCandidate,
  EnrichOutcome,
} from './companyEnrichment.js';
import type { KnowledgeGraph } from './kernel-types.js';
import type { NorthDataClient } from './northDataClient.js';
import { NorthDataClientError } from './northDataClient.js';
import type { NorthDataResponseCache } from './northDataResponseCache.js';
import {
  mapCompanyResponse,
  NorthDataMappingError,
} from './northDataFactMapper.js';

/**
 * Orchestration layer on top of NorthDataClient + mapper + knowledge graph.
 *
 * Responsibilities:
 *   - Talk to NorthData via the client, caching by logical endpoint+params.
 *   - Run the deterministic mapper over the response.
 *   - Upsert Company, Persons, Relations, FinancialSnapshots into the graph.
 *   - Return a caller-friendly verdict (success / disambiguation / not_found).
 *
 * Strict scope: read-only on NorthData, read+write on the graph, **never
 * writes to Odoo**. The optional cross-link to an existing `OdooEntity` is a
 * single `REFERS_TO` edge — no Odoo mutation.
 */

export interface NorthDataIngestOptions {
  client: NorthDataClient;
  graph: KnowledgeGraph;
  /** Optional but recommended — long TTL (30d default) protects Premium quota. */
  cache?: NorthDataResponseCache;
  log?: (msg: string) => void;
}

export class NorthDataIngest implements CompanyEnrichmentProvider {
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: NorthDataIngestOptions) {
    this.log = opts.log ?? ((msg: string): void => { console.error(msg); });
  }

  /**
   * The generic "user typed a name, go figure it out" entry point. Uses
   * `/company/v1/company?name=` with fuzzy matching — NorthData returns one
   * best match when the query is specific enough, otherwise we fall back to
   * universal search and surface the top candidates for the LLM to re-ask
   * the user.
   */
  async enrichByName(
    name: string,
    opts: { address?: string } = {},
  ): Promise<EnrichOutcome> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return { status: 'error', query: name, message: 'Empty company name.' };
    }
    try {
      const raw = await this.fetchCompanyByName(trimmed, opts.address);
      if (!raw || typeof raw !== 'object') {
        return this.disambiguate(trimmed);
      }
      const outcome = await this.ingestMapped(raw);
      return outcome;
    } catch (err) {
      // NorthData returns 400 with "ambiguous" in the body when a fuzzy match
      // is indecisive. Rather than pattern-matching the message, we fall back
      // to universal search on ANY client error and surface candidates — the
      // disambiguation path is always safe.
      if (err instanceof NorthDataClientError) {
        this.log(
          `[northdata-ingest] company lookup by name failed (${String(err.status)}): ${err.message} — falling back to search`,
        );
        return this.disambiguate(trimmed);
      }
      if (err instanceof NorthDataMappingError) {
        return { status: 'error', query: trimmed, message: err.message };
      }
      return {
        status: 'error',
        query: trimmed,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Stable-id path — use when the caller already knows `register.uniqueKey`. */
  async enrichByExternalId(externalId: string): Promise<EnrichOutcome> {
    const trimmed = externalId.trim();
    if (trimmed.length === 0) {
      return { status: 'error', query: externalId, message: 'Empty register key.' };
    }
    try {
      const raw = await this.fetchCompanyByRegisterKey(trimmed);
      if (!raw || typeof raw !== 'object') {
        return { status: 'not_found', query: trimmed };
      }
      return await this.ingestMapped(raw);
    } catch (err) {
      if (err instanceof NorthDataClientError && err.status === 404) {
        return { status: 'not_found', query: trimmed };
      }
      if (err instanceof NorthDataMappingError) {
        return { status: 'error', query: trimmed, message: err.message };
      }
      return {
        status: 'error',
        query: trimmed,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -------------------------------------------------------------------------

  private async ingestMapped(raw: unknown): Promise<EnrichOutcome> {
    const mapped = mapCompanyResponse(raw);
    const companyResult = await this.opts.graph.ingestCompanies([mapped.company]);
    if (mapped.persons.length > 0) {
      await this.opts.graph.ingestPersons(mapped.persons);
    }
    // Relations depend on both endpoints existing — persons were just
    // ingested, the subject company was just ingested. Any relation edge
    // whose counterpart company node doesn't exist (we only saw a register
    // key on the relation, not a full Company payload) is quietly skipped by
    // the graph — counted in `skipped`.
    await this.opts.graph.ingestCompanyRelations(mapped.relations);
    if (mapped.financialSnapshots.length > 0) {
      await this.opts.graph.ingestFinancialSnapshots(mapped.financialSnapshots);
    }
    const fromCache = companyResult.updated > 0 && companyResult.inserted === 0;
    const financialYears = mapped.financialSnapshots.map((s) => s.fiscalYear);
    return {
      status: 'success',
      company: mapped.company,
      personCount: mapped.persons.length,
      financialYears,
      fromCache,
    };
  }

  /**
   * Universal-search fallback. Returns the top few candidates so the LLM can
   * list them and ask the user to pick — per user-selected policy D7.
   */
  private async disambiguate(query: string): Promise<EnrichOutcome> {
    try {
      const raw = await this.universalSearch(query);
      const candidates = extractCandidates(raw);
      if (candidates.length === 0) {
        return { status: 'not_found', query };
      }
      const soleHit = candidates[0];
      if (candidates.length === 1 && soleHit && soleHit.registerKey) {
        // A single unambiguous hit — enrich it directly instead of bouncing
        // back to the user for a confirmation they'd only rubber-stamp.
        return this.enrichByExternalId(soleHit.registerKey);
      }
      return {
        status: 'disambiguation',
        query,
        candidates: candidates.slice(0, 5),
      };
    } catch (err) {
      if (err instanceof NorthDataClientError) {
        return {
          status: 'error',
          query,
          message: `Search failed: ${err.message}`,
        };
      }
      throw err;
    }
  }

  // ---- cache-aware fetch helpers -----------------------------------------

  private async fetchCompanyByName(
    name: string,
    address: string | undefined,
  ): Promise<unknown> {
    const cache = this.opts.cache;
    const cacheKey = {
      endpoint: 'company.byName',
      params: { name, ...(address ? { address } : {}) },
    };
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) return cached;
    const fresh = await this.opts.client.findCompanyByName(name, {
      ...(address ? { address } : {}),
      // Request everything we map so one call populates the full subgraph.
      financials: true,
      events: true,
      owners: true,
      ownerships: true,
      representatives: true,
      relations: true,
      extras: true,
      fuzzyMatch: true,
    });
    cache?.put(cacheKey, fresh);
    return fresh;
  }

  private async fetchCompanyByRegisterKey(registerKey: string): Promise<unknown> {
    const cache = this.opts.cache;
    const cacheKey = {
      endpoint: 'company.byRegisterKey',
      params: { registerKey },
    };
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) return cached;
    const fresh = await this.opts.client.getCompanyByRegisterKey(registerKey, {
      financials: true,
      events: true,
      owners: true,
      ownerships: true,
      representatives: true,
      relations: true,
      extras: true,
    });
    cache?.put(cacheKey, fresh);
    return fresh;
  }

  private async universalSearch(query: string): Promise<unknown> {
    const cache = this.opts.cache;
    const cacheKey = { endpoint: 'search.universal', params: { query } };
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) return cached;
    const fresh = await this.opts.client.universalSearch(query, 10);
    cache?.put(cacheKey, fresh);
    return fresh;
  }
}

/**
 * Extract a flat candidate list from a `SearchResults` payload. We only keep
 * entries that look like companies — persons/publications are orthogonal for
 * the enrich flow. NorthData's response shape wraps matches in a `result`
 * object with `company`, `person`, or `publication`. Unknowns are tolerated.
 */
function extractCandidates(raw: unknown): EnrichCandidate[] {
  if (!raw || typeof raw !== 'object') return [];
  const results = (raw as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  const out: EnrichCandidate[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    const company = (entry as { company?: Record<string, unknown> }).company;
    if (!company) continue;
    const nameObj = company['name'];
    const nameStr =
      nameObj && typeof nameObj === 'object'
        ? String((nameObj as { name?: unknown }).name ?? '').trim()
        : '';
    if (nameStr.length === 0) continue;
    const register = company['register'];
    const registerKey =
      register && typeof register === 'object'
        ? String((register as { uniqueKey?: unknown }).uniqueKey ?? '').trim() ||
          undefined
        : undefined;
    const address = company['address'];
    const city =
      address && typeof address === 'object'
        ? String((address as { city?: unknown }).city ?? '').trim() || undefined
        : undefined;
    const url = String((company as { northDataUrl?: unknown }).northDataUrl ?? '').trim();
    out.push({
      name: nameStr,
      ...(registerKey ? { registerKey } : {}),
      ...(city ? { city } : {}),
      ...(url ? { url } : {}),
    });
  }
  return out;
}
