// Append-only audit log — the REQ-008 guardrail ("log all actions and decisions").
//
// One JSON object per line. Each entry carries the hash of the entry before it,
// so editing or removing any line that has entries after it breaks the chain and
// verify() says where.
//
// Known limit: removing the LAST entries cannot be detected from the file alone —
// what is left is still a valid chain. Catching that needs the latest hash kept
// somewhere the file's editor cannot reach (an external anchor); that belongs to
// STORY-006 ("logs are immutable and securely stored").
//
// Fail closed: if an entry cannot be written, append() throws AuditWriteError and
// the log refuses every later write too (a failed write may have left half a line).
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

// Credentials must never land in the log, even by accident. Two layers:
//   1. a field whose NAME looks secret has its whole value replaced;
//   2. any string anywhere (detail, rationale, subject) has token-shaped text
//      replaced — error messages often quote the URL or header that failed.
const SECRET_KEY = /secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key|bearer|session/i;

const SECRET_TEXT = [
  // Authorization header values: "Bearer abc…", "Basic dXNl…"
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  // Query-string or key=value secrets: "?access_token=…", "client_secret=…"
  [/\b(access_token|refresh_token|id_token|token|api[_-]?key|client_secret|secret|password|sig|code)=[^&\s"']+/gi, '$1=[redacted]'],
  // JSON Web Tokens: three base64url parts, the first starting "eyJ"
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
];

function scrubText(text) {
  return SECRET_TEXT.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text);
}

function redact(value) {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

// A parsed line is an entry only if it has the shape append() writes.
const isEntry = (e) => e !== null && typeof e === 'object' && !Array.isArray(e)
  && Number.isInteger(e.seq) && typeof e.hash === 'string' && typeof e.prevHash === 'string';

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

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const toLines = (text) => text.split('\n').filter((l) => l.trim() !== '');
const readLines = (file) => toLines(readText(file));

export function createAuditLog({ file, now = () => new Date() }) {
  if (!file) throw new AuditWriteError('createAuditLog needs a file path');

  // Pick up where the file left off, so restarts continue the same chain.
  let last = null;
  let text;
  try {
    text = readText(file);
  } catch (err) {
    throw new AuditWriteError(`Could not open audit log ${file}`, { cause: err });
  }
  if (text && !text.endsWith('\n')) {
    throw new AuditWriteError(`Audit log ${file} ends with an incomplete line (an interrupted write?); refusing to extend it`);
  }
  const lines = toLines(text);
  if (lines.length) {
    try {
      last = JSON.parse(lines.at(-1));
    } catch (err) {
      throw new AuditWriteError(`Audit log ${file} ends with an unreadable line; refusing to extend it`, { cause: err });
    }
    if (!isEntry(last)) {
      throw new AuditWriteError(`Audit log ${file} ends with a line that is not an audit entry; refusing to extend it`);
    }
  }

  // Set by the first failed write. From then on the file's tail is unknown, so
  // every later append is refused rather than glued onto a half-written line.
  let failedWrite = null;

  function append({ correlationId, actor, action, subject, rationale, detail }) {
    const missing = [
      !correlationId && 'correlationId',
      !(actor?.type && actor?.id) && 'actor.type/actor.id',
      !action && 'action',
    ].filter(Boolean);
    if (missing.length) throw new AuditWriteError(`Audit entry is missing ${missing.join(', ')}`);
    if (failedWrite) {
      throw new AuditWriteError(
        `Audit log ${file} refused "${action}": an earlier write failed and may have left half a line. Check the file, then restart.`,
        { cause: failedWrite },
      );
    }

    const entry = body({
      seq: (last?.seq ?? 0) + 1,
      at: now().toISOString(),
      correlationId,
      actor: { type: actor.type, id: actor.id },
      action,
      subject: subject == null ? subject : redact(subject),
      rationale: rationale == null ? rationale : redact(rationale),
      detail: redact(detail ?? {}),
      prevHash: last?.hash ?? GENESIS_HASH,
    });
    entry.hash = hashOf(entry);

    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      failedWrite = err;
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
      if (!isEntry(e)) return { ok: false, brokenAt: i + 1, reason: 'line is not an audit entry' };
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
