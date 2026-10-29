import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import type { ConnectionRejectionCause, PluginContext } from '@omadia/plugin-api';
import { readString } from './configValues.js';
import type { OdooClientConfig } from './kernel-types.js';

/**
 * Issue omadia#1453 — the two ways Odoo explicitly refuses our credentials.
 * `protocol_auth_failure`: `common.authenticate` answered something other than
 * a positive uid (Odoo says "wrong key" with `false` over HTTP 200).
 * `http_401`: the endpoint itself answered 401 (e.g. a reverse proxy in front
 * of Odoo). Everything else — 5xx, timeouts, DNS, unparseable bodies — is NOT
 * an auth verdict and carries no rejection.
 */
export type OdooAuthRejection = Extract<
  ConnectionRejectionCause,
  'protocol_auth_failure' | 'http_401'
>;

export class OdooClientError extends Error {
  public readonly status: number;
  public readonly upstreamBody?: string;
  /** Set only when Odoo explicitly refused the credentials. */
  public readonly authRejection?: OdooAuthRejection;

  constructor(
    message: string,
    status: number,
    upstreamBody?: string,
    authRejection?: OdooAuthRejection,
  ) {
    super(message);
    this.name = 'OdooClientError';
    this.status = status;
    this.upstreamBody = upstreamBody;
    this.authRejection = authRejection;
  }
}

/** The explicit credential refusal carried by `err`, or `undefined`. */
export function authRejectionOf(err: unknown): OdooAuthRejection | undefined {
  return err instanceof OdooClientError ? err.authRejection : undefined;
}

/**
 * Issue omadia#1453 — notified about the auth outcome of every `execute()`
 * call, so the plugin can surface a key that Odoo stopped accepting while the
 * plugin is running (revoked/expired upstream) without waiting for a chat turn.
 */
export interface OdooAuthObserver {
  /** Odoo explicitly refused the credentials on a real call. */
  onAuthRejected(cause: OdooAuthRejection): void;
  /** A real, authenticated call succeeded. */
  onAuthAccepted(): void;
}

interface OdooClientOptions {
  url: string;
  /** Odoo database name. Empty or absent: use the first database the
   * instance lists at `/web/database/list`. */
  db?: string;
  login: string;
  apiKey: string;
  maxBytes: number;
  /** When true, disable TLS verification for Odoo requests only. Used for
   * local dev against a private-CA-signed Odoo; never enable in production. */
  insecureTls?: boolean;
  fetchImpl?: typeof fetch;
  authObserver?: OdooAuthObserver;
}

export interface OdooExecuteRequest {
  model: string;
  method: string;
  positionalArgs: unknown[];
  kwargs: Record<string, unknown>;
}

/** Shape of the Odoo `common.version` payload (fields are best-effort). */
export interface OdooServerVersion {
  server_version?: string;
  server_version_info?: unknown[];
  server_serie?: string;
  protocol_version?: number;
}

/**
 * Thin JSON-RPC wrapper around the Odoo /jsonrpc endpoint. Caches the
 * authenticated UID in-process and transparently re-authenticates when
 * Odoo reports a stale session.
 */
export class OdooClient {
  private readonly url: string;
  /** Set when the operator named a database; otherwise discovered once. */
  private readonly configuredDb: string | undefined;
  private readonly login: string;
  private readonly apiKey: string;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly authObserver: OdooAuthObserver | undefined;

  private uidPromise: Promise<number> | undefined;
  private dbPromise: Promise<string> | undefined;

  constructor(opts: OdooClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.configuredDb = opts.db?.trim() || undefined;
    this.login = opts.login;
    this.apiKey = opts.apiKey;
    this.maxBytes = opts.maxBytes;
    this.authObserver = opts.authObserver;
    if (opts.fetchImpl) {
      this.fetchImpl = opts.fetchImpl;
    } else if (opts.insecureTls) {
      // Scoped TLS bypass: a private undici Agent that skips cert verification
      // is bound only to this client's fetches. Node's global fetch and
      // Anthropic/Confluence connections keep full verification.
      const agent = new UndiciAgent({ connect: { rejectUnauthorized: false } });
      this.fetchImpl = ((
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) =>
        undiciFetch(input as string, {
          ...(init as Record<string, unknown>),
          dispatcher: agent,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)) as unknown as typeof fetch;
      console.warn(
        '[odoo-client] ⚠ TLS verification DISABLED for Odoo requests (ODOO_INSECURE_TLS=true) — LOCAL USE ONLY',
      );
    } else {
      this.fetchImpl = fetch;
    }
  }

  static fromConfig(config: OdooClientConfig): OdooClient {
    if (!config.ODOO_URL || !config.ODOO_LOGIN || !config.ODOO_API_KEY) {
      throw new Error('OdooClient.fromConfig called without required secrets');
    }
    return new OdooClient({
      url: config.ODOO_URL,
      db: config.ODOO_DB,
      login: config.ODOO_LOGIN,
      apiKey: config.ODOO_API_KEY,
      maxBytes: config.ODOO_PROXY_MAX_BYTES,
      insecureTls: config.ODOO_INSECURE_TLS,
    });
  }

  /**
   * Build a client from a PluginContext. Secrets come from the vault, the
   * non-secret fields from the installed-agent registry. Because HR and
   * Accounting both `depends_on` the Odoo integration, their ctx resolves to
   * the same credentials — a shared client for both is therefore safe.
   */
  static async fromContext(
    ctx: PluginContext,
    operational: { maxBytes: number; insecureTls: boolean },
  ): Promise<OdooClient> {
    const apiKey = await ctx.secrets.require('odoo_api_key');
    const url = ctx.config.require<string>('odoo_url');
    const db = readString(ctx.config.get<unknown>('odoo_db'), '') || undefined;
    const login = ctx.config.require<string>('odoo_login');
    return new OdooClient({
      url,
      db,
      login,
      apiKey,
      maxBytes: operational.maxBytes,
      insecureTls: operational.insecureTls,
    });
  }

  /** Force a re-auth on the next execute(). Called after the first attempt
   * surfaces a session-related error. */
  invalidateSession(): void {
    this.uidPromise = undefined;
  }

  /**
   * Odoo server version + capability info via the unauthenticated `common`
   * service `version` method. Cheap, no UID/auth needed — used by the
   * `odoo_version` native tool to answer "which Odoo version are we on?".
   * Returns the raw Odoo payload: `{ server_version, server_version_info,
   * server_serie, protocol_version }`.
   */
  async version(): Promise<OdooServerVersion> {
    const result = await this.rpc({
      service: 'common',
      method: 'version',
      args: [],
    });
    return (result ?? {}) as OdooServerVersion;
  }

  /**
   * The database every call runs against: the configured one, or the first
   * entry of Odoo's `/web/database/list` when the setup left it empty. The
   * discovered name is cached for the client's lifetime; a failed lookup is
   * not, so the next call asks again.
   */
  async getDb(): Promise<string> {
    if (this.configuredDb) return this.configuredDb;
    if (!this.dbPromise) {
      this.dbPromise = this.discoverDb().catch((err) => {
        this.dbPromise = undefined;
        throw err;
      });
    }
    return this.dbPromise;
  }

  private async discoverDb(): Promise<string> {
    let listed: unknown;
    try {
      listed = await this.postJsonRpc('/web/database/list', {});
    } catch (err) {
      // Typically `list_db = False` on the server, or a proxy that blocks
      // `/web/database/*`. Not a credential verdict, and neither an upstream
      // body nor a 401 status, so it never reads as an expired session.
      const reason = err instanceof Error ? err.message : String(err);
      const status = err instanceof OdooClientError ? err.status : 502;
      throw new OdooClientError(
        `Odoo database list unavailable (${reason}) — set the database name in the setup`,
        status === 401 ? 502 : status,
      );
    }
    const names = Array.isArray(listed)
      ? listed.filter((n): n is string => typeof n === 'string' && n !== '')
      : [];
    const first = names[0];
    if (!first) {
      throw new OdooClientError(
        'Odoo lists no database — set the database name in the setup',
        404,
      );
    }
    console.log(
      `[odoo-client] no database configured — using "${first}" (first of ${String(names.length)} listed by ${this.url})`,
    );
    return first;
  }

  /** Returns the cached UID or authenticates on demand. */
  async getUid(): Promise<number> {
    if (!this.uidPromise) {
      this.uidPromise = this.authenticate().catch((err) => {
        // Clear the cache so the *next* caller retries instead of seeing the
        // stale rejected promise forever.
        this.uidPromise = undefined;
        throw err;
      });
    }
    return this.uidPromise;
  }

  /**
   * Issue omadia#1453 — ask Odoo whether the credentials are accepted right
   * now. Always a fresh `common.authenticate` (never the cached uid), so a key
   * revoked since the last call is noticed. Resolves on acceptance; rejects
   * with an `OdooClientError` otherwise — check `authRejectionOf(err)` to tell
   * an explicit refusal from an outage. Does not notify the auth observer:
   * the caller (the kernel's connection probe) records its own verdict.
   */
  async checkCredentials(): Promise<void> {
    await this.authenticate();
  }

  private async authenticate(): Promise<number> {
    const db = await this.getDb();
    const response = await this.rpc({
      service: 'common',
      method: 'authenticate',
      args: [db, this.login, this.apiKey, {}],
    });
    if (typeof response !== 'number' || !Number.isInteger(response) || response <= 0) {
      // Odoo answers `false` for a wrong key and for a user missing from the
      // database alike, so a discovered database stays a rejection — but the
      // message names it, since it may not be the one the operator meant.
      const dbHint = this.configuredDb
        ? ''
        : ` (database "${db}" is the first one Odoo lists — if the instance has several, set the database name in the setup)`;
      throw new OdooClientError(
        `Odoo authentication failed: unexpected response ${JSON.stringify(response)}${dbHint}`,
        401,
        undefined,
        'protocol_auth_failure',
      );
    }
    return response;
  }

  async execute(req: OdooExecuteRequest): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.executeWithSessionRetry(req);
    } catch (err) {
      const rejection = authRejectionOf(err);
      if (rejection) this.notifyObserver((o) => o.onAuthRejected(rejection));
      throw err;
    }
    this.notifyObserver((o) => o.onAuthAccepted());
    return result;
  }

  private async executeWithSessionRetry(req: OdooExecuteRequest): Promise<unknown> {
    try {
      return await this.executeOnce(req);
    } catch (err) {
      if (err instanceof OdooClientError && isSessionError(err)) {
        this.invalidateSession();
        return this.executeOnce(req);
      }
      throw err;
    }
  }

  /** A failing observer must never turn a successful Odoo call into an error
   *  or mask the original one. */
  private notifyObserver(fn: (observer: OdooAuthObserver) => void): void {
    if (!this.authObserver) return;
    try {
      fn(this.authObserver);
    } catch (err) {
      console.error(
        '[odoo-client] auth observer failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async executeOnce(req: OdooExecuteRequest): Promise<unknown> {
    const uid = await this.getUid();
    const db = await this.getDb();
    return this.rpc({
      service: 'object',
      method: 'execute_kw',
      args: [db, uid, this.apiKey, req.model, req.method, req.positionalArgs, req.kwargs],
    });
  }

  private async rpc(params: {
    service: string;
    method: string;
    args: unknown[];
  }): Promise<unknown> {
    return this.postJsonRpc('/jsonrpc', params);
  }

  private async postJsonRpc(path: string, params: object): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', params });
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const text = await safeReadText(response, this.maxBytes);
      throw new OdooClientError(
        `Odoo HTTP ${response.status}`,
        response.status,
        text === TRUNCATED ? undefined : text,
        response.status === 401 ? 'http_401' : undefined,
      );
    }

    const text = await safeReadText(response, this.maxBytes);
    if (text === TRUNCATED) {
      throw new OdooClientError(
        `Odoo response exceeded ${this.maxBytes} bytes — verfeinere limit oder fields.`,
        413,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OdooClientError('Odoo returned non-JSON body', 502, text);
    }

    if (isJsonRpcError(parsed)) {
      const message = extractErrorMessage(parsed);
      throw new OdooClientError(`Odoo JSON-RPC error: ${message}`, 502, JSON.stringify(parsed));
    }
    if (isJsonRpcResult(parsed)) {
      return parsed.result;
    }
    throw new OdooClientError('Unexpected JSON-RPC response shape', 502, text);
  }
}

const TRUNCATED = '__ODOO_BODY_TRUNCATED__';

async function safeReadText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return TRUNCATED;
  return text;
}

function isJsonRpcError(value: unknown): value is { error: unknown } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function isJsonRpcResult(value: unknown): value is { result: unknown } {
  return typeof value === 'object' && value !== null && 'result' in value;
}

function isSessionError(err: OdooClientError): boolean {
  // Odoo surfaces expired sessions as JSON-RPC errors, not HTTP 401 — the
  // message hints are the only reliable signal.
  if (err.status === 401) return true;
  const body = err.upstreamBody ?? '';
  return /session_expired|access(?:_denied|Error)|AccessDenied/i.test(body);
}

function extractErrorMessage(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return 'unknown error';
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'object' && error !== null) {
    const asRecord = error as Record<string, unknown>;
    const data = asRecord['data'];
    if (typeof data === 'object' && data !== null) {
      const message = (data as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    const message = asRecord['message'];
    if (typeof message === 'string') return message;
  }
  return 'unknown error';
}
