import type { PluginContext } from '@omadia/plugin-api';

import { NorthDataClient } from './northDataClient.js';
import { NorthDataIngest } from './northDataIngest.js';
import { NorthDataResponseCache } from './northDataResponseCache.js';
import { OdooClient } from './odooClient.js';
import { OdooEntitySync } from './odooEntitySync.js';
import { OdooResponseCache } from './odooResponseCache.js';
import { OpenRegisterClient } from './openRegisterClient.js';
import { OpenRegisterIngest } from './openRegisterIngest.js';
import type { CompanyEnrichmentProvider } from './companyEnrichment.js';
import type { KnowledgeGraph } from './kernel-types.js';
import {
  EnrichCompanyTool,
  enrichCompanyToolSpec,
} from './northDataEnrichTool.js';

/**
 * @omadia/integration-odoo — plugin entry point.
 *
 * `kind: integration`. Exposes two things to the kernel on activate():
 *   - `odoo.client`    OdooClient (JSON-RPC wrapper, UID-cached, maxBytes-capped)
 *   - `odoo.cache`     OdooResponseCache (5-min TTL, per-process)
 *
 * Required config (via `ctx.config`):
 *   - `odoo_url`     base URL of the Odoo instance
 *   - `odoo_db`      database name
 *   - `odoo_login`   technical-user e-mail for JSON-RPC auth
 * Optional config:
 *   - `odoo_proxy_max_bytes` default 500000 — caps response payload size
 *   - `odoo_insecure_tls`    default 'false' — dev-only TLS bypass
 *
 * Required secret (via `ctx.secrets`):
 *   - `odoo_api_key`  rotated via Odoo → Profil → Accountsicherheit
 *
 * Consumers (Odoo-Accounting + Odoo-HR sub-agents, OdooEntitySync in the
 * kernel) reach the services via
 *   ctx.services.get<OdooClient>('odoo.client')
 *   ctx.services.get<OdooResponseCache>('odoo.cache')
 * (or, at kernel level, serviceRegistry.get<...>).
 *
 * The `odoo.enrich` (CompanyEnrichmentProvider bundling OpenRegister /
 * NorthData) + the `enrich_company` native tool stay kernel-owned in this
 * commit and migrate into this plugin in phase-2.2-iii. `OdooEntitySync`
 * stays kernel-constructed in this commit and migrates onto
 * `ctx.jobs.register` in phase-2.2-iv.
 */

export const ODOO_CLIENT_SERVICE_NAME = 'odoo.client';
export const ODOO_CACHE_SERVICE_NAME = 'odoo.cache';
export const ODOO_ENRICH_SERVICE_NAME = 'odoo.enrich';

const KNOWLEDGE_GRAPH_SERVICE_NAME = 'knowledgeGraph';

/**
 * System-prompt text the orchestrator weaves into Claude's tool-list briefing
 * whenever `enrich_company` is active. Picked up via the NativeToolRegistry's
 * promptDoc channel (same seam `render_diagram` uses) — the orchestrator no
 * longer carries a hardcoded branch for this tool.
 */
const ENRICH_COMPANY_PROMPT_DOC =
  '\n- `enrich_company`: Handelsregister-Stammdaten, Geschäftsführer, Gesellschafter + Bonitäts-Einschätzung (Status, EK-Signale) zu einer konkreten deutschen Firma. Quelle variiert je nach Konfiguration (OpenRegister / NorthData). READ-ONLY; schreibt nur in den Knowledge-Graph, niemals nach Odoo. Bei Mehrdeutigkeit (mehrere Treffer) NICHT selbst eine auswählen — dem User die Kandidatenliste vorlegen und nach Präzisierung (Name+Stadt oder stabile ID) fragen.\n';

export interface OdooPluginHandle {
  close(): Promise<void>;
}

function parseBoolean(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePositiveFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFetchLevel(
  raw: string | undefined,
): 'minimal' | 'standard' | 'full' {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'minimal' || v === 'full') return v;
  return 'standard';
}

export async function activate(ctx: PluginContext): Promise<OdooPluginHandle> {
  ctx.log('activating odoo integration');

  const apiKey = await ctx.secrets.require('odoo_api_key');
  const url = ctx.config.require<string>('odoo_url');
  const db = ctx.config.require<string>('odoo_db');
  const login = ctx.config.require<string>('odoo_login');
  const maxBytes = parsePositiveInt(
    ctx.config.get<string>('odoo_proxy_max_bytes'),
    500_000,
  );
  const insecureTls = parseBoolean(ctx.config.get<string>('odoo_insecure_tls'));

  const client = new OdooClient({
    url,
    db,
    login,
    apiKey,
    maxBytes,
    insecureTls,
  });
  const cache = new OdooResponseCache();

  const disposeClient = ctx.services.provide<OdooClient>(
    ODOO_CLIENT_SERVICE_NAME,
    client,
  );
  const disposeCache = ctx.services.provide<OdooResponseCache>(
    ODOO_CACHE_SERVICE_NAME,
    cache,
  );

  ctx.log(
    `[odoo] ready (url=${url}, db=${db}, login=${login}, maxBytes=${String(maxBytes)}, insecureTls=${String(insecureTls)}) — services '${ODOO_CLIENT_SERVICE_NAME}' + '${ODOO_CACHE_SERVICE_NAME}' published`,
  );

  // --- enrich_company provider + tool ---------------------------------------
  // OpenRegister wins when both providers are enabled; NorthData stays as
  // Plan-B. When neither is enabled, the tool simply stays unregistered —
  // the orchestrator's native-tool registry drops it from both dispatch and
  // prompt-list automatically. Reaching the kernel-owned KnowledgeGraph via
  // `ctx.services.get('knowledgeGraph')` is a pre-S+8 bridge (kernel pushes
  // itself into ServiceRegistry at boot); once the KG extraction lands, this
  // plugin's manifest gains `requires: ["knowledgeGraph@^1"]`.
  const openRegisterEnabled = parseBoolean(
    ctx.config.get<string>('openregister_enabled'),
  );
  const openRegisterApiKey = openRegisterEnabled
    ? await ctx.secrets.get('openregister_api_key')
    : undefined;
  const northDataEnabled = parseBoolean(
    ctx.config.get<string>('northdata_enabled'),
  );
  const northDataApiKey = northDataEnabled
    ? await ctx.secrets.get('northdata_api_key')
    : undefined;

  let enrichProvider: CompanyEnrichmentProvider | undefined;
  let enrichLabel = '';
  let disposeEnrichService: (() => void) | undefined;
  let disposeEnrichTool: (() => void) | undefined;

  if (openRegisterEnabled && openRegisterApiKey) {
    const orBaseUrl =
      ctx.config.get<string>('openregister_base_url') ??
      'https://api.openregister.de';
    const orRps = parsePositiveFloat(
      ctx.config.get<string>('openregister_rate_limit_rps'),
      2,
    );
    const orMaxBytes = parsePositiveInt(
      ctx.config.get<string>('openregister_max_bytes'),
      500_000,
    );
    const orCacheTtlDays = parsePositiveInt(
      ctx.config.get<string>('openregister_cache_ttl_days'),
      30,
    );
    const orFetchLevel = parseFetchLevel(
      ctx.config.get<string>('openregister_fetch_level'),
    );
    const orClient = new OpenRegisterClient({
      apiKey: openRegisterApiKey,
      baseUrl: orBaseUrl,
      maxBytes: orMaxBytes,
      minIntervalMs: orRps > 0 ? Math.ceil(1000 / orRps) : 0,
    });
    const orCache = new NorthDataResponseCache({
      ttlMs: orCacheTtlDays * 24 * 60 * 60 * 1000,
    });
    const graph = ctx.services.get<KnowledgeGraph>(KNOWLEDGE_GRAPH_SERVICE_NAME);
    if (!graph) {
      throw new Error(
        `[odoo] enrich_company requires '${KNOWLEDGE_GRAPH_SERVICE_NAME}' service (kernel must publish before plugin activation)`,
      );
    }
    enrichProvider = new OpenRegisterIngest({
      client: orClient,
      graph,
      cache: orCache,
      fetchLevel: orFetchLevel,
      log: (msg) => {
        console.error(msg);
      },
    });
    enrichLabel = `openregister(fetch=${orFetchLevel}, rate=${String(orRps)}rps, ttl=${String(orCacheTtlDays)}d)`;
  } else if (northDataEnabled && northDataApiKey) {
    const ndBaseUrl =
      ctx.config.get<string>('northdata_base_url') ??
      'https://www.northdata.com/_api';
    const ndRps = parsePositiveFloat(
      ctx.config.get<string>('northdata_rate_limit_rps'),
      2,
    );
    const ndMaxBytes = parsePositiveInt(
      ctx.config.get<string>('northdata_max_bytes'),
      500_000,
    );
    const ndCacheTtlDays = parsePositiveInt(
      ctx.config.get<string>('northdata_cache_ttl_days'),
      30,
    );
    const ndClient = new NorthDataClient({
      apiKey: northDataApiKey,
      baseUrl: ndBaseUrl,
      maxBytes: ndMaxBytes,
      minIntervalMs: ndRps > 0 ? Math.ceil(1000 / ndRps) : 0,
    });
    const ndCache = new NorthDataResponseCache({
      ttlMs: ndCacheTtlDays * 24 * 60 * 60 * 1000,
    });
    const graph = ctx.services.get<KnowledgeGraph>(KNOWLEDGE_GRAPH_SERVICE_NAME);
    if (!graph) {
      throw new Error(
        `[odoo] enrich_company requires '${KNOWLEDGE_GRAPH_SERVICE_NAME}' service (kernel must publish before plugin activation)`,
      );
    }
    enrichProvider = new NorthDataIngest({
      client: ndClient,
      graph,
      cache: ndCache,
      log: (msg) => {
        console.error(msg);
      },
    });
    enrichLabel = `northdata(rate=${String(ndRps)}rps, ttl=${String(ndCacheTtlDays)}d)`;
  }

  if (enrichProvider) {
    disposeEnrichService = ctx.services.provide<CompanyEnrichmentProvider>(
      ODOO_ENRICH_SERVICE_NAME,
      enrichProvider,
    );
    const tool = new EnrichCompanyTool(enrichProvider);
    disposeEnrichTool = ctx.tools.register(
      enrichCompanyToolSpec,
      (input) => tool.handle(input),
      { promptDoc: ENRICH_COMPANY_PROMPT_DOC },
    );
    ctx.log(
      `[odoo] enrich_company tool ready (${enrichLabel}) — service '${ODOO_ENRICH_SERVICE_NAME}' published, tool contributed`,
    );
  } else {
    ctx.log(
      '[odoo] enrich_company DISABLED (set openregister_enabled+openregister_api_key or northdata_enabled+northdata_api_key)',
    );
  }

  // --- Background entity-sync job ------------------------------------------
  // First consumer of the S+3.5 JobScheduler platform. Replaces the kernel's
  // prior setTimeout+setInterval pair: the scheduler owns the interval tick
  // + singleton-lock (overlap: 'skip'); the plugin's close() bulk-stops the
  // job via scheduler.stopForPlugin() — dispose here is the explicit handle.
  // Initial sync stays a fire-and-forget setTimeout so activate() returns
  // quickly; subsequent runs go through the scheduler.
  let disposeEntitySync: (() => void) | undefined;
  let initialSyncTimer: NodeJS.Timeout | undefined;
  const entitySyncEnabled = parseBoolean(
    ctx.config.get<string>('odoo_entity_sync_enabled'),
  );
  if (entitySyncEnabled) {
    const graphForSync = ctx.services.get<KnowledgeGraph>(
      KNOWLEDGE_GRAPH_SERVICE_NAME,
    );
    if (!graphForSync) {
      throw new Error(
        `[odoo] odoo_entity_sync_enabled=true requires '${KNOWLEDGE_GRAPH_SERVICE_NAME}' service (kernel must publish before plugin activation)`,
      );
    }
    const intervalHours = parsePositiveInt(
      ctx.config.get<string>('odoo_entity_sync_interval_hours'),
      6,
    );
    const pageSize = parsePositiveInt(
      ctx.config.get<string>('odoo_entity_sync_page_size'),
      100,
    );
    const maxPerModel = parsePositiveInt(
      ctx.config.get<string>('odoo_entity_sync_max_per_model'),
      5000,
    );
    const sync = new OdooEntitySync({
      odoo: client,
      graph: graphForSync,
      pageSize,
      maxPerModel,
      log: (msg) => {
        console.error(msg);
      },
    });
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Jittered initial run — fires up to 30s after activate() returns so a
    // restart-storm across machines doesn't all hit Odoo at once.
    const jitterMs = Math.floor(Math.random() * 30_000);
    initialSyncTimer = setTimeout(() => {
      void sync.syncAll().catch((err: unknown) => {
        console.error(
          '[odoo-sync] initial sync failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }, jitterMs);
    initialSyncTimer.unref?.();

    disposeEntitySync = ctx.jobs.register(
      {
        name: 'entity-sync',
        schedule: { intervalMs },
        timeoutMs: 10 * 60 * 1000,
        overlap: 'skip',
      },
      async (_signal) => {
        await sync.syncAll();
      },
    );
    ctx.log(
      `[odoo] entity-sync job registered (every ${String(intervalHours)}h, page=${String(pageSize)}, cap=${String(maxPerModel)})`,
    );
  }

  return {
    async close(): Promise<void> {
      ctx.log('deactivating odoo integration');
      if (initialSyncTimer !== undefined) clearTimeout(initialSyncTimer);
      disposeEntitySync?.();
      disposeEnrichTool?.();
      disposeEnrichService?.();
      disposeClient();
      disposeCache();
    },
  };
}
