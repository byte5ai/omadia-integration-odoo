import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { PluginContext } from '@omadia/plugin-api';
import { OdooClient, OdooClientError, verifyOdooConnection } from '@omadia/integration-odoo';
import type { OdooProbeClientFactory } from '@omadia/integration-odoo';

// --- fixtures ----------------------------------------------------------------

interface Call {
  path: string;
  method?: string;
  args?: unknown[];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Fake Odoo: `/web/database/list` answers `listResponse`, `authenticate`
 * answers `authResult` (uid 7 by default), `execute_kw` answers an empty
 * result. Records every call.
 */
function fakeOdoo(
  listResponse: () => Response,
  authResult: unknown = 7,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as {
      params: { method?: string; args?: unknown[] };
    };
    calls.push({ path, method: body.params.method, args: body.params.args });
    if (path === '/web/database/list') return listResponse();
    if (body.params.method === 'authenticate') {
      return jsonResponse({ jsonrpc: '2.0', id: null, result: authResult });
    }
    return jsonResponse({ jsonrpc: '2.0', id: null, result: [] });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const listed = (names: unknown): (() => Response) => () =>
  jsonResponse({ jsonrpc: '2.0', id: null, result: names });

const listDisabled = (): Response =>
  jsonResponse({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: 200,
      message: 'Odoo Server Error',
      data: { name: 'odoo.exceptions.AccessDenied', message: 'Access Denied' },
    },
  });

function clientFor(fetchImpl: typeof fetch, db?: string): OdooClient {
  return new OdooClient({
    url: 'https://erp.example.com',
    db,
    login: 'bot@example.com',
    apiKey: 'k',
    maxBytes: 500_000,
    fetchImpl,
  });
}

const EXEC_REQ = {
  model: 'res.partner',
  method: 'search_read',
  positionalArgs: [[]],
  kwargs: { limit: 1 },
};

const dbOf = (call: Call | undefined): unknown => call?.args?.[0];

// --- database resolution ---------------------------------------------------------

describe('optional odoo_db: database resolution', () => {
  it('a configured database is used as is, the list is never asked', async () => {
    const { fetchImpl, calls } = fakeOdoo(listed(['other']));
    await clientFor(fetchImpl, 'prod').execute(EXEC_REQ);
    assert.deepEqual(
      calls.map((c) => c.path),
      ['/jsonrpc', '/jsonrpc'],
    );
    assert.equal(dbOf(calls[0]), 'prod');
    assert.equal(dbOf(calls[1]), 'prod');
  });

  for (const db of [undefined, '', '   ']) {
    it(`db=${JSON.stringify(db)} ⇒ the first listed database for authenticate and execute_kw`, async () => {
      const { fetchImpl, calls } = fakeOdoo(listed(['first-db', 'second-db']));
      await clientFor(fetchImpl, db).execute(EXEC_REQ);
      assert.equal(calls[0]?.path, '/web/database/list');
      const authenticate = calls.find((c) => c.method === 'authenticate');
      const execute = calls.find((c) => c.method === 'execute_kw');
      assert.equal(dbOf(authenticate), 'first-db');
      assert.equal(dbOf(execute), 'first-db');
    });
  }

  it('the discovered database is cached for the client lifetime', async () => {
    const { fetchImpl, calls } = fakeOdoo(listed(['first-db']));
    const client = clientFor(fetchImpl);
    await client.execute(EXEC_REQ);
    client.invalidateSession();
    await client.execute(EXEC_REQ);
    assert.equal(calls.filter((c) => c.path === '/web/database/list').length, 1);
    assert.equal(await client.getDb(), 'first-db');
  });

  it('an empty list ⇒ a clear error, no auth verdict, and the next call asks again', async () => {
    const { fetchImpl, calls } = fakeOdoo(listed([]));
    const client = clientFor(fetchImpl);
    await assert.rejects(client.execute(EXEC_REQ), (err: unknown) => {
      assert.ok(err instanceof OdooClientError);
      assert.equal(err.status, 404);
      assert.equal(err.authRejection, undefined);
      assert.match(err.message, /set the database name/);
      return true;
    });
    await assert.rejects(client.execute(EXEC_REQ));
    assert.equal(calls.filter((c) => c.path === '/web/database/list').length, 2);
    assert.equal(calls.some((c) => c.method === 'authenticate'), false);
  });

  it('list disabled on the server (list_db = False) ⇒ a clear error, never an expired session', async () => {
    const { fetchImpl, calls } = fakeOdoo(listDisabled);
    await assert.rejects(clientFor(fetchImpl).execute(EXEC_REQ), (err: unknown) => {
      assert.ok(err instanceof OdooClientError);
      assert.equal(err.authRejection, undefined);
      assert.equal(err.upstreamBody, undefined);
      assert.match(err.message, /database list unavailable.*set the database name/);
      return true;
    });
    // no session retry: the list is asked exactly once
    assert.equal(calls.filter((c) => c.path === '/web/database/list').length, 1);
  });

  it('HTTP 401 on the list (proxy) ⇒ list unavailable, no auth verdict, no session retry', async () => {
    const { fetchImpl, calls } = fakeOdoo(() => new Response('unauthorized', { status: 401 }));
    await assert.rejects(clientFor(fetchImpl).execute(EXEC_REQ), (err: unknown) => {
      assert.ok(err instanceof OdooClientError);
      assert.notEqual(err.status, 401);
      assert.equal(err.authRejection, undefined);
      assert.match(err.message, /database list unavailable \(Odoo HTTP 401\)/);
      return true;
    });
    assert.equal(calls.filter((c) => c.path === '/web/database/list').length, 1);
  });

  it('authenticate → false with a discovered database ⇒ still a rejection, the message names the database', async () => {
    const { fetchImpl } = fakeOdoo(listed(['first-db', 'second-db']), false);
    await assert.rejects(clientFor(fetchImpl).execute(EXEC_REQ), (err: unknown) => {
      assert.ok(err instanceof OdooClientError);
      assert.equal(err.authRejection, 'protocol_auth_failure');
      assert.match(err.message, /database "first-db" is the first one Odoo lists/);
      return true;
    });
  });

  it('authenticate → false with a configured database ⇒ no database hint', async () => {
    const { fetchImpl } = fakeOdoo(listed(['other']), false);
    await assert.rejects(clientFor(fetchImpl, 'prod').execute(EXEC_REQ), (err: unknown) => {
      assert.ok(err instanceof OdooClientError);
      assert.equal(err.authRejection, 'protocol_auth_failure');
      assert.doesNotMatch(err.message, /first one Odoo lists/);
      return true;
    });
  });
});

// --- setup values ------------------------------------------------------------------

function fakeCtx(config: Record<string, unknown>): { ctx: PluginContext; logs: string[] } {
  const logs: string[] = [];
  const ctx = {
    secrets: {
      require: async (key: string) => {
        if (key === 'odoo_api_key') return 'k';
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

/** Captures the settings the probe would connect with. */
function capturingProbe(): { factory: OdooProbeClientFactory; seen: Array<string | undefined> } {
  const seen: Array<string | undefined> = [];
  return {
    seen,
    factory: (settings) => {
      seen.push(settings.db);
      return { checkCredentials: async () => undefined };
    },
  };
}

describe('optional odoo_db: setup values', () => {
  const base = { odoo_url: 'https://erp.example.com', odoo_login: 'bot@example.com' };

  for (const [label, value] of [
    ['absent', undefined],
    ['empty', ''],
    ['blank', '   '],
  ] as const) {
    it(`${label} odoo_db ⇒ activates with no database (discovered later)`, async () => {
      const { ctx } = fakeCtx(value === undefined ? base : { ...base, odoo_db: value });
      const probe = capturingProbe();
      const verdict = await verifyOdooConnection(ctx, probe.factory);
      assert.equal(verdict.status, 'connected');
      assert.deepEqual(probe.seen, [undefined]);
    });
  }

  it('a set odoo_db is passed on trimmed', async () => {
    const { ctx } = fakeCtx({ ...base, odoo_db: '  prod  ' });
    const probe = capturingProbe();
    await verifyOdooConnection(ctx, probe.factory);
    assert.deepEqual(probe.seen, ['prod']);
  });

  it('a probe against a server without a database list ⇒ inconclusive, not rejected', async () => {
    const { ctx, logs } = fakeCtx(base);
    const { fetchImpl } = fakeOdoo(listDisabled);
    const verdict = await verifyOdooConnection(ctx, (settings) =>
      new OdooClient({ ...settings, fetchImpl }),
    );
    assert.equal(verdict.status, 'inconclusive');
    assert.ok(logs.some((l) => l.includes('database list unavailable')));
  });

  for (const [label, value] of [
    ['absent', undefined],
    ['blank', '   '],
    ['non-string', 42],
  ] as const) {
    it(`OdooClient.fromContext: ${label} odoo_db ⇒ builds a client that discovers the database`, async () => {
      const { ctx } = fakeCtx(value === undefined ? base : { ...base, odoo_db: value });
      await OdooClient.fromContext(ctx, { maxBytes: 500_000, insecureTls: false });
    });
  }

  it('OdooClient.fromContext: a set odoo_db is used trimmed', async () => {
    const { ctx } = fakeCtx({ ...base, odoo_db: '  prod  ' });
    const client = await OdooClient.fromContext(ctx, { maxBytes: 500_000, insecureTls: false });
    assert.equal(await client.getDb(), 'prod');
  });
});
