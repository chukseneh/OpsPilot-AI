// Workflow engine: classify, run low-risk, pause high-risk, automation failure (STORY-005). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowEngine, migrateWorkflows, PermissionDeniedError, WorkflowRequestError } from '../src/automation/workflows.js';
import { createStandInExecutor, createInventoryStatusExecutor } from '../src/automation/executors.js';
import { createInventoryService } from '../src/inventory/service.js';
import { openPGlite, migrate } from '../src/inventory/db.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';

const PM = { id: 'pm-1', role: 'process manager' };
const IT = { id: 'it-1', role: 'IT manager' };

const chat = {
  id: 'ai-chat', name: 'Help-desk chatbot', department: 'Support', purpose: 'Answers IT questions', owner: 'it-support-1',
  status: 'active', dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: true,
};

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); await migrateWorkflows(pg); });
after(async () => { await pg.close(); });

async function setup({ notify, ticket, payment, riskLevel = 'low' } = {}) {
  await pg.exec('TRUNCATE workflow_actions, workflow_runs, ai_systems');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'wf-')), 'audit.jsonl') });
  const inventory = createInventoryService({ db: pg, audit });
  await inventory.registerSystem({ user: IT, system: chat });
  if (riskLevel !== 'unassessed') {
    // Give it a rating as a recorded assessment would.
    await pg.query("UPDATE ai_systems SET risk_level = $1, risk_assessment_id = 'RA-x', risk_assessed_at = now() WHERE id = 'ai-chat'", [riskLevel]);
  }
  const executors = {
    notify: notify ?? createStandInExecutor('notify'),
    create_ticket: ticket ?? createStandInExecutor('create_ticket'),
    payment: payment ?? createStandInExecutor('payment'),
    'inventory.update_status': createInventoryStatusExecutor({ inventory }),
  };
  const engine = createWorkflowEngine({ db: pg, audit, executors, runOptions: { retryDelayMs: 1, timeoutMs: 200 } });
  const entries = () => audit.readAll().filter((e) => e.action.startsWith('workflow.'));
  return { audit, inventory, executors, engine, entries };
}

// ---- Acceptance 2: low-risk actions run automatically ----

test('a workflow of low-risk actions runs to the end without anyone approving', async () => {
  const { engine, executors } = await setup();
  const wf = await engine.startWorkflow({ user: PM, workflowId: 'WF-1', name: 'Chatbot weekly review', actions: [
    { type: 'create_ticket', params: { title: 'Review chatbot answers', systemId: 'ai-chat' } },
    { type: 'notify', params: { to: 'it-support-1', systemId: 'ai-chat' } },
  ] });
  assert.equal(wf.run.status, 'completed');
  assert.deepEqual(wf.actions.map((a) => [a.status, a.riskLevel]), [['succeeded', 'low'], ['succeeded', 'low']]);
  assert.equal(executors.create_ticket.done().length, 1);
  assert.equal(executors.notify.done().length, 1);
});

// ---- Acceptance 1: high-risk actions wait for a person ----

test('a high-risk action stops the workflow for approval; nothing after it runs', async () => {
  const { engine, executors } = await setup();
  const wf = await engine.startWorkflow({ user: PM, workflowId: 'WF-2', name: 'Pay vendor', actions: [
    { type: 'notify', params: { to: 'finance' } },
    { type: 'payment', params: { amount: 5000, to: 'vendor-9' } },
    { type: 'notify', params: { to: 'vendor-9' } },
  ] });
  assert.equal(wf.run.status, 'awaiting_approval');
  assert.deepEqual(wf.actions.map((a) => a.status), ['succeeded', 'awaiting_approval', 'pending']);
  assert.equal(wf.actions[1].riskLevel, 'high');
  assert.ok(wf.actions[1].riskReasons.some((r) => r.rule === 'payment.over_limit'));
  assert.ok(wf.actions[1].approvalRequestedAt);
  assert.equal(executors.payment.calls, 0, 'the payment did not run');
  assert.equal(executors.notify.done().length, 1, 'the step after it did not run');
});

test('the live inventory rating decides: the same action is high for a high-risk system', async () => {
  const { engine } = await setup({ riskLevel: 'high' });
  const wf = await engine.startWorkflow({ user: PM, workflowId: 'WF-3', name: 'Notify', actions: [{ type: 'notify', params: { systemId: 'ai-chat' } }] });
  assert.equal(wf.actions[0].status, 'awaiting_approval');
  assert.deepEqual(wf.actions[0].riskReasons.filter((r) => r.effect === 'high').map((r) => r.rule), ['system.high_risk']);
});

// ---- Failure path: incorrect risk categorization ----

test('an author labelling a high-risk action low does not let it run unattended', async () => {
  const { engine, executors } = await setup();
  const wf = await engine.startWorkflow({ user: PM, workflowId: 'WF-4', name: 'Retire chatbot', actions: [
    { type: 'inventory.update_status', params: { systemId: 'ai-chat', status: 'retired' }, declaredRisk: 'low' },
  ] });
  assert.equal(wf.actions[0].status, 'awaiting_approval');
  assert.ok(wf.actions[0].riskReasons.some((r) => r.rule === 'declared.low_ignored'));
  assert.equal(wf.actions[0].params.expectedVersion, 1, 'the version the decision was based on is pinned');
  assert.equal(executors.payment.calls, 0);
});

// ---- Trust: all automated actions logged with risk levels ----

test('every action is logged with its risk level: classified, started, executed (automatic), or awaiting approval', async () => {
  const { engine, entries, audit } = await setup();
  await engine.startWorkflow({ user: PM, workflowId: 'WF-5', name: 'Mixed', actions: [
    { type: 'notify', params: { to: 'a' } },
    { type: 'payment', params: { amount: 20 } },
  ] });
  const e = entries();
  assert.deepEqual(e.map((x) => x.action), [
    'workflow.started',
    'workflow.action_classified', 'workflow.action_started', 'workflow.action_executed',
    'workflow.action_classified', 'workflow.approval_requested',
  ]);
  for (const x of e.slice(1)) assert.ok(['low', 'high'].includes(x.detail.riskLevel), `${x.action} carries a risk level`);
  const executed = e.find((x) => x.action === 'workflow.action_executed');
  assert.deepEqual([executed.detail.riskLevel, executed.detail.automatic, executed.actor.id], ['low', true, 'automation-agent']);
  assert.ok(e.find((x) => x.action === 'workflow.action_classified' && x.detail.step === 2).detail.reasons.length > 0);
  assert.equal(e[0].actor.id, 'pm-1');
  assert.equal(audit.verify().ok, true);
});

// ---- Failure path: automation failure ----

test('a failing action stops the workflow at that step, is logged, and later steps never run', async () => {
  const ticket = createStandInExecutor('create_ticket', { fail: 'ticketing system rejected the request' });
  const { engine, executors, entries } = await setup({ ticket });
  const wf = await engine.startWorkflow({ user: PM, workflowId: 'WF-6', name: 'Ticket then notify', actions: [
    { type: 'create_ticket', params: {} },
    { type: 'notify', params: {} },
  ] });
  assert.equal(wf.run.status, 'failed');
  assert.deepEqual(wf.actions.map((a) => a.status), ['failed', 'pending']);
  assert.match(wf.actions[0].error, /ticketing system rejected the request/);
  assert.equal(executors.notify.calls, 0);
  const failed = entries().find((x) => x.action === 'workflow.action_failed');
  assert.equal(failed.detail.riskLevel, 'low');
  assert.ok(entries().some((x) => x.action === 'workflow.failed'));
});

test('a failed workflow can be resumed; the failed step runs once, and the rest follow', async () => {
  const ticket = createStandInExecutor('create_ticket', { failTimes: 3 }); // fails all 3 attempts of the first run
  const { engine, executors } = await setup({ ticket });
  const first = await engine.startWorkflow({ user: PM, workflowId: 'WF-7', name: 'Retry me', actions: [{ type: 'create_ticket', params: {} }, { type: 'notify', params: {} }] });
  assert.equal(first.run.status, 'failed');
  const resumed = await engine.resumeWorkflow({ user: PM, workflowId: 'WF-7' });
  assert.equal(resumed.run.status, 'completed');
  assert.equal(executors.create_ticket.done().length, 1);
  assert.equal(executors.notify.done().length, 1);
  await assert.rejects(engine.resumeWorkflow({ user: PM, workflowId: 'WF-7' }), /only a failed workflow can be resumed/);
});

test('an action type with no executor fails cleanly rather than crashing', async () => {
  const { engine } = await setup();
  const wf = await engine.startWorkflow({ user: PM, workflowId: 'WF-8', name: 'Odd', actions: [{ type: 'notify', params: {} }] });
  assert.equal(wf.run.status, 'completed');
  const engineNoExec = createWorkflowEngine({ db: pg, audit: createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'wf-')), 'a.jsonl') }), executors: {} });
  const r = await engineNoExec.startWorkflow({ user: PM, workflowId: 'WF-9', name: 'No executor', actions: [{ type: 'notify', params: {} }] });
  assert.equal(r.run.status, 'failed');
  assert.match(r.actions[0].error, /No executor/);
});

// ---- Idempotency and requests ----

test('starting the same workflow twice runs each action once; a reused id with other actions is refused', async () => {
  const { engine, executors } = await setup();
  const actions = [{ type: 'notify', params: { to: 'a' } }];
  const [a, b] = await Promise.all([
    engine.startWorkflow({ user: PM, workflowId: 'WF-10', name: 'Once', actions }),
    engine.startWorkflow({ user: PM, workflowId: 'WF-10', name: 'Once', actions }),
  ]);
  assert.equal(a.run.id, 'WF-10');
  assert.equal(b.run.id, 'WF-10', 'the racing second start is a replay, not a database error');
  assert.equal(executors.notify.done().length, 1, 'notified once');
  const again = await engine.startWorkflow({ user: PM, workflowId: 'WF-10', name: 'Once', actions });
  assert.equal(again.run.status, 'completed');
  await assert.rejects(engine.startWorkflow({ user: PM, workflowId: 'WF-10', name: 'Once', actions: [{ type: 'notify', params: { to: 'b' } }] }), WorkflowRequestError);
});

test('only process and operations managers may start workflows; refusals are logged', async () => {
  const { engine, entries } = await setup();
  await assert.rejects(engine.startWorkflow({ user: IT, workflowId: 'WF-11', name: 'x', actions: [{ type: 'notify' }] }), PermissionDeniedError);
  await assert.rejects(engine.startWorkflow({ workflowId: 'WF-12', name: 'x', actions: [{ type: 'notify' }] }), PermissionDeniedError);
  const ops = await engine.startWorkflow({ user: { id: 'ops-1', role: 'operations manager' }, workflowId: 'WF-13', name: 'x', actions: [{ type: 'notify' }] });
  assert.equal(ops.run.status, 'completed');
  assert.deepEqual(entries().filter((e) => e.action === 'workflow.denied').map((e) => e.actor.id), ['it-1', 'unknown-requester']);
});

test('a malformed workflow is rejected before anything is stored', async () => {
  const { engine } = await setup();
  for (const [args, msg] of [
    [{ workflowId: '', name: 'x', actions: [{ type: 'notify' }] }, /workflowId/],
    [{ workflowId: 'W', name: 'x', actions: [] }, /non-empty list/],
    [{ workflowId: 'W', name: 'x', actions: [{ type: 'notify' }, { params: {} }] }, /action 2 has no type/],
  ]) await assert.rejects(engine.startWorkflow({ user: PM, ...args }), msg);
  assert.equal(await engine.getWorkflow('W'), null);
});

test('if the audit log fails, the workflow does not start', async () => {
  await pg.exec('TRUNCATE workflow_actions, workflow_runs');
  const audit = { append: (e) => { if (e.action === 'workflow.started') throw new AuditWriteError('disk full'); return { seq: 1, ...e }; } };
  const engine = createWorkflowEngine({ db: pg, audit, executors: { notify: createStandInExecutor('notify') } });
  await assert.rejects(engine.startWorkflow({ user: PM, workflowId: 'WF-14', name: 'x', actions: [{ type: 'notify' }] }), AuditWriteError);
  assert.equal(await engine.getWorkflow('WF-14'), null);
});
