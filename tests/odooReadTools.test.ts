import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EntityRefBus } from '@omadia/plugin-api';
import {
  scopeForModel,
  createOdooQueryHandler,
  createOdooDescribeHandler,
  createOdooVersionHandler,
} from '@omadia/integration-odoo';
import type { OdooClient, OdooReadToolDeps } from '@omadia/integration-odoo';
import { turnContext } from '@omadia/orchestrator';

const newBus = (): EntityRefBus =>
  new EntityRefBus({ getCurrentTurnId: () => turnContext.currentTurnId() });

/** Stub OdooClient: routes execute() through a supplied impl + a fixed version. */
function stubClient(
  impl: (model: string, method: string, kwargs: Record<string, unknown>) => unknown,
): OdooClient {
  return {
    execute: async ({
      model,
      method,
      kwargs,
    }: {
      model: string;
      method: string;
      kwargs: Record<string, unknown>;
    }) => impl(model, method, kwargs),
    version: async () => ({ server_version: '17.0', server_serie: '17.0' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function deps(client: OdooClient): OdooReadToolDeps {
  return { client, entityRefBus: newBus() };
}

describe('scopeForModel', () => {
  it('maps accounting + hr models and rejects unknown ones', () => {
    assert.equal(scopeForModel('account.move'), 'accounting');
    assert.equal(scopeForModel('res.partner'), 'accounting');
    assert.equal(scopeForModel('hr.employee'), 'hr');
    assert.equal(scopeForModel('hr.leave'), 'hr');
    assert.equal(scopeForModel('ir.config_parameter'), undefined);
    assert.equal(scopeForModel('sale.order'), undefined);
  });
});

describe('odoo_query handler', () => {
  it('reads a whitelisted model and returns records', async () => {
    const handler = createOdooQueryHandler(
      deps(stubClient(() => [{ id: 1, name: 'INV/001' }])),
    );
    const out = await handler({ model: 'account.move', fields: ['name'], limit: 5 });
    const parsed = JSON.parse(out);
    assert.equal(parsed.model, 'account.move');
    assert.equal(parsed.scope, 'accounting');
    assert.equal(parsed.count, 1);
    assert.equal(parsed.records[0].name, 'INV/001');
  });

  it('rejects a model outside any whitelist before hitting Odoo', async () => {
    let called = false;
    const handler = createOdooQueryHandler(
      deps(
        stubClient(() => {
          called = true;
          return [];
        }),
      ),
    );
    const out = await handler({ model: 'ir.config_parameter' });
    assert.match(out, /model_not_allowed/);
    assert.equal(called, false, 'must not call Odoo for a non-whitelisted model');
  });

  it('keeps the HR red-line block in force via the shared guard', async () => {
    const handler = createOdooQueryHandler(deps(stubClient(() => [])));
    const out = await handler({ model: 'hr.employee', fields: ['name', 'wage'] });
    assert.match(out, /hr_red_line_field/);
    assert.match(out, /wage/);
  });
});

describe('odoo_describe handler', () => {
  it('lists the whitelist with no model argument and makes no network call', async () => {
    let called = false;
    const handler = createOdooDescribeHandler(
      deps(
        stubClient(() => {
          called = true;
          return {};
        }),
      ),
    );
    const out = await handler({});
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.scopes));
    const hr = parsed.scopes.find((s: { scope: string }) => s.scope === 'hr');
    assert.ok(hr.models.includes('hr.employee'));
    assert.equal(called, false);
  });

  it('flattens fields_get for a given model', async () => {
    const handler = createOdooDescribeHandler(
      deps(
        stubClient((_m, method) => {
          assert.equal(method, 'fields_get');
          return {
            name: { string: 'Name', type: 'char' },
            amount_total: { string: 'Total', type: 'monetary' },
          };
        }),
      ),
    );
    const out = await handler({ model: 'account.move' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.count, 2);
    const name = parsed.fields.find((f: { name: string }) => f.name === 'name');
    assert.equal(name.type, 'char');
    assert.equal(name.label, 'Name');
  });
});

describe('odoo_version handler', () => {
  it('reports the server version', async () => {
    const handler = createOdooVersionHandler(deps(stubClient(() => [])));
    const out = await handler();
    const parsed = JSON.parse(out);
    assert.equal(parsed.server_version, '17.0');
  });
});
