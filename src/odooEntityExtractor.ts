import type { EntityRef } from './kernel-types.js';

/**
 * Pure extractor: given an Odoo execute_kw (model, method) and its response,
 * yields an EntityRef per record whose id appears in the payload. Called from
 * the Odoo proxy after red-line stripping, so whatever reaches here is what
 * the agent actually received.
 *
 * Coverage:
 * - `search_read`, `read`  → array of records with `id`
 * - `search`               → array of ids
 * - `search_count`, `read_group`, `fields_get` → no record ids → []
 */
export function extractOdooEntityRefs(model: string, method: string, result: unknown): EntityRef[] {
  if (method === 'search_read' || method === 'read') {
    return extractFromRecordArray(model, result);
  }
  if (method === 'search') {
    return extractFromIdArray(model, result);
  }
  return [];
}

function extractFromRecordArray(model: string, result: unknown): EntityRef[] {
  if (!Array.isArray(result)) return [];
  const refs: EntityRef[] = [];
  for (const record of result) {
    if (typeof record !== 'object' || record === null) continue;
    const rec = record as Record<string, unknown>;
    const idRaw = rec['id'];
    if (typeof idRaw !== 'number' && typeof idRaw !== 'string') continue;
    const nameRaw = rec['name'] ?? rec['display_name'];
    const displayName = typeof nameRaw === 'string' ? nameRaw : undefined;
    refs.push({ system: 'odoo', model, id: idRaw, displayName, op: 'read' });
  }
  return refs;
}

function extractFromIdArray(model: string, result: unknown): EntityRef[] {
  if (!Array.isArray(result)) return [];
  const refs: EntityRef[] = [];
  for (const id of result) {
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    refs.push({ system: 'odoo', model, id, op: 'read' });
  }
  return refs;
}
