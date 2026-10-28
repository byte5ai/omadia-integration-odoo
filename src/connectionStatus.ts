import type {
  PluginConnectionVerdict,
  PluginContext,
  StatusAccessor,
} from '@omadia/plugin-api';

import {
  authRejectionOf,
  OdooClient,
  type OdooAuthObserver,
  type OdooClientError,
} from './odooClient.js';
import {
  readOdooConnectionSettings,
  type OdooConnectionSettings,
} from './odooSettings.js';

/**
 * Issue omadia#1453 — operator-visible connection status for the Odoo
 * integration.
 *
 * Two halves:
 *  - `verifyConnection(ctx)` is the optional module export the kernel
 *    (plugin-api >= 1.35.0) calls after every activation and from the
 *    operator's "check now" endpoint. Older hosts never call it.
 *  - `createAuthStatusReporter(status)` is wired into the running client and
 *    reports a key Odoo stops accepting mid-life (revoked or expired upstream)
 *    the first time a real call hits it — the probe only runs at activation.
 *
 * Copy: neither half sets `title`/`detail`. The plugin has no access to the
 * operator's locale, the kernel ships no copy of its own, and the web-ui
 * renders its own localized fallback for a bare `error` state.
 */

/** Factory seam so tests can exercise the verdict mapping without a network. */
export type OdooProbeClientFactory = (
  settings: OdooConnectionSettings,
) => Pick<OdooClient, 'checkCredentials'>;

const defaultProbeClient: OdooProbeClientFactory = (settings) =>
  new OdooClient(settings);

/**
 * Map one fresh `common.authenticate` to a connection verdict:
 *  - uid accepted                          ⇒ `connected`
 *  - `authenticate → false` / HTTP 401     ⇒ `rejected` + cause
 *  - anything else (5xx, timeout, DNS, unparseable body, missing setup
 *    field)                                ⇒ `inconclusive`
 * Never throws: a probe failure must not read as a dead key.
 */
export async function verifyOdooConnection(
  ctx: PluginContext,
  makeClient: OdooProbeClientFactory = defaultProbeClient,
): Promise<PluginConnectionVerdict> {
  try {
    const settings = await readOdooConnectionSettings(ctx);
    await makeClient(settings).checkCredentials();
    return { status: 'connected' };
  } catch (err) {
    const cause = authRejectionOf(err);
    if (cause) return { status: 'rejected', cause };
    ctx.log(`[odoo] connection probe inconclusive: ${describeError(err)}`);
    return { status: 'inconclusive' };
  }
}

/**
 * Report call-time auth outcomes through `ctx.status`.
 *
 * - Every explicit rejection reports `error` (re-reporting refreshes the
 *   kernel-stamped `checked_at`).
 * - A later successful authenticated call reports `ok` again — but only if
 *   this reporter raised the error. A status somebody else wrote (the
 *   kernel's probe verdict, another plugin-side report) is left alone.
 *
 * Tolerates a host without `ctx.status`.
 */
export function createAuthStatusReporter(
  status: StatusAccessor | undefined,
): OdooAuthObserver {
  let raisedError = false;
  return {
    onAuthRejected(): void {
      if (!status) return;
      status.report({ state: 'error' });
      raisedError = true;
    },
    onAuthAccepted(): void {
      if (!status || !raisedError) return;
      status.report({ state: 'ok' });
      raisedError = false;
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as Partial<OdooClientError>).status;
    return status === undefined ? err.message : `${err.message} (status ${String(status)})`;
  }
  return String(err);
}
