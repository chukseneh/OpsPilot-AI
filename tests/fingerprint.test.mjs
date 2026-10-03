// Shared request fingerprint. Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stableJson, fingerprint } from '../src/lib/fingerprint.js';

test('key order does not change the fingerprint; values and array order do', () => {
  assert.equal(fingerprint({ a: 1, b: { c: [1, 2], d: 'x' } }), fingerprint({ b: { d: 'x', c: [1, 2] }, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
  assert.match(fingerprint({}), /^[0-9a-f]{64}$/);
});

test('stableJson writes undefined as null and sorts nested keys', () => {
  assert.equal(stableJson({ b: undefined, a: [undefined, { z: 1, y: 2 }] }), '{"a":[null,{"y":2,"z":1}],"b":null}');
});
