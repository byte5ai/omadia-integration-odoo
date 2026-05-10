import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractOdooEntityRefs } from '@omadia/integration-odoo';

describe('extractOdooEntityRefs', () => {
  it('extracts refs from search_read records with name fallback to display_name', () => {
    const result = [
      { id: 1, name: 'Alice' },
      { id: 2, display_name: 'Bob' },
      { id: 3 },
    ];
    const refs = extractOdooEntityRefs('hr.employee', 'search_read', result);
    assert.equal(refs.length, 3);
    assert.deepEqual(refs[0], {
      system: 'odoo',
      model: 'hr.employee',
      id: 1,
      displayName: 'Alice',
      op: 'read',
    });
    assert.equal(refs[1]?.displayName, 'Bob');
    assert.equal(refs[2]?.displayName, undefined);
  });

  it('handles the read method like search_read', () => {
    const refs = extractOdooEntityRefs('res.partner', 'read', [
      { id: 42, name: 'Acme' },
    ]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.model, 'res.partner');
  });

  it('extracts raw id arrays for the search method', () => {
    const refs = extractOdooEntityRefs('hr.department', 'search', [10, 11, 12]);
    assert.deepEqual(
      refs.map((r) => r.id),
      [10, 11, 12],
    );
    assert.ok(refs.every((r) => r.displayName === undefined));
  });

  it('returns no refs for count/group/fields_get methods', () => {
    assert.deepEqual(extractOdooEntityRefs('x', 'search_count', 5), []);
    assert.deepEqual(extractOdooEntityRefs('x', 'read_group', [{}]), []);
    assert.deepEqual(extractOdooEntityRefs('x', 'fields_get', {}), []);
  });

  it('skips malformed entries silently instead of throwing', () => {
    const refs = extractOdooEntityRefs('m', 'search_read', [
      null,
      { id: 'str-id', name: 'Allowed' },
      { name: 'missing id' },
      'bogus',
      { id: 7, name: 42 }, // non-string name → undefined displayName
    ]);
    assert.equal(refs.length, 2);
    assert.equal(refs[0]?.id, 'str-id');
    assert.equal(refs[1]?.id, 7);
    assert.equal(refs[1]?.displayName, undefined);
  });

  it('returns [] for non-array input to array-expecting methods', () => {
    assert.deepEqual(extractOdooEntityRefs('m', 'search_read', null), []);
    assert.deepEqual(extractOdooEntityRefs('m', 'search', 'nope'), []);
  });
});
