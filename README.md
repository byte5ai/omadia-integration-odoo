<div align="center">

# @omadia/integration-odoo

### Read-only Odoo JSON-RPC layer for omadia's agents, plus company-enrichment via OpenRegister / NorthData.

An **Odoo** integration for [omadia](https://github.com/byte5ai/omadia).
Publishes the `odoo.client`, `odoo.cache` and `odoo.enrich` services and
contributes the native `enrich_company` tool.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

## How it works

| Concern | Implementation |
|---|---|
| Odoo access | Read-only JSON-RPC client (`odooClient.ts`), toolkit factory (`odooToolkit.ts`) |
| Caching | `odooResponseCache.ts` |
| Entity sync | `odooEntitySync.ts`, `odooEntityExtractor.ts` |
| Company enrichment | NorthData + OpenRegister clients, fact mappers, ingest pipelines, `enrich_company` tool |
| Service surface | Publishes `odoo.client`, `odoo.cache`, `odoo.schema`, `odoo.enrich` to the service registry |

### Network and TLS

Every Odoo, OpenRegister and NorthData request goes through `ctx.http`:
the allow-list from `permissions.network.outbound`, the kernel's egress check
and a per-plugin request budget, which the clients wait out on
`HttpRateLimitError`. The plugin has no network dispatcher of its own (#10).

`odoo_insecure_tls` is retired and has no effect. To reach an Odoo with a
private-CA or self-signed certificate, add that certificate on the host with
`NODE_EXTRA_CA_CERTS`; verification stays on. **LOCAL USE ONLY:** never
disable TLS verification host-wide on a hosted instance. A per-plugin trust
option on `ctx.http` is proposed in byte5ai/omadia#2381.

This package is a pure integration layer — no user-facing setup beyond Odoo
connection credentials (see [`manifest.yaml`](manifest.yaml) for the full
field list).

## Build, typecheck & test

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build        # tsc
npm test             # esbuild-transpile tests/ → node --test
```

`@omadia/plugin-api` is a **peer dependency**, provided by the omadia host at
runtime. `@omadia/orchestrator` is linked as a **test-only** dependency —
`tests/odooCore.test.ts` exercises the odoo↔orchestrator `turnContext`
integration point, but the package itself never depends on orchestrator (it
is not in `peerDependencies`). For local dev, `tsconfig.json` maps both to
sibling checkouts under `../odoo-bot/middleware/packages/*` — check out
`odoo-bot` alongside this repo, or adjust the `paths` entries.

## License

MIT © byte5 GmbH — see [LICENSE](LICENSE).
