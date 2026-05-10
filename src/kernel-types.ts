/**
 * Boundary types duplicated from kernel surfaces this plugin depends on at
 * compile time. Kept deliberately narrow — structural typing lets the real
 * kernel implementations (EntityRefBus, KnowledgeGraph, LocalSubAgentTool)
 * satisfy these interfaces without the plugin importing from kernel paths.
 *
 * When S+8 extracts `@omadia/knowledge-graph`, the KG-related types
 * here should be replaced by imports from that package (and this plugin's
 * manifest should declare `requires: ["knowledgeGraph@^1"]`). Until then,
 * this file is the single source of cross-boundary shapes for Odoo-plugin.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// EntityRef + EntityRefBus
// ---------------------------------------------------------------------------

/** Mirrors kernel `src/types/entityRef.ts`. */
export interface EntityRef {
  system: 'odoo' | 'confluence';
  model: string;
  id: string | number;
  displayName?: string;
  op: 'read';
}

/** Narrow surface of the kernel EntityRefBus — plugin only publishes. */
export interface EntityRefBus {
  publish(ref: EntityRef): void;
}

// ---------------------------------------------------------------------------
// Knowledge-graph ingest payloads
// ---------------------------------------------------------------------------

export type CompanyStatus = 'active' | 'liquidation' | 'terminated';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface EntityIngest {
  system: 'odoo' | 'confluence';
  model: string;
  id: string | number;
  displayName?: string;
  extras?: Record<string, unknown>;
}

export interface EntityIngestResult {
  entityIds: string[];
  inserted: number;
  updated: number;
}

export interface CompanyIngest {
  externalId: string;
  name: string;
  rawName?: string;
  legalForm?: string;
  registerCourt?: string;
  registerNumber?: string;
  registerCountry?: string;
  status?: CompanyStatus;
  terminated?: boolean;
  address?: string;
  vatId?: string;
  proxyPolicy?: string;
  northDataUrl?: string;
  segmentCodes?: Record<string, string[]>;
  riskLevel?: RiskLevel;
  riskSignals?: string[];
  isWatched?: boolean;
  extras?: Record<string, unknown>;
}

export interface CompanyIngestResult {
  companyIds: string[];
  inserted: number;
  updated: number;
}

export interface PersonIngest {
  externalId: string;
  name: string;
  firstName?: string;
  lastName: string;
  birthDate?: string;
  city?: string;
  internalNorthDataId?: string;
  extras?: Record<string, unknown>;
}

export interface PersonIngestResult {
  personIds: string[];
  inserted: number;
  updated: number;
}

export interface ManagesEdgeIngest {
  personExternalId: string;
  companyExternalId: string;
  role?: string;
  since?: string;
  until?: string;
}

export interface ShareholderEdgeIngest {
  holderExternalId: string;
  holderType: 'Person' | 'Company';
  companyExternalId: string;
  sharePercent?: number;
  since?: string;
  until?: string;
}

export interface SucceededByEdgeIngest {
  fromCompanyExternalId: string;
  toCompanyExternalId: string;
  reason?: string;
}

export interface CompanyRelationsIngest {
  manages?: ManagesEdgeIngest[];
  shareholders?: ShareholderEdgeIngest[];
  successions?: SucceededByEdgeIngest[];
}

export interface FinancialIndicator {
  id: string;
  name?: string;
  value?: number;
  unit?: string;
  estimate?: boolean;
  note?: string;
}

export interface FinancialSnapshotIngest {
  companyExternalId: string;
  fiscalYear: number;
  date?: string;
  consolidated?: boolean;
  sourceName?: string;
  items: FinancialIndicator[];
}

export interface FinancialSnapshotIngestResult {
  snapshotIds: string[];
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Narrow projection of the kernel KnowledgeGraph surface used by this plugin
 * (OdooEntitySync + NorthData/OpenRegister ingest). Structurally satisfied
 * by the full kernel interface.
 */
export interface KnowledgeGraph {
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;
  ingestCompanies(companies: CompanyIngest[]): Promise<CompanyIngestResult>;
  ingestPersons(persons: PersonIngest[]): Promise<PersonIngestResult>;
  ingestCompanyRelations(rels: CompanyRelationsIngest): Promise<unknown>;
  ingestFinancialSnapshots(
    snapshots: FinancialSnapshotIngest[],
  ): Promise<FinancialSnapshotIngestResult>;
}

/**
 * Deterministic `externalId` for Person nodes. NorthData's own Person.id is
 * documented as volatile, so we derive a stable hash over last/first name +
 * birth date + city. Must match kernel's implementation byte-for-byte so both
 * sides ingest into the same node.
 */
export function personSyntheticId(parts: {
  lastName: string;
  firstName?: string;
  birthDate?: string;
  city?: string;
}): string {
  const norm = (s?: string): string => (s ?? '').trim().toLowerCase();
  const joined = [
    norm(parts.lastName),
    norm(parts.firstName),
    norm(parts.birthDate),
    norm(parts.city),
  ].join('|');
  return createHash('sha1').update(joined).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// LocalSubAgentTool — return shape of odooToolkit factory
// ---------------------------------------------------------------------------

export interface LocalSubAgentToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface LocalSubAgentTool {
  spec: LocalSubAgentToolSpec;
  handle(input: unknown): Promise<string>;
}

// ---------------------------------------------------------------------------
// Narrow config shapes for fromConfig-style factories
// ---------------------------------------------------------------------------

export interface OdooClientConfig {
  readonly ODOO_URL?: string;
  readonly ODOO_DB?: string;
  readonly ODOO_LOGIN?: string;
  readonly ODOO_API_KEY?: string;
  readonly ODOO_PROXY_MAX_BYTES: number;
  readonly ODOO_INSECURE_TLS?: boolean;
}

export interface NorthDataClientConfig {
  readonly NORTHDATA_API_KEY?: string;
  readonly NORTHDATA_BASE_URL: string;
  readonly NORTHDATA_RATE_LIMIT_RPS: number;
  readonly NORTHDATA_MAX_BYTES: number;
}

export interface OpenRegisterClientConfig {
  readonly OPENREGISTER_API_KEY?: string;
  readonly OPENREGISTER_BASE_URL: string;
  readonly OPENREGISTER_RATE_LIMIT_RPS: number;
  readonly OPENREGISTER_MAX_BYTES: number;
}
