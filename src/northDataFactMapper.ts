import { z } from 'zod';
import {
  personSyntheticId,
  type CompanyIngest,
  type CompanyRelationsIngest,
  type CompanyStatus,
  type FinancialIndicator,
  type FinancialSnapshotIngest,
  type ManagesEdgeIngest,
  type PersonIngest,
  type RiskLevel,
  type ShareholderEdgeIngest,
  type SucceededByEdgeIngest,
} from './kernel-types.js';

/**
 * Pure, deterministic mapper: NorthData `/company/v1/company` JSON response →
 * graph-ingestable objects + a derived risk verdict.
 *
 * Design:
 *   - Parse the API boundary once through a narrow zod schema so the rest of
 *     the function can be strict and return-only-what-we-need. Unknown fields
 *     pass through (`.passthrough()`) because the API surfaces many fields we
 *     don't flatten yet.
 *   - No LLM. No network. Easy to unit-test and re-run on replayed JSON.
 *   - Risk derivation is a fixed rule set. NorthData has no credit score we
 *     could import, so the verdict comes from `status + recent events + latest
 *     equity sign`.
 */

const NumberOrString = z.union([z.number(), z.string()]).optional();

const FinancialItemRaw = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    value: z.number().optional(),
    unit: z.string().optional(),
    estimate: z.boolean().optional(),
    note: z.string().optional(),
    formattedValue: z.string().optional(),
  })
  .passthrough();

const FinancialsRaw = z
  .object({
    date: z.string().optional(),
    formattedDate: z.string().optional(),
    consolidated: z.boolean().optional(),
    source: z
      .object({
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    items: z.array(FinancialItemRaw).optional(),
  })
  .passthrough();

const EventRaw = z
  .object({
    type: z.string(),
    date: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const EventsRaw = z
  .object({ items: z.array(EventRaw).optional() })
  .passthrough();

const AddressRaw = z
  .object({
    street: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    formattedValue: z.string().optional(),
  })
  .passthrough();

const RegisterRaw = z
  .object({
    country: z.string().optional(),
    city: z.string().optional(),
    id: z.string().optional(),
    uniqueKey: z.string().optional(),
  })
  .passthrough();

const CompanyNameRaw = z
  .object({
    name: z.string().optional(),
    legalForm: z.string().optional(),
  })
  .passthrough();

const PersonNameRaw = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

const RelatedPersonRaw = z
  .object({
    id: z.string().optional(),
    name: PersonNameRaw.optional(),
    address: AddressRaw.optional(),
    birthDate: z.string().optional(),
  })
  .passthrough();

const RelatedCompanyRaw = z
  .object({
    id: z.string().optional(),
    name: CompanyNameRaw.optional(),
    register: RegisterRaw.optional(),
  })
  .passthrough();

const RoleRaw = z
  .object({
    group: z.string().optional(),
    type: z.string().optional(),
    dir: z.string().optional(),
    sharesPercent: z.number().optional(),
    announce: z.boolean().optional(),
    date: NumberOrString,
    until: NumberOrString,
  })
  .passthrough();

const RelationRaw = z
  .object({
    company: RelatedCompanyRaw.optional(),
    person: RelatedPersonRaw.optional(),
    description: z.string().optional(),
    roles: z.array(RoleRaw).optional(),
  })
  .passthrough();

const RelationsRaw = z
  .object({ items: z.array(RelationRaw).optional() })
  .passthrough();

const ExtraItemRaw = z
  .object({
    id: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .passthrough();

const ExtrasRaw = z
  .object({
    items: z.array(ExtraItemRaw).optional(),
    sourceName: z.string().optional(),
  })
  .passthrough();

export const NorthDataCompanyResponseSchema = z
  .object({
    id: z.string().optional(),
    rawName: z.string().optional(),
    name: CompanyNameRaw.optional(),
    address: AddressRaw.optional(),
    register: RegisterRaw.optional(),
    status: z.string().optional(),
    terminated: z.boolean().optional(),
    proxyPolicy: z.string().optional(),
    northDataUrl: z.string().optional(),
    segmentCodes: z.record(z.string(), z.array(z.string())).optional(),
    capital: FinancialsRaw.optional(),
    financials: FinancialsRaw.optional(),
    events: EventsRaw.optional(),
    extras: ExtrasRaw.optional(),
    relations: RelationsRaw.optional(),
  })
  .passthrough();

export type NorthDataCompanyResponse = z.infer<
  typeof NorthDataCompanyResponseSchema
>;

export interface MappedCompany {
  company: CompanyIngest;
  persons: PersonIngest[];
  relations: CompanyRelationsIngest;
  financialSnapshots: FinancialSnapshotIngest[];
  /** Raw roles surfaced on the Relations block — useful for the UI. */
  rawRoleCount: number;
}

export class NorthDataMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NorthDataMappingError';
  }
}

/**
 * Transform one `Company` response into graph-ingestable objects. Throws
 * `NorthDataMappingError` when the response lacks the one truly non-negotiable
 * field: `register.uniqueKey` — without that we have no stable identity and
 * ingesting would be meaningless (the next sync would create a duplicate).
 */
export function mapCompanyResponse(raw: unknown): MappedCompany {
  const parsed = NorthDataCompanyResponseSchema.parse(raw);
  const uniqueKey = parsed.register?.uniqueKey?.trim();
  if (!uniqueKey) {
    throw new NorthDataMappingError(
      'NorthData response is missing register.uniqueKey — cannot ingest without a stable identity.',
    );
  }

  const status = normaliseStatus(parsed.status);
  const vatId = readExtra(parsed.extras?.items, 'vatId');
  const eventsArr = parsed.events?.items ?? [];

  // Derive risk signals before building the Company ingest so we can attach
  // them directly. Deterministic function of inputs — same JSON in → same
  // signals out.
  const riskSignals: string[] = [];
  if (status === 'terminated') riskSignals.push('register_terminated');
  if (status === 'liquidation') riskSignals.push('register_liquidation');

  const insolvencyEvent = findInsolvencyEvent(eventsArr);
  if (insolvencyEvent) {
    riskSignals.push(
      `insolvency_opened_${insolvencyEvent.date ?? 'unknown'}`,
    );
  }

  const financialSnapshots = mapFinancials(parsed.financials, uniqueKey);
  const latest = financialSnapshots[0];
  if (latest) {
    const equity = findEquityValue(latest.items);
    if (equity !== undefined && equity < 0) {
      riskSignals.push(`negative_equity_${String(latest.fiscalYear)}`);
    }
  }

  const riskLevel = deriveRiskLevel(status, riskSignals);

  const companyName =
    parsed.name?.name?.trim() ||
    parsed.rawName?.trim() ||
    '(unbekannter Firmenname)';

  const company: CompanyIngest = {
    externalId: uniqueKey,
    name: companyName,
    ...(parsed.rawName ? { rawName: parsed.rawName } : {}),
    ...(parsed.name?.legalForm ? { legalForm: parsed.name.legalForm } : {}),
    ...(parsed.register?.city ? { registerCourt: parsed.register.city } : {}),
    ...(parsed.register?.id ? { registerNumber: parsed.register.id } : {}),
    ...(parsed.register?.country
      ? { registerCountry: parsed.register.country.toUpperCase() }
      : {}),
    ...(status ? { status } : {}),
    ...(parsed.terminated !== undefined
      ? { terminated: parsed.terminated }
      : {}),
    ...(parsed.address?.formattedValue
      ? { address: parsed.address.formattedValue }
      : {}),
    ...(vatId ? { vatId } : {}),
    ...(parsed.proxyPolicy ? { proxyPolicy: parsed.proxyPolicy } : {}),
    ...(parsed.northDataUrl ? { northDataUrl: parsed.northDataUrl } : {}),
    ...(parsed.segmentCodes ? { segmentCodes: parsed.segmentCodes } : {}),
    ...(riskLevel ? { riskLevel } : {}),
    ...(riskSignals.length > 0 ? { riskSignals } : {}),
  };

  const persons: PersonIngest[] = [];
  const manages: ManagesEdgeIngest[] = [];
  const shareholders: ShareholderEdgeIngest[] = [];
  const successions: SucceededByEdgeIngest[] = [];

  let rawRoleCount = 0;
  for (const rel of parsed.relations?.items ?? []) {
    const roles = rel.roles ?? [];
    rawRoleCount += roles.length;

    if (rel.person) {
      const personPayload = buildPersonIngest(rel.person);
      if (!personPayload) continue;
      persons.push(personPayload);

      for (const role of roles) {
        const group = (role.group ?? '').toLowerCase();
        if (group === 'personal') {
          manages.push({
            personExternalId: personPayload.externalId,
            companyExternalId: uniqueKey,
            ...(role.type ? { role: role.type } : {}),
            ...(typeof role.date === 'string' ? { since: role.date } : {}),
            ...(typeof role.until === 'string' ? { until: role.until } : {}),
          });
        } else if (group === 'interest' || group === 'control') {
          // `Interest`/`Control` cover ownership ties in the NorthData model.
          shareholders.push({
            holderExternalId: personPayload.externalId,
            holderType: 'Person',
            companyExternalId: uniqueKey,
            ...(role.sharesPercent !== undefined
              ? { sharePercent: role.sharesPercent }
              : {}),
            ...(typeof role.date === 'string' ? { since: role.date } : {}),
            ...(typeof role.until === 'string' ? { until: role.until } : {}),
          });
        }
      }
      continue;
    }

    if (rel.company) {
      const relatedKey = rel.company.register?.uniqueKey?.trim();
      if (!relatedKey) continue; // without a stable key we can't link.
      for (const role of roles) {
        const group = (role.group ?? '').toLowerCase();
        if (group === 'interest' || group === 'control') {
          shareholders.push({
            holderExternalId: relatedKey,
            holderType: 'Company',
            companyExternalId: uniqueKey,
            ...(role.sharesPercent !== undefined
              ? { sharePercent: role.sharesPercent }
              : {}),
            ...(typeof role.date === 'string' ? { since: role.date } : {}),
            ...(typeof role.until === 'string' ? { until: role.until } : {}),
          });
        } else if (group === 'succession' || group === 'merger') {
          const dir = (role.dir ?? '').toLowerCase();
          // dir=source → related company is the predecessor
          // dir=target → related company is the successor (we point to it)
          if (dir === 'target') {
            successions.push({
              fromCompanyExternalId: uniqueKey,
              toCompanyExternalId: relatedKey,
              ...(role.type ? { reason: role.type } : {}),
            });
          } else if (dir === 'source') {
            successions.push({
              fromCompanyExternalId: relatedKey,
              toCompanyExternalId: uniqueKey,
              ...(role.type ? { reason: role.type } : {}),
            });
          }
        }
      }
    }
  }

  return {
    company,
    persons,
    relations: {
      ...(manages.length > 0 ? { manages } : {}),
      ...(shareholders.length > 0 ? { shareholders } : {}),
      ...(successions.length > 0 ? { successions } : {}),
    },
    financialSnapshots,
    rawRoleCount,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normaliseStatus(raw: string | undefined): CompanyStatus | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === 'active' || lower === 'liquidation' || lower === 'terminated') {
    return lower;
  }
  return undefined;
}

function readExtra(
  items: Array<{ id: string; value?: string | number | boolean }> | undefined,
  id: string,
): string | undefined {
  const hit = items?.find((x) => x.id === id);
  const value = hit?.value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Insolvency event matcher. NorthData's event-type list is dynamic (Appendix G
 * of the user guide) but German insolvency types all contain `Insolv` or map
 * to the canonical source code `Ins`. We match defensively so any new variant
 * still trips the signal.
 */
function findInsolvencyEvent(
  events: Array<{ type: string; date?: string; description?: string }>,
): { type: string; date?: string } | undefined {
  for (const ev of events) {
    const t = (ev.type ?? '').toLowerCase();
    if (
      t.includes('insolv') ||
      t === 'bankruptcyfiling' ||
      t === 'bankruptcy' ||
      t.includes('insolvenz')
    ) {
      return { type: ev.type, ...(ev.date ? { date: ev.date } : {}) };
    }
  }
  return undefined;
}

/**
 * Heuristic equity lookup across Financial.items. Indicator ids are
 * documented as dynamic (northdata.com/_financials), so we match several
 * common variants and treat the first hit as "equity". Conservative: a miss
 * yields `undefined` rather than a false signal.
 */
function findEquityValue(items: FinancialIndicator[]): number | undefined {
  const candidates = ['equity', 'ekQuote', 'eigenkapital', 'totalEquity'];
  for (const id of candidates) {
    const hit = items.find(
      (it) => it.id.toLowerCase() === id.toLowerCase() && typeof it.value === 'number',
    );
    if (hit && typeof hit.value === 'number') return hit.value;
  }
  return undefined;
}

function deriveRiskLevel(
  status: CompanyStatus | undefined,
  signals: string[],
): RiskLevel | undefined {
  if (signals.some((s) => s.startsWith('insolvency_opened_'))) return 'critical';
  if (status === 'terminated') return 'critical';
  if (status === 'liquidation') return 'high';
  if (signals.some((s) => s.startsWith('negative_equity_'))) return 'high';
  if (status === 'active') return 'low';
  return undefined;
}

function mapFinancials(
  raw: z.infer<typeof FinancialsRaw> | undefined,
  _companyExternalId: string,
): FinancialSnapshotIngest[] {
  if (!raw?.items || raw.items.length === 0) return [];
  const year = yearFromIsoDate(raw.date);
  if (year === undefined) return [];
  const items: FinancialIndicator[] = raw.items.map((it) => ({
    id: it.id,
    ...(it.name !== undefined ? { name: it.name } : {}),
    ...(it.value !== undefined ? { value: it.value } : {}),
    ...(it.unit !== undefined ? { unit: it.unit } : {}),
    ...(it.estimate !== undefined ? { estimate: it.estimate } : {}),
    ...(it.note !== undefined ? { note: it.note } : {}),
  }));
  return [
    {
      companyExternalId: _companyExternalId,
      fiscalYear: year,
      ...(raw.date ? { date: raw.date } : {}),
      ...(raw.consolidated !== undefined
        ? { consolidated: raw.consolidated }
        : {}),
      ...(raw.source?.name ? { sourceName: raw.source.name } : {}),
      items,
    },
  ];
}

function yearFromIsoDate(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const match = /^(\d{4})/.exec(iso);
  if (!match) return undefined;
  const year = Number(match[1]);
  if (Number.isNaN(year) || year < 1900 || year > 2100) return undefined;
  return year;
}

function buildPersonIngest(
  raw: z.infer<typeof RelatedPersonRaw>,
): PersonIngest | undefined {
  const lastName = raw.name?.lastName?.trim();
  if (!lastName) return undefined;
  const firstName = raw.name?.firstName?.trim();
  const birthDate = raw.birthDate?.trim();
  const city = raw.address?.city?.trim();
  const externalId = personSyntheticId({
    lastName,
    ...(firstName ? { firstName } : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(city ? { city } : {}),
  });
  const display = [raw.name?.title, firstName, lastName]
    .filter((s): s is string => Boolean(s && s.length > 0))
    .join(' ')
    .trim();
  return {
    externalId,
    name: display.length > 0 ? display : lastName,
    lastName,
    ...(firstName ? { firstName } : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(city ? { city } : {}),
    ...(raw.id ? { internalNorthDataId: raw.id } : {}),
  };
}
