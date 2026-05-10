import type { OpenRegisterClientConfig } from './kernel-types.js';

/**
 * Thin HTTP wrapper around the OpenRegister REST API. Same read-only shape
 * as the NorthData client: credentials in closure, payload decoding stays
 * `unknown` so a dedicated mapper can narrow responses with zod.
 *
 * Endpoints, base URL + auth scheme verified 2026-04 against:
 *   https://docs.openregister.de/authentication
 *   https://github.com/oregister/openregister-typescript (SDK source)
 *
 * Base: `https://api.openregister.de`
 * Auth: `Authorization: Bearer <OPENREGISTER_API_KEY>`
 * Stable company id: permalink-style `DE-HRB-F1103-267645` (directly usable,
 *   no secondary key derivation needed — unlike NorthData).
 *
 * Pricing note: each endpoint call consumes credits. A `standard` enrichment
 * (base + owners + financials) = 3 credits per company. The free tier is
 * 50 credits/month → ~16 enrichments before the quota bites.
 */

export class OpenRegisterClientError extends Error {
  public readonly status: number;
  public readonly upstreamBody?: string;

  constructor(message: string, status: number, upstreamBody?: string) {
    super(message);
    this.name = 'OpenRegisterClientError';
    this.status = status;
    this.upstreamBody = upstreamBody;
  }
}

interface OpenRegisterClientOptions {
  apiKey: string;
  baseUrl: string;
  maxBytes: number;
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
}

/** Token-bucket shim — same pattern as NorthDataClient's `PacedGate`. */
class PacedGate {
  private last = 0;
  constructor(private readonly minIntervalMs: number) {}
  async awaitSlot(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const waitMs = this.last + this.minIntervalMs - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.last = Date.now();
  }
}

/** Query-flag set for `/v1/company/{id}`. */
export interface CompanyDetailsQuery {
  /** Force a live pull from the Handelsregister (slower, fresher). */
  realtime?: boolean;
  /** Strip source-provenance metadata from the response. */
  export?: boolean;
}

export class OpenRegisterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: PacedGate;

  constructor(opts: OpenRegisterClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.maxBytes = opts.maxBytes;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.gate = new PacedGate(opts.minIntervalMs);
  }

  static fromConfig(config: OpenRegisterClientConfig): OpenRegisterClient {
    if (!config.OPENREGISTER_API_KEY) {
      throw new Error(
        'OpenRegisterClient.fromConfig called without OPENREGISTER_API_KEY',
      );
    }
    const rps = config.OPENREGISTER_RATE_LIMIT_RPS;
    const minIntervalMs = rps > 0 ? Math.ceil(1000 / rps) : 0;
    return new OpenRegisterClient({
      apiKey: config.OPENREGISTER_API_KEY,
      baseUrl: config.OPENREGISTER_BASE_URL,
      maxBytes: config.OPENREGISTER_MAX_BYTES,
      minIntervalMs,
    });
  }

  /** `GET /v1/autocomplete/company?query=…` — fuzzy search, cheap. */
  async autocompleteCompany(query: string, limit = 10): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/v1/autocomplete/company`);
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(limit));
    return this.request('GET', url);
  }

  /** `POST /v1/search/company` — structured search with filters. */
  async findCompanies(body: Record<string, unknown>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/v1/search/company`);
    return this.request('POST', url, body);
  }

  /** `GET /v1/company/{id}` — stammdaten + current status + representation. */
  async getCompany(
    companyId: string,
    query: CompanyDetailsQuery = {},
  ): Promise<unknown> {
    const url = new URL(
      `${this.baseUrl}/v1/company/${encodeURIComponent(companyId)}`,
    );
    if (query.realtime) url.searchParams.set('realtime', 'true');
    if (query.export) url.searchParams.set('export', 'true');
    return this.request('GET', url);
  }

  /** `GET /v1/company/{id}/owners` — current owners. */
  async getOwners(companyId: string): Promise<unknown> {
    const url = new URL(
      `${this.baseUrl}/v1/company/${encodeURIComponent(companyId)}/owners`,
    );
    return this.request('GET', url);
  }

  /** `GET /v1/company/{id}/financials` — Jahresabschlüsse. */
  async getFinancials(companyId: string): Promise<unknown> {
    const url = new URL(
      `${this.baseUrl}/v1/company/${encodeURIComponent(companyId)}/financials`,
    );
    return this.request('GET', url);
  }

  /** `GET /v1/company/{id}/ubo` — ultimate beneficial owners. */
  async getUbos(companyId: string): Promise<unknown> {
    const url = new URL(
      `${this.baseUrl}/v1/company/${encodeURIComponent(companyId)}/ubo`,
    );
    return this.request('GET', url);
  }

  /** `GET /v1/company/{id}/owners/historical` — past owners. */
  async getHistoricalOwners(companyId: string): Promise<unknown> {
    const url = new URL(
      `${this.baseUrl}/v1/company/${encodeURIComponent(companyId)}/owners/historical`,
    );
    return this.request('GET', url);
  }

  private async request(
    method: 'GET' | 'POST',
    url: URL,
    body?: Record<string, unknown>,
    attempt = 0,
  ): Promise<unknown> {
    await this.gate.awaitSlot();
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const response = await this.fetchImpl(url.toString(), init);

    if (!response.ok) {
      const bodyText = await safeReadText(response, this.maxBytes);
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        const backoffMs = response.status === 429 ? 2000 : 500;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.request(method, url, body, attempt + 1);
      }
      throw new OpenRegisterClientError(
        `OpenRegister upstream ${String(response.status)}`,
        response.status,
        bodyText,
      );
    }

    const bodyText = await safeReadText(response, this.maxBytes);
    if (bodyText === TRUNCATED_MARKER) {
      throw new OpenRegisterClientError(
        `OpenRegister response exceeded ${String(this.maxBytes)} bytes — refine the query.`,
        413,
      );
    }
    if (bodyText.length === 0) return null;
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new OpenRegisterClientError(
        'OpenRegister returned non-JSON body',
        502,
        bodyText,
      );
    }
  }
}

const TRUNCATED_MARKER = '__OPENREGISTER_BODY_TRUNCATED__';

async function safeReadText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return TRUNCATED_MARKER;
  }
  return text;
}
