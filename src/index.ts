/**
 * @omadia/integration-odoo — public surface.
 *
 * This barrel re-exports the concrete classes + types the middleware kernel
 * currently constructs directly. The plugin's `plugin.ts` entry point (wired
 * in phase-2.2-ii) will eventually own all construction and publish services
 * via ServiceRegistry; until then the kernel in `src/index.ts` imports the
 * classes from here to preserve behaviour during the move.
 */

export { OdooClient, OdooClientError } from './odooClient.js';
export type { OdooExecuteRequest } from './odooClient.js';

export {
  activate,
  ODOO_CLIENT_SERVICE_NAME,
  ODOO_CACHE_SERVICE_NAME,
  ODOO_ENRICH_SERVICE_NAME,
} from './plugin.js';
export type { OdooPluginHandle } from './plugin.js';

export { OdooResponseCache, isCacheable } from './odooResponseCache.js';

export { OdooEntitySync } from './odooEntitySync.js';

export { extractOdooEntityRefs } from './odooEntityExtractor.js';

export {
  executeOdoo,
  scopeForModel,
  ALLOWED_METHODS,
  ALLOWED_MODELS,
} from './odooCore.js';
export type { OdooScope } from './odooCore.js';

export { createOdooExecuteTool } from './odooToolkit.js';

export {
  buildOdooAgentToolkit,
  ODOO_AGENT_TOOLKIT_SERVICE_NAMES,
} from './agentToolkit.js';
export type { OdooAgentToolkit } from './agentToolkit.js';

export {
  odooQueryToolSpec,
  odooDescribeToolSpec,
  odooVersionToolSpec,
  createOdooQueryHandler,
  createOdooDescribeHandler,
  createOdooVersionHandler,
} from './odooReadTools.js';
export type { OdooReadToolDeps } from './odooReadTools.js';
export type { OdooServerVersion } from './odooClient.js';

export { NorthDataClient, NorthDataClientError } from './northDataClient.js';
export { NorthDataResponseCache } from './northDataResponseCache.js';
export { NorthDataIngest } from './northDataIngest.js';

export {
  OpenRegisterClient,
  OpenRegisterClientError,
} from './openRegisterClient.js';
export { OpenRegisterIngest } from './openRegisterIngest.js';

export type {
  CompanyEnrichmentProvider,
  EnrichCandidate,
  EnrichOutcome,
} from './companyEnrichment.js';

export {
  EnrichCompanyTool,
  ENRICH_COMPANY_TOOL_NAME,
  NORTHDATA_ENRICH_TOOL_NAME,
  enrichCompanyToolSpec,
  northDataEnrichToolSpec,
} from './northDataEnrichTool.js';
