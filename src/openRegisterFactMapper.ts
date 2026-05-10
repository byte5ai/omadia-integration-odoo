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
} from './kernel-types.js';

/**
 * Pure, deterministic mapper: OpenRegister REST responses → graph-ingestable
 * objects + a derived risk verdict.
 *
 * Scope:
 *   - Base company details (`/v1/company/{id}`)   → Company + representation → MANAGES edges
 *   - Owners                (`/v1/company/{id}/owners`)      → Persons/Companies + SHAREHOLDER_OF edges
 *   - Financials            (`/v1/company/{id}/financials`)  → FinancialSnapshot per year (equity in cents)
 *
 * No LLM, no network. Unit-testable on replayed JSON.
 *
 * Field-shape reference: openregister SDK source
 *   https://github.com/oregister/openregister-typescript/tree/main/src/resources/company.ts
 */

// ---------------------------------------------------------------------------
// Zod schemas — narrow, passthrough at the leaves so unknown fields don't kill
// the ingest when OpenRegister adds new attributes mid-release.
// ---------------------------------------------------------------------------

const AddressRaw = z
  .object({
    city: z.string().optional(),
    country: z.string().optional(),
    formatted_value: z.string().optional(),
    street: z.string().optional(),
    postal_code: z.string().optional(),
    extra: z.string().optional(),
    start_date: z.string().optional(),
  })
  .passthrough();

const NameRaw = z
  .object({
    name: z.string(),
    legal_form: z.string().optional(),
    start_date: z.string().optional(),
  })
  .passthrough();

const RegisterRaw = z
  .object({
    register_number: z.string().optional(),
    register_type: z.string().optional(),
    register_court: z.string().optional(),
    company_id: z.string().optional(),
    start_date: z.string().optional(),
  })
  .passthrough();

const CapitalRaw = z
  .object({
    amount: z.number().optional(),
    currency: z.string().optional(),
    start_date: z.string().optional(),
  })
  .passthrough();

const NaturalPersonRaw = z
  .object({
    city: z.string().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    date_of_birth: z.string().nullable().optional(),
  })
  .passthrough();

const LegalPersonRaw = z
  .object({
    name: z.string().optional(),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    company_id: z.string().optional(),
  })
  .passthrough();

const RepresentationItemRaw = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.enum(['natural_person', 'legal_person']).optional(),
    role: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().nullable().optional(),
    natural_person: NaturalPersonRaw.optional(),
    legal_person: LegalPersonRaw.optional(),
  })
  .passthrough();

export const OpenRegisterCompanySchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['active', 'inactive', 'liquidation']),
    name: NameRaw,
    register: RegisterRaw.optional(),
    address: AddressRaw.optional(),
    capital: CapitalRaw.optional(),
    representation: z.array(RepresentationItemRaw).optional(),
  })
  .passthrough();

const OwnerRaw = z
  .object({
    type: z.enum(['natural_person', 'legal_person']).optional(),
    percentage_share: z.number().nullable().optional(),
    max_percentage_share: z.number().nullable().optional(),
    natural_person: NaturalPersonRaw.optional(),
    legal_person: LegalPersonRaw.optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
  })
  .passthrough();

export const OpenRegisterOwnersSchema = z
  .object({
    owners: z.array(OwnerRaw).optional(),
  })
  .passthrough();

/**
 * Financials live on a separate endpoint. The API returns per-period reports
 * with tabular aktiva/passiva blocks. We don't try to map the whole tables
 * (hundreds of rows); we extract only what's needed for FinancialSnapshot
 * items + risk signals: year + equity (documented `equity: number | null` in
 * cents). Everything else passes through on the node's `items` list as
 * unstructured extras for later consumers.
 */
const FinancialReportRaw = z
  .object({
    year: z.number().int().optional(),
    equity: z.number().nullable().optional(),
    revenue: z.number().nullable().optional(),
    employees: z.number().nullable().optional(),
    consolidated: z.boolean().optional(),
  })
  .passthrough();

export const OpenRegisterFinancialsSchema = z
  .object({
    reports: z.array(FinancialReportRaw).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Mapper output types (same shape as NorthData mapper to keep the ingest
// service provider-agnostic).
// ---------------------------------------------------------------------------

export interface MappedCompany {
  company: CompanyIngest;
  persons: PersonIngest[];
  relations: CompanyRelationsIngest;
  financialSnapshots: FinancialSnapshotIngest[];
}

export class OpenRegisterMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRegisterMappingError';
  }
}

export interface OpenRegisterInputs {
  /** `/v1/company/{id}` response. Required. */
  base: unknown;
  /** `/v1/company/{id}/owners` response. Optional. */
  owners?: unknown;
  /** `/v1/company/{id}/financials` response. Optional. */
  financials?: unknown;
}

/** Map the three endpoint responses into a graph-ready bundle. */
export function mapOpenRegisterCompany(inputs: OpenRegisterInputs): MappedCompany {
  const base = OpenRegisterCompanySchema.parse(inputs.base);
  const owners = inputs.owners
    ? OpenRegisterOwnersSchema.parse(inputs.owners).owners ?? []
    : [];
  const financials = inputs.financials
    ? OpenRegisterFinancialsSchema.parse(inputs.financials).reports ?? []
    : [];

  const companyExternalId = base.id;

  // -- Persons + MANAGES edges from representation --------------------------
  const persons: PersonIngest[] = [];
  const manages: ManagesEdgeIngest[] = [];
  for (const rep of base.representation ?? []) {
    if (rep.type !== 'natural_person') continue;
    const lastName = rep.natural_person?.last_name?.trim();
    if (!lastName) continue;
    const firstName = rep.natural_person?.first_name?.trim() ?? undefined;
    const birthDate = rep.natural_person?.date_of_birth?.trim() ?? undefined;
    const city = rep.natural_person?.city?.trim() ?? undefined;
    const extId = personSyntheticId({
      lastName,
      ...(firstName ? { firstName } : {}),
      ...(birthDate ? { birthDate } : {}),
      ...(city ? { city } : {}),
    });
    persons.push({
      externalId: extId,
      name: rep.name ?? `${firstName ?? ''} ${lastName}`.trim(),
      lastName,
      ...(firstName ? { firstName } : {}),
      ...(birthDate ? { birthDate } : {}),
      ...(city ? { city } : {}),
      ...(rep.id ? { internalNorthDataId: rep.id } : {}),
    });
    manages.push({
      personExternalId: extId,
      companyExternalId,
      ...(rep.role ? { role: rep.role } : {}),
      ...(rep.start_date ? { since: rep.start_date } : {}),
      ...(rep.end_date ? { until: rep.end_date } : {}),
    });
  }

  // -- Shareholders from owners endpoint -----------------------------------
  const shareholders: ShareholderEdgeIngest[] = [];
  for (const o of owners) {
    const sharePercent = o.percentage_share ?? o.max_percentage_share ?? undefined;
    if (o.type === 'natural_person' && o.natural_person?.last_name) {
      const lastName = o.natural_person.last_name.trim();
      const firstName = o.natural_person.first_name?.trim() ?? undefined;
      const birthDate = o.natural_person.date_of_birth?.trim() ?? undefined;
      const city = o.natural_person.city?.trim() ?? undefined;
      const extId = personSyntheticId({
        lastName,
        ...(firstName ? { firstName } : {}),
        ...(birthDate ? { birthDate } : {}),
        ...(city ? { city } : {}),
      });
      // Ensure the Person node exists — owners may not overlap with representation.
      if (!persons.find((p) => p.externalId === extId)) {
        persons.push({
          externalId: extId,
          name: `${firstName ?? ''} ${lastName}`.trim(),
          lastName,
          ...(firstName ? { firstName } : {}),
          ...(birthDate ? { birthDate } : {}),
          ...(city ? { city } : {}),
        });
      }
      shareholders.push({
        holderExternalId: extId,
        holderType: 'Person',
        companyExternalId,
        ...(sharePercent !== undefined && sharePercent !== null
          ? { sharePercent }
          : {}),
        ...(o.start_date ? { since: o.start_date } : {}),
        ...(o.end_date ? { until: o.end_date } : {}),
      });
      continue;
    }
    if (o.type === 'legal_person' && o.legal_person?.company_id) {
      shareholders.push({
        holderExternalId: o.legal_person.company_id,
        holderType: 'Company',
        companyExternalId,
        ...(sharePercent !== undefined && sharePercent !== null
          ? { sharePercent }
          : {}),
        ...(o.start_date ? { since: o.start_date } : {}),
        ...(o.end_date ? { until: o.end_date } : {}),
      });
    }
  }

  // -- Financial snapshots --------------------------------------------------
  const financialSnapshots: FinancialSnapshotIngest[] = [];
  let latestNegativeEquityYear: number | undefined;
  // Sort reports by year desc so the head is always the latest.
  const sortedReports = [...financials].sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0),
  );
  for (const r of sortedReports) {
    if (!r.year) continue;
    const items: FinancialIndicator[] = [];
    if (r.equity !== null && r.equity !== undefined) {
      // OpenRegister ships equity in cents — normalise to full EUR for graph.
      items.push({ id: 'equity', name: 'Eigenkapital', value: r.equity / 100, unit: 'EUR' });
      if (r.equity < 0 && latestNegativeEquityYear === undefined) {
        latestNegativeEquityYear = r.year;
      }
    }
    if (r.revenue !== null && r.revenue !== undefined) {
      items.push({ id: 'revenue', name: 'Umsatz', value: r.revenue / 100, unit: 'EUR' });
    }
    if (r.employees !== null && r.employees !== undefined) {
      items.push({ id: 'employees', name: 'Mitarbeiter', value: r.employees });
    }
    financialSnapshots.push({
      companyExternalId,
      fiscalYear: r.year,
      items,
      ...(r.consolidated !== undefined ? { consolidated: r.consolidated } : {}),
    });
  }

  // -- Derived risk ---------------------------------------------------------
  const status = normaliseStatus(base.status);
  const riskSignals: string[] = [];
  if (status === 'terminated') riskSignals.push('register_inactive');
  if (status === 'liquidation') riskSignals.push('register_liquidation');
  if (latestNegativeEquityYear !== undefined) {
    riskSignals.push(`negative_equity_${String(latestNegativeEquityYear)}`);
  }
  const riskLevel: RiskLevel | undefined = deriveRiskLevel(status, riskSignals);

  // -- Company ingest -------------------------------------------------------
  const company: CompanyIngest = {
    externalId: companyExternalId,
    name: base.name.name,
    ...(base.name.legal_form ? { legalForm: base.name.legal_form } : {}),
    ...(base.register?.register_court
      ? { registerCourt: base.register.register_court }
      : {}),
    ...(base.register?.register_number
      ? { registerNumber: base.register.register_number }
      : {}),
    ...(status ? { status } : {}),
    ...(status === 'terminated' ? { terminated: true } : {}),
    ...(base.address?.formatted_value
      ? { address: base.address.formatted_value }
      : {}),
    ...(riskLevel ? { riskLevel } : {}),
    ...(riskSignals.length > 0 ? { riskSignals } : {}),
  };

  return {
    company,
    persons,
    relations: {
      ...(manages.length > 0 ? { manages } : {}),
      ...(shareholders.length > 0 ? { shareholders } : {}),
    },
    financialSnapshots,
  };
}

/**
 * Map OpenRegister's status enum onto our graph's `CompanyStatus`. OpenRegister
 * uses `inactive` where NorthData / the graph schema use `terminated`.
 */
function normaliseStatus(
  raw: 'active' | 'inactive' | 'liquidation',
): CompanyStatus {
  if (raw === 'inactive') return 'terminated';
  return raw;
}

function deriveRiskLevel(
  status: CompanyStatus | undefined,
  signals: string[],
): RiskLevel | undefined {
  if (status === 'terminated') return 'critical';
  if (status === 'liquidation') return 'high';
  if (signals.some((s) => s.startsWith('negative_equity_'))) return 'high';
  if (status === 'active') return 'low';
  return undefined;
}
