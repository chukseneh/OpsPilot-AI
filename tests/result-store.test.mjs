// Result store, including list() (added for the STORY-011 dashboard).
// Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync } from 'node:fs';
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

  test(`${kind} store: ids like "constructor", "toString" and "__proto__" are ordinary ids`, () => {
    // Found in code review: the file store used to answer get('constructor') with a
    // built-in function, and saving under '__proto__' silently lost the record.
    const store = make();
    assert.equal(store.get('constructor'), null);
    assert.equal(store.get('toString'), null);
    assert.equal(store.get('__proto__'), null);
    store.put('__proto__', { status: 'completed', n: 1 });
    store.put('constructor', { status: 'failed' });
    assert.deepEqual(store.get('__proto__'), { status: 'completed', n: 1 });
    assert.deepEqual(store.get('constructor'), { status: 'failed' });
    assert.deepEqual(store.list().map((e) => e.id).sort(), ['__proto__', 'constructor']);
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

test('a briefly busy file (Windows EPERM/EBUSY) is retried, then saved', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'store-')), 'results.json');
  let refusals = 0;
  const flakyRename = (from, to) => {
    if (refusals < 2) { refusals += 1; throw Object.assign(new Error('busy'), { code: refusals === 1 ? 'EPERM' : 'EBUSY' }); }
    renameSync(from, to);
  };
  const store = createFileResultStore({ file, rename: flakyRename });
  store.put('a', { status: 'completed' });
  assert.equal(refusals, 2);
  assert.deepEqual(store.get('a'), { status: 'completed' });
});

test('a file that stays busy fails after 5 tries; other errors are not retried', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'store-')), 'results.json');
  let tries = 0;
  const alwaysBusy = createFileResultStore({ file, rename: () => { tries += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  assert.throws(() => alwaysBusy.put('a', {}), /busy/);
  assert.equal(tries, 5);

  tries = 0;
  const broken = createFileResultStore({ file, rename: () => { tries += 1; throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); } });
  assert.throws(() => broken.put('a', {}), /no space/);
  assert.equal(tries, 1);
});

test('the file store follows JSON key order (number-like ids first), as documented', () => {
  const store = stores.file();
  store.put('b', {});
  store.put('10', {});
  store.put('2', {});
  assert.deepEqual(store.list().map((e) => e.id), ['2', '10', 'b']);
});

test('a file store reopened on the same file lists what an earlier one saved', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'store-')), 'results.json');
  createFileResultStore({ file }).put('op-1', { status: 'completed' });
  assert.deepEqual(createFileResultStore({ file }).list(), [{ id: 'op-1', record: { status: 'completed' } }]);
});
