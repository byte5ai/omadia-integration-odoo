import { z } from 'zod';
import type {
  CompanyEnrichmentProvider,
  EnrichOutcome,
} from './companyEnrichment.js';

/**
 * `enrich_company` — native orchestrator tool.
 *
 * Provider-agnostic. Delegates to whichever `CompanyEnrichmentProvider` the
 * middleware wires in `index.ts` (OpenRegister active today; NorthData kept
 * as Plan-B). Returns a compact German text summary the orchestrator weaves
 * into the user-facing reply, plus — on fuzzy-match ambiguity — a candidate
 * list the orchestrator is instructed to present to the user for choice,
 * never auto-pick (policy D7).
 */

const EnrichInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    address: z.string().trim().min(1).optional(),
    externalId: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.name || v.externalId), {
    message: 'either `name` or `externalId` must be provided',
  });

export const ENRICH_COMPANY_TOOL_NAME = 'enrich_company';
/** @deprecated use {@link ENRICH_COMPANY_TOOL_NAME}. */
export const NORTHDATA_ENRICH_TOOL_NAME = ENRICH_COMPANY_TOOL_NAME;

export const enrichCompanyToolSpec = {
  name: ENRICH_COMPANY_TOOL_NAME,
  description:
    'Hole Handelsregister-Stammdaten + Bonitäts-Signale zu einer deutschen Firma (Quelle: OpenRegister, ggf. andere Provider) und lege sie im Knowledge-Graph ab. Nutze dieses Tool wenn der User nach einer konkreten Firma fragt (Stammdaten, Geschäftsführer, Gesellschafter, Bonität, Insolvenz-Status, Umsatz, Eigenkapital). READ-ONLY gegenüber Odoo — schreibt NICHT zurück, nur in unseren Graphen. Bei mehreren Treffern liefert das Tool eine Kandidatenliste zurück — in dem Fall stelle dem User die Auswahl vor und frage nach (Name+Stadt oder stabile ID), starte NICHT selbst mit einem der Treffer.\n\nInput: mindestens einer der Parameter. `name` ist fuzzy (idealerweise mit `address` = Stadt/Ort). `externalId` ist die stabile Firmen-ID des Providers (z.B. `DE-HRB-F1103-267645` für OpenRegister), falls bereits bekannt — überspringt die fuzzy-Suche.\n\nAusgabe: kurzer DE-Text mit Status, Geschäftsführern (wenn bekannt), Risk-Level + Signalen, neuester Finanzdatenjahr. Bei Mehrdeutigkeit: Kandidatenliste mit Name + Stadt + ID.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description:
          'Firmenname für die fuzzy-Suche. Empfohlen: Rechtsform mit angeben ("Lilium GmbH", nicht nur "Lilium").',
      },
      address: {
        type: 'string',
        description:
          'Stadt oder Ort, um den Treffer zu disambiguieren. Optional aber dringend empfohlen wenn der Name allein mehrdeutig ist.',
      },
      externalId: {
        type: 'string',
        description:
          'Stabile Firmen-ID des aktiven Providers (z.B. `DE-HRB-F1103-267645` bei OpenRegister), wenn bereits bekannt. Überspringt die fuzzy-Suche.',
      },
    },
    required: [],
  },
};

/** Kept for backwards-compat with earlier orchestrator imports. */
export const northDataEnrichToolSpec = enrichCompanyToolSpec;

export class EnrichCompanyTool {
  constructor(private readonly provider: CompanyEnrichmentProvider) {}

  async handle(input: unknown): Promise<string> {
    const parsed = EnrichInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Error: invalid enrich_company input — ${issues}`;
    }
    const { name, address, externalId } = parsed.data;
    const started = Date.now();
    const outcome: EnrichOutcome = externalId
      ? await this.provider.enrichByExternalId(externalId)
      : await this.provider.enrichByName(name!, address ? { address } : {});
    const durationMs = Date.now() - started;
    return formatOutcome(outcome, durationMs);
  }
}

/** @deprecated import {@link EnrichCompanyTool} instead. Kept as type+value alias for callers that still reference the old name. */
export { EnrichCompanyTool as NorthDataEnrichTool };

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function formatOutcome(outcome: EnrichOutcome, durationMs: number): string {
  switch (outcome.status) {
    case 'success': {
      const c = outcome.company;
      const lines: string[] = [];
      const header = c.registerNumber
        ? `${c.name} (${[c.legalForm, c.registerCourt, c.registerNumber].filter(Boolean).join(' · ')})`
        : c.name;
      lines.push(`**${header}** — in Knowledge-Graph gespeichert${outcome.fromCache ? ' (Cache-Treffer, Daten bereits bekannt)' : ''}.`);
      if (c.status) lines.push(`- Status: ${c.status}`);
      if (c.address) lines.push(`- Adresse: ${c.address}`);
      if (c.vatId) lines.push(`- USt-IdNr.: ${c.vatId}`);
      if (c.riskLevel) {
        const label = RISK_LABELS[c.riskLevel] ?? c.riskLevel;
        lines.push(`- **Bonitäts-Einschätzung: ${label}**`);
      }
      if (c.riskSignals && c.riskSignals.length > 0) {
        lines.push(`- Signale: ${c.riskSignals.join(', ')}`);
      }
      if (outcome.personCount > 0) {
        lines.push(`- Beteiligte Personen (GF/Gesellschafter): ${String(outcome.personCount)}`);
      }
      if (outcome.financialYears.length > 0) {
        lines.push(
          `- Jüngste Finanzdaten: Jahr ${String(outcome.financialYears[0])}`,
        );
      }
      if (c.northDataUrl) {
        lines.push(`- Quelle: ${c.northDataUrl}`);
      }
      lines.push(`_(NorthData-Lookup ${String(durationMs)} ms)_`);
      return lines.join('\n');
    }

    case 'disambiguation': {
      const lines: string[] = [];
      lines.push(
        `Mehrere Firmen mit dem Namen **"${outcome.query}"** gefunden. Bitte den User um Spezifizierung — NICHT selbst eine auswählen.`,
      );
      lines.push('');
      lines.push('Kandidaten:');
      outcome.candidates.forEach((cand, idx) => {
        const parts = [
          `${String(idx + 1)}. ${cand.name}`,
          cand.city ? `Stadt: ${cand.city}` : undefined,
          cand.registerKey ? `registerKey=${cand.registerKey}` : undefined,
        ].filter(Boolean);
        lines.push(`- ${parts.join(' · ')}`);
      });
      lines.push('');
      lines.push(
        'Bitte den User fragen: "Welche dieser Firmen meinst du? Gib mir den Namen mit Stadt oder die HRB-Nummer." Danach `enrich_company` erneut aufrufen mit präzisierten Parametern.',
      );
      return lines.join('\n');
    }

    case 'not_found':
      return `Keine Firma gefunden für "${outcome.query}". Möglicherweise falsch geschrieben oder nicht im NorthData-Bestand. Bitte den User um präzisere Eingabe (ggf. mit Rechtsform + Stadt).`;

    case 'error':
      return `Error: NorthData-Lookup für "${outcome.query}" fehlgeschlagen — ${outcome.message}`;
  }
}

const RISK_LABELS: Record<string, string> = {
  low: 'unauffällig (low)',
  medium: 'leicht erhöht (medium)',
  high: 'erhöht (high)',
  critical: 'kritisch (critical)',
};
