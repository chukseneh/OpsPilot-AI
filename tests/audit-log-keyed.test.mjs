// Keyed (HMAC) audit log hashes (STORY-006). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { createAuditLog, openAuditLogFromEnv, verifyAuditFile, AuditWriteError, GENESIS_HASH } from '../src/audit/auditLog.js';

const newKey = () => randomBytes(32).toString('hex'); // a throwaway key per test, never committed
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'audit-keyed-')), 'audit.jsonl');
const actor = { type: 'person', id: 'u-1' };

function writeThree(log) {
  log.append({ correlationId: 'c', actor, action: 'a.one', rationale: 'first' });
  log.append({ correlationId: 'c', actor, action: 'a.two', rationale: 'second' });
  log.append({ correlationId: 'c', actor, action: 'a.three', rationale: 'third' });
}

// What an attacker without the key would do: edit an entry, then recompute every
// hash after it so the chain links up again. With plain SHA-256 this works.
function rewriteFrom(file, seq, change, hashWith) {
  const entries = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let prev = seq > 1 ? entries[seq - 2].hash : GENESIS_HASH;
  for (const e of entries.slice(seq - 1)) {
    if (e.seq === seq) change(e);
    e.prevHash = prev;
    const { hash, ...rest } = e;
    const ordered = { seq: rest.seq, at: rest.at, correlationId: rest.correlationId, actor: rest.actor, action: rest.action, subject: rest.subject, rationale: rest.rationale, detail: rest.detail, prevHash: rest.prevHash, ...(rest.alg ? { alg: rest.alg } : {}) };
    e.hash = hashWith(JSON.stringify(ordered));
    prev = e.hash;
  }
  writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

test('a keyed log marks every entry hmac-sha256 and verifies with its key', () => {
  const file = tmpFile();
  const key = newKey();
  const log = createAuditLog({ file, key });
  writeThree(log);
  assert.ok(log.readAll().every((e) => e.alg === 'hmac-sha256'));
  assert.deepEqual(log.verify(), { ok: true, count: 3, keyed: true });
  // Reopening with the same key continues the same chain.
  createAuditLog({ file, key }).append({ correlationId: 'c', actor, action: 'a.four' });
  assert.deepEqual(createAuditLog({ file, key }).verify(), { ok: true, count: 4, keyed: true });
});

// ---- Failure path: log tampering ----

test('THE GAP THIS CLOSES: a plain-hash log can be rewritten so verify() still passes', () => {
  const file = tmpFile();
  writeThree(createAuditLog({ file }));
  rewriteFrom(file, 2, (e) => { e.rationale = 'forged'; }, (text) => createHash('sha256').update(text).digest('hex'));
  const v = createAuditLog({ file }).verify();
  assert.equal(v.ok, true, 'an unkeyed chain cannot tell');
  assert.equal(v.keyed, false, '…and says so: it was not checked with a key');
});

test('a keyed log catches the same rewrite, even with every later hash recomputed', () => {
  const file = tmpFile();
  const key = newKey();
  writeThree(createAuditLog({ file, key }));
  const attackerKey = newKey(); // the attacker does not have the real key
  rewriteFrom(file, 2, (e) => { e.rationale = 'forged'; }, (text) => createHmac('sha256', attackerKey).update(text).digest('hex'));
  // A read-only check finds the first forged entry …
  const checked = verifyAuditFile({ file, key });
  assert.deepEqual([checked.ok, checked.brokenAt, checked.reason, checked.keyed], [false, 2, 'entry was changed after it was written', true]);
  // … and nothing more is ever written onto it.
  assert.throws(() => createAuditLog({ file, key }), /does not match this key/);
});

test('the same edit without recomputing is caught too', () => {
  const file = tmpFile();
  const key = newKey();
  writeThree(createAuditLog({ file, key }));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[0]); e.actor.id = 'someone-else'; lines[0] = JSON.stringify(e);
  writeFileSync(file, `${lines.join('\n')}\n`);
  assert.equal(verifyAuditFile({ file, key }).brokenAt, 1);
});

test('a keyed log is never opened with the wrong key, or with none; a plain log is never opened with a key', () => {
  const file = tmpFile();
  writeThree(createAuditLog({ file, key: newKey() }));
  assert.throws(() => createAuditLog({ file, key: newKey() }), /does not match this key/);
  assert.throws(() => createAuditLog({ file }), /uses hmac-sha256 hashes but was opened without a key/);

  const plain = tmpFile();
  writeThree(createAuditLog({ file: plain }));
  assert.throws(() => createAuditLog({ file: plain, key: newKey() }), /uses sha256 hashes but was opened with a key/);
});

test('a key that is too short, or not text, is refused', () => {
  for (const key of ['short', '', 12345, null]) {
    assert.throws(() => createAuditLog({ file: tmpFile(), key }), (err) => err instanceof AuditWriteError && /at least 32 characters/.test(err.message));
  }
});

test('the key never appears in the log file or in any error', () => {
  const file = tmpFile();
  const key = newKey();
  writeThree(createAuditLog({ file, key }));
  assert.ok(!readFileSync(file, 'utf8').includes(key));
  for (const attempt of [() => createAuditLog({ file, key: `${key}x` }), () => createAuditLog({ file })]) {
    try { attempt(); assert.fail('should have thrown'); } catch (err) { assert.ok(!err.message.includes(key)); }
  }
});

test('production opens only with AUDIT_LOG_KEY set', () => {
  assert.throws(() => openAuditLogFromEnv({ file: tmpFile(), env: {} }), /AUDIT_LOG_KEY is not set/);
  assert.throws(() => openAuditLogFromEnv({ file: tmpFile(), env: { AUDIT_LOG_KEY: 'too-short' } }), /at least 32 characters/);
  const log = openAuditLogFromEnv({ file: tmpFile(), env: { AUDIT_LOG_KEY: newKey() } });
  log.append({ correlationId: 'c', actor, action: 'a.one' });
  assert.equal(log.verify().keyed, true);
});

test('unkeyed logs keep working exactly as before, and say they are unkeyed', () => {
  const file = tmpFile();
  const log = createAuditLog({ file });
  writeThree(log);
  assert.ok(log.readAll().every((e) => e.alg === undefined), 'plain entries carry no alg field');
  assert.deepEqual(log.verify(), { ok: true, count: 3, keyed: false });
});

test('checking a keyed log without the key, or a plain log with one, reports the mismatch', () => {
  const file = tmpFile();
  writeThree(createAuditLog({ file, key: newKey() }));
  assert.match(verifyAuditFile({ file }).reason, /entry uses hmac-sha256 hashes; this check uses sha256/);
});
