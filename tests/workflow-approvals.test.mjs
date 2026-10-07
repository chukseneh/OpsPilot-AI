// Approving and rejecting high-risk workflow actions (STORY-005). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowEngine, migrateWorkflows, PermissionDeniedError, WorkflowRequestError } from '../src/automation/workflows.js';
import { createStandInExecutor, createInventoryStatusExecutor } from '../src/automation/executors.js';
import { createInventoryService } from '../src/inventory/service.js';
import { openPGlite, migrate } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const STARTER = { id: 'pm-1', role: 'process manager' };
const APPROVER = { id: 'pm-2', role: 'process manager' };
const IT = { id: 'it-1', role: 'IT manager' };

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); await migrateWorkflows(pg); });
after(async () => { await pg.close(); });

async function setup() {
  await pg.exec('TRUNCATE workflow_actions, workflow_runs, ai_systems');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'wfa-')), 'audit.jsonl') });
  const inventory = createInventoryService({ db: pg, audit });
  await inventory.registerSystem({ user: IT, system: {
    id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications', owner: 'hr-lead-1',
    status: 'active', dataCategories: ['personal'], decisionImpact: 'significant', humanOversight: 'none', userFacing: false,
  } });
  const executors = {
    notify: createStandInExecutor('notify'),
    payment: createStandInExecutor('payment'),
    'inventory.update_status': createInventoryStatusExecutor({ inventory }),
  };
  const engine = createWorkflowEngine({ db: pg, audit, executors, runOptions: { retryDelayMs: 1 } });
  const wf = await engine.startWorkflow({ user: STARTER, workflowId: 'WF-A', name: 'Pause CV screener and pay auditor', actions: [
    { type: 'inventory.update_status', params: { systemId: 'ai-cv-screen', status: 'paused', reason: 'Bias review' } }, // high: active system out of use
    { type: 'notify', params: { to: 'hr-lead-1' } },                                                                   // low
    { type: 'payment', params: { amount: 2500, to: 'external-auditor' } },                                             // high
    { type: 'notify', params: { to: 'finance' } },                                                                     // low
  ] });
  const decisions = () => audit.readAll().filter((e) => /approved|rejected|decision|denied|stopped/.test(e.action));
  return { audit, inventory, executors, engine, wf, decisions };
}

test('approved: the high-risk action runs, low-risk steps carry on, the next high-risk step waits again', async () => {
  const { engine, executors, inventory, wf } = await setup();
  assert.deepEqual(wf.actions.map((a) => a.status), ['awaiting_approval', 'pending', 'pending', 'pending']);

  const after1 = await engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'approve', note: 'Review agreed with HR' });
  assert.deepEqual(after1.actions.map((a) => a.status), ['succeeded', 'succeeded', 'awaiting_approval', 'pending']);
  assert.equal(after1.actions[0].decidedBy, 'pm-2');
  assert.equal(after1.actions[0].decisionNote, 'Review agreed with HR');
  assert.equal((await inventory.listSystems({ user: IT })).systems[0].status, 'paused');
  assert.equal(executors.payment.calls, 0);

  const after3 = await engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 3, decision: 'approve' });
  assert.equal(after3.run.status, 'completed');
  assert.equal(executors.payment.done().length, 1);
  assert.equal(executors.notify.done().length, 2);
});

test('the approval and the execution after it are logged with the risk level and who approved', async () => {
  const { engine, audit } = await setup();
  await engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'approve', note: 'ok' });
  const e = audit.readAll();
  const approved = e.find((x) => x.action === 'workflow.action_approved');
  assert.deepEqual([approved.actor.id, approved.detail.riskLevel, approved.rationale, approved.detail.escalated], ['pm-2', 'high', 'ok', false]);
  const ran = e.find((x) => x.action === 'workflow.action_executed' && x.detail.step === 1);
  assert.deepEqual([ran.detail.riskLevel, ran.detail.automatic, ran.detail.approvedBy], ['high', false, 'pm-2']);
  assert.equal(audit.verify().ok, true);
});

test('rejected: the action and every later step do not run; the workflow stops', async () => {
  const { engine, executors, inventory, decisions } = await setup();
  const wf = await engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'reject', note: 'Not during hiring week' });
  assert.equal(wf.run.status, 'rejected');
  assert.deepEqual(wf.actions.map((a) => a.status), ['rejected', 'skipped', 'skipped', 'skipped']);
  assert.equal((await inventory.listSystems({ user: IT })).systems[0].status, 'active', 'nothing changed');
  assert.equal(executors.notify.calls + executors.payment.calls, 0);
  const stopped = decisions().find((x) => x.action === 'workflow.stopped');
  assert.deepEqual(stopped.detail.skippedSteps, [2, 3, 4]);
});

test('the person who started a workflow cannot approve its high-risk actions', async () => {
  const { engine, decisions } = await setup();
  await assert.rejects(engine.decide({ user: STARTER, workflowId: 'WF-A', step: 1, decision: 'approve' }),
    (err) => err instanceof WorkflowRequestError && /started a workflow may not decide/.test(err.message));
  assert.equal((await engine.getWorkflow('WF-A')).actions[0].status, 'awaiting_approval');
  assert.equal(decisions().at(-1).action, 'workflow.decision_refused');
});

test('before escalation only a process manager may decide; other roles are refused and logged', async () => {
  const { engine, decisions } = await setup();
  for (const role of ['operations manager', 'compliance officer', 'IT manager']) {
    await assert.rejects(engine.decide({ user: { id: `u-${role}`, role }, workflowId: 'WF-A', step: 1, decision: 'approve' }), PermissionDeniedError);
  }
  await assert.rejects(engine.decide({ workflowId: 'WF-A', step: 1, decision: 'approve' }), PermissionDeniedError);
  const denied = decisions().filter((x) => x.action === 'workflow.denied');
  assert.equal(denied.length, 4);
  assert.match(denied[0].rationale, /before it is escalated; allowed roles: process manager/);
});

test('deciding twice the same way changes nothing; deciding the other way is refused', async () => {
  const { engine, executors } = await setup();
  await engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'approve' });
  const again = await engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'approve' });
  assert.equal(again.actions[0].status, 'succeeded');
  assert.equal(executors.notify.done().length, 1, 'nothing ran twice');
  await assert.rejects(engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'reject' }), /already approved by pm-2/);
  await assert.rejects(engine.decide({ user: { id: 'pm-3', role: 'process manager' }, workflowId: 'WF-A', step: 1, decision: 'approve' }), /already approved by pm-2/);
});

test('only the step that is waiting can be decided; bad requests are refused and logged', async () => {
  const { engine, decisions } = await setup();
  await assert.rejects(engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 2, decision: 'approve' }), /not waiting for approval \(it is pending\)/);
  await assert.rejects(engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 9, decision: 'approve' }), /has no step 9/);
  await assert.rejects(engine.decide({ user: APPROVER, workflowId: 'WF-none', step: 1, decision: 'approve' }), /no workflow WF-none/);
  await assert.rejects(engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'maybe' }), /"approve" or "reject"/);
  assert.equal(decisions().filter((x) => x.action === 'workflow.decision_refused').length, 4);
});

test('if the system changed while the action waited, the approved action fails instead of acting on stale data', async () => {
  const { engine, inventory } = await setup();
  await inventory.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'retired', expectedVersion: 1, reason: 'Decommissioned' });
  const wf = await engine.decide({ user: APPROVER, workflowId: 'WF-A', step: 1, decision: 'approve' });
  assert.equal(wf.run.status, 'failed');
  assert.match(wf.actions[0].error, /InventoryConflictError/);
  assert.equal((await inventory.listSystems({ user: IT })).systems[0].status, 'retired', 'the newer change stands');
});
