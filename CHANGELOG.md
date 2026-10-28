# Changelog

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

## 0.2.1

- Declare the provider/consumer capability contract for the odoo retirement
  (omadia#839). Adds `entityRefBus@^1` to `requires:` (kernel-published via the
  knowledge-graph plugins, activate() throws without it) — retiring the
  `@omadia/integration-odoo` row in `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`
  — and declares the plugin-scoped services this integration publishes under
  `provides:` (`odoo.client`, `odoo.cache`, `odoo.agentToolkit.hr`,
  `odoo.agentToolkit.accounting`, `odoo.enrich`) so the odoo sub-agents can
  declare the matching `requires:`.
