// Starting OpsPilot securely (STORY-006). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

test('documents: an upload through the started system is extracted, its file kept, logged in the KEYED log, and still there after a restart', async () => {
  const env = envFor();
  const PM = { id: 'pm-1', role: 'process manager' };
  const ANALYST = { id: 'fa-1', role: 'financial analyst' };
  const invoice = new TextEncoder().encode('Invoice number: INV-1\nSupplier: Contoso\nInvoice date: 2026-09-01\nDue date: 2026-09-30\nTotal: 120.00 GBP\n');

  const first = await startOpsPilot({ env, timers });
  let doc;
  try {
    doc = await first.services.documents.uploadDocument({ user: PM, fileName: 'inv-1.txt', bytes: invoice });
    assert.equal(doc.status, 'extracted');
    assert.equal(doc.fields.total.value, 120);
    const logged = first.audit.readAll().filter((e) => e.action.startsWith('document.'));
    assert.deepEqual(logged.map((e) => e.action), ['document.uploaded', 'document.extracted']);
    assert.ok(logged.every((e) => e.alg === 'hmac-sha256'), 'document entries are signed with the key');
  } finally {
    await first.stop();
  }
  assert.ok(existsSync(join(dirname(env.AUDIT_LOG_FILE), 'documents', doc.sha256)), 'the file is kept beside the log by default');

  const second = await startOpsPilot({ env, timers });
  try {
    const again = await second.services.documents.getDocument({ user: ANALYST, documentId: doc.id });
    assert.deepEqual([again.status, again.fields.invoice_number.value], ['extracted', 'INV-1']);
    const repeat = await second.services.documents.uploadDocument({ user: PM, fileName: 'inv-1.txt', bytes: invoice });
    assert.equal(repeat.id, doc.id, 'a repeat upload after a restart is still recognised');
    assert.equal((await second.anchors.verify()).ok, true);
  } finally {
    await second.stop();
  }
});

test('DOCUMENTS_DIR puts uploaded files somewhere else', async () => {
  const env = { ...envFor(), DOCUMENTS_DIR: join(mkdtempSync(join(tmpdir(), 'opspilot-docs-')), 'store') };
  const system = await startOpsPilot({ env, timers });
  try {
    const doc = await system.services.documents.uploadDocument({ user: { id: 'pm-1', role: 'process manager' }, fileName: 'a.txt', bytes: new TextEncoder().encode('Total: 1.00 GBP') });
    assert.ok(existsSync(join(env.DOCUMENTS_DIR, doc.sha256)));
  } finally {
    await system.stop();
  }
});

test('ROI: a calculation through the started system is saved, logged with its assumptions in the KEYED log, and kept across a restart', async () => {
  const env = envFor();
  const ANALYST = { id: 'fa-1', role: 'financial analyst' };
  const assumptions = {
    name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
    timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32 }],
    costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800 }] },
    uncertainty: { savings: 0.2, costs: 0.1 },
  };
  const first = await startOpsPilot({ env, timers });
  try {
    const s = await first.services.roi.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-1', assumptions });
    assert.equal(s.status, 'ok');
    const entry = first.audit.readAll().find((e) => e.action === 'roi.calculated');
    assert.deepEqual(entry.detail.assumptions, assumptions);
    assert.equal(entry.alg, 'hmac-sha256');
  } finally {
    await first.stop();
  }
  const second = await startOpsPilot({ env, timers });
  try {
    assert.equal((await second.services.roi.getRoiScenario({ user: ANALYST, scenarioId: 'ROI-1' })).result.expected.annualSavings, 1536000);
  } finally {
    await second.stop();
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
