// Where finished work is remembered, keyed by operation id, so running the same
// operation twice does not redo it. A record looks like:
//   { status: 'running' | 'completed' | 'failed', tasks: { [taskId]: taskResult } }

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createMemoryResultStore() {
  const records = new Map();
  return {
    get: (operationId) => structuredClone(records.get(operationId) ?? null),
    put: (operationId, record) => { records.set(operationId, structuredClone(record)); },
  };
}

// One JSON file for all operations. Each put rewrites it via a temp file and a
// rename, so a crash mid-write leaves the previous version, not half a file.
export function createFileResultStore({ file }) {
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  return {
    get: (operationId) => load()[operationId] ?? null,
    put(operationId, record) {
      const all = load();
      all[operationId] = record;
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
      renameSync(tmp, file);
    },
  };
}
