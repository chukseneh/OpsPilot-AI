// Starting OpsPilot securely (STORY-006). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { startOpsPilot, StartupRefusedError } from '../src/system.js';

const IT = { id: 'it-1', role: 'IT manager' };
const SECURITY = { id: 'sec-1', role: 'security officer' };
const chat = {
  id: 'ai-chat', name: 'Help-desk chatbot', department: 'Support', purpose: 'Answers IT questions', owner: 'it-support-1',
  status: 'active', dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: true,
};
// Timers that never fire on their own, so tests decide when things happen.
const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
const timers = { approvals: idle, anchors: idle };

function envFor() {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-system-'));
  return { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl') };
}
const refused = (pattern) => (err) => err instanceof StartupRefusedError && pattern.test(err.message);

test('refuses to start without the key, with a short key, or with no database', async () => {
  const env = envFor();
  await assert.rejects(startOpsPilot({ env: { ...env, AUDIT_LOG_KEY: undefined }, timers }), refused(/AUDIT_LOG_KEY is not set/));
  await assert.rejects(startOpsPilot({ env: { ...env, AUDIT_LOG_KEY: 'too-short' }, timers }), refused(/at least 32 characters/));
  await assert.rejects(startOpsPilot({ env: { AUDIT_LOG_KEY: env.AUDIT_LOG_KEY }, timers }), refused(/No database is configured/));
});

test('a full start: every action lands in the KEYED log, the start is anchored, and the services work', async () => {
  const env = envFor();
  const system = await startOpsPilot({ env, timers });
  try {
    await system.services.inventory.registerSystem({ user: IT, system: chat, reason: 'Initial load' });
    await system.services.inventory.updateStatus({ user: IT, systemId: 'ai-chat', status: 'paused', expectedVersion: 1, reason: 'Retraining' });

    const all = system.audit.readAll();
    assert.ok(all.every((e) => e.alg === 'hmac-sha256'), 'every entry is signed with the key');
    assert.deepEqual(all.map((e) => e.action), ['system.started', 'inventory.registered', 'inventory.status_changed']);

    const integrity = await system.anchors.verify();
    assert.equal(integrity.ok, true);
    assert.equal(integrity.lastAnchoredSeq, 1, 'the start was anchored');

    const read = await system.services.auditReader.readAuditLog({ user: SECURITY });
    assert.deepEqual([read.integrity.ok, read.integrity.keyed, read.integrity.anchored], [true, true, true]);
  } finally {
    await system.stop();
  }
});

test('stop anchors the final state and is safe twice; a restart continues the same chain', async () => {
  const env = envFor();
  const first = await startOpsPilot({ env, timers });
  await first.services.inventory.registerSystem({ user: IT, system: chat, reason: 'Initial load' });
  await Promise.all([first.stop(), first.stop()]);

  const second = await startOpsPilot({ env, timers });
  try {
    const all = second.audit.readAll();
    assert.deepEqual(all.map((e) => e.action), ['system.started', 'inventory.registered', 'system.stopped', 'system.started']);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);
    const v = await second.anchors.verify();
    assert.equal(v.ok, true);
    assert.equal(v.lastAnchoredSeq, 4);
    // The database persisted too.
    assert.equal((await second.services.inventory.listSystems({ user: IT })).systems.length, 1);
  } finally {
    await second.stop();
  }
});

test('refuses to start on a tampered log (entries cut off after shutdown)', async () => {
  const env = envFor();
  const first = await startOpsPilot({ env, timers });
  await first.services.inventory.registerSystem({ user: IT, system: chat, reason: 'Initial load' });
  await first.stop();
  const lines = readFileSync(env.AUDIT_LOG_FILE, 'utf8').trim().split('\n');
  writeFileSync(env.AUDIT_LOG_FILE, `${lines.slice(0, 2).join('\n')}\n`); // remove "system.stopped"
  await assert.rejects(startOpsPilot({ env, timers }), refused(/does not match its anchors: entries after #2 were removed.*a person must investigate/));
});

test('refuses to start on an edited log, and on the wrong key', async () => {
  const env = envFor();
  await (await startOpsPilot({ env, timers })).stop();
  await assert.rejects(startOpsPilot({ env: { ...env, AUDIT_LOG_KEY: randomBytes(32).toString('hex') }, timers }), refused(/could not be opened: .*does not match this key/));

  const lines = readFileSync(env.AUDIT_LOG_FILE, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[0]); e.actor.id = 'someone-else'; lines[0] = JSON.stringify(e);
  writeFileSync(env.AUDIT_LOG_FILE, `${lines.join('\n')}\n`);
  await assert.rejects(startOpsPilot({ env, timers }), refused(/does not match its anchors: the chain is broken/));
});

test('refuses to start on a half-written log, and points to the repair', async () => {
  const env = envFor();
  await (await startOpsPilot({ env, timers })).stop();
  appendFileSync(env.AUDIT_LOG_FILE, '{"seq":3,"at":');
  await assert.rejects(startOpsPilot({ env, timers }), refused(/not healthy: the log ends with \d+ damaged byte.*repairAuditLog/));
});

test('the key never appears in any refusal', async () => {
  const env = envFor();
  await (await startOpsPilot({ env, timers })).stop();
  const otherKey = randomBytes(32).toString('hex');
  for (const bad of [{ ...env, AUDIT_LOG_KEY: otherKey }, { AUDIT_LOG_KEY: env.AUDIT_LOG_KEY }]) {
    try { await startOpsPilot({ env: bad, timers }); assert.fail('should refuse'); } catch (err) {
      assert.ok(!err.message.includes(env.AUDIT_LOG_KEY) && !err.message.includes(otherKey));
    }
  }
});

test('only the real executor is wired by default: a stand-in action type fails cleanly', async () => {
  const env = envFor();
  const system = await startOpsPilot({ env, timers });
  try {
    const wf = await system.services.workflows.startWorkflow({ user: { id: 'pm-1', role: 'process manager' }, workflowId: 'WF-1', name: 'Notify', actions: [{ type: 'notify', params: {} }] });
    assert.equal(wf.run.status, 'failed');
    assert.match(wf.actions[0].error, /No executor/);
  } finally {
    await system.stop();
  }
});
