/**
 * Generic read-only Odoo native tools — the orchestrator-level counterpart to
 * the scope-locked `odoo_execute` sub-agent tool.
 *
 * Mirrors the Dynamics-365 integration's `dynamics_query` / `dynamics_describe`
 * convention: a small, model-agnostic read surface the top-level orchestrator
 * can call directly, without routing through a domain sub-agent.
 *
 *   - `odoo_query`    read records (search_read) from a whitelisted model
 *   - `odoo_describe` discover the schema (fields_get) or list allowed models
 *   - `odoo_version`  report the connected Odoo server version
 *
 * SAFETY: `odoo_query` / `odoo_describe` are config-gated (default OFF) because
 * exposing reads at orchestrator level widens the surface beyond the HR /
 * accounting sub-agent boundary. When enabled, every call still routes through
 * `executeOdoo`, so the model whitelist, the read-only method whitelist, the
 * response cache, and — critically — the HR red-line field stripping all
 * remain in force. `odoo_version` leaks no business data and is always on.
 */

import { z } from 'zod';

import { OdooClientError, type OdooClient, type OdooServerVersion } from './odooClient.js';
import {
  ALLOWED_METHODS,
  ALLOWED_MODELS,
  executeOdoo,
  scopeForModel,
  type OdooScope,
} from './odooCore.js';
import type { EntityRefBus } from './kernel-types.js';
import type { OdooResponseCache } from './odooResponseCache.js';

const MAX_OUTPUT_CHARS = 40_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface OdooReadToolDeps {
  client: OdooClient;
  entityRefBus: EntityRefBus;
  responseCache?: OdooResponseCache;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function allowedModelsLine(): string {
  return (Object.keys(ALLOWED_MODELS) as OdooScope[])
    .map((s) => `${s}: ${[...ALLOWED_MODELS[s]].sort().join(', ')}`)
    .join(' | ');
}

/** Run an already-scoped read through the core guard and stringify the result. */
async function runRead(
  scope: OdooScope,
  model: string,
  method: string,
  positionalArgs: unknown[],
  kwargs: Record<string, unknown>,
  deps: OdooReadToolDeps,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
  try {
    const outcome = await executeOdoo(
      { scope, model, method, positionalArgs, kwargs },
      deps,
    );
    if (!outcome.ok) {
      switch (outcome.error.kind) {
        case 'method_not_allowed':
          return {
            ok: false,
            message: `Error: method_not_allowed — ${outcome.error.method}. Allowed: ${[...ALLOWED_METHODS].join(', ')}.`,
          };
        case 'model_not_allowed':
          return {
            ok: false,
            message: `Error: model_not_allowed — ${outcome.error.model} is not in the ${scope} whitelist.`,
          };
        case 'hr_red_line_field':
          return {
            ok: false,
            message: `Error: hr_red_line_field — field \`${outcome.error.field}\` is server-side blocked (wages, tax IDs, bank/private contact data). Not retrievable.`,
          };
      }
    }
    return { ok: true, result: (outcome as { result: unknown }).result };
  } catch (err) {
    if (err instanceof OdooClientError) {
      return { ok: false, message: `Error: odoo_upstream_${String(err.status)} — ${err.message}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Error: odoo_network_error — ${msg}` };
  }
}

function boundJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length > MAX_OUTPUT_CHARS) {
    return `${json.slice(0, MAX_OUTPUT_CHARS)}\n\n…[truncated, original ${String(json.length)} chars — narrow with \`limit\` or \`fields\`]`;
  }
  return json;
}

// ---------------------------------------------------------------------------
// odoo_query
// ---------------------------------------------------------------------------

const QueryInputSchema = z.object({
  model: z.string().min(1).max(120),
  domain: z.array(z.unknown()).optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  order: z.string().optional(),
});

export const odooQueryToolSpec = {
  name: 'odoo_query',
  description: [
    'Read records from Odoo (read-only search_read). Use for questions about ERP data across the whitelisted HR + accounting models.',
    'Pass the Odoo model (e.g. "account.move", "hr.employee"), an optional Odoo domain filter, the fields to return, and a limit.',
    'NEVER creates, updates or deletes. HR red-line fields (wages, tax IDs, bank/private contact data) are blocked server-side.',
    `Allowed models — ${allowedModelsLine()}.`,
  ].join(' '),
  input_schema: {
    type: 'object' as const,
    properties: {
      model: {
        type: 'string',
        description: 'Odoo model technical name, e.g. "account.move", "res.partner", "hr.employee", "hr.leave".',
      },
      domain: {
        type: 'array',
        description:
          'Odoo search domain as a nested array, e.g. [["state","=","posted"],["move_type","=","out_invoice"]]. Omit for no filter.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fields to return, e.g. ["name","amount_total","invoice_date"]. Omit to let Odoo choose defaults (heavier).',
      },
      limit: {
        type: 'number',
        description: `Max rows (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
      },
      offset: { type: 'number', description: 'Row offset for paging. Default 0.' },
      order: { type: 'string', description: 'Sort, e.g. "invoice_date desc, name asc".' },
    },
    required: ['model'],
  },
};

export const ODOO_QUERY_PROMPT_DOC =
  '\n- `odoo_query`: read-only Odoo ERP reads (search_read) across whitelisted HR + accounting models — pass `model`, optional Odoo `domain` filter, `fields`, `limit` (max 100). NEVER writes. HR red-line fields (wages, bank/private data) are blocked server-side. Use `odoo_describe` first if unsure which fields a model exposes.\n';

export function createOdooQueryHandler(deps: OdooReadToolDeps) {
  return async (input: unknown): Promise<string> => {
    const parsed = QueryInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid odoo_query input — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    }
    const { model, domain, fields, limit, offset, order } = parsed.data;
    const scope = scopeForModel(model);
    if (!scope) {
      return `Error: model_not_allowed — "${model}" is not in any read whitelist. Allowed — ${allowedModelsLine()}.`;
    }
    const kwargs: Record<string, unknown> = {
      limit: Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    };
    if (fields) kwargs['fields'] = fields;
    if (offset !== undefined) kwargs['offset'] = offset;
    if (order !== undefined) kwargs['order'] = order;

    const res = await runRead(scope, model, 'search_read', [domain ?? []], kwargs, deps);
    if (!res.ok) return res.message;
    const rows = Array.isArray(res.result) ? res.result : [];
    return boundJson({
      model,
      scope,
      count: rows.length,
      truncated: rows.length >= Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
      records: res.result,
    });
  };
}

// ---------------------------------------------------------------------------
// odoo_describe
// ---------------------------------------------------------------------------

const DescribeInputSchema = z.object({
  model: z.string().min(1).max(120).optional(),
});

export const odooDescribeToolSpec = {
  name: 'odoo_describe',
  description: [
    'Discover the Odoo schema. With no arguments, lists the whitelisted models grouped by scope (hr / accounting).',
    'With "model" set, lists that model\'s fields (name + type + label) via fields_get so you can build a precise odoo_query.',
    'Read-only. Call this before odoo_query when unsure which fields a model exposes.',
  ].join(' '),
  input_schema: {
    type: 'object' as const,
    properties: {
      model: {
        type: 'string',
        description: 'Odoo model technical name to describe its fields, e.g. "account.move". Omit to list the allowed models.',
      },
    },
    required: [],
  },
};

export const ODOO_DESCRIBE_PROMPT_DOC =
  '\n- `odoo_describe`: discover the Odoo schema. No args → list the whitelisted models per scope (hr / accounting). `model` set → list that model\'s fields (name + type + label) via fields_get. Call this before `odoo_query` whenever you are unsure of the exact field names.\n';

export function createOdooDescribeHandler(deps: OdooReadToolDeps) {
  return async (input: unknown): Promise<string> => {
    const parsed = DescribeInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid odoo_describe input — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    }
    const model = parsed.data.model?.trim();

    // No model → list the whitelist, no network call.
    if (!model) {
      return boundJson({
        scopes: (Object.keys(ALLOWED_MODELS) as OdooScope[]).map((scope) => ({
          scope,
          models: [...ALLOWED_MODELS[scope]].sort(),
        })),
        methods: [...ALLOWED_METHODS],
      });
    }

    const scope = scopeForModel(model);
    if (!scope) {
      return `Error: model_not_allowed — "${model}" is not in any read whitelist. Allowed — ${allowedModelsLine()}.`;
    }
    const res = await runRead(
      scope,
      model,
      'fields_get',
      [],
      { attributes: ['string', 'type', 'help'] },
      deps,
    );
    if (!res.ok) return res.message;
    // fields_get returns a { field: {string,type,help} } map — flatten to a
    // compact list so the model gets the names without the verbose metadata.
    const fieldsMap = (res.result ?? {}) as Record<string, { string?: string; type?: string }>;
    const fields = Object.entries(fieldsMap).map(([name, meta]) => ({
      name,
      type: meta?.type,
      label: meta?.string,
    }));
    return boundJson({ model, scope, count: fields.length, fields });
  };
}

// ---------------------------------------------------------------------------
// odoo_version
// ---------------------------------------------------------------------------

export const odooVersionToolSpec = {
  name: 'odoo_version',
  description:
    'Report the connected Odoo server version (server_version + version info). Read-only metadata, no business data. Use when the user asks which Odoo version / release the instance runs.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export const ODOO_VERSION_PROMPT_DOC =
  '\n- `odoo_version`: report the connected Odoo server version (e.g. "17.0"). Use when the user asks which Odoo version / release the instance is on.\n';

export function createOdooVersionHandler(deps: OdooReadToolDeps) {
  return async (): Promise<string> => {
    try {
      const v: OdooServerVersion = await deps.client.version();
      return JSON.stringify({
        server_version: v.server_version,
        server_serie: v.server_serie,
        server_version_info: v.server_version_info,
        protocol_version: v.protocol_version,
      });
    } catch (err) {
      if (err instanceof OdooClientError) {
        return `Error: odoo_upstream_${String(err.status)} — ${err.message}`;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: odoo_network_error — ${msg}`;
    }
  };
}
