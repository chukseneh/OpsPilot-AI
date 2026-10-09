// When storing the audit log fails (STORY-006, failure path "log storage failure").
//
// The log already fails closed (auditLog.js): a write that fails stops the action,
// every later write is refused, and a file ending in a half-written line is not
// extended. This file adds the two things an operator needs next:
//
//   checkAuditStorage({ file, log })  — is the log healthy? Writes nothing.
//   repairAuditLog({ file, key, user, reason }) — recover from a half-written last line.
//
// A repair never deletes anything and never touches a complete entry. Only the
// damaged END of the file — bytes after the last complete entry — is moved into a
// separate "<file>.damaged-<time>" file, and only after the rest of the chain has
// been checked. Damage anywhere else is refused: that is not a failed write, it is
// tampering or corruption, and it needs a person to look at it.
//
// Why a repair cannot remove an anchored entry: an anchor records a COMPLETE,
// parseable entry, and a repair only removes bytes that are not one.

import {
  readFileSync, writeFileSync, existsSync, accessSync, statfsSync, truncateSync, mkdtempSync, rmSync, constants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { roleAllowed } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { createAuditLog, verifyAuditFile } from './auditLog.js';

export { PermissionDeniedError };
export const REPAIR_ROLES = Object.freeze(['security officer']);

export class AuditRepairRefusedError extends Error {
  constructor(message, options) { super(message, options); this.name = 'AuditRepairRefusedError'; }
}

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isEntry = (line) => {
  try {
    const e = JSON.parse(line);
    return e !== null && typeof e === 'object' && Number.isInteger(e.seq) && typeof e.hash === 'string';
  } catch { return false; }
};

// Splits the file into the complete entries and any damaged end.
function splitTail(text) {
  const lines = text.split('\n');
  // text ending in "\n" gives a final empty string: no partial line.
  let tail = lines.pop();
  // A complete-looking last line that is not an entry counts as damage too.
  while (tail === '' && lines.length && !isEntry(lines.at(-1))) tail = `${lines.pop()}\n`;
  const good = lines.length ? `${lines.join('\n')}\n` : '';
  return { good, damaged: text.slice(good.length) };
}

export function checkAuditStorage({ file, log } = {}) {
  const problems = [];
  const dir = dirname(file);
  let writable = true;
  try {
    accessSync(existsSync(file) ? file : dir, constants.W_OK);
  } catch (err) {
    writable = false;
    problems.push(`cannot write to ${existsSync(file) ? 'the log file' : 'the log folder'}: ${err.code ?? err.message}`);
  }
  let freeBytes = null;
  try {
    const s = statfsSync(existsSync(dir) ? dir : '.');
    freeBytes = s.bavail * s.bsize;
  } catch (err) {
    problems.push(`cannot read free disk space: ${err.code ?? err.message}`);
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const { good, damaged } = splitTail(text);
  if (damaged) problems.push(`the log ends with ${Buffer.byteLength(damaged)} damaged byte(s) after its last complete entry (an interrupted write?)`);
  if (log?.writeFailed) problems.push('a write to the log has failed; every later action is being refused');
  const goodLines = good.split('\n').filter(Boolean);
  const lastSeq = goodLines.length ? JSON.parse(goodLines.at(-1)).seq : 0;
  return { ok: problems.length === 0, writable, freeBytes, lastSeq, tailComplete: !damaged, writeFailed: Boolean(log?.writeFailed), problems };
}

export function repairAuditLog({ file, key, user, reason, roles = REPAIR_ROLES, now = () => new Date() } = {}) {
  // ---- 1. Who, and why? (A refusal cannot be logged into a damaged log; it is reported in the error.) ----
  if (!isNonEmpty(user?.id) || !roleAllowed(user.role, roles)) {
    throw new PermissionDeniedError(`Only ${roles.join(', ')} may repair the audit log (asked by ${user?.id ?? 'no user'}, role "${user?.role ?? 'none'}").`);
  }
  if (!isNonEmpty(reason)) throw new AuditRepairRefusedError('A reason is required to repair the audit log; it is recorded as the decision rationale.');

  // ---- 2. Anything to repair? Repairing twice does nothing the second time. ----
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const { good, damaged } = splitTail(text);
  if (!damaged) return { repaired: false, reason: 'nothing to repair: the log ends with a complete entry' };

  // ---- 3. Is ONLY the end damaged? Check the rest of the chain before touching anything. ----
  const scratch = mkdtempSync(join(tmpdir(), 'audit-repair-'));
  let check;
  try {
    writeFileSync(join(scratch, 'good.jsonl'), good);
    check = verifyAuditFile({ file: join(scratch, 'good.jsonl'), key });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!check.ok) {
    throw new AuditRepairRefusedError(`Refusing to repair: the log is damaged before its end (entry #${check.brokenAt}: ${check.reason}). That is not an interrupted write; a person must investigate.`);
  }

  // ---- 4. Set the damaged bytes aside (never delete them), then cut the file back. ----
  const savedTo = `${file}.damaged-${now().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(savedTo, damaged, { flag: 'wx', mode: 0o600 }); // wx: never overwrite an earlier one
  truncateSync(file, Buffer.byteLength(good));

  // ---- 5. Record the repair as a decision, with its rationale, in the repaired log. ----
  const log = createAuditLog({ file, key, now });
  const entry = log.append({
    correlationId: 'audit-repair',
    actor: { type: 'person', id: user.id },
    action: 'audit.repaired',
    rationale: reason,
    detail: { removedBytes: Buffer.byteLength(damaged), savedTo, lastGoodSeq: check.count },
  });
  return { repaired: true, savedTo, removedBytes: Buffer.byteLength(damaged), lastGoodSeq: check.count, entrySeq: entry.seq };
}
