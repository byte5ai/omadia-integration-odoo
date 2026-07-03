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
| Service surface | Publishes `odoo.client`, `odoo.cache`, `odoo.enrich` to the service registry |

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
