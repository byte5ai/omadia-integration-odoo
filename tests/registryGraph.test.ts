import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { NorthDataIngest, OpenRegisterIngest } from '@omadia/integration-odoo';

// byte5ai/omadia-integration-odoo#13: enrich_company wrote through
// graph.ingestCompanies / ingestPersons / ingestCompanyRelations /
// ingestFinancialSnapshots, which the kernel no longer has. A plugin gets the
// bounded knowledgeGraph@1 service (ADR 0044): the contract methods only, with
// entity writes held to permissions.graph.entity_systems (ADR 0167).

interface EntityRow {
  system: string;
  model: string;
  id: string | number;
  displayName?: string;
  extras?: Record<string, unknown>;
}

function declaredSystems(): string[] {
  const manifest = readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8');
  const block = /\n    entity_systems:\n((?:\s+- ".*"\n)+)/.exec(manifest);
  assert.ok(block, 'permissions.graph.entity_systems is missing');
  return [...block[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1] as string);
}

/**
 * The shape of the bounded graph a plugin gets: only `ingestEntities` and
 * `ingestFacts` write, no provider-specific methods, and a write outside the
 * declared systems throws before anything is stored (the kernel's
 * `entityWriteGuard`).
 */
function boundedGraph(systems: readonly string[]): {
  graph: { ingestEntities(rows: EntityRow[]): Promise<{ entityIds: string[]; inserted: number; updated: number }> };
  nodes: Map<string, EntityRow>;
} {
  const nodes = new Map<string, EntityRow>();
  const graph = Object.freeze({
    async ingestEntities(rows: EntityRow[]) {
      for (const row of rows) {
        if (!systems.includes(row.system)) {
          throw new Error(`KgEntityNamespaceError: system '${row.system}' not declared`);
        }
      }
      let inserted = 0;
      let updated = 0;
      const entityIds: string[] = [];
      for (const row of rows) {
        const id = `${row.system}:${row.model}:${String(row.id)}`;
        const existing = nodes.get(id);
        if (existing) updated += 1;
        else inserted += 1;
        // Both kernel providers merge properties per top-level key
        // (Neon `properties || EXCLUDED.properties`, in-memory spread).
        nodes.set(id, existing ? { ...row, extras: { ...existing.extras, ...row.extras } } : row);
        entityIds.push(id);
      }
      return { entityIds, inserted, updated };
    },
    async ingestFacts() {
      return { factIds: [], inserted: 0, updated: 0 };
    },
  });
  return { graph, nodes };
}

const OPENREGISTER_BASE = {
  id: 'DE-HRB-F1103-267645',
  status: 'active',
  name: { name: 'Beispiel GmbH', legal_form: 'GmbH' },
  register: { register_court: 'Frankfurt am Main', register_number: 'HRB 267645' },
  address: { formatted_value: 'Hauptstr. 1, 60311 Frankfurt am Main' },
  representation: [
    {
      id: 'rep-1',
      name: 'Erika Mustermann',
      type: 'natural_person',
      role: 'Geschäftsführerin',
      start_date: '2020-01-01',
      natural_person: {
        first_name: 'Erika',
        last_name: 'Mustermann',
        date_of_birth: '1980-05-17',
        city: 'Frankfurt',
      },
    },
  ],
};

const OPENREGISTER_OWNERS = {
  owners: [
    {
      type: 'natural_person',
      percentage_share: 60,
      natural_person: {
        first_name: 'Erika',
        last_name: 'Mustermann',
        date_of_birth: '1980-05-17',
        city: 'Frankfurt',
      },
    },
    {
      type: 'legal_person',
      percentage_share: 40,
      legal_person: { name: 'Holding AG', company_id: 'DE-HRB-M-1' },
    },
  ],
};

const OPENREGISTER_FINANCIALS = {
  reports: [
    { year: 2023, equity: 12_000_000, revenue: 99_000_000 },
    { year: 2024, equity: 15_000_000 },
  ],
};

function fakeOpenRegisterClient(): unknown {
  return {
    getCompany: async () => OPENREGISTER_BASE,
    getOwners: async () => OPENREGISTER_OWNERS,
    getFinancials: async () => OPENREGISTER_FINANCIALS,
    autocompleteCompany: async () => ({
      results: [{ company_id: OPENREGISTER_BASE.id, name: 'Beispiel GmbH' }],
    }),
  };
}

const NORTHDATA_COMPANY = {
  name: { name: 'Nord GmbH', legalForm: 'GmbH' },
  register: { uniqueKey: '1234567890', city: 'Hamburg', id: 'HRB 1', country: 'de' },
  status: 'active',
  relations: {
    items: [
      {
        person: {
          name: { firstName: 'Max', lastName: 'Muster' },
          birthDate: '1975-01-02',
          address: { city: 'Hamburg' },
        },
        roles: [{ group: 'Personal', type: 'Geschäftsführer', date: '2019-03-01' }],
      },
    ],
  },
  financials: { date: '2024-12-31', items: [{ id: 'equity', value: 50000 }] },
};

function fakeNorthDataClient(): unknown {
  return {
    findCompanyByName: async () => NORTHDATA_COMPANY,
    getCompanyByRegisterKey: async () => NORTHDATA_COMPANY,
    universalSearch: async () => ({ results: [] }),
  };
}

describe('enrich_company writes through the bounded graph (#13)', () => {
  it('declares the provider systems next to odoo', () => {
    assert.deepEqual(declaredSystems(), ['odoo', 'openregister', 'northdata']);
  });

  it('OpenRegister: company and persons land as openregister entities', async () => {
    const { graph, nodes } = boundedGraph(declaredSystems());
    const ingest = new OpenRegisterIngest({
      client: fakeOpenRegisterClient() as never,
      graph,
      log: () => {},
    });

    const outcome = await ingest.enrichByExternalId(OPENREGISTER_BASE.id);
    assert.equal(outcome.status, 'success', JSON.stringify(outcome));
    if (outcome.status !== 'success') return;
    assert.equal(outcome.personCount, 1);
    assert.deepEqual(outcome.financialYears, [2024, 2023]);
    assert.equal(outcome.fromCache, false);

    const companyId = `openregister:company:${OPENREGISTER_BASE.id}`;
    const company = nodes.get(companyId);
    assert.ok(company, 'company node missing');
    assert.equal(company.displayName, 'Beispiel GmbH');
    assert.equal(company.extras?.['legalForm'], 'GmbH');
    assert.equal(company.extras?.['riskLevel'], 'low');
    assert.deepEqual(company.extras?.['financialYears'], [2024, 2023]);

    const persons = [...nodes.values()].filter((n) => n.model === 'person');
    assert.equal(persons.length, 1);
    const person = persons[0];
    assert.ok(person);
    assert.equal(person.system, 'openregister');
    assert.equal(person.extras?.['birthDate'], undefined, 'birth date must not be stored');
    assert.equal(person.extras?.['roles'], undefined, 'relations live on the company only');
    const personRef = `openregister:person:${String(person.id)}`;
    assert.deepEqual(company.extras?.['managers'], [
      { person: personRef, role: 'Geschäftsführerin', since: '2020-01-01' },
    ]);
    assert.deepEqual(company.extras?.['shareholders'], [
      { holder: personRef, holderType: 'Person', sharePercent: 60 },
      { holder: 'openregister:company:DE-HRB-M-1', holderType: 'Company', sharePercent: 40 },
    ]);
    assert.ok(
      [...nodes.keys()].every((id) => id.startsWith('openregister:')),
      'no node outside the provider system',
    );

    const again = await ingest.enrichByExternalId(OPENREGISTER_BASE.id);
    assert.equal(again.status, 'success');
    if (again.status === 'success') assert.equal(again.fromCache, true);
    assert.equal(nodes.size, 2, 'a second run updates, it does not duplicate');
  });

  it('a later run with fewer relations clears the stale ones', async () => {
    const { graph, nodes } = boundedGraph(declaredSystems());
    let base: Record<string, unknown> = OPENREGISTER_BASE;
    let owners: unknown = OPENREGISTER_OWNERS;
    const client = {
      getCompany: async () => base,
      getOwners: async () => owners,
      getFinancials: async () => ({ reports: [{ year: 2024, equity: -100 }] }),
      autocompleteCompany: async () => ({ results: [] }),
    };
    const ingest = new OpenRegisterIngest({ client: client as never, graph, log: () => {} });

    await ingest.enrichByExternalId(OPENREGISTER_BASE.id);
    const companyId = `openregister:company:${OPENREGISTER_BASE.id}`;
    assert.equal((nodes.get(companyId)?.extras?.['managers'] as unknown[]).length, 1);
    assert.equal(nodes.get(companyId)?.extras?.['riskLevel'], 'high');

    base = { ...OPENREGISTER_BASE, representation: [] };
    owners = { owners: [] };
    const client2Financials = { reports: [{ year: 2025, equity: 500 }] };
    client.getFinancials = async () => client2Financials;
    // A fresh ingest instance: the response cache is per instance.
    const again = new OpenRegisterIngest({ client: client as never, graph, log: () => {} });
    await again.enrichByExternalId(OPENREGISTER_BASE.id);

    const extras = nodes.get(companyId)?.extras ?? {};
    assert.deepEqual(extras['managers'], []);
    assert.deepEqual(extras['shareholders'], []);
    assert.deepEqual(extras['riskSignals'], []);
    assert.equal(extras['riskLevel'], 'low');
    assert.deepEqual(extras['financialYears'], [2025]);
  });

  it('NorthData: company and persons land as northdata entities', async () => {
    const { graph, nodes } = boundedGraph(declaredSystems());
    const ingest = new NorthDataIngest({
      client: fakeNorthDataClient() as never,
      graph,
      log: () => {},
    });

    const outcome = await ingest.enrichByExternalId('1234567890');
    assert.equal(outcome.status, 'success', JSON.stringify(outcome));
    if (outcome.status !== 'success') return;
    assert.equal(outcome.personCount, 1);
    assert.deepEqual(outcome.financialYears, [2024]);
    const company = nodes.get('northdata:company:1234567890');
    assert.ok(company, 'company node missing');
    assert.equal(company.displayName, 'Nord GmbH');
    assert.equal(nodes.size, 2);
    assert.ok([...nodes.keys()].every((id) => id.startsWith('northdata:')));
  });

  it('an undeclared provider system is refused, not written', async () => {
    const { graph, nodes } = boundedGraph(['odoo']);
    const ingest = new OpenRegisterIngest({
      client: fakeOpenRegisterClient() as never,
      graph,
      log: () => {},
    });
    const outcome = await ingest.enrichByExternalId(OPENREGISTER_BASE.id);
    assert.equal(outcome.status, 'error');
    if (outcome.status === 'error') assert.match(outcome.message, /KgEntityNamespaceError/);
    assert.equal(nodes.size, 0);
  });
});
