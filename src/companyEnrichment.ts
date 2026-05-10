import type { CompanyIngest } from './kernel-types.js';

/**
 * Provider-agnostic abstraction for company-enrichment data sources.
 *
 * Concrete providers (NorthData, OpenRegister, …) each wrap their own REST
 * API + deterministic mapper and expose this narrow interface. The
 * `enrich_company` tool and the orchestrator wiring in `index.ts` talk to
 * this interface — not to any particular vendor — so swapping providers is
 * one pointer change, not a rewrite.
 *
 * Rules each provider MUST honour:
 *   - Read-only against the external source.
 *   - On ambiguity (fuzzy match with >1 plausible hit) return a
 *     `disambiguation` outcome; never auto-pick the first result. The tool's
 *     contract with the user (policy D7) depends on this.
 *   - Idempotent graph ingestion. A second call for the same company should
 *     produce zero new Company nodes, only updated ones.
 */
export interface CompanyEnrichmentProvider {
  /**
   * Fuzzy entry point. Callers pass the raw user-provided company name plus
   * an optional city/address hint. Returns a success / disambiguation /
   * not_found / error outcome.
   */
  enrichByName(
    name: string,
    opts?: { address?: string },
  ): Promise<EnrichOutcome>;
  /**
   * Stable-id entry point. `externalId` is whatever the provider calls its
   * canonical company identifier — for NorthData this is `register.uniqueKey`
   * (numeric string), for OpenRegister it's the permalink-style id
   * (`DE-HRB-F1103-267645`). The graph stores both under the same
   * `company:<externalId>` naming scheme.
   */
  enrichByExternalId(externalId: string): Promise<EnrichOutcome>;
}

/**
 * Shape of a single candidate we surface to the user when the provider
 * can't pick a single company with high confidence. Kept deliberately small
 * — the user only needs enough to re-identify the entity they meant.
 */
export interface EnrichCandidate {
  name: string;
  /** Provider-specific stable id. Hand this back to `enrichByExternalId`. */
  registerKey?: string;
  city?: string;
  url?: string;
}

/** Outcome of a single enrichment attempt. */
export type EnrichOutcome =
  | {
      status: 'success';
      company: CompanyIngest;
      personCount: number;
      financialYears: number[];
      linkedOdooEntity?: string;
      /** `true` when the data came from a cache hit (no external call). */
      fromCache: boolean;
    }
  | {
      status: 'disambiguation';
      query: string;
      candidates: EnrichCandidate[];
    }
  | {
      status: 'not_found';
      query: string;
    }
  | {
      status: 'error';
      query: string;
      message: string;
    };
