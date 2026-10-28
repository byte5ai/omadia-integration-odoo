# Changelog

## 0.2.2

- Type the setup fields (byte5ai/omadia#1478). `odoo_url`, `openregister_base_url`
  and `northdata_base_url` are `url` (the host rejects non-http(s) values at
  install), the five on/off switches are `boolean` (checkboxes, real YAML
  `false` defaults), sizes/intervals/TTLs are `integer`, and
  `openregister_fetch_level` is an `enum` (minimal / standard / full). The two
  `*_rate_limit_rps` decimals stay `string` because the host has no decimal
  field type.
- Existing installs keep working: the plugin reads both typed values and the
  legacy strings stored before 0.2.2 (`"true"`, `"500000"`). A value it cannot
  read now logs `[odoo] <key>=… is not … — using default …` instead of falling
  back silently.

## 0.2.1

- Declare the provider/consumer capability contract for the odoo retirement
  (omadia#839). Adds `entityRefBus@^1` to `requires:` (kernel-published via the
  knowledge-graph plugins, activate() throws without it) — retiring the
  `@omadia/integration-odoo` row in `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`
  — and declares the plugin-scoped services this integration publishes under
  `provides:` (`odoo.client`, `odoo.cache`, `odoo.agentToolkit.hr`,
  `odoo.agentToolkit.accounting`, `odoo.enrich`) so the odoo sub-agents can
  declare the matching `requires:`.
