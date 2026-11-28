/**
 * Boundary types duplicated from kernel surfaces this plugin depends on at
 * compile time. Kept deliberately narrow — structural typing lets the real
 * kernel implementations (EntityRefBus, KnowledgeGraph, LocalSubAgentTool)
 * satisfy these interfaces without the plugin importing from kernel paths.
 *
 * Only kernel shapes belong here. The company-enrichment payloads are
 * plugin-local and live in `registryTypes.ts`.
 */

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

/**
 * Entity systems this plugin writes. Each one must be listed in the
 * manifest's `permissions.graph.entity_systems` (ADR 0167): `odoo` for the
 * entity sync, `openregister` / `northdata` for `enrich_company`.
 */
export type EntitySystem = 'odoo' | 'openregister' | 'northdata';

export interface EntityIngest {
  system: EntitySystem;
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

/**
 * Narrow projection of the kernel `knowledgeGraph@1` surface this plugin
 * uses: entity writes only (OdooEntitySync, company enrichment). The bounded
 * service a plugin gets (ADR 0044) holds them to the systems declared in
 * `permissions.graph.entity_systems` (ADR 0167). Structurally satisfied by
 * the plugin-api `KnowledgeGraph`.
 */
export interface KnowledgeGraph {
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;
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

/**
 * Privacy-Shield v3 (stable-id tokenization) — tool-side PII field
 * annotation. Mirror of `@omadia/plugin-api`'s `ToolPIIField`; kept in
 * this kernel-types file so `integration-odoo` stays free of a direct
 * dependency on the harness package, like every other type here.
 *
 * When a tool wrapper carries `piiFields`, the harness runs a
 * stable-id tokenization pass over the tool's raw JSON result BEFORE
 * the NER detectors, masking the annotated leaves as whole-value
 * tokens. `path` / `idPath` are step expressions: `key`, `[]` array
 * spread (may lead the path for a top-level array), and `[N]` array
 * index (Odoo many2one tuples are `[id, label]`, so `field[1]` is the
 * label and `field[0]` the id).
 */
export interface ToolPIIField {
  readonly path: string;
  readonly idPath: string;
  readonly type?:
    | 'PERSON'
    | 'EMAIL'
    | 'PHONE'
    | 'IBAN'
    | 'CARD'
    | 'ADDRESS'
    | 'ORG'
    | 'APIKEY';
}

export interface LocalSubAgentTool {
  spec: LocalSubAgentToolSpec;
  handle(input: unknown): Promise<string>;
  /**
   * Optional PII field annotations consumed by the harness's
   * privacy-guard stable-id pre-pass. Absent ⇒ the tool result goes
   * straight to the NER detectors as before.
   */
  piiFields?: readonly ToolPIIField[];
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
