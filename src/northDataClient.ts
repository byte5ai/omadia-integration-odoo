import type { NorthDataClientConfig } from './kernel-types.js';

/**
 * Thin HTTP wrapper around the NorthData Data API. Same read-only shape as
 * ConfluenceClient: credentials live in closure, payload decoding stays
 * `unknown` so a dedicated mapper can narrow the response with zod.
 *
 * Endpoint set, verified against
 *   https://github.com/northdata/api/blob/master/swagger.yaml
 *   https://github.com/northdata/api/blob/master/doc/data-api-userguide/data-api-userguide.md
 * (checked 2026-04):
 *
 *   GET /company/v1/company        single-company lookup + detail
 *   GET /person/v1/person          single-person lookup
 *   GET /search/v1/universal       universal text search
 *   GET /search/v1/power           power search (financials, events, geo)
 *   GET /pub/v1/publications       company publications (insolvency, HR, etc.)
 *   GET /reference/v1/overview     dynamic reference data (event types, ...)
 *
 * Stable external identifier is `register.uniqueKey` — a string like
 * "12203550103038" — NOT the internal `companyId` (which NorthData explicitly
 * warns against storing, see Appendix B of the user guide).
 *
 * Auth: `X-Api-Key: XXXX-XXXX` HTTPS header (method 1, recommended for
 * production). The `?api_key=` query-param variant (method 2) is only used as
 * a fallback when callers stream the key via query strings — not the default
 * here.
 */

/**
 * Opt-in detail flags for `/company/v1/company`. Matches the swagger-defined
 * boolean query params one-for-one — each one makes the response heavier (and,
 * on Premium plans, more expensive), so callers pick only what they need.
 *
 *   history          earlier names, addresses, register entries
 *   financials       `Financials` block (Umsatz, EK, Bilanzsumme, ...)
 *   events           lifecycle events (NameChange, Incorporation, Insolvency)
 *   eventType        pipe-separated filter, see `getReferenceOverview`
 *   maxEvents        cap on returned events
 *   relations        all relations (implies owners + representatives)
 *   owners           shareholders of the subject company
 *   ownerships       companies owned by the subject
 *   representatives  managing directors / board members
 *   sheets           balance / earnings / cashflow structured rows
 *   extras           3rd-party extras (vatId, email, phone, fax, url, wz)
 *   alwaysResolve    always re-fetch related companies from the live DB
 *   fuzzyMatch       best-effort name match when `registerKey` isn't known
 */
export interface CompanyDetailOptions {
  address?: string;
  history?: boolean;
  financials?: boolean;
  events?: boolean;
  eventType?: string;
  maxEvents?: number;
  relations?: boolean;
  owners?: boolean;
  ownerships?: boolean;
  representatives?: boolean;
  sheets?: boolean;
  extras?: boolean;
  alwaysResolve?: boolean;
  fuzzyMatch?: boolean;
}

function applyCompanyDetailFlags(url: URL, options: CompanyDetailOptions): void {
  if (options.history) url.searchParams.set('history', 'true');
  if (options.financials) url.searchParams.set('financials', 'true');
  if (options.events) url.searchParams.set('events', 'true');
  if (options.eventType) url.searchParams.set('eventType', options.eventType);
  if (options.maxEvents !== undefined)
    url.searchParams.set('maxEvents', String(options.maxEvents));
  if (options.relations) url.searchParams.set('relations', 'true');
  if (options.owners) url.searchParams.set('owners', 'true');
  if (options.ownerships) url.searchParams.set('ownerships', 'true');
  if (options.representatives) url.searchParams.set('representatives', 'true');
  if (options.sheets) url.searchParams.set('sheets', 'true');
  if (options.extras) url.searchParams.set('extras', 'true');
  if (options.alwaysResolve) url.searchParams.set('alwaysResolve', 'true');
}

export class NorthDataClientError extends Error {
  public readonly status: number;
  public readonly upstreamBody?: string;

  constructor(message: string, status: number, upstreamBody?: string) {
    super(message);
    this.name = 'NorthDataClientError';
    this.status = status;
    this.upstreamBody = upstreamBody;
  }
}

interface NorthDataClientOptions {
  apiKey: string;
  baseUrl: string;
  maxBytes: number;
  /** Minimum interval between outbound requests in ms — derived from RPS. */
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Token-bucket rate limiter boiled down to the single-token case we need:
 * `awaitSlot()` resolves at most once per `minIntervalMs`. Per-process, which
 * is enough given the middleware runs one machine at a time in Fly. When we
 * scale out horizontally the Premium quota will need a distributed limiter.
 */
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

export class NorthDataClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: PacedGate;

  constructor(opts: NorthDataClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.maxBytes = opts.maxBytes;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.gate = new PacedGate(opts.minIntervalMs);
  }

  static fromConfig(config: NorthDataClientConfig): NorthDataClient {
    if (!config.NORTHDATA_API_KEY) {
      throw new Error('NorthDataClient.fromConfig called without NORTHDATA_API_KEY');
    }
    const rps = config.NORTHDATA_RATE_LIMIT_RPS;
    const minIntervalMs = rps > 0 ? Math.ceil(1000 / rps) : 0;
    return new NorthDataClient({
      apiKey: config.NORTHDATA_API_KEY,
      baseUrl: config.NORTHDATA_BASE_URL,
      maxBytes: config.NORTHDATA_MAX_BYTES,
      minIntervalMs,
    });
  }

  /**
   * Fuzzy company lookup by name + optional city ("address"). Returns a single
   * best-match `Company` when the name is specific enough — NorthData's
   * `/company/v1/company` endpoint serves as both a single-record getter and a
   * fuzzy finder depending on arguments. For ranked search over many hits use
   * {@link universalSearch} or {@link powerSearch}.
   */
  async findCompanyByName(
    name: string,
    options: CompanyDetailOptions = {},
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/company/v1/company`);
    url.searchParams.set('name', name);
    if (options.address) url.searchParams.set('address', options.address);
    if (options.fuzzyMatch !== false) url.searchParams.set('fuzzyMatch', 'true');
    applyCompanyDetailFlags(url, options);
    return this.request('GET', url);
  }

  /**
   * Stable-id company lookup. `registerKey` is the `register.uniqueKey` field
   * surfaced on every Company — the official canonical identifier (see user
   * guide, "Identifying a company by register ID"). Returns full company
   * detail shaped by the opt-in flags in `options`.
   */
  async getCompanyByRegisterKey(
    registerKey: string,
    options: CompanyDetailOptions = {},
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/company/v1/company`);
    url.searchParams.set('registerKey', registerKey);
    applyCompanyDetailFlags(url, options);
    return this.request('GET', url);
  }

  /** Direct person lookup by NorthData person id. */
  async getPerson(personId: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/person/v1/person`);
    url.searchParams.set('id', personId);
    return this.request('GET', url);
  }

  /** Universal ranked search across NorthData entries — matches the widget
   *  suggest box. Returns a `SearchResults` envelope. */
  async universalSearch(query: string, limit = 10): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/search/v1/universal`);
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(limit));
    return this.request('GET', url);
  }

  /**
   * Publication stream (Handelsregister / Bundesanzeiger / insolvency / UT).
   * Phase-5 change-monitoring reads this daily with a `minTimestamp` window
   * per source — see user guide "Retrieving publications" for the pattern.
   */
  async getPublications(
    minTimestamp: string,
    maxTimestamp: string,
    source?: string,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/pub/v1/publications`);
    url.searchParams.set('minTimestamp', minTimestamp);
    url.searchParams.set('maxTimestamp', maxTimestamp);
    if (source) url.searchParams.set('source', source);
    return this.request('GET', url);
  }

  /** Reference data: event types, segment-code standards, register list. */
  async getReferenceOverview(): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/reference/v1/overview`);
    return this.request('GET', url);
  }

  private async request(method: 'GET', url: URL, attempt = 0): Promise<unknown> {
    await this.gate.awaitSlot();
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        // NorthData uses `X-Api-Key` (method 1 in the user guide).
        // `api_key=` query-string fallback is intentionally not wired — keys
        // leak into access logs that way.
        'X-Api-Key': this.apiKey,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response, this.maxBytes);
      // One backoff-retry on 429 + 5xx. Longer chains hide the failure and
      // burn quota — if the upstream is sick, fail fast and let the caller
      // fall back (e.g. cached summary, user-visible error).
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        const backoffMs = response.status === 429 ? 2000 : 500;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.request(method, url, attempt + 1);
      }
      throw new NorthDataClientError(
        `NorthData upstream ${String(response.status)}`,
        response.status,
        bodyText,
      );
    }

    const bodyText = await safeReadText(response, this.maxBytes);
    if (bodyText === TRUNCATED_MARKER) {
      throw new NorthDataClientError(
        `NorthData response exceeded ${String(this.maxBytes)} bytes — refine the query.`,
        413,
      );
    }
    if (bodyText.length === 0) return null;
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new NorthDataClientError('NorthData returned non-JSON body', 502, bodyText);
    }
  }
}

const TRUNCATED_MARKER = '__NORTHDATA_BODY_TRUNCATED__';

async function safeReadText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return TRUNCATED_MARKER;
  }
  return text;
}
