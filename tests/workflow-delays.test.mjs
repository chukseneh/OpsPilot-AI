// Approval delays: escalate, then expire (STORY-005). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowEngine, migrateWorkflows, PermissionDeniedError } from '../src/automation/workflows.js';
import { createStandInExecutor } from '../src/automation/executors.js';
import { openPGlite, migrate } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const HOUR = 60 * 60 * 1000;
const STARTER = { id: 'pm-1', role: 'process manager' };
const OPS = { id: 'ops-1', role: 'operations manager' };
const COMPLIANCE = { id: 'co-1', role: 'compliance officer' };

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); await migrateWorkflows(pg); });
after(async () => { await pg.close(); });

// A clock the test moves by hand, so "5 hours later" happens at once.
async function setup({ notify } = {}) {
  await pg.exec('TRUNCATE workflow_actions, workflow_runs');
  let t = Date.parse('2026-10-06T09:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'wfd-')), 'audit.jsonl'), now: clock.now });
  const executors = { notify: notify ?? createStandInExecutor('notify'), payment: createStandInExecutor('payment') };
  const engine = createWorkflowEngine({ db: pg, audit, executors, now: clock.now, runOptions: { retryDelayMs: 1, maxAttempts: 2 } });
  const wf = await engine.startWorkflow({ user: STARTER, workflowId: 'WF-D', name: 'Pay contractor', actions: [
    { type: 'payment', params: { amount: 4000, to: 'contractor-7' } },
    { type: 'notify', params: { to: 'contractor-7' } },
  ] });
  const actions = () => audit.readAll().map((e) => e.action);
  return { audit, engine, executors, clock, wf, actions };
}

test('the approval gets a deadline 24 hours after it was requested', async () => {
  const { wf } = await setup();
  const a = wf.actions[0];
  assert.equal(a.status, 'awaiting_approval');
  assert.equal(a.approvalRequestedAt, '2026-10-06T09:00:00.000Z');
  assert.equal(a.deadlineAt, '2026-10-07T09:00:00.000Z');
});

test('nothing happens before the escalation time', async () => {
  const { engine, clock } = await setup();
  clock.advance(3 * HOUR);
  assert.deepEqual(await engine.checkApprovalDelays(), { escalated: [], expired: [] });
});

test('after 4 hours it is escalated once: more roles may decide, and one reminder is sent', async () => {
  const { engine, executors, clock, audit, actions } = await setup();
  await assert.rejects(engine.decide({ user: OPS, workflowId: 'WF-D', step: 1, decision: 'approve' }), PermissionDeniedError);

  clock.advance(5 * HOUR);
  assert.deepEqual(await engine.checkApprovalDelays(), { escalated: ['WF-D:1'], expired: [] });
  assert.deepEqual(await engine.checkApprovalDelays(), { escalated: [], expired: [] }, 'only once');
  assert.equal(executors.notify.done().length, 1, 'one reminder');
  assert.match(executors.notify.done()[0].params.subject, /WF-D step 1 \(payment, high risk\)/);

  const esc = audit.readAll().find((e) => e.action === 'workflow.approval_escalated');
  assert.equal(esc.detail.riskLevel, 'high');
  assert.equal(esc.detail.waitedMs, 5 * HOUR);
  assert.match(esc.rationale, /Waiting 300 min/);
  assert.ok(actions().includes('workflow.reminder_sent'));

  // Now an operations manager (or compliance officer) may decide.
  const wf = await engine.decide({ user: OPS, workflowId: 'WF-D', step: 1, decision: 'approve', note: 'Escalated; approved' });
  assert.equal(wf.run.status, 'completed');
  const approved = audit.readAll().find((e) => e.action === 'workflow.action_approved');
  assert.equal(approved.detail.escalated, true);
});

test('a compliance officer may also decide once escalated', async () => {
  const { engine, clock } = await setup();
  clock.advance(5 * HOUR);
  await engine.checkApprovalDelays();
  const wf = await engine.decide({ user: COMPLIANCE, workflowId: 'WF-D', step: 1, decision: 'reject' });
  assert.equal(wf.run.status, 'rejected');
});

// ---- Failure path: approval delays ----

test('at the deadline it expires as rejected: the payment never runs, later steps are skipped', async () => {
  const { engine, executors, clock, audit } = await setup();
  clock.advance(25 * HOUR);
  assert.deepEqual(await engine.checkApprovalDelays(), { escalated: [], expired: ['WF-D:1'] });
  const wf = await engine.getWorkflow('WF-D');
  assert.equal(wf.run.status, 'expired');
  assert.deepEqual(wf.actions.map((a) => a.status), ['expired', 'skipped']);
  assert.equal(executors.payment.calls, 0);

  const expired = audit.readAll().find((e) => e.action === 'workflow.approval_expired');
  assert.equal(expired.detail.riskLevel, 'high');
  assert.match(expired.rationale, /treated as rejected — it was not run/);
  assert.deepEqual(audit.readAll().find((e) => e.action === 'workflow.stopped').detail.skippedSteps, [2]);
  assert.deepEqual(await engine.checkApprovalDelays(), { escalated: [], expired: [] }, 'only once');
});

test('a decision that arrives after the deadline is refused, and the action is expired then and there', async () => {
  const { engine, executors, clock, actions } = await setup();
  clock.advance(5 * HOUR);
  await engine.checkApprovalDelays();
  clock.advance(20 * HOUR); // past the deadline; the sweep has not run since
  await assert.rejects(engine.decide({ user: OPS, workflowId: 'WF-D', step: 1, decision: 'approve' }), /passed its approval deadline and has expired/);
  const wf = await engine.getWorkflow('WF-D');
  assert.equal(wf.run.status, 'expired');
  assert.equal(executors.payment.calls, 0, 'a late approval never runs the action');
  assert.ok(actions().includes('workflow.approval_expired'));
  assert.equal(actions().at(-1), 'workflow.decision_refused');
});

test('a reminder that cannot be sent is logged; the escalation still stands', async () => {
  const notify = createStandInExecutor('notify', { fail: 'mail server rejected the message' });
  const { engine, clock, audit } = await setup({ notify });
  clock.advance(5 * HOUR);
  assert.deepEqual((await engine.checkApprovalDelays()).escalated, ['WF-D:1']);
  const failed = audit.readAll().find((e) => e.action === 'workflow.reminder_failed');
  assert.match(failed.rationale, /mail server rejected the message/);
  assert.ok((await engine.getWorkflow('WF-D')).actions[0].escalatedAt);
});

test('an approval decided in time is left alone by the sweep', async () => {
  const { engine, clock } = await setup();
  await engine.decide({ user: { id: 'pm-2', role: 'process manager' }, workflowId: 'WF-D', step: 1, decision: 'approve' });
  clock.advance(30 * HOUR);
  assert.deepEqual(await engine.checkApprovalDelays(), { escalated: [], expired: [] });
  assert.equal((await engine.getWorkflow('WF-D')).run.status, 'completed');
});
