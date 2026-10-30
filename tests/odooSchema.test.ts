import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EntityRefBus } from '@omadia/plugin-api';
import {
  ALLOWED_MODELS,
  createOdooSchemaService,
  OdooClientError,
  OdooSchemaError,
  parseFieldsGet,
} from '@omadia/integration-odoo';
import type { OdooClient } from '@omadia/integration-odoo';
import { turnContext } from '@omadia/orchestrator';

const newBus = (): EntityRefBus =>
  new EntityRefBus({ getCurrentTurnId: () => turnContext.currentTurnId() });

interface Call {
  model: string;
  method: string;
  kwargs: Record<string, unknown>;
}

function stubClient(impl: (call: Call) => unknown, calls: Call[] = []): OdooClient {
  return {
    execute: async (req: Call) => {
      calls.push(req);
      return impl(req);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function service(client: OdooClient, genericReadEnabled = false) {
  return createOdooSchemaService({ client, entityRefBus: newBus(), genericReadEnabled });
}

describe('odoo.schema@1 — listModels', () => {
  it('lists every whitelisted model once, sorted, with its scope and no network call', () => {
    const calls: Call[] = [];
    const models = service(stubClient(() => ({}), calls)).listModels();
    const expected = [...ALLOWED_MODELS.hr, ...ALLOWED_MODELS.accounting].sort();
    assert.deepEqual(
      models.map((m) => m.model),
      expected,
    );
    assert.equal(models.find((m) => m.model === 'hr.employee')?.scope, 'hr');
    assert.equal(models.find((m) => m.model === 'account.move')?.scope, 'accounting');
    assert.equal(calls.length, 0);
  });

  it('names odoo_execute as the reading tool, plus odoo_query only when generic reads are on', () => {
    const off = service(stubClient(() => ({})), false).listModels();
    assert.ok(off.every((m) => m.tools.join() === 'odoo_execute'));
    const on = service(stubClient(() => ({})), true).listModels();
    assert.ok(on.every((m) => m.tools.join() === 'odoo_execute,odoo_query'));
  });
});

describe('odoo.schema@1 — describeModel', () => {
  it('runs one fields_get asking for the relation, and returns sorted fields', async () => {
    const calls: Call[] = [];
    const svc = service(
      stubClient(
        () => ({
          name: { string: 'Name', type: 'char' },
          department_id: {
            string: 'Department',
            type: 'many2one',
            relation: 'hr.department',
            help: 'The department',
          },
          category_ids: { string: 'Tags', type: 'many2many', relation: 'hr.employee.category' },
        }),
        calls,
      ),
    );
    const fields = await svc.describeModel('hr.employee');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'fields_get');
    assert.equal(calls[0]!.model, 'hr.employee');
    assert.deepEqual(calls[0]!.kwargs['attributes'], ['type', 'relation', 'string', 'help']);
    assert.deepEqual(fields, [
      { name: 'category_ids', type: 'many2many', relation: 'hr.employee.category', label: 'Tags' },
      {
        name: 'department_id',
        type: 'many2one',
        relation: 'hr.department',
        label: 'Department',
        help: 'The department',
      },
      { name: 'name', type: 'char', label: 'Name' },
    ]);
  });

  it('never lists an HR red-line field', async () => {
    const svc = service(
      stubClient(() => ({
        wage: { string: 'Wage', type: 'monetary' },
        bank_account_id: { string: 'Bank', type: 'many2one', relation: 'res.partner.bank' },
        job_id: { string: 'Job', type: 'many2one', relation: 'hr.job' },
      })),
    );
    const fields = await svc.describeModel('hr.employee');
    assert.deepEqual(
      fields.map((f) => f.name),
      ['job_id'],
    );
  });

  it('refuses a model outside the whitelist without calling Odoo', async () => {
    const calls: Call[] = [];
    const svc = service(stubClient(() => ({}), calls));
    await assert.rejects(svc.describeModel('res.users'), OdooSchemaError);
    await assert.rejects(svc.describeModel('hr.employee; drop'), OdooSchemaError);
    assert.equal(calls.length, 0);
  });

  it('passes an Odoo client error through', async () => {
    const svc = service(
      stubClient(() => {
        throw new OdooClientError('unreachable', 502);
      }),
    );
    await assert.rejects(svc.describeModel('hr.department'), OdooClientError);
  });
});

describe('parseFieldsGet', () => {
  it('drops malformed entries and empty attributes', () => {
    assert.deepEqual(parseFieldsGet(null), []);
    assert.deepEqual(parseFieldsGet([]), []);
    assert.deepEqual(
      parseFieldsGet({
        a: null,
        b: { string: 'B' },
        c: { type: 'many2one', relation: '', string: '' },
      }),
      [{ name: 'c', type: 'many2one' }],
    );
  });
});
