// Result store, including list() (added for the STORY-011 dashboard).
// Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryResultStore, createFileResultStore } from '../src/orchestration/resultStore.js';

const stores = {
  memory: () => createMemoryResultStore(),
  file: () => createFileResultStore({ file: join(mkdtempSync(join(tmpdir(), 'store-')), 'results.json') }),
};

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind} store: list() is empty before anything is saved`, () => {
    assert.deepEqual(make().list(), []);
  });

  test(`${kind} store: list() returns every record in first-saved order, and an update keeps its place`, () => {
    const store = make();
    store.put('a', { status: 'completed', n: 1 });
    store.put('b', { status: 'failed' });
    store.put('a', { status: 'completed', n: 2 });
    assert.deepEqual(store.list(), [
      { id: 'a', record: { status: 'completed', n: 2 } },
      { id: 'b', record: { status: 'failed' } },
    ]);
  });

  test(`${kind} store: changing what list() returned does not change what is stored`, () => {
    const store = make();
    store.put('a', { status: 'completed', tags: ['x'] });
    const [entry] = store.list();
    entry.record.status = 'tampered';
    entry.record.tags.push('y');
    assert.deepEqual(store.get('a'), { status: 'completed', tags: ['x'] });
  });
}

test('a file store reopened on the same file lists what an earlier one saved', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'store-')), 'results.json');
  createFileResultStore({ file }).put('op-1', { status: 'completed' });
  assert.deepEqual(createFileResultStore({ file }).list(), [{ id: 'op-1', record: { status: 'completed' } }]);
});
