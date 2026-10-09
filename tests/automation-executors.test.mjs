// Action executors and the automation failure path (STORY-005). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runAction, createStandInExecutor, createInventoryStatusExecutor, ActionFailedError, AUTOMATION_AGENT,
} from '../src/automation/executors.js';
import { createInventoryService } from '../src/inventory/service.js';
import { openPGlite, migrate, DatabaseUnavailableError } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const fast = { retryDelayMs: 1 };

test('a stand-in runs once per idempotency key, and says it is a stand-in', async () => {
  const notify = createStandInExecutor('notify');
  const a = await runAction(notify, { to: 'owner' }, { idempotencyKey: 'wf-1:step-1', ...fast });
  const b = await runAction(notify, { to: 'owner' }, { idempotencyKey: 'wf-1:step-1', ...fast });
  assert.equal(a.result.standIn, true);
  assert.equal(b.result.repeated, true);
  assert.equal(notify.done().length, 1, 'notified once, not twice');
});

// ---- Failure path: automation failure ----

test('a temporary failure is retried and then succeeds', async () => {
  const ticket = createStandInExecutor('create_ticket', { failTimes: 2 });
  const r = await runAction(ticket, {}, { idempotencyKey: 'k', ...fast });
  assert.equal(r.attempts, 3);
  assert.equal(ticket.done().length, 1);
});

test('retries are capped: a failure that keeps happening gives up with ActionFailedError', async () => {
  const ticket = createStandInExecutor('create_ticket', { failTimes: 10 });
  await assert.rejects(runAction(ticket, {}, { idempotencyKey: 'k', maxAttempts: 3, ...fast }), (err) => {
    assert.ok(err instanceof ActionFailedError);
    assert.equal(err.attempts, 3);
    assert.match(err.message, /create_ticket failed \(gave up after 3 attempts\): TemporaryActionError/);
    return true;
  });
  assert.equal(ticket.calls, 3);
});

test('a permanent failure is not retried', async () => {
  const pay = createStandInExecutor('payment', { fail: 'account closed' });
  await assert.rejects(runAction(pay, {}, { idempotencyKey: 'k', ...fast }),
    (err) => err instanceof ActionFailedError && err.attempts === 1 && /not retried.*account closed/.test(err.message));
  assert.equal(pay.calls, 1);
});

test('an executor that hangs (and ignores the signal) is timed out on every attempt', async () => {
  const hang = createStandInExecutor('notify', { hang: true });
  const started = Date.now();
  await assert.rejects(runAction(hang, {}, { idempotencyKey: 'k', timeoutMs: 20, maxAttempts: 2, ...fast }),
    (err) => err instanceof ActionFailedError && /gave up after 2 attempts\): TemporaryActionError: timed out after 20 ms/.test(err.message));
  assert.ok(Date.now() - started < 2000);
});

test('no executor, or no idempotency key, is refused before anything runs', async () => {
  await assert.rejects(runAction(undefined, {}, { idempotencyKey: 'k' }), /No executor/);
  const notify = createStandInExecutor('notify');
  await assert.rejects(runAction(notify, {}, {}), /idempotency key is required/);
  assert.equal(notify.calls, 0);
});

// ---- The real executor: the STORY-004 inventory ----

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); });
after(async () => { await pg.close(); });

async function inventorySetup() {
  await pg.exec('TRUNCATE ai_systems');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'exec-')), 'audit.jsonl') });
  const inventory = createInventoryService({ db: pg, audit });
  await inventory.registerSystem({ user: { id: 'it-1', role: 'IT manager' }, system: {
    id: 'ai-chat', name: 'Help-desk chatbot', department: 'Support', purpose: 'Answers IT questions', owner: 'it-support-1',
    status: 'active', dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: true,
  } });
  return { audit, inventory, executor: createInventoryStatusExecutor({ inventory }) };
}

test('the inventory executor changes a status as the automation agent, once', async () => {
  const { audit, inventory, executor } = await inventorySetup();
  const params = { systemId: 'ai-chat', status: 'paused', expectedVersion: 1, reason: 'Workflow wf-1' };
  const first = await runAction(executor, params, { idempotencyKey: 'wf-1:step-2', ...fast });
  const again = await runAction(executor, params, { idempotencyKey: 'wf-1:step-2', ...fast });
  assert.deepEqual(first.result, { systemId: 'ai-chat', status: 'paused', version: 2, changed: true });
  assert.equal(again.result.changed, false, 'a repeat changes nothing');
  assert.equal((await inventory.listSystems({ user: { id: 'it-1', role: 'IT manager' } })).systems[0].version, 2);

  const change = audit.readAll().find((e) => e.action === 'inventory.status_changed');
  assert.equal(change.actor.id, AUTOMATION_AGENT.id);
  assert.equal(change.correlationId, 'wf-1:step-2');
});

test('if the system changed while the action waited, the inventory refuses and the action fails (not retried)', async () => {
  const { inventory, executor } = await inventorySetup();
  await inventory.updateStatus({ user: { id: 'it-1', role: 'IT manager' }, systemId: 'ai-chat', status: 'paused', expectedVersion: 1, reason: 'test' });
  await assert.rejects(
    runAction(executor, { systemId: 'ai-chat', status: 'retired', expectedVersion: 1 }, { idempotencyKey: 'wf-2:step-1', ...fast }),
    (err) => err instanceof ActionFailedError && err.attempts === 1 && /InventoryConflictError/.test(err.message),
  );
});

test('a briefly unreachable database is retried', async () => {
  let calls = 0;
  const flaky = { updateStatus: async () => {
    calls += 1;
    if (calls === 1) throw new DatabaseUnavailableError('lost the connection');
    return { system: { id: 'ai-chat', status: 'paused', version: 2 }, changed: true };
  } };
  const r = await runAction(createInventoryStatusExecutor({ inventory: flaky }), { systemId: 'ai-chat', status: 'paused', expectedVersion: 1 }, { idempotencyKey: 'k', ...fast });
  assert.equal(r.attempts, 2);
});
