import type {
  CompanyEnrichmentProvider,
  EnrichCandidate,
  EnrichOutcome,
} from './companyEnrichment.js';
import type { KnowledgeGraph } from './kernel-types.js';
import type { NorthDataResponseCache } from './northDataResponseCache.js';
import type { OpenRegisterClient } from './openRegisterClient.js';
import { OpenRegisterClientError } from './openRegisterClient.js';
import {
  mapOpenRegisterCompany,
  OpenRegisterMappingError,
  type MappedCompany,
} from './openRegisterFactMapper.js';

/**
 * OpenRegister-flavoured `CompanyEnrichmentProvider`. Wraps the client +
 * deterministic mapper and writes the result into the knowledge graph using
 * the generic ingest surface (so swapping to NorthData or any future provider
 * is just a pointer change in `index.ts`).
 *
 * Fetch strategy (driven by `fetchLevel`):
 *   - minimal  : `/v1/company/{id}` only (1 credit, no GF/Finanzen)
 *   - standard : + `/owners` + `/financials` (3 credits, default)
 *   - full     : all of the above (+ UBO + historical-owners — reserved for
 *                when we need them; not used in mapper v1)
 */

export type OpenRegisterFetchLevel = 'minimal' | 'standard' | 'full';

export interface OpenRegisterIngestOptions {
  client: OpenRegisterClient;
  graph: KnowledgeGraph;
  /**
   * Optional — TTL-cache keyed by (endpoint, params). Reuses the same class
   * as NorthData since the key/value shape is identical.
   */
  cache?: NorthDataResponseCache;
  fetchLevel?: OpenRegisterFetchLevel;
  log?: (msg: string) => void;
}

export class OpenRegisterIngest implements CompanyEnrichmentProvider {
  private readonly log: (msg: string) => void;
  private readonly fetchLevel: OpenRegisterFetchLevel;

  constructor(private readonly opts: OpenRegisterIngestOptions) {
    this.log = opts.log ?? ((msg: string): void => { console.error(msg); });
    this.fetchLevel = opts.fetchLevel ?? 'standard';
  }

  async enrichByName(
    name: string,
    opts: { address?: string } = {},
  ): Promise<EnrichOutcome> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return { status: 'error', query: name, message: 'Empty company name.' };
    }
    try {
      const raw = await this.autocomplete(trimmed, 10);
      const candidates = extractCandidates(raw, opts.address);
      if (candidates.length === 0) {
        return { status: 'not_found', query: trimmed };
      }
      const soleHit = candidates[0];
      if (candidates.length === 1 && soleHit?.registerKey) {
        return this.enrichByExternalId(soleHit.registerKey);
      }
      // Even with multiple hits, if the user supplied an `address` and exactly
      // one candidate city-matches, prefer it over disambiguation. Anything
      // else bounces back for the user to pick (policy D7).
      if (opts.address) {
        const cityLower = opts.address.trim().toLowerCase();
        const cityMatches = candidates.filter(
          (c) => c.city?.toLowerCase() === cityLower,
        );
        if (cityMatches.length === 1 && cityMatches[0]?.registerKey) {
          return this.enrichByExternalId(cityMatches[0].registerKey);
        }
      }
      return {
        status: 'disambiguation',
        query: trimmed,
        candidates: candidates.slice(0, 5),
      };
    } catch (err) {
      if (err instanceof OpenRegisterClientError) {
        return {
          status: 'error',
          query: trimmed,
          message: `Search failed: ${err.message}`,
        };
      }
      return {
        status: 'error',
        query: trimmed,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async enrichByExternalId(externalId: string): Promise<EnrichOutcome> {
    const trimmed = externalId.trim();
    if (trimmed.length === 0) {
      return { status: 'error', query: externalId, message: 'Empty company id.' };
    }
    try {
      const [base, owners, financials] = await Promise.all([
        this.fetchBase(trimmed),
        this.fetchLevel === 'minimal' ? Promise.resolve(undefined) : this.fetchOwners(trimmed),
        this.fetchLevel === 'minimal' ? Promise.resolve(undefined) : this.fetchFinancials(trimmed),
      ]);
      if (!base || typeof base !== 'object') {
        return { status: 'not_found', query: trimmed };
      }
      const mapped = mapOpenRegisterCompany({
        base,
        ...(owners ? { owners } : {}),
        ...(financials ? { financials } : {}),
      });
      return await this.ingestMapped(mapped);
    } catch (err) {
      if (err instanceof OpenRegisterClientError && err.status === 404) {
        return { status: 'not_found', query: trimmed };
      }
      if (err instanceof OpenRegisterMappingError) {
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

  private async ingestMapped(mapped: MappedCompany): Promise<EnrichOutcome> {
    const companyResult = await this.opts.graph.ingestCompanies([mapped.company]);
    if (mapped.persons.length > 0) {
      await this.opts.graph.ingestPersons(mapped.persons);
    }
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

  // ---- cache-aware fetch helpers -----------------------------------------

  private async fetchBase(id: string): Promise<unknown> {
    return this.cachedGet({ endpoint: 'company.base', params: { id } }, () =>
      this.opts.client.getCompany(id),
    );
  }

  private async fetchOwners(id: string): Promise<unknown> {
    return this.cachedGet({ endpoint: 'company.owners', params: { id } }, () =>
      this.opts.client.getOwners(id),
    );
  }

  private async fetchFinancials(id: string): Promise<unknown> {
    return this.cachedGet({ endpoint: 'company.financials', params: { id } }, () =>
      this.opts.client.getFinancials(id),
    );
  }

  private async autocomplete(query: string, limit: number): Promise<unknown> {
    return this.cachedGet(
      { endpoint: 'autocomplete', params: { query, limit } },
      () => this.opts.client.autocompleteCompany(query, limit),
    );
  }

  private async cachedGet(
    key: { endpoint: string; params: Record<string, unknown> },
    fetch: () => Promise<unknown>,
  ): Promise<unknown> {
    const cache = this.opts.cache;
    const cached = cache?.get(key);
    if (cached !== undefined) {
      this.log(`[openregister-ingest] cache hit ${key.endpoint}`);
      return cached;
    }
    const fresh = await fetch();
    cache?.put(key, fresh);
    return fresh;
  }
}

/**
 * Parse the `/v1/autocomplete/company` response into a flat candidate list.
 * Response shape (from SDK): `{ results: Array<{company_id, name, address?, legal_form?, active?}> }`.
 * We take a defensive approach — unknown keys are tolerated, missing `company_id`
 * drops the entry.
 */
function extractCandidates(
  raw: unknown,
  preferredCity: string | undefined,
): EnrichCandidate[] {
  if (!raw || typeof raw !== 'object') return [];
  const results = (raw as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  const out: EnrichCandidate[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const companyId = typeof e['company_id'] === 'string' ? e['company_id'] : '';
    if (companyId.length === 0) continue;
    const name =
      typeof e['name'] === 'string'
        ? e['name']
        : extractNameField(e['name']);
    if (!name) continue;
    const city = extractCity(e);
    out.push({
      name,
      registerKey: companyId,
      ...(city ? { city } : {}),
    });
  }
  // If we have a preferred city, stable-sort city-matches first.
  if (preferredCity) {
    const cityLower = preferredCity.trim().toLowerCase();
    out.sort((a, b) => {
      const am = a.city?.toLowerCase() === cityLower ? 1 : 0;
      const bm = b.city?.toLowerCase() === cityLower ? 1 : 0;
      return bm - am;
    });
  }
  return out;
}

function extractNameField(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const name = (raw as { name?: unknown }).name;
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined;
}

function extractCity(entry: Record<string, unknown>): string | undefined {
  const address = entry['address'];
  if (address && typeof address === 'object') {
    const city = (address as { city?: unknown }).city;
    if (typeof city === 'string' && city.trim().length > 0) return city;
  }
  const city = entry['city'];
  if (typeof city === 'string' && city.trim().length > 0) return city;
  return undefined;
}
