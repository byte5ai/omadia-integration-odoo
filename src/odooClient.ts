import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import type { PluginContext } from '@omadia/plugin-api';
import type { OdooClientConfig } from './kernel-types.js';

export class OdooClientError extends Error {
  public readonly status: number;
  public readonly upstreamBody?: string;

  constructor(message: string, status: number, upstreamBody?: string) {
    super(message);
    this.name = 'OdooClientError';
    this.status = status;
    this.upstreamBody = upstreamBody;
  }
}

interface OdooClientOptions {
  url: string;
  db: string;
  login: string;
  apiKey: string;
  maxBytes: number;
  /** When true, disable TLS verification for Odoo requests only. Used for
   * local dev against a private-CA-signed Odoo; never enable in production. */
  insecureTls?: boolean;
  fetchImpl?: typeof fetch;
}

export interface OdooExecuteRequest {
  model: string;
  method: string;
  positionalArgs: unknown[];
  kwargs: Record<string, unknown>;
}

/**
 * Thin JSON-RPC wrapper around the Odoo /jsonrpc endpoint. Caches the
 * authenticated UID in-process and transparently re-authenticates when
 * Odoo reports a stale session.
 */
export class OdooClient {
  private readonly url: string;
  private readonly db: string;
  private readonly login: string;
  private readonly apiKey: string;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  private uidPromise: Promise<number> | undefined;

  constructor(opts: OdooClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.db = opts.db;
    this.login = opts.login;
    this.apiKey = opts.apiKey;
    this.maxBytes = opts.maxBytes;
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
    if (!config.ODOO_URL || !config.ODOO_DB || !config.ODOO_LOGIN || !config.ODOO_API_KEY) {
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
    const db = ctx.config.require<string>('odoo_db');
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

  private async authenticate(): Promise<number> {
    const response = await this.rpc({
      service: 'common',
      method: 'authenticate',
      args: [this.db, this.login, this.apiKey, {}],
    });
    if (typeof response !== 'number' || !Number.isInteger(response) || response <= 0) {
      throw new OdooClientError(
        `Odoo authentication failed: unexpected response ${JSON.stringify(response)}`,
        401,
      );
    }
    return response;
  }

  async execute(req: OdooExecuteRequest): Promise<unknown> {
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

  private async executeOnce(req: OdooExecuteRequest): Promise<unknown> {
    const uid = await this.getUid();
    return this.rpc({
      service: 'object',
      method: 'execute_kw',
      args: [this.db, uid, this.apiKey, req.model, req.method, req.positionalArgs, req.kwargs],
    });
  }

  private async rpc(params: {
    service: string;
    method: string;
    args: unknown[];
  }): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', params });
    const response = await this.fetchImpl(`${this.url}/jsonrpc`, {
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
