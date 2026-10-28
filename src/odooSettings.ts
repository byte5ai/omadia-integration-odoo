import type { PluginContext } from '@omadia/plugin-api';

/** Default cap for one Odoo response body, in bytes. */
export const DEFAULT_ODOO_MAX_BYTES = 500_000;

export function parseBoolean(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Everything an `OdooClient` needs to reach and authenticate against Odoo. */
export interface OdooConnectionSettings {
  readonly url: string;
  readonly db: string;
  readonly login: string;
  readonly apiKey: string;
  readonly maxBytes: number;
  readonly insecureTls: boolean;
}

/**
 * Read the Odoo connection from the plugin context: the API key from the
 * vault, the rest from the setup fields. Shared by `activate()` and
 * `verifyConnection()` so the probe checks exactly the connection the tools
 * use. Throws when a required field is missing.
 */
export async function readOdooConnectionSettings(
  ctx: PluginContext,
): Promise<OdooConnectionSettings> {
  const apiKey = await ctx.secrets.require('odoo_api_key');
  const url = ctx.config.require<string>('odoo_url');
  const db = ctx.config.require<string>('odoo_db');
  const login = ctx.config.require<string>('odoo_login');
  const maxBytes = parsePositiveInt(
    ctx.config.get<string>('odoo_proxy_max_bytes'),
    DEFAULT_ODOO_MAX_BYTES,
  );
  const insecureTls = parseBoolean(ctx.config.get<string>('odoo_insecure_tls'));
  return { url, db, login, apiKey, maxBytes, insecureTls };
}
