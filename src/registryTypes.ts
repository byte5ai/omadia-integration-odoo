/**
 * Plugin-local shapes for the company-enrichment providers (OpenRegister /
 * NorthData). The mappers produce them; `registryGraph.ts` turns them into
 * kernel `EntityIngest` rows for the provider's own entity system
 * (ADR 0167). They are not kernel types: the kernel graph has no company,
 * person, relation or financial-snapshot write methods (removed with the
 * KG-ACL refactor, byte5ai/omadia#120).
 */

import { createHash } from 'node:crypto';

export type CompanyStatus = 'active' | 'liquidation' | 'terminated';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

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


/**
 * Deterministic `externalId` for Person nodes. NorthData's own Person.id is
 * documented as volatile, so we derive a stable hash over last/first name +
 * birth date + city, so a person keeps one node across enrichment runs.
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

