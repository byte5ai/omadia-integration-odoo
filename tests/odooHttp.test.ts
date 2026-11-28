import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import type { PluginContext } from '@omadia/plugin-api';
import {
  OdooClient,
  verifyOdooConnection,
  odooFetchFromContext,
  withMinInterval,
  withRateLimitRetry,
} from '@omadia/integration-odoo';

// byte5ai/omadia-integration-odoo#10: with ODOO_INSECURE_TLS the client sent
// every request through its own undici dispatcher, past the kernel's egress
// check. Every Odoo request now goes through ctx.http.

class HttpRateLimitError extends Error {
  constructor() {
    super("plugin '@omadia/integration-odoo' exceeded its per-minute HTTP request budget");
    this.name = 'HttpRateLimitError';
  }
}

function rpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeCtx(opts: {
  config?: Record<string, unknown>;
  http?: { fetch(url: string, init?: RequestInit): Promise<Response> } | undefined;
}): { ctx: PluginContext; logs: string[] } {
  const logs: string[] = [];
  const config: Record<string, unknown> = {
    odoo_url: 'https://erp.example.com',
    odoo_db: 'prod',
    odoo_login: 'bot@example.com',
    ...opts.config,
  };
  const ctx = {
    secrets: {
      require: async () => 'k',
      get: async () => undefined,
    },
    config: {
      require: <T>(key: string): T => {
        const v = config[key];
        if (v === undefined) throw new Error(`missing config ${key}`);
        return v as T;
      },
      get: <T>(key: string): T | undefined => config[key] as T | undefined,
    },
    log: (msg: string) => {
      logs.push(msg);
    },
    ...(opts.http ? { http: opts.http } : {}),
  } as unknown as PluginContext;
  return { ctx, logs };
}

describe('Odoo requests go through ctx.http (#10)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error('global fetch must not be used');
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fromContext sends every call through ctx.http', async () => {
    const urls: string[] = [];
    const { ctx } = fakeCtx({
      http: {
        fetch: async (url) => {
          urls.push(url);
          return rpcResult(7);
        },
      },
    });
    const client = await OdooClient.fromContext(ctx, { maxBytes: 500_000, insecureTls: false });
    await client.checkCredentials();
    assert.deepEqual(urls, ['https://erp.example.com/jsonrpc']);
  });

  it('the connection probe takes the same path', async () => {
    let calls = 0;
    const { ctx } = fakeCtx({
      http: {
        fetch: async () => {
          calls += 1;
          return rpcResult(7);
        },
      },
    });
    const verdict = await verifyOdooConnection(ctx);
    assert.equal(verdict.status, 'connected');
    assert.equal(calls, 1);
  });

  it('a host without ctx.http gets an error, not a silent global fetch', async () => {
    const { ctx } = fakeCtx({ http: undefined });
    assert.throws(() => odooFetchFromContext(ctx), /ctx\.http is missing/);
    const verdict = await verifyOdooConnection(ctx);
    assert.equal(verdict.status, 'inconclusive');
  });

  it('odoo_insecure_tls no longer changes the path; it only warns', async () => {
    const urls: string[] = [];
    const { ctx, logs } = fakeCtx({
      http: {
        fetch: async (url) => {
          urls.push(url);
          return rpcResult(7);
        },
      },
    });
    const client = await OdooClient.fromContext(ctx, { maxBytes: 500_000, insecureTls: true });
    await client.checkCredentials();
    assert.equal(urls.length, 1);
    assert.ok(logs.some((l) => l.includes('no longer disables TLS verification')));
  });

  it('the plugin imports no undici of its own', () => {
    const srcDir = new URL('../src/', import.meta.url);
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(new URL(file, srcDir), 'utf8');
      assert.doesNotMatch(text, /from ['"]undici['"]/, `${file} imports undici`);
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>;
    };
    assert.equal(pkg.peerDependencies?.['undici'], undefined);
  });
});

describe('ctx.http rate limit', () => {
  it('waits and retries a rate-limited request', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const fetchImpl = withRateLimitRetry(
      (async () => {
        attempts += 1;
        if (attempts < 3) throw new HttpRateLimitError();
        return rpcResult(1);
      }) as unknown as typeof fetch,
      { waitsMs: [10, 20, 30], sleep: async (ms) => void waits.push(ms) },
    );
    const res = await fetchImpl('https://erp.example.com/jsonrpc');
    assert.equal(res.status, 200);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [10, 20]);
  });

  it('gives up after the last wait and rethrows the kernel error', async () => {
    let attempts = 0;
    const fetchImpl = withRateLimitRetry(
      (async () => {
        attempts += 1;
        throw new HttpRateLimitError();
      }) as unknown as typeof fetch,
      { waitsMs: [1, 1], sleep: async () => undefined },
    );
    await assert.rejects(fetchImpl('https://erp.example.com/jsonrpc'), { name: 'HttpRateLimitError' });
    assert.equal(attempts, 3);
  });

  it('does not retry any other error', async () => {
    let attempts = 0;
    const forbidden = new Error('not permitted');
    forbidden.name = 'HttpForbiddenError';
    const fetchImpl = withRateLimitRetry(
      (async () => {
        attempts += 1;
        throw forbidden;
      }) as unknown as typeof fetch,
      { waitsMs: [1, 1], sleep: async () => undefined },
    );
    await assert.rejects(fetchImpl('https://erp.example.com/jsonrpc'), { name: 'HttpForbiddenError' });
    assert.equal(attempts, 1);
  });
});

describe('entity-sync pacing', () => {
  it('spaces concurrent requests by the interval', async () => {
    const sleeps: number[] = [];
    let sent = 0;
    const fetchImpl = withMinInterval(
      (async () => {
        sent += 1;
        return rpcResult(1);
      }) as unknown as typeof fetch,
      1_500,
      { now: () => 1_000, sleep: async (ms) => void sleeps.push(ms) },
    );
    await Promise.all([fetchImpl('a'), fetchImpl('b'), fetchImpl('c')]);
    assert.equal(sent, 3);
    // The first goes at once, the next two at +1.5 s and +3 s.
    assert.deepEqual(sleeps, [1_500, 3_000]);
  });

  it('does not wait when requests are already far apart', async () => {
    let clock = 0;
    let slept = 0;
    const fetchImpl = withMinInterval(
      (async () => rpcResult(1)) as unknown as typeof fetch,
      1_500,
      { now: () => clock, sleep: async (ms) => void (slept += ms) },
    );
    await fetchImpl('a');
    clock += 10_000;
    await fetchImpl('b');
    assert.equal(slept, 0);
  });
});
