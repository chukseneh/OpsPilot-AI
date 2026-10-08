// The approval-delay timer (STORY-005). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowEngine, migrateWorkflows } from '../src/automation/workflows.js';
import { createStandInExecutor } from '../src/automation/executors.js';
import { openPGlite, migrate } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const HOUR = 60 * 60 * 1000;
const PM = { id: 'pm-1', role: 'process manager' };

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); await migrateWorkflows(pg); });
after(async () => { await pg.close(); });

// Timers the test drives by hand: fire() runs what setInterval was given.
function fakeTimers() {
  const t = { fn: null, every: null, cleared: false };
  return {
    t,
    timers: {
      setInterval: (fn, ms) => { t.fn = fn; t.every = ms; return { unref() {} }; },
      clearInterval: () => { t.cleared = true; },
    },
    fire: () => t.fn(),
  };
}

async function setup({ db = pg } = {}) {
  await pg.exec('TRUNCATE workflow_actions, workflow_runs');
  let now = Date.parse('2026-10-08T09:00:00Z');
  const clock = { now: () => new Date(now), advance: (ms) => { now += ms; } };
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'timer-')), 'audit.jsonl'), now: clock.now });
  const executors = { notify: createStandInExecutor('notify'), payment: createStandInExecutor('payment') };
  const engine = createWorkflowEngine({ db, audit, executors, now: clock.now, runOptions: { retryDelayMs: 1 } });
  if (db === pg) {
    await engine.startWorkflow({ user: PM, workflowId: 'WF-T', name: 'Pay', actions: [{ type: 'payment', params: { amount: 5000 } }] });
  }
  return { audit, engine, clock, executors };
}

test('runs every 5 minutes by default, and escalates then expires with nobody calling the sweep', async () => {
  const { engine, clock, audit, executors } = await setup();
  const ft = fakeTimers();
  const timer = engine.startApprovalTimer({ timers: ft.timers });
  assert.equal(ft.t.every, 5 * 60 * 1000);

  clock.advance(5 * HOUR);
  assert.deepEqual(await ft.fire(), { escalated: ['WF-T:1'], expired: [] });
  clock.advance(20 * HOUR);
  assert.deepEqual(await ft.fire(), { escalated: [], expired: ['WF-T:1'] });

  assert.equal((await engine.getWorkflow('WF-T')).run.status, 'expired');
  assert.equal(executors.payment.calls, 0);
  const actions = audit.readAll().map((e) => e.action);
  assert.ok(actions.includes('workflow.approval_escalated') && actions.includes('workflow.approval_expired'));
  assert.equal(timer.stats.sweeps, 2);
  await timer.stop();
});

test('never two sweeps at once: a tick while one is running is skipped', async () => {
  const { engine, clock } = await setup();
  const ft = fakeTimers();
  const timer = engine.startApprovalTimer({ timers: ft.timers });
  clock.advance(5 * HOUR);
  const first = ft.fire();
  const second = ft.fire(); // fires while the first is still running
  assert.equal(second, first, 'the second tick joins the running sweep');
  await first;
  assert.deepEqual(timer.stats, { sweeps: 1, skipped: 1, failed: 0 });
  await timer.stop();
});

test('a failing sweep is logged and the timer carries on', async () => {
  let down = true;
  const flaky = {
    ...pg,
    query: (...args) => (down ? Promise.reject(Object.assign(new Error('connection refused'), { name: 'DatabaseUnavailableError' })) : pg.query(...args)),
    transaction: (fn) => pg.transaction(fn),
    exec: (sql) => pg.exec(sql),
  };
  const { engine, audit } = await setup({ db: flaky });
  const ft = fakeTimers();
  const timer = engine.startApprovalTimer({ timers: ft.timers });

  assert.equal(await ft.fire(), null);
  const failed = audit.readAll().find((e) => e.action === 'workflow.sweep_failed');
  assert.match(failed.rationale, /will run again in 300 s: DatabaseUnavailableError: connection refused/);
  assert.equal(failed.actor.id, 'automation-agent');

  down = false;
  assert.deepEqual(await ft.fire(), { escalated: [], expired: [] }, 'the next tick works');
  assert.deepEqual(timer.stats, { sweeps: 1, skipped: 0, failed: 1 });
  await timer.stop();
});

test('if even the audit log fails, onError is told — the failure is never swallowed', async () => {
  const broken = createWorkflowEngine({
    db: { query: () => Promise.reject(new Error('db down')) },
    audit: { append: () => { throw new Error('audit disk full'); } },
  });
  const heard = [];
  const ft = fakeTimers();
  const timer = broken.startApprovalTimer({ timers: ft.timers, onError: (err) => heard.push(err.message) });
  await ft.fire();
  assert.deepEqual(heard, ['audit disk full']);
  await timer.stop();
});

test('stop() clears the timer, waits for a running sweep, and later ticks do nothing', async () => {
  const { engine, clock } = await setup();
  const ft = fakeTimers();
  const timer = engine.startApprovalTimer({ timers: ft.timers });
  clock.advance(5 * HOUR);
  const inProgress = ft.fire();
  await timer.stop();
  assert.equal(ft.t.cleared, true);
  assert.deepEqual(await inProgress, { escalated: ['WF-T:1'], expired: [] }, 'the sweep in progress finished');
  assert.equal(await ft.fire(), null, 'nothing runs after stop');
  assert.equal(timer.stats.sweeps, 1);
});

test('with real timers it fires on its own', async () => {
  const { engine, clock } = await setup();
  clock.advance(5 * HOUR);
  const timer = engine.startApprovalTimer({ everyMs: 20 });
  await new Promise((r) => { setTimeout(r, 200); });
  await timer.stop();
  assert.ok(timer.stats.sweeps >= 1);
  assert.ok((await engine.getWorkflow('WF-T')).actions[0].escalatedAt, 'escalated by the timer alone');
});
