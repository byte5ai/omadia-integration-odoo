import type { PluginContext } from '@omadia/plugin-api';

import { readBoolean, readPositiveInt, type Warn } from './configValues.js';

/** Default cap for one Odoo response body, in bytes. */
export const DEFAULT_ODOO_MAX_BYTES = 500_000;

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
 * use. Reads typed and legacy string values the same way the rest of the
 * plugin does (`configValues.ts`, omadia#1478); `warn` receives the message
 * for a value it cannot read. Throws when a required field is missing.
 */
export async function readOdooConnectionSettings(
  ctx: PluginContext,
  warn: Warn = () => undefined,
): Promise<OdooConnectionSettings> {
  const apiKey = await ctx.secrets.require('odoo_api_key');
  const url = ctx.config.require<string>('odoo_url');
  const db = ctx.config.require<string>('odoo_db');
  const login = ctx.config.require<string>('odoo_login');
  const maxBytes = readPositiveInt(
    'odoo_proxy_max_bytes',
    ctx.config.get<unknown>('odoo_proxy_max_bytes'),
    DEFAULT_ODOO_MAX_BYTES,
    warn,
  );
  const insecureTls = readBoolean(
    'odoo_insecure_tls',
    ctx.config.get<unknown>('odoo_insecure_tls'),
    false,
    warn,
  );
  return { url, db, login, apiKey, maxBytes, insecureTls };
}
