# `@omadia/integration-odoo` — Integration Surface

**Source of truth for Builder-Agents that depend on this plugin.** Read this
before writing cross-integration code. The Builder-Boilerplate's CLAUDE.md
points at this file by convention; do NOT trust your training-memory of
"the Odoo client API" — it drifts.

## Service Registry

This plugin publishes two services on the kernel `ServiceRegistry`:

| Service Name   | TypeScript Type                                | Purpose                                              |
|----------------|------------------------------------------------|------------------------------------------------------|
| `odoo.client`  | `OdooClient` (`./src/odooClient.ts`)           | JSON-RPC wrapper, UID-cached, maxBytes-capped        |
| `odoo.cache`   | `OdooResponseCache` (`./src/odooResponseCache.ts`) | 5-min TTL response cache for stable models       |

Plus optionally (only when `enrich_company` config-flag is set):

| Service Name   | TypeScript Type | Purpose                                |
|----------------|-----------------|----------------------------------------|
| `odoo.enrich`  | toolkit-side    | OpenRegister/NorthData company enrich  |

## Consumption Pattern

Plugin must declare `de.byte5.integration.odoo` in `manifest.yaml`'s
`depends_on`. Then in `activate()`:

```typescript
import type { OdooClient, OdooResponseCache } from '@omadia/integration-odoo';

const odoo = ctx.services.get<OdooClient>('odoo.client');
if (!odoo) {
  throw new Error(
    'odoo.client unavailable — ensure depends_on includes ' +
    '"de.byte5.integration.odoo" and the integration is installed/active',
  );
}

// Optional, for stable read-through caching:
const cache = ctx.services.get<OdooResponseCache>('odoo.cache');
```

`peerDependencies` in `package.json` must include
`"@omadia/integration-odoo": "*"` so the type import resolves.

## `OdooClient` API — verbatim

```typescript
class OdooClient {
  // Server-cached UID. First call authenticates, subsequent calls reuse.
  // Throws OdooClientError on auth failure.
  async getUid(): Promise<number>;

  // Single execute_kw call. THIS is the only method you call for reads/writes.
  // The client wraps this in a UID-aware retry on session-error.
  async execute(req: OdooExecuteRequest): Promise<unknown>;

  // Force a fresh UID on the next call (rarely needed; the retry-loop in
  // `execute()` already invalidates on 401/session_invalid).
  invalidateSession(): void;
}

interface OdooExecuteRequest {
  model: string;          // e.g. 'hr.employee', 'res.partner', 'account.move'
  method: string;         // 'search_read' | 'read' | 'search' | 'search_count' |
                          // 'read_group' | 'write' | 'create' | 'unlink' | …
  positionalArgs: unknown[]; // shape depends on `method` — see snippets below
  kwargs: Record<string, unknown>; // limit, offset, fields (for search-only), context, …
}
```

**Errors** raised as `OdooClientError`:

```typescript
class OdooClientError extends Error {
  readonly status: number;          // upstream HTTP status when known
  readonly upstreamBody?: string;   // truncated upstream body
}
```

## Concrete Snippets

### Read active employees (HR)

```typescript
const rows = await odoo.execute({
  model: 'hr.employee',
  method: 'search_read',
  // positionalArgs[0] = domain (filter), positionalArgs[1] = fields-projection
  positionalArgs: [[['active', '=', true]], ['id', 'name', 'work_email']],
  kwargs: { limit: 200, order: 'name asc' },
}) as Array<{ id: number; name: string; work_email: string | false }>;
```

### Read posted invoices (Accounting)

```typescript
const invoices = await odoo.execute({
  model: 'account.move',
  method: 'search_read',
  positionalArgs: [
    [['move_type', '=', 'out_invoice'], ['state', '=', 'posted']],
    ['id', 'name', 'partner_id', 'amount_total', 'invoice_date'],
  ],
  kwargs: { limit: 50, order: 'invoice_date desc' },
}) as Array<unknown>;
```

### Read by ids

```typescript
const employees = await odoo.execute({
  model: 'hr.employee',
  method: 'read',
  // positionalArgs[0] = ids, positionalArgs[1] = fields
  positionalArgs: [[7, 12, 19], ['id', 'name', 'department_id']],
  kwargs: {},
}) as Array<unknown>;
```

### Aggregations

```typescript
const groups = await odoo.execute({
  model: 'account.move',
  method: 'read_group',
  // positionalArgs: [domain, measures, groupby]
  positionalArgs: [
    [['state', '=', 'posted']],
    ['amount_total:sum'],
    ['partner_id'],
  ],
  kwargs: { lazy: false, limit: 100 },
}) as Array<unknown>;
```

## Was NICHT geht

- ❌ **`odoo.execute_kw('hr.employee', 'search_read', ...)`** — the `OdooClient`
  has NO method called `execute_kw`. `execute_kw` is the upstream Odoo JSON-RPC
  method-name, used INTERNALLY by the client. Always call `odoo.execute({...})`.
- ❌ **`odoo.searchRead(...)` / `odoo.read(...)`** — no such convenience methods.
  Everything goes through `execute({model, method, positionalArgs, kwargs})`.
- ❌ **Don't construct `OdooClient` yourself** — the integration plugin owns
  authentication and credential rotation. Always consume via
  `ctx.services.get<OdooClient>('odoo.client')`.
- ❌ **Don't `getUid()` then call execute manually** — `execute()` calls
  `getUid()` itself and refreshes on session-error. Calling `getUid()` first
  just doubles the round-trip on cold start.

## `OdooResponseCache` — when to use

Optional read-through cache for **stable** models (chart of accounts,
journals, departments, currencies). The cache list (`CACHEABLE`) is
maintained inside the integration plugin; treat it as opaque.

```typescript
import type { CacheLookupKey } from '@omadia/integration-odoo';

const cache = ctx.services.get<OdooResponseCache>('odoo.cache');
const key: CacheLookupKey = {
  model: 'hr.department',
  method: 'search_read',
  positionalArgs: [[]],
  kwargs: { fields: ['id', 'name'] },
};
let result = cache?.get(key);
if (result === undefined) {
  result = await odoo.execute({ ...key });
  cache?.put(key, result);
}
```

Stale data tolerance: 5 minutes. For volatile data (employee assignments,
WIP transactions, real-time stock), bypass the cache.

## Reference implementations

- `middleware/packages/harness-orchestrator/src/odooSubAgent.ts` — kernel-side
  Odoo sub-agent, uses `OdooClient` + `OdooResponseCache` heavily.
- `middleware/src/plugins/builder/tools/composeFixPrompt.ts` — `enrich_company`
  consumer that reads `odoo.enrich`.

## Versioning

API additions are non-breaking; adding new methods to `OdooClient` does NOT
require `peerDependencies` bumps. Renames or signature changes in
`OdooExecuteRequest` are major-version events — check this file's git-blame
when in doubt.
