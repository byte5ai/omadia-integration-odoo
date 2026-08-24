# Changelog

## 0.2.1

- Declare the provider/consumer capability contract for the odoo retirement
  (omadia#839). Adds `entityRefBus@^1` to `requires:` (kernel-published via the
  knowledge-graph plugins, activate() throws without it) — retiring the
  `@omadia/integration-odoo` row in `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`
  — and declares the plugin-scoped services this integration publishes under
  `provides:` (`odoo.client`, `odoo.cache`, `odoo.agentToolkit.hr`,
  `odoo.agentToolkit.accounting`, `odoo.enrich`) so the odoo sub-agents can
  declare the matching `requires:`.
