# Changelog

## 0.4.0

- `odoo_db` is optional. Left empty, the connector uses the first database
  the instance lists at `/web/database/list` (the same JSON-RPC endpoint the
  Odoo database selector uses), so a single-database instance needs only URL,
  login and API key.
  - The name is looked up once per client and logged
    (`[odoo-client] no database configured — using "<db>" …`). A failed
    lookup is not cached, so the next call asks again.
  - A server that does not publish its list (`list_db = False`) or lists no
    database raises an `OdooClientError` that names the setup field to fill
    in. It never counts as a credential rejection: `verifyConnection`
    reports `inconclusive`, and `execute()` does not retry it as an expired
    session.
  - Instances with several databases should keep naming one: the first
    listed entry is not guaranteed to be the one you mean.
  - New `OdooClient.getDb()` returns the database in use. `fromConfig` no
    longer requires `ODOO_DB`.
- Setup form: the field is now "Datenbank-Name (optional)", and its help text
  and the setup guide (en/de) explain the fallback and when to set it.
  Existing installs keep their configured database.

## 0.3.0

- Report rejected Odoo credentials to the operator (omadia#1453). A wrong,
  revoked or expired `odoo_api_key` used to activate cleanly and show
  "Active · configured" until a chat turn failed.
  - New optional export `verifyConnection(ctx)` from the plugin entry. The
    kernel (plugin-api >= 1.35.0) calls it after each activation and from
    `POST /api/v1/admin/runtime/installed/:id/verify`. It runs one fresh
    `common.authenticate`: an accepted uid means `connected`;
    `authenticate → false` means `rejected` with cause
    `protocol_auth_failure`; HTTP 401 means `rejected` with cause `http_401`;
    timeouts, 5xx, DNS failures, unparseable bodies and missing setup fields
    all mean `inconclusive`. It never throws.
  - Call-time reporting: when a real `OdooClient.execute()` call is refused
    (`authenticate → false` or HTTP 401), the plugin reports
    `ctx.status.report({ state: 'error' })`, so the store badge and the tool
    gate react without a chat turn. The next successful authenticated call
    reports `ok`, but only when the plugin raised that error itself. A
    verdict from the kernel's probe is left alone.
  - Neither path sets `title`/`detail`. The plugin cannot see the operator's
    locale, and the web-ui renders its own localized text for a bare `error`.
  - `OdooClientError.authRejection` names the explicit refusal.
    `checkCredentials()` forces a fresh authenticate. Both are documented in
    `INTEGRATION.md`.
- `compat.core` is unchanged (`>=1.0 <2.0`). The new code imports only types
  from `@omadia/plugin-api`, and an older host ignores the `verifyConnection`
  export. A local build now needs plugin-api 1.35.0 types in the sibling
  `odoo-bot` checkout.

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
