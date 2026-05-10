import type { OdooClient } from './odooClient.js';
import type { EntityRefBus } from './kernel-types.js';
import { extractOdooEntityRefs } from './odooEntityExtractor.js';
import { isCacheable, type OdooResponseCache } from './odooResponseCache.js';

export type OdooScope = 'accounting' | 'hr';

/**
 * Methods the sub-agent (and any legacy proxy caller) is allowed to invoke
 * via execute_kw. Anything outside this set is a write or control-flow
 * operation that must never reach Odoo.
 */
export const ALLOWED_METHODS = new Set<string>([
  'search',
  'search_read',
  'read',
  'search_count',
  'read_group',
  'fields_get',
]);

export const ALLOWED_MODELS: Record<OdooScope, Set<string>> = {
  accounting: new Set([
    'account.move',
    'account.move.line',
    'account.payment',
    'res.partner',
    'account.account',
    'account.journal',
    'res.currency',
    // Analytic accounting (Kostenstellen). `account.analytic.account` is the
    // dimension table (ID, name, code, plan) — slow-changing, cacheable.
    // `account.analytic.line` are per-invoice analytic entries (who booked
    // what on which cost centre) — hot, NOT cacheable. Read-only like every
    // other model in this scope.
    'account.analytic.account',
    'account.analytic.line',
  ]),
  hr: new Set([
    'hr.employee',
    'hr.employee.public',
    'hr.department',
    'hr.job',
    'hr.contract',
    'hr.leave',
    'hr.leave.allocation',
    'hr.leave.type',
    'hr.attendance',
    'hr.applicant',
    'resource.calendar',
    'resource.calendar.leaves',
    'resource.calendar.attendance',
    'hr.work.location',
  ]),
};

/**
 * HR red-line fields: never surfaced to the agent or user. Blocked in the
 * request and stripped from the response. Keeps compensation, tax IDs,
 * banking details, private addresses, and emergency contacts out of reach.
 */
export const HR_RED_LINE_FIELDS = new Set<string>([
  'wage',
  'hourly_wage',
  'struct_id',
  'ssnid',
  'sinid',
  'identification_id',
  'passport_id',
  'permit_no',
  'bank_account_id',
  'private_street',
  'private_street2',
  'private_zip',
  'private_city',
  'private_country_id',
  'private_email',
  'private_phone',
  'emergency_contact',
  'emergency_phone',
]);

export const HR_CONTRACT_BLOCKED_ALWAYS = new Set<string>([
  'wage',
  'hourly_wage',
  'struct_id',
]);

export type OdooCoreError =
  | { kind: 'method_not_allowed'; method: string }
  | { kind: 'model_not_allowed'; model: string; scope: OdooScope }
  | { kind: 'hr_red_line_field'; field: string };

export interface OdooExecuteArgs {
  scope: OdooScope;
  model: string;
  method: string;
  positionalArgs: unknown[];
  kwargs: Record<string, unknown>;
}

/**
 * Validates a request against the scope's whitelists + HR red-line rules and
 * runs it. Publishes EntityRefs on success. Used by both the sub-agent
 * toolkit and (historically) the HTTP proxy route — single source of truth.
 */
export async function executeOdoo(
  args: OdooExecuteArgs,
  deps: {
    client: OdooClient;
    entityRefBus: EntityRefBus;
    responseCache?: OdooResponseCache;
  },
): Promise<{ ok: true; result: unknown } | { ok: false; error: OdooCoreError }> {
  if (!ALLOWED_METHODS.has(args.method)) {
    return { ok: false, error: { kind: 'method_not_allowed', method: args.method } };
  }
  if (!ALLOWED_MODELS[args.scope].has(args.model)) {
    return {
      ok: false,
      error: { kind: 'model_not_allowed', model: args.model, scope: args.scope },
    };
  }
  if (args.scope === 'hr') {
    const violation = findRedLineFieldViolation(args.model, args.kwargs);
    if (violation !== undefined) {
      return { ok: false, error: { kind: 'hr_red_line_field', field: violation } };
    }
  }

  // Whitelist cache for slow-changing lookups (chart-of-accounts, journals,
  // departments, fields_get …). We cache **before** red-line stripping so a
  // cached HR read still runs through the strip on each hit — never bypasses
  // safety. Hot transactional models (account.move etc.) are NOT cacheable
  // and fall straight through.
  const cache = deps.responseCache;
  const cacheable = cache !== undefined && isCacheable(args.model, args.method);
  let result: unknown;
  if (cacheable) {
    const cached = cache.get({
      scope: args.scope,
      model: args.model,
      method: args.method,
      kwargs: args.kwargs,
      positionalArgs: args.positionalArgs,
    });
    if (cached !== undefined) {
      result = cached;
    }
  }
  if (result === undefined) {
    result = await deps.client.execute({
      model: args.model,
      method: args.method,
      positionalArgs: args.positionalArgs,
      kwargs: args.kwargs,
    });
    if (cacheable && cache !== undefined) {
      cache.put(
        {
          scope: args.scope,
          model: args.model,
          method: args.method,
          kwargs: args.kwargs,
          positionalArgs: args.positionalArgs,
        },
        result,
      );
    }
  }
  if (args.scope === 'hr') {
    result = stripRedLineFields(args.model, result);
  }
  for (const ref of extractOdooEntityRefs(args.model, args.method, result)) {
    deps.entityRefBus.publish(ref);
  }
  return { ok: true, result };
}

function findRedLineFieldViolation(
  model: string,
  kwargs: Record<string, unknown>,
): string | undefined {
  const fields = kwargs['fields'];
  if (!Array.isArray(fields)) return undefined;
  for (const field of fields) {
    if (typeof field !== 'string') continue;
    if (HR_RED_LINE_FIELDS.has(field)) return field;
    if (model === 'hr.contract' && HR_CONTRACT_BLOCKED_ALWAYS.has(field)) return field;
    for (const segment of field.split('.')) {
      if (HR_RED_LINE_FIELDS.has(segment)) return field;
    }
  }
  return undefined;
}

function stripRedLineFields(model: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripRedLineFields(model, v));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (HR_RED_LINE_FIELDS.has(key)) continue;
      if (model === 'hr.contract' && HR_CONTRACT_BLOCKED_ALWAYS.has(key)) continue;
      out[key] = stripRedLineFields(model, v);
    }
    return out;
  }
  return value;
}
