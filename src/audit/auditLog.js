// Append-only audit log — the REQ-008 guardrail ("log all actions and decisions").
//
// One JSON object per line. Each entry carries the hash of the entry before it,
// so editing or removing any line that has entries after it breaks the chain and
// verify() says where.
//
// Keyed hashes (STORY-006): with a `key`, each hash is an HMAC-SHA256 made with
// that secret key instead of a plain SHA-256. A plain hash can be recomputed by
// anyone, so someone who edits a line could rewrite every later hash and leave a
// chain that still verifies; without the key they cannot. Each keyed entry says
// alg: 'hmac-sha256' (an entry with no alg is plain SHA-256), and a log never
// mixes the two. In production use openAuditLogFromEnv(), which refuses to run
// without AUDIT_LOG_KEY. The key is never written to the log or put in an error.
//
// Known limit: removing the LAST entries cannot be detected from the file alone —
// what is left is still a valid chain. Catching that needs the latest hash kept
// somewhere the file's editor cannot reach (an external anchor).
//
// Fail closed: if an entry cannot be written, append() throws AuditWriteError and
// the log refuses every later write too (a failed write may have left half a line).
// Callers must stop the action rather than carry on unrecorded.
//
// Single-writer: appends are synchronous so entries from one process stay in
// order. Two processes writing the same file at once is not supported.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

import { isDecision } from './decisions.js';

export const GENESIS_HASH = '0'.repeat(64);
export const KEYED_ALG = 'hmac-sha256';
export const MIN_KEY_LENGTH = 32;

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

// Fixed key order, so the same entry always hashes the same way. `alg` is only
// present on keyed entries, so plain entries hash exactly as they always did.
function body(e) {
  const b = {
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
  if (e.alg) b.alg = e.alg;
  return b;
}

const algOf = (e) => e.alg ?? 'sha256';
// With a key: HMAC-SHA256, which cannot be recomputed without the key.
const hashOf = (e, key) => {
  const text = JSON.stringify(body(e));
  return key ? createHmac('sha256', key).update(text).digest('hex') : createHash('sha256').update(text).digest('hex');
};

// Production: the key comes from AUDIT_LOG_KEY and the log will not open without it.
export function openAuditLogFromEnv({ file, env = process.env, now } = {}) {
  const key = env.AUDIT_LOG_KEY;
  if (typeof key !== 'string' || key.length === 0) {
    throw new AuditWriteError('AUDIT_LOG_KEY is not set; the audit log will not run without its signing key.');
  }
  return createAuditLog({ file, key, now });
}

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const toLines = (text) => text.split('\n').filter((l) => l.trim() !== '');
const readLines = (file) => toLines(readText(file));

// onWriteFailure(err) is called once, on the first failed write, so someone hears
// about it at once (not just through a stream of refused actions). `write` is the
// function that appends to the file; tests replace it to simulate a full disk.
export function createAuditLog({
  file, now = () => new Date(), key,
  onWriteFailure = (err) => { console.error(`AUDIT LOG WRITE FAILED (${file}): ${err?.message ?? err}. Every later action will be refused until this is fixed.`); },
  write = appendFileSync,
} = {}) {
  if (!file) throw new AuditWriteError('createAuditLog needs a file path');
  if (key !== undefined && (typeof key !== 'string' || key.length < MIN_KEY_LENGTH)) {
    throw new AuditWriteError(`The audit log key must be at least ${MIN_KEY_LENGTH} characters.`);
  }
  const alg = key ? KEYED_ALG : 'sha256';

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
    // Never mix keyed and plain entries, and never extend a keyed log with the wrong key.
    if (algOf(last) !== alg) {
      throw new AuditWriteError(`Audit log ${file} uses ${algOf(last)} hashes but was opened ${key ? 'with' : 'without'} a key; refusing to extend it`);
    }
    if (key && last.hash !== hashOf(last, key)) {
      throw new AuditWriteError(`Audit log ${file}: its last entry does not match this key (wrong key, or the entry was changed); refusing to extend it`);
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
    // A decision without its "why" is refused, like any other incomplete entry:
    // the caller's action stops rather than being recorded without a rationale.
    if (isDecision(action) && (typeof rationale !== 'string' || rationale.trim() === '')) {
      throw new AuditWriteError(`"${action}" records a decision, so it must include its rationale`);
    }
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
      alg: key ? KEYED_ALG : undefined,
    });
    entry.hash = hashOf(entry, key);

    try {
      mkdirSync(dirname(file), { recursive: true });
      // mode 0o600: when the file is first created, only its owner may read or write it
      // (Linux/macOS; Windows does not use these permission bits).
      write(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      failedWrite = err;
      try {
        onWriteFailure(err);
      } catch (alertErr) {
        console.error(`audit log: the write-failure alert itself failed: ${alertErr?.message ?? alertErr}`);
      }
      throw new AuditWriteError(`Could not write audit entry "${action}" to ${file}`, { cause: err });
    }
    last = entry;
    return entry;
  }

  function readAll() {
    return readLines(file).map((l) => JSON.parse(l));
  }

  return {
    file, append, readAll,
    verify: () => verifyAuditFile({ file, key }),
    get writeFailed() { return failedWrite !== null; },
  };
}

// Recompute every hash and check every link; reports the first broken entry.
// Read-only, so it can check a file that createAuditLog() would refuse to extend.
// `keyed` says whether the hashes were checked with the secret key: an unkeyed
// log can only show it is internally consistent, not that nobody rewrote it.
export function verifyAuditFile({ file, key }) {
  const keyed = Boolean(key);
  const alg = keyed ? KEYED_ALG : 'sha256';
  const broken = (brokenAt, reason) => ({ ok: false, brokenAt, reason, keyed });
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  const all = readLines(file);
  for (const [i, line] of all.entries()) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return broken(i + 1, 'line is not valid JSON');
    }
    if (!isEntry(e)) return broken(i + 1, 'line is not an audit entry');
    if (e.seq !== expectedSeq) return broken(e.seq, `expected seq ${expectedSeq}`);
    if (algOf(e) !== alg) return broken(e.seq, `entry uses ${algOf(e)} hashes; this check uses ${alg}`);
    if (e.prevHash !== prevHash) return broken(e.seq, 'prevHash does not match the previous entry');
    if (e.hash !== hashOf(e, key)) return broken(e.seq, 'entry was changed after it was written');
    prevHash = e.hash;
    expectedSeq += 1;
  }
  return { ok: true, count: all.length, keyed };
}
