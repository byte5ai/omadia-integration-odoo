import { z } from 'zod';
import {
  ALLOWED_METHODS,
  ALLOWED_MODELS,
  executeOdoo,
  type OdooScope,
} from './odooCore.js';
import type { OdooClient } from './odooClient.js';
import { OdooClientError } from './odooClient.js';
import type { EntityRefBus, LocalSubAgentTool } from './kernel-types.js';
import type { OdooResponseCache } from './odooResponseCache.js';

const ExecuteInputSchema = z.object({
  model: z.string().min(1).max(120),
  method: z.enum([...ALLOWED_METHODS] as [string, ...string[]]),
  positional_args: z.array(z.unknown()).default([]),
  kwargs: z.record(z.unknown()).default({}),
});

const MAX_OUTPUT_CHARS = 60_000;

/**
 * Builds the single `odoo_execute` tool for a sub-agent. The tool is
 * scope-locked at construction time — the accounting sub-agent can't
 * accidentally query HR models and vice versa. Output is serialised as
 * compact JSON and bounded in size so a runaway `search_read` with no
 * `limit` doesn't swamp the sub-agent's context.
 */
export function createOdooExecuteTool(
  scope: OdooScope,
  deps: {
    client: OdooClient;
    entityRefBus: EntityRefBus;
    responseCache?: OdooResponseCache;
  },
): LocalSubAgentTool {
  const allowedModels = [...ALLOWED_MODELS[scope]].sort().join(', ');
  return {
    spec: {
      name: 'odoo_execute',
      description: [
        `Run a read-only Odoo execute_kw call in the ${scope} scope.`,
        `Allowed models: ${allowedModels}.`,
        `Allowed methods: ${[...ALLOWED_METHODS].join(', ')}.`,
        'Returns the raw Odoo result as JSON (no "{result: …}" wrapper).',
        scope === 'hr'
          ? 'HR red-line fields (wages, tax IDs, bank details, private contact info, emergency contacts) are blocked server-side and will be rejected if requested or stripped from responses.'
          : '',
      ]
        .filter((s) => s.length > 0)
        .join(' '),
      input_schema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          method: {
            type: 'string',
            enum: [...ALLOWED_METHODS],
          },
          positional_args: {
            type: 'array',
            description:
              "Odoo execute_kw positional args. `[domain]` for search/search_read, `[ids]` for read, `[domain, measures, groupby]` for read_group.",
          },
          kwargs: {
            type: 'object',
            description:
              "Odoo execute_kw kwargs — typically `{fields: [...], limit: N, order: '...'}`.",
          },
        },
        required: ['model', 'method'],
      },
    },
    async handle(input: unknown): Promise<string> {
      const parsed = ExecuteInputSchema.safeParse(input);
      if (!parsed.success) {
        return `Error: invalid odoo_execute input — ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`;
      }
      const { model, method, positional_args, kwargs } = parsed.data;
      try {
        const outcome = await executeOdoo(
          {
            scope,
            model,
            method,
            positionalArgs: positional_args,
            kwargs: kwargs as Record<string, unknown>,
          },
          deps,
        );
        if (!outcome.ok) {
          switch (outcome.error.kind) {
            case 'method_not_allowed':
              return `Error: method_not_allowed — ${outcome.error.method}. Allowed: ${[...ALLOWED_METHODS].join(', ')}.`;
            case 'model_not_allowed':
              return `Error: model_not_allowed — ${outcome.error.model} is not in the ${scope} whitelist (${allowedModels}).`;
            case 'hr_red_line_field':
              return `Error: hr_red_line_field — field \`${outcome.error.field}\` ist server-side gesperrt. Nicht abrufbar.`;
          }
        }
        const json = JSON.stringify(outcome.result);
        if (json.length > MAX_OUTPUT_CHARS) {
          return `${json.slice(0, MAX_OUTPUT_CHARS)}\n\n…[gekürzt, Original ${String(json.length)} Zeichen — bitte mit \`limit\` oder gezielteren \`fields\` nachschärfen]`;
        }
        return json;
      } catch (err) {
        // Surface network + upstream errors to the sub-agent so it can decide
        // whether to retry or report to the user — instead of bubbling up
        // through the whole stack as a thrown exception.
        if (err instanceof OdooClientError) {
          return `Error: odoo_upstream_${String(err.status)} — ${err.message}`;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cause = (err as any)?.cause;
        const causeCode = cause && typeof cause === 'object' ? (cause as Record<string, unknown>)['code'] : undefined;
        return `Error: odoo_network_error — ${msg}${causeCode ? ` (cause=${String(causeCode)})` : ''}`;
      }
    },
  };
}
