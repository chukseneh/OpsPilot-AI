// Append-only audit log — the REQ-008 guardrail ("log all actions and decisions").
//
// One JSON object per line. Each entry carries the hash of the entry before it,
// so editing or deleting any past line breaks the chain and verify() says where.
//
// Fail closed: if an entry cannot be written, append() throws AuditWriteError.
// Callers must stop the action rather than carry on unrecorded.
//
// Single-writer: appends are synchronous so entries from one process stay in
// order. Two processes writing the same file at once is not supported.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export class AuditWriteError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AuditWriteError';
  }
}

// Credentials must never land in the log, even by accident.
const SECRET_KEY = /secret|token|password|passwd|api[_-]?key|authorization|cookie/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Fixed key order, so the same entry always hashes the same way.
function body(e) {
  return {
    seq: e.seq,
    at: e.at,
    correlationId: e.correlationId,
    actor: e.actor,
    action: e.action,
    subject: e.subject ?? null,
    rationale: e.rationale ?? null,
    detail: e.detail ?? {},
    prevHash: e.prevHash,
  };
}

const hashOf = (e) => sha256(JSON.stringify(body(e)));

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

export function createAuditLog({ file, now = () => new Date() }) {
  if (!file) throw new AuditWriteError('createAuditLog needs a file path');

  // Pick up where the file left off, so restarts continue the same chain.
  let last = null;
  let lines;
  try {
    lines = readLines(file);
  } catch (err) {
    throw new AuditWriteError(`Could not open audit log ${file}`, { cause: err });
  }
  if (lines.length) {
    try {
      last = JSON.parse(lines.at(-1));
    } catch (err) {
      throw new AuditWriteError(`Audit log ${file} ends with an unreadable line; refusing to extend it`, { cause: err });
    }
  }

  function append({ correlationId, actor, action, subject, rationale, detail }) {
    const missing = [
      !correlationId && 'correlationId',
      !(actor?.type && actor?.id) && 'actor.type/actor.id',
      !action && 'action',
    ].filter(Boolean);
    if (missing.length) throw new AuditWriteError(`Audit entry is missing ${missing.join(', ')}`);

    const entry = body({
      seq: (last?.seq ?? 0) + 1,
      at: now().toISOString(),
      correlationId,
      actor: { type: actor.type, id: actor.id },
      action,
      subject,
      rationale,
      detail: redact(detail ?? {}),
      prevHash: last?.hash ?? GENESIS_HASH,
    });
    entry.hash = hashOf(entry);

    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      throw new AuditWriteError(`Could not write audit entry "${action}" to ${file}`, { cause: err });
    }
    last = entry;
    return entry;
  }

  function readAll() {
    return readLines(file).map((l) => JSON.parse(l));
  }

  // Recompute every hash and check every link. Reports the first broken entry.
  function verify() {
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    const all = readLines(file);
    for (const [i, line] of all.entries()) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return { ok: false, brokenAt: i + 1, reason: 'line is not valid JSON' };
      }
      if (e.seq !== expectedSeq) return { ok: false, brokenAt: e.seq, reason: `expected seq ${expectedSeq}` };
      if (e.prevHash !== prevHash) return { ok: false, brokenAt: e.seq, reason: 'prevHash does not match the previous entry' };
      if (e.hash !== hashOf(e)) return { ok: false, brokenAt: e.seq, reason: 'entry was changed after it was written' };
      prevHash = e.hash;
      expectedSeq += 1;
    }
    return { ok: true, count: all.length };
  }

  return { file, append, readAll, verify };
}
