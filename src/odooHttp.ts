import type { PluginContext } from '@omadia/plugin-api';

/**
 * The plugin's network path (byte5ai/omadia-integration-odoo#10).
 *
 * Every Odoo, OpenRegister and NorthData request goes through `ctx.http`: the kernel checks it against
 * the manifest's `permissions.network.outbound` (`$config.odoo_url`), the
 * room's host prohibitions and the model-endpoint block, and counts it in
 * the plugin's per-minute budget. The plugin no longer has a dispatcher of
 * its own, so nothing it sends is invisible to the kernel's egress check
 * (security-architecture "Network sandbox", S3c residual).
 *
 * `ctx.http` allows a fixed number of requests per plugin and minute and
 * throws `HttpRateLimitError` past it. An entity-sync run or a busy turn can
 * reach that, so a refused request waits and is sent again. The waits add up
 * to more than the kernel's one-minute window, so a request is refused for
 * good only when other calls keep draining the budget.
 */

/** Waits before each retry of a rate-limited request, in ms. */
export const RATE_LIMIT_RETRY_WAITS_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The kernel's `HttpRateLimitError`, matched by name across package copies. */
export function isHttpRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'HttpRateLimitError';
}

/** Wrap a fetch so `HttpRateLimitError` waits and retries; other errors pass. */
export function withRateLimitRetry(
  fetchImpl: typeof fetch,
  opts: { waitsMs?: readonly number[]; sleep?: Sleep; log?: (msg: string) => void } = {},
): typeof fetch {
  const waits = opts.waitsMs ?? RATE_LIMIT_RETRY_WAITS_MS;
  const sleep = opts.sleep ?? realSleep;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchImpl(input, init);
      } catch (err) {
        const wait = waits[attempt];
        if (!isHttpRateLimitError(err) || wait === undefined) throw err;
        opts.log?.(
          `[odoo] ctx.http request budget exhausted; retry ${String(attempt + 1)}/${String(waits.length)} in ${String(wait)}ms`,
        );
        await sleep(wait);
      }
    }
  }) as typeof fetch;
}

/**
 * Requests per minute the entity sync may use of the plugin's `ctx.http`
 * budget (60 per minute, shared with every chat tool and consumer plugin).
 * The rest stays free for interactive calls while a sync runs.
 */
export const ENTITY_SYNC_REQUESTS_PER_MINUTE = 40;

/**
 * Space the requests of `fetchImpl` at least `intervalMs` apart (by start
 * time), across concurrent callers. The entity sync's models run in
 * parallel; this keeps them below their share of the budget.
 */
export function withMinInterval(
  fetchImpl: typeof fetch,
  intervalMs: number,
  opts: { now?: () => number; sleep?: Sleep } = {},
): typeof fetch {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  let nextSlot = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const current = now();
    const slot = Math.max(current, nextSlot);
    nextSlot = slot + intervalMs;
    if (slot > current) await sleep(slot - current);
    return fetchImpl(input, init);
  }) as typeof fetch;
}

/**
 * The fetch the plugin's clients use inside the kernel: `ctx.http` with the
 * rate-limit retry. Throws when the host gives the plugin no `ctx.http`
 * (the manifest declares outbound hosts, so a current kernel always does);
 * the plugin does not fall back to a path the kernel cannot see.
 */
export function odooFetchFromContext(ctx: PluginContext): typeof fetch {
  const http = ctx.http;
  if (!http) {
    throw new Error(
      '[odoo] ctx.http is missing: the host gives this plugin no checked network access (permissions.network.outbound)',
    );
  }
  const httpFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    http.fetch(requestUrl(input), init)) as typeof fetch;
  return withRateLimitRetry(httpFetch, { log: (msg) => ctx.log(msg) });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * `odoo_insecure_tls` used to switch TLS verification off through a private
 * `undici` agent, which the kernel's egress check does not see. That agent
 * is gone and the setting has no effect. A private CA is trusted with
 * `NODE_EXTRA_CA_CERTS` on the host, which keeps verification on.
 */
export const INSECURE_TLS_RETIRED_WARNING =
  '[odoo] odoo_insecure_tls is set but no longer disables TLS verification (byte5ai/omadia-integration-odoo#10). ' +
  'To reach an Odoo with a private-CA or self-signed certificate, add that certificate to the host with ' +
  'NODE_EXTRA_CA_CERTS (verification stays on).';
