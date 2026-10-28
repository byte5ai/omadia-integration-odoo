import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { PluginActionStatus, PluginContext } from '@omadia/plugin-api';
import {
  OdooClient,
  OdooClientError,
  createAuthStatusReporter,
  verifyConnection,
  verifyOdooConnection,
} from '@omadia/integration-odoo';
import type { OdooProbeClientFactory } from '@omadia/integration-odoo';

// --- fixtures ----------------------------------------------------------------

type FetchStub = (body: { params: { service: string; method: string } }) => Response;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Routes every JSON-RPC call through `stub`, recording the methods called. */
function fakeFetch(stub: FetchStub): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as {
      params: { service: string; method: string };
    };
    calls.push(`${body.params.service}.${body.params.method}`);
    return stub(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function failingFetch(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

interface FakeCtx {
  ctx: PluginContext;
  logs: string[];
}

function fakeCtx(opts: { apiKey?: string } = {}): FakeCtx {
  const logs: string[] = [];
  const config: Record<string, string> = {
    odoo_url: 'https://erp.example.com',
    odoo_db: 'prod',
    odoo_login: 'bot@example.com',
  };
  const ctx = {
    secrets: {
      require: async (key: string) => {
        if (key === 'odoo_api_key' && opts.apiKey !== undefined) return opts.apiKey;
        throw new Error(`missing secret ${key}`);
      },
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
  } as unknown as PluginContext;
  return { ctx, logs };
}

function probeWith(fetchImpl: typeof fetch): OdooProbeClientFactory {
  return (settings) => new OdooClient({ ...settings, fetchImpl });
}

function recordingStatus(): {
  status: { report(s: PluginActionStatus): void; clear(): void };
  reports: PluginActionStatus[];
} {
  const reports: PluginActionStatus[] = [];
  return {
    reports,
    status: {
      report: (s) => {
        reports.push(s);
      },
      clear: () => {
        reports.push({ state: 'ok' });
      },
    },
  };
}

const authenticateReturns =
  (result: unknown, onExecute: () => Response = () => jsonResponse({ result: [] })): FetchStub =>
  (body) =>
    body.params.method === 'authenticate'
      ? jsonResponse({ jsonrpc: '2.0', id: null, result })
      : onExecute();

const EXEC_REQ = {
  model: 'hr.employee',
  method: 'search_read',
  positionalArgs: [[]],
  kwargs: { limit: 1 },
};

// --- verifyConnection ----------------------------------------------------------

describe('verifyConnection (omadia#1453)', () => {
  it('is exported from the plugin entry', () => {
    assert.equal(typeof verifyConnection, 'function');
  });

  it('accepted uid ⇒ connected, via one fresh authenticate', async () => {
    const { ctx } = fakeCtx({ apiKey: 'good' });
    const { fetchImpl, calls } = fakeFetch(authenticateReturns(7));
    const verdict = await verifyOdooConnection(ctx, probeWith(fetchImpl));
    assert.deepEqual(verdict, { status: 'connected' });
    assert.deepEqual(calls, ['common.authenticate']);
  });

  it('authenticate → false ⇒ rejected with protocol_auth_failure', async () => {
    const { ctx } = fakeCtx({ apiKey: 'falsch-1234' });
    const { fetchImpl } = fakeFetch(authenticateReturns(false));
    const verdict = await verifyOdooConnection(ctx, probeWith(fetchImpl));
    assert.deepEqual(verdict, { status: 'rejected', cause: 'protocol_auth_failure' });
  });

  it('HTTP 401 ⇒ rejected with http_401', async () => {
    const { ctx } = fakeCtx({ apiKey: 'k' });
    const { fetchImpl } = fakeFetch(() => new Response('Unauthorized', { status: 401 }));
    const verdict = await verifyOdooConnection(ctx, probeWith(fetchImpl));
    assert.deepEqual(verdict, { status: 'rejected', cause: 'http_401' });
  });

  for (const status of [500, 502, 503, 504, 429, 403, 404]) {
    it(`HTTP ${String(status)} ⇒ inconclusive`, async () => {
      const { ctx } = fakeCtx({ apiKey: 'k' });
      const { fetchImpl } = fakeFetch(() => new Response('nope', { status }));
      const verdict = await verifyOdooConnection(ctx, probeWith(fetchImpl));
      assert.deepEqual(verdict, { status: 'inconclusive' });
    });
  }

  it('timeout ⇒ inconclusive', async () => {
    const { ctx, logs } = fakeCtx({ apiKey: 'k' });
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const verdict = await verifyOdooConnection(ctx, probeWith(failingFetch(timeout)));
    assert.deepEqual(verdict, { status: 'inconclusive' });
    assert.ok(logs.some((l) => l.includes('inconclusive')));
  });

  it('DNS / network failure ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({ apiKey: 'k' });
    const dns = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND erp.example.com'), {
        code: 'ENOTFOUND',
      }),
    });
    const verdict = await verifyOdooConnection(ctx, probeWith(failingFetch(dns)));
    assert.deepEqual(verdict, { status: 'inconclusive' });
  });

  it('captive-portal HTML over 200 ⇒ inconclusive, not connected', async () => {
    const { ctx } = fakeCtx({ apiKey: 'k' });
    const { fetchImpl } = fakeFetch(() => new Response('<html>login</html>', { status: 200 }));
    const verdict = await verifyOdooConnection(ctx, probeWith(fetchImpl));
    assert.deepEqual(verdict, { status: 'inconclusive' });
  });

  it('JSON-RPC error (e.g. unknown database) ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({ apiKey: 'k' });
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', error: { message: 'Odoo Server Error', data: { message: 'database "prod" does not exist' } } }),
    );
    const verdict = await verifyOdooConnection(ctx, probeWith(fetchImpl));
    assert.deepEqual(verdict, { status: 'inconclusive' });
  });

  it('missing setup field ⇒ inconclusive, never throws', async () => {
    const { ctx } = fakeCtx(); // no api key in the vault
    let factoryCalled = false;
    const verdict = await verifyOdooConnection(ctx, () => {
      factoryCalled = true;
      throw new Error('unreachable');
    });
    assert.deepEqual(verdict, { status: 'inconclusive' });
    assert.equal(factoryCalled, false);
  });

  it('never carries operator-facing copy (the kernel ships none, the web-ui localizes)', async () => {
    const { ctx } = fakeCtx({ apiKey: 'k' });
    const { fetchImpl } = fakeFetch(authenticateReturns(false));
    const verdict = await verifyOdooConnection(ctx, probeWith(fetchImpl));
    assert.equal(verdict.title, undefined);
    assert.equal(verdict.detail, undefined);
  });
});

// --- call-time reporting -------------------------------------------------------

function clientWith(fetchImpl: typeof fetch, status: ReturnType<typeof recordingStatus>['status']) {
  return new OdooClient({
    url: 'https://erp.example.com',
    db: 'prod',
    login: 'bot@example.com',
    apiKey: 'k',
    maxBytes: 500_000,
    fetchImpl,
    authObserver: createAuthStatusReporter(status),
  });
}

describe('call-time auth status reporting (omadia#1453)', () => {
  it('authenticate → false on a real call ⇒ reports error, still throws the 401', async () => {
    const rec = recordingStatus();
    const { fetchImpl } = fakeFetch(authenticateReturns(false));
    const client = clientWith(fetchImpl, rec.status);
    await assert.rejects(client.execute(EXEC_REQ), (err: unknown) => {
      assert.ok(err instanceof OdooClientError);
      assert.equal(err.status, 401);
      assert.equal(err.authRejection, 'protocol_auth_failure');
      return true;
    });
    assert.ok(rec.reports.length >= 1);
    assert.ok(rec.reports.every((r) => r.state === 'error'));
    assert.equal(rec.reports[0]?.title, undefined);
  });

  it('HTTP 401 on execute_kw ⇒ reports error', async () => {
    const rec = recordingStatus();
    const { fetchImpl } = fakeFetch(
      authenticateReturns(7, () => new Response('Unauthorized', { status: 401 })),
    );
    const client = clientWith(fetchImpl, rec.status);
    await assert.rejects(client.execute(EXEC_REQ));
    assert.deepEqual(rec.reports.at(-1), { state: 'error' });
  });

  it('5xx / network failure on a real call ⇒ reports nothing', async () => {
    const rec = recordingStatus();
    const { fetchImpl } = fakeFetch(
      authenticateReturns(7, () => new Response('down', { status: 503 })),
    );
    await assert.rejects(clientWith(fetchImpl, rec.status).execute(EXEC_REQ));
    await assert.rejects(
      clientWith(failingFetch(new TypeError('fetch failed')), rec.status).execute(EXEC_REQ),
    );
    assert.deepEqual(rec.reports, []);
  });

  it('success after a reported error ⇒ reports ok once', async () => {
    const rec = recordingStatus();
    let keyValid = false;
    const { fetchImpl } = fakeFetch((body) =>
      body.params.method === 'authenticate'
        ? jsonResponse({ result: keyValid ? 7 : false })
        : jsonResponse({ result: [{ id: 1 }] }),
    );
    const client = clientWith(fetchImpl, rec.status);

    await assert.rejects(client.execute(EXEC_REQ));
    assert.equal(rec.reports.at(-1)?.state, 'error');

    keyValid = true;
    rec.reports.length = 0;
    assert.deepEqual(await client.execute(EXEC_REQ), [{ id: 1 }]);
    assert.deepEqual(rec.reports, [{ state: 'ok' }]);

    // A second success must not report again.
    await client.execute(EXEC_REQ);
    assert.deepEqual(rec.reports, [{ state: 'ok' }]);
  });

  it('success without a plugin-raised error ⇒ reports nothing (does not clobber the probe verdict)', async () => {
    const rec = recordingStatus();
    const { fetchImpl } = fakeFetch(authenticateReturns(7));
    await clientWith(fetchImpl, rec.status).execute(EXEC_REQ);
    assert.deepEqual(rec.reports, []);
  });

  it('a throwing status sink never breaks or masks the Odoo call', async () => {
    const throwing = {
      report: () => {
        throw new Error('sink down');
      },
      clear: () => {
        throw new Error('sink down');
      },
    };
    const ok = fakeFetch(authenticateReturns(7, () => jsonResponse({ result: [{ id: 2 }] })));
    assert.deepEqual(await clientWith(ok.fetchImpl, throwing).execute(EXEC_REQ), [{ id: 2 }]);

    const bad = fakeFetch(authenticateReturns(false));
    await assert.rejects(clientWith(bad.fetchImpl, throwing).execute(EXEC_REQ), OdooClientError);
  });

  it('tolerates a host without ctx.status', async () => {
    const observer = createAuthStatusReporter(undefined);
    observer.onAuthRejected('http_401');
    observer.onAuthAccepted();
  });
});
