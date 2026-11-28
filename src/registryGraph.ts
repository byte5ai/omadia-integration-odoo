import type { EnrichOutcome } from './companyEnrichment.js';
import type { EntityIngest, KnowledgeGraph } from './kernel-types.js';
import type {
  CompanyIngest,
  CompanyRelationsIngest,
  FinancialSnapshotIngest,
  PersonIngest,
} from './registryTypes.js';

/**
 * Company-register data in the knowledge graph (byte5ai/omadia-integration-odoo#13).
 *
 * The kernel graph writes entities only through `ingestEntities`, and the
 * bounded `knowledgeGraph@1` service holds a plugin to the entity systems its
 * manifest declares (ADR 0044, ADR 0167). Register data is not Odoo data, so
 * each provider writes into its own system:
 *
 *   - `<system>:company:<register id>` — the company; its managers,
 *     shareholders, successors and the fiscal years with financial data are
 *     small extras on it, the one source of truth for the relations;
 *   - `<system>:person:<synthetic id>` — managers and shareholders. A person
 *     carries no relation list: the graph merges extras per key, so a list
 *     written from one company would overwrite the one from another.
 *
 * There is no edge write in the contract, so relations live as entity-id
 * references in the extras. Financial snapshots are not written: a fact
 * needs a source turn (`FactIngest.sourceTurnId`), which a tool call does not
 * have. Their fiscal years stay on the company and in the tool's answer.
 * A person's birth date is used for the stable id only and never stored.
 */

export type RegistrySystem = 'openregister' | 'northdata';

export const COMPANY_MODEL = 'company';
export const PERSON_MODEL = 'person';

export interface MappedRegistryCompany {
  company: CompanyIngest;
  persons: PersonIngest[];
  relations: CompanyRelationsIngest;
  financialSnapshots: FinancialSnapshotIngest[];
}

/** `<system>:<model>:<id>`, the kernel's entity node id scheme. */
export function registryEntityId(
  system: RegistrySystem,
  model: string,
  id: string,
): string {
  return `${system}:${model}:${id}`;
}

/** Map one provider result onto `EntityIngest` rows: the company first. */
export function toRegistryEntities(
  system: RegistrySystem,
  mapped: MappedRegistryCompany,
): EntityIngest[] {
  const companyId = mapped.company.externalId;
  const ref = (model: string, id: string): string =>
    registryEntityId(system, model, id);
  const { manages = [], shareholders = [], successions = [] } = mapped.relations;

  const managers = manages
    .filter((m) => m.companyExternalId === companyId)
    .map((m) => ({
      person: ref(PERSON_MODEL, m.personExternalId),
      ...(m.role ? { role: m.role } : {}),
      ...(m.since ? { since: m.since } : {}),
      ...(m.until ? { until: m.until } : {}),
    }));
  const holders = shareholders
    .filter((s) => s.companyExternalId === companyId)
    .map((s) => ({
      holder: ref(
        s.holderType === 'Person' ? PERSON_MODEL : COMPANY_MODEL,
        s.holderExternalId,
      ),
      holderType: s.holderType,
      ...(s.sharePercent !== undefined ? { sharePercent: s.sharePercent } : {}),
      ...(s.since ? { since: s.since } : {}),
      ...(s.until ? { until: s.until } : {}),
    }));
  const successors = successions
    .filter((s) => s.fromCompanyExternalId === companyId)
    .map((s) => ({
      company: ref(COMPANY_MODEL, s.toCompanyExternalId),
      ...(s.reason ? { reason: s.reason } : {}),
    }));
  const financialYears = [
    ...new Set(mapped.financialSnapshots.map((s) => s.fiscalYear)),
  ].sort((a, b) => b - a);

  const { externalId: _id, name, extras: companyExtras, ...companyFields } =
    mapped.company;
  const company: EntityIngest = {
    system,
    model: COMPANY_MODEL,
    id: companyId,
    displayName: name,
    extras: {
      ...companyExtras,
      ...companyFields,
      // Always written, empty included: the graph merges extras per key, so
      // a key left out would keep a stale value from an earlier run (an
      // insolvency signal that no longer applies, a manager who left).
      riskLevel: companyFields.riskLevel ?? null,
      riskSignals: companyFields.riskSignals ?? [],
      managers,
      shareholders: holders,
      successors,
      financialYears,
    },
  };

  const seen = new Set<string>();
  const persons: EntityIngest[] = [];
  for (const p of mapped.persons) {
    if (seen.has(p.externalId)) continue;
    seen.add(p.externalId);
    persons.push({
      system,
      model: PERSON_MODEL,
      id: p.externalId,
      displayName: p.name,
      extras: {
        ...p.extras,
        lastName: p.lastName,
        ...(p.firstName ? { firstName: p.firstName } : {}),
        ...(p.city ? { city: p.city } : {}),
      },
    });
  }
  return [company, ...persons];
}

/**
 * Write one provider result and build the tool's success outcome.
 * `fromCache` means no row was new: the company and all its persons were
 * already in the graph (before, it looked at the company row alone).
 */
export async function ingestRegistryCompany(
  graph: KnowledgeGraph,
  system: RegistrySystem,
  mapped: MappedRegistryCompany,
): Promise<Extract<EnrichOutcome, { status: 'success' }>> {
  const rows = toRegistryEntities(system, mapped);
  const result = await graph.ingestEntities(rows);
  return {
    status: 'success',
    company: mapped.company,
    personCount: rows.length - 1,
    financialYears: mapped.financialSnapshots.map((s) => s.fiscalYear),
    fromCache: result.inserted === 0 && result.updated > 0,
  };
}
