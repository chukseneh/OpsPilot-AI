// Audit log anchors in PostgreSQL (STORY-006). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';

import { createAuditLog } from '../src/audit/auditLog.js';
import { createAuditAnchors, migrateAnchors } from '../src/audit/anchors.js';
import { openPGlite } from '../src/inventory/db.js';

const actor = { type: 'person', id: 'u-1' };
const newKey = () => randomBytes(32).toString('hex');

let pg;
before(async () => { pg = await openPGlite(); await migrateAnchors(pg); });
after(async () => { await pg.close(); });

let n = 0;
function setup({ entries = 3 } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'anchors-')), 'audit.jsonl');
  const key = newKey();
  const log = createAuditLog({ file, key });
  for (let i = 1; i <= entries; i += 1) log.append({ correlationId: 'c', actor, action: `a.${i}`, rationale: `r${i}` });
  n += 1;
  const anchors = createAuditAnchors({ db: pg, file, key, logId: `log-${n}` });
  return { file, key, log, anchors, logId: `log-${n}` };
}
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n');

test('anchoring records the log end once; a second anchor with nothing new writes nothing', async () => {
  const { anchors, log } = setup();
  assert.deepEqual(await anchors.anchor(), { anchored: true, seq: 3 });
  assert.deepEqual(await anchors.anchor(), { anchored: false, seq: 3, reason: 'nothing new since the last anchor' });
  log.append({ correlationId: 'c', actor, action: 'a.4' });
  assert.deepEqual(await anchors.verify(), { ok: true, count: 4, anchors: 1, lastAnchoredSeq: 3, unanchored: 1 });
  assert.deepEqual(await anchors.anchor(), { anchored: true, seq: 4 });
});

// ---- Failure path: log tampering ----

test('THE GAP THIS CLOSES: cutting off the last entries is caught', async () => {
  const { file, key, anchors } = setup({ entries: 5 });
  await anchors.anchor();
  writeFileSync(file, `${lines(file).slice(0, 3).join('\n')}\n`); // remove #4 and #5
  const { verifyAuditFile } = await import('../src/audit/auditLog.js');
  assert.equal(verifyAuditFile({ file, key }).ok, true, 'the chain alone cannot tell');
  const v = await anchors.verify();
  assert.equal(v.ok, false);
  assert.match(v.reason, /entries after #3 were removed: an anchor shows the log had reached #5/);
});

test('an insider WITH the key rewrites history and recomputes a perfect chain: only the anchor catches it', async () => {
  const { file, key, anchors } = setup();
  await anchors.anchor();
  // Rewrite entry #2 and re-sign #2 and #3 with the real key.
  const all = lines(file).map((l) => JSON.parse(l));
  all[1].rationale = 'forged by an insider';
  let prev = all[0].hash;
  for (const e of all.slice(1)) {
    e.prevHash = prev;
    const { hash, ...rest } = e;
    const ordered = { seq: rest.seq, at: rest.at, correlationId: rest.correlationId, actor: rest.actor, action: rest.action, subject: rest.subject, rationale: rest.rationale, detail: rest.detail, prevHash: rest.prevHash, alg: rest.alg };
    e.hash = createHmac('sha256', key).update(JSON.stringify(ordered)).digest('hex');
    prev = e.hash;
  }
  writeFileSync(file, `${all.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const { verifyAuditFile } = await import('../src/audit/auditLog.js');
  assert.equal(verifyAuditFile({ file, key }).ok, true, 'the chain alone is fooled');
  const v = await anchors.verify();
  assert.equal(v.ok, false);
  assert.match(v.reason, /entry #3 does not match its anchor: the log was rewritten from there/);
});

test('a forged anchor (inserted without the key) is caught', async () => {
  const { anchors, logId } = setup();
  await anchors.anchor();
  await pg.query("INSERT INTO audit_anchors (log_id, seq, hash, signature) VALUES ($1, 9, $2, 'not-a-real-signature')", [logId, 'a'.repeat(64)]);
  const v = await anchors.verify();
  assert.equal(v.ok, false);
  assert.match(v.reason, /anchor at #9 has an invalid signature/);
});

test('the database refuses to change or delete an anchor', async () => {
  const { anchors, logId } = setup();
  await anchors.anchor();
  await assert.rejects(pg.query('UPDATE audit_anchors SET seq = 1 WHERE log_id = $1', [logId]), /append-only: UPDATE is not allowed/);
  await assert.rejects(pg.query('DELETE FROM audit_anchors WHERE log_id = $1', [logId]), /append-only: DELETE is not allowed/);
  await assert.rejects(pg.exec('TRUNCATE audit_anchors'), /append-only: TRUNCATE is not allowed/);
  assert.equal((await anchors.verify()).ok, true);
});

test('a tampered log is never anchored (that would vouch for the tampering)', async () => {
  const { file, anchors } = setup({ entries: 4 });
  await anchors.anchor();
  writeFileSync(file, `${lines(file).slice(0, 2).join('\n')}\n`);
  const r = await anchors.anchor();
  assert.equal(r.anchored, false);
  assert.equal(r.tampered, true);
});

test('anchors need the key', () => {
  assert.throws(() => createAuditAnchors({ db: pg, file: 'x', key: 'short' }), /need the audit log key/);
});

test('the timer anchors on its own, reports tampering to the log and to onError, and carries on after a failure', async () => {
  const { file, log, anchors } = setup();
  const t = { fn: null };
  const timers = { setInterval: (fn) => { t.fn = fn; return {}; }, clearInterval: () => {} };
  const heard = [];
  const timer = anchors.startTimer({ audit: log, timers, onError: (m) => heard.push(m) });

  assert.deepEqual(await t.fn(), { anchored: true, seq: 3 });
  // Now cut the tail: the next tick finds it.
  writeFileSync(file, `${lines(file).slice(0, 1).join('\n')}\n`);
  const r = await t.fn();
  assert.equal(r.tampered, true);
  assert.match(heard[0], /Anchoring refused: entries after #1 were removed/);
  assert.deepEqual(timer.stats, { anchored: 1, unchanged: 0, failed: 1 });
  await timer.stop();
});

test('a database failure while anchoring is reported and the timer carries on', async () => {
  const { file, key, log } = setup();
  let down = true;
  const flaky = { query: (...a) => (down ? Promise.reject(new Error('connection refused')) : pg.query(...a)) };
  const anchors = createAuditAnchors({ db: flaky, file, key, logId: 'flaky' });
  const t = { fn: null };
  const timer = anchors.startTimer({ audit: log, timers: { setInterval: (fn) => { t.fn = fn; return {}; }, clearInterval() {} }, onError: () => {} });
  assert.equal(await t.fn(), null);
  assert.match(log.readAll().at(-1).rationale, /Could not anchor the audit log; will try again in 300 s: Error: connection refused/);
  down = false;
  assert.equal((await t.fn()).anchored, true);
  await timer.stop();
});
