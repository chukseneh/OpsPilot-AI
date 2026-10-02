// Audit log checks (REQ-008). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuditLog, AuditWriteError, GENESIS_HASH } from '../src/audit/auditLog.js';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
const event = (action, extra = {}) => ({
  correlationId: 'op-1', actor: { type: 'system', id: 'orchestrator' }, action, ...extra,
});

test('entries are numbered and chained, and the chain verifies', () => {
  const log = createAuditLog({ file: tempFile() });
  const a = log.append(event('operation.started'));
  const b = log.append(event('task.assigned', { subject: 'task-1', rationale: 'agent has the process capability' }));
  assert.equal(a.seq, 1);
  assert.equal(a.prevHash, GENESIS_HASH);
  assert.equal(b.seq, 2);
  assert.equal(b.prevHash, a.hash);
  assert.equal(b.rationale, 'agent has the process capability');
  assert.deepEqual(log.verify(), { ok: true, count: 2 });
});

test('a reopened log continues the same chain', () => {
  const file = tempFile();
  const first = createAuditLog({ file }).append(event('operation.started'));
  const second = createAuditLog({ file }).append(event('operation.completed'));
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  assert.equal(createAuditLog({ file }).verify().ok, true);
});

test('editing a past entry is detected', () => {
  const file = tempFile();
  const log = createAuditLog({ file });
  log.append(event('task.assigned', { detail: { agentId: 'agent-a' } }));
  log.append(event('task.completed'));
  writeFileSync(file, readFileSync(file, 'utf8').replace('agent-a', 'agent-z'));
  const result = log.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
});

test('deleting a past entry is detected', () => {
  const file = tempFile();
  const log = createAuditLog({ file });
  log.append(event('one'));
  log.append(event('two'));
  log.append(event('three'));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, `${lines[0]}\n${lines[2]}\n`);
  assert.equal(log.verify().ok, false);
});

test('an entry missing who, what or which operation is refused and not written', () => {
  const file = tempFile();
  const log = createAuditLog({ file });
  assert.throws(() => log.append({ action: 'task.assigned' }), AuditWriteError);
  assert.throws(() => log.append({ correlationId: 'op-1', actor: { type: 'agent' }, action: 'x' }), /actor/);
  assert.deepEqual(log.readAll(), []);
});

test('a write that fails throws, so the caller cannot carry on unrecorded', () => {
  // The log opens fine, but its folder path runs through a file, so the write cannot land.
  const blocker = join(mkdtempSync(join(tmpdir(), 'audit-')), 'not-a-folder');
  writeFileSync(blocker, '');
  const log = createAuditLog({ file: join(blocker, 'audit.jsonl') });
  assert.throws(() => log.append(event('operation.started')), (err) => err instanceof AuditWriteError && Boolean(err.cause));
  assert.deepEqual(log.readAll(), []);
});

test('a log that cannot be opened fails with AuditWriteError, not a raw system error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  assert.throws(() => createAuditLog({ file: dir }), AuditWriteError);
});

test('credential-like fields are redacted before they reach the log', () => {
  const file = tempFile();
  createAuditLog({ file }).append(event('connector.called', {
    detail: { endpoint: '/me/messages', accessToken: 'eyJ-real-looking', nested: { apiKey: 'k-123', page: 2 } },
  }));
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('eyJ-real-looking'));
  assert.ok(!text.includes('k-123'));
  assert.match(text, /"page":2/);
});
