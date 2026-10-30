/**
 * `odoo.schema@1` — the Odoo schema this integration can read, for kernel
 * consumers that need it before any chat has touched a model (byte5ai/omadia
 * field classification, #1630 follow-up: suggestions right after activation).
 *
 * Schema only. `listModels()` is the read whitelist (no network call) plus
 * the tool names whose results carry each model's fields. `describeModel()`
 * runs ONE `fields_get` through `executeOdoo`, so the whitelist, the response
 * cache and the HR red-line stripping apply exactly as for `odoo_describe`: a
 * red-line field (wages, bank/private data) is never listed. No record is
 * read, no value crosses this service.
 */

import { ALLOWED_MODELS, executeOdoo, scopeForModel, type OdooScope } from './odooCore.js';
import type { OdooReadToolDeps } from './odooReadTools.js';

export const ODOO_SCHEMA_SERVICE_NAME = 'odoo.schema';

/** The scope-locked sub-agent tool every whitelisted model is read through. */
export const ODOO_EXECUTE_TOOL_NAME = 'odoo_execute';
/** The orchestrator-level generic read tool (only when enabled). */
export const ODOO_QUERY_TOOL_NAME = 'odoo_query';

const FIELDS_GET_ATTRIBUTES = ['type', 'relation', 'string', 'help'] as const;

export interface OdooSchemaModel {
  /** Technical model name, e.g. `hr.employee`. */
  readonly model: string;
  readonly scope: OdooScope;
  /** Tools whose results carry this model's fields (`odoo_execute`, plus
   *  `odoo_query` when the generic read tools are enabled). */
  readonly tools: readonly string[];
}

export interface OdooSchemaField {
  readonly name: string;
  /** Odoo field type, e.g. `many2one`, `char`. */
  readonly type: string;
  /** Target model of a `many2one` / `one2many` / `many2many` field. */
  readonly relation?: string;
  /** The field's label (`string`). */
  readonly label?: string;
  readonly help?: string;
}

export interface OdooSchemaService {
  /** Whitelisted models with the tools that read them, sorted. No network. */
  listModels(): readonly OdooSchemaModel[];
  /**
   * The fields of one whitelisted model, sorted by name; red-line fields are
   * left out. Throws `OdooSchemaError` for a model outside the whitelist and
   * passes an `OdooClientError` (unreachable, auth) through.
   */
  describeModel(model: string): Promise<readonly OdooSchemaField[]>;
}

export class OdooSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdooSchemaError';
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Flatten a `fields_get` map into sorted fields; malformed entries dropped. */
export function parseFieldsGet(raw: unknown): OdooSchemaField[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const fields: OdooSchemaField[] = [];
  for (const [name, attrs] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof attrs !== 'object' || attrs === null) continue;
    const a = attrs as Record<string, unknown>;
    const type = asText(a['type']);
    if (type === undefined) continue;
    const relation = asText(a['relation']);
    const label = asText(a['string']);
    const help = asText(a['help']);
    fields.push({
      name,
      type,
      ...(relation !== undefined ? { relation } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(help !== undefined ? { help } : {}),
    });
  }
  return fields.sort((x, y) => x.name.localeCompare(y.name));
}

export function createOdooSchemaService(
  deps: OdooReadToolDeps & { readonly genericReadEnabled: boolean },
): OdooSchemaService {
  const tools: readonly string[] = deps.genericReadEnabled
    ? [ODOO_EXECUTE_TOOL_NAME, ODOO_QUERY_TOOL_NAME]
    : [ODOO_EXECUTE_TOOL_NAME];
  const models: readonly OdooSchemaModel[] = (Object.keys(ALLOWED_MODELS) as OdooScope[])
    .flatMap((scope) => [...ALLOWED_MODELS[scope]].map((model) => ({ model, scope, tools })))
    .sort((x, y) => x.model.localeCompare(y.model));

  return {
    listModels: () => models,
    async describeModel(model) {
      const scope = scopeForModel(model);
      if (scope === undefined) {
        throw new OdooSchemaError(`model_not_allowed — ${JSON.stringify(model)} is not in any read whitelist`);
      }
      const outcome = await executeOdoo(
        {
          scope,
          model,
          method: 'fields_get',
          positionalArgs: [],
          kwargs: { attributes: [...FIELDS_GET_ATTRIBUTES] },
        },
        deps,
      );
      if (!outcome.ok) {
        // Unreachable for a whitelisted model and fields_get; kept exhaustive.
        throw new OdooSchemaError(`fields_get refused for ${model}: ${outcome.error.kind}`);
      }
      return parseFieldsGet(outcome.result);
    },
  };
}
