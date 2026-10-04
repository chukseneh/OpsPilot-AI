// Where finished work is remembered, keyed by operation id, so running the same
// operation twice does not redo it. A record looks like:
//   { status: 'running' | 'completed' | 'failed', tasks: { [taskId]: taskResult } }
//
// Both stores offer get(id), put(id, record) and list(). list() is read-only and
// returns copies, [{ id, record }]. Order: the memory store lists records in the
// order they were first saved; the file store follows JSON object key order, which
// puts number-like ids ("2", "10") first. Readers that care about order must sort.
//
// Any string is a safe id, including "constructor", "toString" and "__proto__":
// records are only ever looked up among ids that were actually saved.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createMemoryResultStore() {
  const records = new Map();
  return {
    get: (operationId) => structuredClone(records.get(operationId) ?? null),
    put: (operationId, record) => { records.set(operationId, structuredClone(record)); },
    list: () => [...records].map(([id, record]) => ({ id, record: structuredClone(record) })),
  };
}

// Windows can briefly refuse to replace a file another program has open (antivirus,
// or a reader mid-read). Those errors are retried a few times; anything else is not.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 5;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One JSON file for all operations. Each put rewrites it via a temp file and a
// rename, so a crash mid-write leaves the previous version, not half a file.
// `rename` can be replaced in tests to simulate a busy file.
export function createFileResultStore({ file, rename = renameSync }) {
  // A Map, not a plain object: a plain object would answer ids like "constructor"
  // with built-in values, and saving "__proto__" would change the object instead.
  const load = () => {
    if (!existsSync(file)) return new Map();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} does not hold a result store`);
    return new Map(Object.entries(parsed)); // own keys only — JSON.parse makes "__proto__" an ordinary key
  };

  function replaceFile(tmp) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        rename(tmp, file);
        return;
      } catch (err) {
        if (!BUSY.has(err?.code) || attempt >= RENAME_ATTEMPTS) throw err;
        sleepSync(20 * 2 ** (attempt - 1)); // 20, 40, 80, 160 ms
      }
    }
  }

  return {
    get: (operationId) => {
      const all = load();
      return all.has(operationId) ? all.get(operationId) : null;
    },
    put(operationId, record) {
      const all = load();
      all.set(operationId, record);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      // Object.fromEntries defines "__proto__" as an ordinary key, so it is saved like any other.
      writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(all), null, 2)}\n`);
      replaceFile(tmp);
    },
    list: () => [...load()].map(([id, record]) => ({ id, record })),
  };
}
