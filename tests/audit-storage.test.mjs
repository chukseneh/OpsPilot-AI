// Log storage failure: alert, health check and repair (STORY-006). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { checkAuditStorage, repairAuditLog, AuditRepairRefusedError, PermissionDeniedError } from '../src/audit/storage.js';

const SECURITY = { id: 'sec-1', role: 'security officer' };
const actor = { type: 'person', id: 'u-1' };

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'storage-')), 'audit.jsonl');
  const key = randomBytes(32).toString('hex');
  const log = createAuditLog({ file, key });
  log.append({ correlationId: 'c', actor, action: 'a.one' });
  log.append({ correlationId: 'c', actor, action: 'a.two' });
  return { file, key, log };
}

// ---- Failure path: log storage failure ----

test('a full disk: the action is refused, the alert fires once, and later writes are refused too', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'storage-')), 'audit.jsonl');
  const alerts = [];
  let diskFull = false;
  const log = createAuditLog({
    file,
    onWriteFailure: (err) => alerts.push(err.code),
    write: (...args) => { if (diskFull) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); return appendFileSync(...args); },
  });
  log.append({ correlationId: 'c', actor, action: 'a.one' });
  diskFull = true;
  assert.throws(() => log.append({ correlationId: 'c', actor, action: 'a.two' }), AuditWriteError);
  diskFull = false; // the disk recovers, but the tail of the file is unknown: still refused
  assert.throws(() => log.append({ correlationId: 'c', actor, action: 'a.three' }), /an earlier write failed/);
  assert.deepEqual(alerts, ['ENOSPC'], 'alerted once, not on every refused action');
  assert.equal(log.writeFailed, true);
  assert.equal(checkAuditStorage({ file, log }).ok, false);
  assert.match(checkAuditStorage({ file, log }).problems.join(' '), /a write to the log has failed/);
});

test('a broken alert does not hide the write failure', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'storage-')), 'audit.jsonl');
  const log = createAuditLog({ file, onWriteFailure: () => { throw new Error('pager down'); }, write: () => { throw new Error('disk gone'); } });
  assert.throws(() => log.append({ correlationId: 'c', actor, action: 'a.one' }), AuditWriteError);
});

test('the health check reports a healthy log, and a half-written last line, without writing anything', () => {
  const { file, log } = setup();
  const healthy = checkAuditStorage({ file, log });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.writable, true);
  assert.equal(healthy.lastSeq, 2);
  assert.ok(healthy.freeBytes > 0);

  appendFileSync(file, '{"seq":3,"at":"2026-10-08T'); // a write cut off half way
  const before = readFileSync(file, 'utf8');
  const damaged = checkAuditStorage({ file });
  assert.equal(damaged.ok, false);
  assert.equal(damaged.tailComplete, false);
  assert.equal(damaged.lastSeq, 2);
  assert.match(damaged.problems[0], /ends with 26 damaged byte\(s\)/);
  assert.equal(readFileSync(file, 'utf8'), before, 'the check wrote nothing');
});

test('repair: the damaged end is set aside (not deleted), the chain continues, and the repair is logged', () => {
  const { file, key } = setup();
  appendFileSync(file, '{"seq":3,"at":"2026-10-08T');
  assert.throws(() => createAuditLog({ file, key }), /incomplete line/);

  const r = repairAuditLog({ file, key, user: SECURITY, reason: 'Disk filled during the nightly batch; space freed' });
  assert.equal(r.repaired, true);
  assert.equal(r.lastGoodSeq, 2);
  assert.equal(readFileSync(r.savedTo, 'utf8'), '{"seq":3,"at":"2026-10-08T', 'the damaged bytes are kept');

  const log = createAuditLog({ file, key });
  const last = log.readAll().at(-1);
  assert.deepEqual([last.seq, last.action, last.actor.id, last.rationale], [3, 'audit.repaired', 'sec-1', 'Disk filled during the nightly batch; space freed']);
  assert.equal(log.verify().ok, true);
  log.append({ correlationId: 'c', actor, action: 'a.after-repair' });
  assert.equal(log.verify().ok, true);
});

test('repairing twice does nothing the second time', () => {
  const { file, key } = setup();
  appendFileSync(file, 'garbage');
  repairAuditLog({ file, key, user: SECURITY, reason: 'Interrupted write' });
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(repairAuditLog({ file, key, user: SECURITY, reason: 'Interrupted write' }), { repaired: false, reason: 'nothing to repair: the log ends with a complete entry' });
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('damage before the end is refused: that is tampering, not a failed write', () => {
  const { file, key } = setup();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[0]); e.action = 'a.forged'; lines[0] = JSON.stringify(e);
  writeFileSync(file, `${lines.join('\n')}\n{"partial`);
  assert.throws(() => repairAuditLog({ file, key, user: SECURITY, reason: 'x' }),
    (err) => err instanceof AuditRepairRefusedError && /damaged before its end \(entry #1/.test(err.message));
  assert.ok(readFileSync(file, 'utf8').endsWith('{"partial'), 'nothing was changed');
});

test('only a security officer may repair, and only with a reason', () => {
  const { file, key } = setup();
  appendFileSync(file, 'garbage');
  for (const user of [{ id: 'co-1', role: 'compliance officer' }, { id: 'it-1', role: 'IT manager' }, undefined]) {
    assert.throws(() => repairAuditLog({ file, key, user, reason: 'x' }), PermissionDeniedError);
  }
  assert.throws(() => repairAuditLog({ file, key, user: SECURITY, reason: '  ' }), /A reason is required/);
  assert.ok(readFileSync(file, 'utf8').endsWith('garbage'), 'nothing was changed');
  assert.ok(!existsSync(`${file}.damaged`));
});
