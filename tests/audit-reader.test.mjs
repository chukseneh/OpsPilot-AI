// Reading the audit log: access control, filters, integrity, and the record of the read (STORY-006). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createAuditLog } from '../src/audit/auditLog.js';
import { createAuditReader, PermissionDeniedError, AuditReadRequestError, MAX_PAGE_SIZE } from '../src/audit/reader.js';
import { createAuditAnchors, migrateAnchors } from '../src/audit/anchors.js';
import { openPGlite } from '../src/inventory/db.js';

const SECURITY = { id: 'sec-1', role: 'Security_Officer' };
const COMPLIANCE = { id: 'co-1', role: 'compliance officer' };

let pg;
before(async () => { pg = await openPGlite(); await migrateAnchors(pg); });
after(async () => { await pg.close(); });

let n = 0;
function setup({ withAnchors = false } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'reader-')), 'audit.jsonl');
  const key = randomBytes(32).toString('hex');
  const log = createAuditLog({ file, key });
  const at = (who, action, extra = {}) => log.append({ correlationId: extra.c ?? 'WF-1', actor: { type: 'person', id: who }, action, ...extra });
  at('pm-1', 'workflow.started');
  at('pm-2', 'workflow.action_approved', { rationale: 'Invoice checked' });
  at('it-1', 'inventory.status_changed', { c: 'inventory:ai-x', rationale: 'Bias review' });
  at('pm-1', 'workflow.completed');
  n += 1;
  const anchors = withAnchors ? createAuditAnchors({ db: pg, file, key, logId: `reader-${n}` }) : undefined;
  const reader = createAuditReader({ audit: log, file, key, anchors });
  return { file, key, log, anchors, reader };
}

test('a security officer reads the whole log, with integrity confirmed', async () => {
  const { reader } = setup();
  const r = await reader.readAuditLog({ user: SECURITY });
  assert.equal(r.entries.length, 4);
  assert.deepEqual(r.integrity, { ok: true, keyed: true, anchored: false });
  assert.equal(r.nextAfter, null);
});

test('filters by request, actor, action (or action prefix) and time', async () => {
  const { reader } = setup();
  const ids = async (filter) => (await reader.readAuditLog({ user: COMPLIANCE, filter })).entries.map((e) => e.seq);
  assert.deepEqual(await ids({ correlationId: 'inventory:ai-x' }), [3]);
  assert.deepEqual(await ids({ actorId: 'pm-1' }), [1, 4]);
  assert.deepEqual(await ids({ action: 'workflow.action_approved' }), [2]);
  assert.deepEqual(await ids({ action: 'workflow.' }), [1, 2, 4]);
  assert.deepEqual(await ids({ to: '2000-01-01T00:00:00Z' }), []);
});

test('pages are capped and continue where the last one stopped', async () => {
  const { reader } = setup();
  const p1 = await reader.readAuditLog({ user: SECURITY, page: { limit: 2 } });
  assert.deepEqual(p1.entries.map((e) => e.seq), [1, 2]);
  const p2 = await reader.readAuditLog({ user: SECURITY, page: { limit: 2, after: p1.nextAfter } });
  assert.deepEqual(p2.entries.map((e) => e.seq).slice(0, 2), [3, 4]);
  await assert.rejects(reader.readAuditLog({ user: SECURITY, page: { limit: MAX_PAGE_SIZE + 1 } }), AuditReadRequestError);
  await assert.rejects(reader.readAuditLog({ user: SECURITY, filter: { password: 'x' } }), /unknown filter field/);
  await assert.rejects(reader.readAuditLog({ user: SECURITY, filter: { from: 'yesterday' } }), /ISO 8601/);
});

test('every read is itself logged: who, which filter, how many', async () => {
  const { reader, log } = setup();
  await reader.readAuditLog({ user: COMPLIANCE, filter: { actorId: 'pm-1' } });
  const read = log.readAll().at(-1);
  assert.equal(read.action, 'audit.read');
  assert.equal(read.actor.id, 'co-1');
  assert.deepEqual(read.detail.filter, { actorId: 'pm-1' });
  assert.equal(read.detail.returned, 2);
});

test('what a reader is given is a copy: changing it does not change the log', async () => {
  const { reader, log } = setup();
  const r = await reader.readAuditLog({ user: SECURITY });
  r.entries[1].rationale = 'changed by the reader';
  assert.equal(log.readAll()[1].rationale, 'Invoice checked');
  assert.equal(log.verify().ok, true);
});

// ---- Failure path: unauthorized log access ----

test('any other role is refused, and the refusal is logged with its reason', async () => {
  const { reader, log } = setup();
  for (const role of ['process manager', 'IT manager', 'operations manager', 'process analyst']) {
    await assert.rejects(reader.readAuditLog({ user: { id: `u-${role}`, role } }), PermissionDeniedError);
  }
  await assert.rejects(reader.readAuditLog({}), PermissionDeniedError);
  const denied = log.readAll().filter((e) => e.action === 'audit.read_denied');
  assert.equal(denied.length, 5);
  assert.match(denied[0].rationale, /may not read the audit log; allowed roles: security officer, compliance officer/);
  assert.equal(denied.at(-1).actor.id, 'unknown-requester');
  assert.ok(!log.readAll().some((e) => e.action === 'audit.read'), 'no read happened');
});

// ---- Failure path: log tampering, surfaced to the reader ----

test('a tampered log is shown with a warning, and the finding is logged', async () => {
  const { file, reader, log } = setup();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[1]); e.rationale = 'forged'; lines[1] = JSON.stringify(e);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const r = await reader.readAuditLog({ user: SECURITY });
  assert.equal(r.integrity.ok, false);
  assert.equal(r.integrity.brokenAt, 2);
  assert.match(r.integrity.warning, /tampered with or damaged: entry was changed after it was written/);
  assert.equal(r.entries.length, 4, 'still shown, so the auditor can see what was done');
  assert.ok(log.readAll().some((x) => x.action === 'audit.tampering_detected'));
});

test('with anchors, a cut-off tail is reported to the reader', async () => {
  const { file, anchors, reader } = setup({ withAnchors: true });
  await anchors.anchor();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`);
  const r = await reader.readAuditLog({ user: SECURITY });
  assert.equal(r.integrity.anchored, true);
  assert.equal(r.integrity.ok, false);
  assert.match(r.integrity.warning, /entries after #2 were removed/);
});

test('the log file is created readable and writable by its owner only (Linux/macOS)', { skip: process.platform === 'win32' && 'Windows does not use POSIX permission bits' }, () => {
  const { file } = setup();
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
