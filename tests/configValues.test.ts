import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  readBoolean,
  readEnum,
  readPositiveInt,
  readPositiveNumber,
  readString,
} from '../src/configValues.js';

// byte5ai/omadia#1478 — typed values (new installs) and legacy strings
// (installs configured before 0.2.2) must both read correctly, and an
// unreadable value must be reported instead of silently defaulted.

const noWarn = (msg: string): void => {
  assert.fail(`unexpected warning: ${msg}`);
};

function collect(): { warn: (m: string) => void; warnings: string[] } {
  const warnings: string[] = [];
  return { warn: (m) => warnings.push(m), warnings };
}

describe('readBoolean', () => {
  it('reads typed and legacy values', () => {
    assert.equal(readBoolean('k', true, false, noWarn), true);
    assert.equal(readBoolean('k', false, true, noWarn), false);
    assert.equal(readBoolean('k', 'true', false, noWarn), true);
    assert.equal(readBoolean('k', 'False', true, noWarn), false);
    assert.equal(readBoolean('k', undefined, false, noWarn), false);
    assert.equal(readBoolean('k', '', true, noWarn), true);
  });

  it('warns on anything else', () => {
    const { warn, warnings } = collect();
    assert.equal(readBoolean('odoo_insecure_tls', 'yes', false, warn), false);
    assert.equal(readBoolean('k', 1, false, warn), false);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? '', /odoo_insecure_tls="yes"/);
  });
});

describe('readPositiveInt', () => {
  it('reads typed and legacy values', () => {
    assert.equal(readPositiveInt('k', 500_000, 1, noWarn), 500_000);
    assert.equal(readPositiveInt('k', '6', 1, noWarn), 6);
    assert.equal(readPositiveInt('k', undefined, 30, noWarn), 30);
  });

  it('warns on invalid values', () => {
    const { warn, warnings } = collect();
    assert.equal(readPositiveInt('k', '6h', 6, warn), 6);
    assert.equal(readPositiveInt('k', 0, 6, warn), 6);
    assert.equal(readPositiveInt('k', 1.5, 6, warn), 6);
    assert.equal(warnings.length, 3);
  });
});

describe('readPositiveNumber', () => {
  it('reads decimals as number or string', () => {
    assert.equal(readPositiveNumber('k', 0.5, 2, noWarn), 0.5);
    assert.equal(readPositiveNumber('k', '1.5', 2, noWarn), 1.5);
    assert.equal(readPositiveNumber('k', '2', 1, noWarn), 2);
  });

  it('warns on invalid values', () => {
    const { warn, warnings } = collect();
    assert.equal(readPositiveNumber('k', '1,5', 2, warn), 2);
    assert.equal(readPositiveNumber('k', '-1', 2, warn), 2);
    assert.equal(warnings.length, 2);
  });
});

describe('readEnum', () => {
  const levels = ['minimal', 'standard', 'full'] as const;

  it('accepts allowed values case-insensitively', () => {
    assert.equal(readEnum('k', 'full', levels, 'standard', noWarn), 'full');
    assert.equal(readEnum('k', ' Minimal ', levels, 'standard', noWarn), 'minimal');
    assert.equal(readEnum('k', undefined, levels, 'standard', noWarn), 'standard');
  });

  it('warns on unknown values', () => {
    const { warn, warnings } = collect();
    assert.equal(readEnum('k', 'max', levels, 'standard', warn), 'standard');
    assert.equal(warnings.length, 1);
  });
});

describe('readString', () => {
  it('falls back on empty or non-string values', () => {
    assert.equal(readString('https://x.example', 'd'), 'https://x.example');
    assert.equal(readString('  ', 'd'), 'd');
    assert.equal(readString(undefined, 'd'), 'd');
  });
});

describe('manifest setup field types', () => {
  const manifest = readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8');
  const typeOf = (key: string): string | undefined =>
    new RegExp(`- key: "${key}"\\n\\s+type: "(\\w+)"`).exec(manifest)?.[1];

  const expected: Record<string, string> = {
    odoo_url: 'url',
    openregister_base_url: 'url',
    northdata_base_url: 'url',
    odoo_insecure_tls: 'boolean',
    odoo_generic_read_enabled: 'boolean',
    odoo_entity_sync_enabled: 'boolean',
    openregister_enabled: 'boolean',
    northdata_enabled: 'boolean',
    odoo_proxy_max_bytes: 'integer',
    odoo_entity_sync_interval_hours: 'integer',
    odoo_entity_sync_page_size: 'integer',
    odoo_entity_sync_max_per_model: 'integer',
    openregister_cache_ttl_days: 'integer',
    openregister_max_bytes: 'integer',
    northdata_cache_ttl_days: 'integer',
    northdata_max_bytes: 'integer',
    openregister_fetch_level: 'enum',
  };

  for (const [key, type] of Object.entries(expected)) {
    it(`${key} is ${type}`, () => {
      assert.equal(typeOf(key), type);
    });
  }

  it('boolean defaults are real YAML booleans, not strings', () => {
    assert.doesNotMatch(manifest, /type: "boolean"[\s\S]*?default: "(true|false)"/);
  });
});
