import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EntityRefBus } from '@omadia/plugin-api';
import { executeOdoo } from '@omadia/integration-odoo';
import type { OdooClient } from '@omadia/integration-odoo';
import { turnContext } from '@omadia/orchestrator';

const newBus = (): EntityRefBus =>
  new EntityRefBus({ getCurrentTurnId: () => turnContext.currentTurnId() });

/** Minimal stub mimicking the execute() method we depend on. */
function stubClient(impl: (model: string, method: string) => unknown): OdooClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    execute: async ({ model, method }: { model: string; method: string }) =>
      impl(model, method),
  } as any;
}

describe('executeOdoo', () => {
  it('rejects methods outside the read-only whitelist', async () => {
    const bus = newBus();
    const outcome = await executeOdoo(
      {
        scope: 'accounting',
        model: 'account.move',
        method: 'write', // write is never allowed
        positionalArgs: [],
        kwargs: {},
      },
      { client: stubClient(() => []), entityRefBus: bus },
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.kind, 'method_not_allowed');
  });

  it('rejects models outside the scope whitelist', async () => {
    const bus = newBus();
    const outcome = await executeOdoo(
      {
        scope: 'accounting',
        model: 'hr.employee', // not in accounting scope
        method: 'search_read',
        positionalArgs: [],
        kwargs: {},
      },
      { client: stubClient(() => []), entityRefBus: bus },
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.kind, 'model_not_allowed');
  });

  it('rejects HR requests that ask for red-line fields', async () => {
    const bus = newBus();
    const outcome = await executeOdoo(
      {
        scope: 'hr',
        model: 'hr.employee',
        method: 'search_read',
        positionalArgs: [],
        kwargs: { fields: ['name', 'wage'] },
      },
      { client: stubClient(() => []), entityRefBus: bus },
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.error.kind, 'hr_red_line_field');
      assert.equal(outcome.error.field, 'wage');
    }
  });

  it('rejects dotted red-line sub-selectors (contract_id.wage)', async () => {
    const bus = newBus();
    const outcome = await executeOdoo(
      {
        scope: 'hr',
        model: 'hr.employee',
        method: 'search_read',
        positionalArgs: [],
        kwargs: { fields: ['contract_id.wage'] },
      },
      { client: stubClient(() => []), entityRefBus: bus },
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.kind, 'hr_red_line_field');
  });

  it('strips red-line fields from HR responses even when not requested', async () => {
    const bus = newBus();
    // Odoo can return default fields the agent never asked for — the strip
    // step is defense-in-depth.
    const client = stubClient(() => [
      {
        id: 1,
        name: 'Anna',
        wage: 5000, // red-line: must be stripped
        private_email: 'anna@home', // red-line: must be stripped
        department_id: [3, 'Eng'],
      },
    ]);
    const outcome = await executeOdoo(
      {
        scope: 'hr',
        model: 'hr.employee',
        method: 'search_read',
        positionalArgs: [],
        kwargs: { fields: ['name', 'department_id'] },
      },
      { client, entityRefBus: bus },
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      const record = (outcome.result as Array<Record<string, unknown>>)[0];
      assert.equal(record?.['wage'], undefined);
      assert.equal(record?.['private_email'], undefined);
      assert.equal(record?.['name'], 'Anna');
      assert.deepEqual(record?.['department_id'], [3, 'Eng']);
    }
  });

  it('publishes EntityRefs to the bus tagged with the active turnId', async () => {
    const bus = newBus();
    const client = stubClient(() => [{ id: 7, name: 'Rec' }]);
    const collection = bus.beginCollection('turn-Z');
    await turnContext.run({ turnId: 'turn-Z', turnDate: '2026-04-19' }, async () => {
      await executeOdoo(
        {
          scope: 'accounting',
          model: 'res.partner',
          method: 'search_read',
          positionalArgs: [],
          kwargs: {},
        },
        { client, entityRefBus: bus },
      );
    });
    const refs = collection.drain();
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.id, 7);
  });
});
