import type { KnowledgeGraph, EntityIngest } from './kernel-types.js';
import type { OdooClient } from './odooClient.js';

/**
 * Periodically pulls core business entities (res.partner, hr.employee,
 * hr.department, account.journal, account.account, res.currency) from Odoo
 * into the knowledge graph so
 * `findEntityCapturedTurns` can resolve names like "Lilium GmbH" even when
 * no past chat turn has captured them yet.
 *
 * Read-only on the Odoo side. Batched `search_read` with conservative page
 * sizes keeps the JSON-RPC payloads under the configured proxy-max-bytes.
 * Failures in one model don't block the others — each sync step is isolated
 * so a flaky Odoo response for one model doesn't starve the rest.
 *
 * HR fields are picked to deliberately avoid red-lines: no wage, no private
 * contact. department_id + job_title + work_email are safe public metadata.
 */

export interface OdooEntitySyncOptions {
  odoo: OdooClient;
  graph: KnowledgeGraph;
  /** Page size per search_read. Keep below ~200 for payload sanity. */
  pageSize?: number;
  /** Hard ceiling per model per run; prevents a runaway sync when Odoo has
   *  e.g. 10 000 partners. Defaults to 5 000. */
  maxPerModel?: number;
  log?: (msg: string) => void;
}

/** One sync pass across all configured models. Returns per-model counts. */
export interface SyncResult {
  partners: ModelResult;
  employees: ModelResult;
  departments: ModelResult;
  journals: ModelResult;
  accounts: ModelResult;
  currencies: ModelResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ModelResult {
  read: number;
  ingested: number;
  inserted: number;
  updated: number;
  skipped: number;
  error?: string;
}

export class OdooEntitySync {
  private readonly pageSize: number;
  private readonly maxPerModel: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: OdooEntitySyncOptions) {
    this.pageSize = opts.pageSize ?? 100;
    this.maxPerModel = opts.maxPerModel ?? 5000;
    this.log = opts.log ?? ((msg: string): void => { console.log(msg); });
  }

  /** Full pass. Each model step is isolated so one failure doesn't cascade. */
  async syncAll(): Promise<SyncResult> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    this.log(`[odoo-sync] starting full pass (startedAt=${startedAt})`);
    const [partners, employees, departments, journals, accounts, currencies] = await Promise.all([
      this.safe('partners', () => this.syncPartners()),
      this.safe('employees', () => this.syncEmployees()),
      this.safe('departments', () => this.syncDepartments()),
      this.safe('journals', () => this.syncJournals()),
      this.safe('accounts', () => this.syncAccounts()),
      this.safe('currencies', () => this.syncCurrencies()),
    ]);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - started;
    this.log(
      `[odoo-sync] done partners=${formatModel(partners)} employees=${formatModel(employees)} departments=${formatModel(departments)} journals=${formatModel(journals)} accounts=${formatModel(accounts)} currencies=${formatModel(currencies)} took=${String(durationMs)}ms`,
    );
    return { partners, employees, departments, journals, accounts, currencies, startedAt, finishedAt, durationMs };
  }

  /**
   * Customers + suppliers. We pull only active records with any commercial
   * relationship (customer_rank > 0 OR supplier_rank > 0) to skip contacts
   * that are mere address-book entries.
   */
  async syncPartners(): Promise<ModelResult> {
    return this.syncModel('res.partner', {
      domain: [
        '&',
        ['active', '=', true],
        '|',
        ['customer_rank', '>', 0],
        ['supplier_rank', '>', 0],
      ],
      fields: ['id', 'name', 'display_name', 'email', 'vat', 'customer_rank', 'supplier_rank', 'is_company'],
      makeEntity: (row) => {
        const displayName = stringOrEmpty(row['display_name']) || stringOrEmpty(row['name']);
        if (!displayName) return null;
        return {
          system: 'odoo',
          model: 'res.partner',
          id: Number(row['id']),
          displayName,
          extras: {
            ...(row['email'] ? { email: String(row['email']) } : {}),
            ...(row['vat'] ? { vat: String(row['vat']) } : {}),
            ...(row['is_company'] === true ? { isCompany: true } : {}),
            customerRank: Number(row['customer_rank'] ?? 0),
            supplierRank: Number(row['supplier_rank'] ?? 0),
          },
        };
      },
    });
  }

  /**
   * Employees — public-domain fields only. Red-lined columns (wage,
   * hourly_wage, private_street/phone/email, identification_id, bank) are
   * NEVER requested here; the Odoo toolkit enforces the same policy at the
   * agent layer but defense-in-depth matters.
   */
  async syncEmployees(): Promise<ModelResult> {
    return this.syncModel('hr.employee', {
      domain: [['active', '=', true]],
      fields: ['id', 'name', 'work_email', 'work_phone', 'job_title', 'department_id'],
      makeEntity: (row) => {
        const displayName = stringOrEmpty(row['name']);
        if (!displayName) return null;
        const deptTuple = row['department_id'];
        const departmentName = Array.isArray(deptTuple) && deptTuple.length >= 2
          ? String(deptTuple[1])
          : undefined;
        return {
          system: 'odoo',
          model: 'hr.employee',
          id: Number(row['id']),
          displayName,
          extras: {
            ...(row['work_email'] ? { workEmail: String(row['work_email']) } : {}),
            ...(row['work_phone'] ? { workPhone: String(row['work_phone']) } : {}),
            ...(row['job_title'] ? { jobTitle: String(row['job_title']) } : {}),
            ...(departmentName ? { departmentName } : {}),
          },
        };
      },
    });
  }

  async syncDepartments(): Promise<ModelResult> {
    return this.syncModel('hr.department', {
      domain: [['active', '=', true]],
      fields: ['id', 'name', 'complete_name', 'manager_id'],
      makeEntity: (row) => {
        const displayName = stringOrEmpty(row['complete_name']) || stringOrEmpty(row['name']);
        if (!displayName) return null;
        const managerTuple = row['manager_id'];
        const managerName = Array.isArray(managerTuple) && managerTuple.length >= 2
          ? String(managerTuple[1])
          : undefined;
        return {
          system: 'odoo',
          model: 'hr.department',
          id: Number(row['id']),
          displayName,
          extras: managerName ? { managerName } : {},
        };
      },
    });
  }

  async syncJournals(): Promise<ModelResult> {
    return this.syncModel('account.journal', {
      domain: [['active', '=', true]],
      fields: ['id', 'name', 'code', 'type', 'currency_id'],
      makeEntity: (row) => {
        const displayName = stringOrEmpty(row['name']);
        if (!displayName) return null;
        const currencyTuple = row['currency_id'];
        const currency = Array.isArray(currencyTuple) && currencyTuple.length >= 2
          ? String(currencyTuple[1])
          : undefined;
        return {
          system: 'odoo',
          model: 'account.journal',
          id: Number(row['id']),
          displayName,
          extras: {
            ...(row['code'] ? { code: String(row['code']) } : {}),
            ...(row['type'] ? { type: String(row['type']) } : {}),
            ...(currency ? { currency } : {}),
          },
        };
      },
    });
  }

  /**
   * Chart of accounts. Enables the accounting sub-agent to resolve codes like
   * "1400" or names like "Forderungen aus Lieferungen und Leistungen" via the
   * graph instead of a live Odoo call on every turn.
   */
  async syncAccounts(): Promise<ModelResult> {
    return this.syncModel('account.account', {
      domain: [],
      fields: ['id', 'code', 'name', 'account_type', 'currency_id', 'deprecated'],
      makeEntity: (row) => {
        const code = stringOrEmpty(row['code']);
        const name = stringOrEmpty(row['name']);
        if (!code && !name) return null;
        const displayName = code && name ? `${code} ${name}` : (code || name);
        const currencyTuple = row['currency_id'];
        const currency = Array.isArray(currencyTuple) && currencyTuple.length >= 2
          ? String(currencyTuple[1])
          : undefined;
        return {
          system: 'odoo',
          model: 'account.account',
          id: Number(row['id']),
          displayName,
          extras: {
            ...(code ? { code } : {}),
            ...(row['account_type'] ? { accountType: String(row['account_type']) } : {}),
            ...(currency ? { currency } : {}),
            ...(row['deprecated'] === true ? { deprecated: true } : {}),
          },
        };
      },
    });
  }

  /**
   * Currencies. Small table (< 200 rows) but stable — perfect graph candidate
   * so FX-related follow-ups don't round-trip to Odoo.
   */
  async syncCurrencies(): Promise<ModelResult> {
    return this.syncModel('res.currency', {
      domain: [],
      fields: ['id', 'name', 'symbol', 'rounding', 'decimal_places', 'active'],
      makeEntity: (row) => {
        const displayName = stringOrEmpty(row['name']);
        if (!displayName) return null;
        return {
          system: 'odoo',
          model: 'res.currency',
          id: Number(row['id']),
          displayName,
          extras: {
            ...(row['symbol'] ? { symbol: String(row['symbol']) } : {}),
            ...(typeof row['rounding'] === 'number' ? { rounding: row['rounding'] } : {}),
            ...(typeof row['decimal_places'] === 'number' ? { decimalPlaces: row['decimal_places'] } : {}),
            ...(row['active'] === false ? { active: false } : {}),
          },
        };
      },
    });
  }

  private async syncModel(
    model: string,
    opts: {
      domain: unknown[];
      fields: string[];
      makeEntity: (row: Record<string, unknown>) => EntityIngest | null;
    },
  ): Promise<ModelResult> {
    let offset = 0;
    const totals: ModelResult = {
      read: 0,
      ingested: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
    };
    while (totals.read < this.maxPerModel) {
      const limit = Math.min(this.pageSize, this.maxPerModel - totals.read);
      const response = await this.opts.odoo.execute({
        model,
        method: 'search_read',
        positionalArgs: [opts.domain],
        kwargs: {
          fields: opts.fields,
          limit,
          offset,
          order: 'id asc',
        },
      });
      if (!Array.isArray(response)) {
        throw new Error(`unexpected non-array response from ${model}.search_read`);
      }
      if (response.length === 0) break;
      totals.read += response.length;
      const batch: EntityIngest[] = [];
      for (const row of response as Array<Record<string, unknown>>) {
        const ent = opts.makeEntity(row);
        if (ent) batch.push(ent);
        else totals.skipped++;
      }
      if (batch.length > 0) {
        const result = await this.opts.graph.ingestEntities(batch);
        totals.ingested += result.entityIds.length;
        totals.inserted += result.inserted;
        totals.updated += result.updated;
      }
      if (response.length < limit) break;
      offset += response.length;
    }
    return totals;
  }

  private async safe(
    label: string,
    fn: () => Promise<ModelResult>,
  ): Promise<ModelResult> {
    const started = Date.now();
    this.log(`[odoo-sync] ${label}: start`);
    try {
      const r = await fn();
      const took = Date.now() - started;
      this.log(
        `[odoo-sync] ${label}: done read=${String(r.read)} ingested=${String(r.ingested)} ins=${String(r.inserted)} upd=${String(r.updated)} skip=${String(r.skipped)} took=${String(took)}ms`,
      );
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const took = Date.now() - started;
      console.error(`[odoo-sync] ${label}: FAIL (${String(took)}ms):`, msg);
      return { read: 0, ingested: 0, inserted: 0, updated: 0, skipped: 0, error: msg };
    }
  }
}

function stringOrEmpty(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  return String(v);
}

function formatModel(r: ModelResult): string {
  if (r.error) return `ERROR(${r.error.slice(0, 40)})`;
  return `read=${String(r.read)}/ingested=${String(r.ingested)}/ins=${String(r.inserted)}/upd=${String(r.updated)}/skip=${String(r.skipped)}`;
}
