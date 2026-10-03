// One place for "is this the same request as before?". Used by the orchestrator
// (operations) and the analysis service (analyses) to tell a genuine repeat of a
// request from an id reused with different content.

import { createHash } from 'node:crypto';

// JSON with object keys sorted, so { a, b } and { b, a } read the same.
// undefined is written as null, matching JSON's own treatment inside arrays.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const fingerprint = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
