/**
 * Odoo agent-toolkit factory.
 *
 * Phase 6: de-duplicates the near-identical `activate()` bodies that the
 * `@omadia/agent-odoo-hr` and `@omadia/agent-odoo-accounting` plugins used to
 * carry. Both packages independently fetched the scoped `odoo.executeTool.*`
 * service, fetched `knowledgeGraph`, built a `createGraphLookupTool(scope)`
 * wrapper, and returned `{ tools: [graphLookup, executeTool] }` — ~95%
 * identical code.
 *
 * Plugins are distributed as isolated ZIP uploads, so the agents cannot
 * statically `import` this code from the integration. Instead the integration
 * assembles the toolkit once per scope and publishes it as a service
 * (`odoo.agentToolkit.{scope}`); the agents become thin consumers:
 *
 *   const toolkit = ctx.services.get<OdooAgentToolkit>('odoo.agentToolkit.hr');
 *
 * The graphLookup tool comes from `@omadia/verifier` — a harness-provided peer
 * that the agents already depended on. Moving the construction here is what
 * lets the agent packages drop the dependency on it entirely.
 */

import { createGraphLookupTool } from '@omadia/verifier';

import type { LocalSubAgentTool } from './kernel-types.js';
import type { OdooScope } from './odooCore.js';

/** Value shape published under `odoo.agentToolkit.{scope}`. */
export interface OdooAgentToolkit {
  readonly tools: LocalSubAgentTool[];
}

/** Service names the Odoo sub-agent plugins consume to obtain their toolkit. */
export const ODOO_AGENT_TOOLKIT_SERVICE_NAMES: Record<OdooScope, string> = {
  accounting: 'odoo.agentToolkit.accounting',
  hr: 'odoo.agentToolkit.hr',
};

/**
 * Build the in-process toolkit a scoped Odoo sub-agent runs with:
 *   - `query_graph` — the verifier's knowledge-graph lookup tool, scope-tagged
 *   - `odoo_execute` — the scope-locked read-only Odoo tool (passed in)
 *
 * `graph` is the kernel's KnowledgeGraph instance. It is typed loosely because
 * `createGraphLookupTool` only forwards the instance and never reaches into
 * class-internal members — the same cast the agent packages used before.
 */
export function buildOdooAgentToolkit(
  scope: OdooScope,
  deps: { executeTool: LocalSubAgentTool; graph: unknown },
): OdooAgentToolkit {
  const graphLookup = createGraphLookupTool(scope, {
    graph: deps.graph as Parameters<typeof createGraphLookupTool>[1]['graph'],
  });
  return {
    tools: [graphLookup as unknown as LocalSubAgentTool, deps.executeTool],
  };
}
