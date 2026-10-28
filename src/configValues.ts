/**
 * Setup-value readers that accept BOTH shapes a stored value can have
 * (byte5ai/omadia#1478):
 *
 * - typed — since 0.2.2 the manifest declares `boolean` / `integer` / `enum`
 *   fields, so the host stores `true` / `500000`;
 * - legacy strings — installs configured before 0.2.2 keep `"true"` /
 *   `"500000"` in their stored config; the host validates types at install
 *   time only, so those strings stay until the operator saves again.
 *
 * An unreadable value falls back to the default, but never silently: the
 * caller's `warn` gets the key and the raw value.
 */

export type Warn = (message: string) => void;

function isUnset(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '';
}

function warnDefault(
  warn: Warn,
  key: string,
  raw: unknown,
  expected: string,
  fallback: unknown,
): void {
  warn(
    `[odoo] ${key}=${JSON.stringify(raw)} is not ${expected} — using default ${String(fallback)}`,
  );
}

export function readBoolean(
  key: string,
  raw: unknown,
  fallback: boolean,
  warn: Warn,
): boolean {
  if (isUnset(raw)) return fallback;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  warnDefault(warn, key, raw, 'true/false', fallback);
  return fallback;
}

export function readPositiveInt(
  key: string,
  raw: unknown,
  fallback: number,
  warn: Warn,
): number {
  if (isUnset(raw)) return fallback;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (Number.isInteger(n) && n > 0) return n;
  warnDefault(warn, key, raw, 'a positive integer', fallback);
  return fallback;
}

/** Decimals stay `type: string` in the manifest — the host has no decimal
 *  field type — so this is the only validation they get. */
export function readPositiveNumber(
  key: string,
  raw: unknown,
  fallback: number,
  warn: Warn,
): number {
  if (isUnset(raw)) return fallback;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  warnDefault(warn, key, raw, 'a positive number', fallback);
  return fallback;
}

export function readEnum<T extends string>(
  key: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
  warn: Warn,
): T {
  if (isUnset(raw)) return fallback;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    const match = allowed.find((value) => value === normalized);
    if (match) return match;
  }
  warnDefault(warn, key, raw, `one of ${allowed.join('/')}`, fallback);
  return fallback;
}

/** URL fields: an empty legacy value means "use the default". */
export function readString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}
