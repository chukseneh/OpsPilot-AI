// Web access, step 4a: the approvals and workflows endpoints, over real HTTP.
// Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkflowEngine, migrateWorkflows } from '../src/automation/workflows.js';
import { createStandInExecutor } from '../src/automation/executors.js';
import { openPGlite, migrate } from '../src/inventory/db.js';
import { migrateAccounts } from '../src/web/accounts.js';
import { migrateSessions } from '../src/web/sessions.js';
import { workflowRoutes } from '../src/web/workflowRoutes.js';
import { startHarness } from './helpers/webHarness.mjs';

const PEOPLE = {
  'pm.starter': 'process manager',
  'pm.approver': 'process manager',
  'ops.manager': 'operations manager',
  'co.officer': 'compliance officer',
  'da.analyst': 'data analyst',
};
const PAY_AND_NOTIFY = {
  workflowId: 'WF-WEB-1', name: 'Pay the auditor and tell finance',
  actions: [
    { type: 'payment', params: { amount: 2500, to: 'external-auditor' } }, // high risk: waits for approval
    { type: 'notify', params: { to: 'finance' } },                         // low risk
  ],
};

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); await migrateWorkflows(pg); await migrateAccounts(pg); await migrateSessions(pg); });
after(async () => { await pg.close(); });

async function setup() {
  await pg.exec('TRUNCATE workflow_actions, workflow_runs');
  const notifyBehaviour = {};
  const executors = { payment: createStandInExecutor('payment'), notify: createStandInExecutor('notify', notifyBehaviour) };
  let engine;
  const h = await startHarness({
    db: pg, people: PEOPLE,
    routes: (audit) => {
      engine = createWorkflowEngine({ db: pg, audit, executors, runOptions: { retryDelayMs: 1 } });
      return workflowRoutes({ workflows: engine });
    },
  });
  const people = {};
  for (const name of Object.keys(PEOPLE)) people[name] = await h.signIn(name);
  return { ...h, executors, notifyBehaviour, people, engine };
}
const withApi = (name, fn) => test(name, async () => {
  const ctx = await setup();
  try { await fn(ctx); } finally { await ctx.close(); }
});

withApi('a process manager starts a workflow; the high-risk step waits for approval', async ({ call, people, executors, audit }) => {
  const r = await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.workflow.run.requestedBy, 'pm.starter', 'the starter is the signed-in user');
  assert.deepEqual(r.json.workflow.actions.map((a) => [a.status, a.riskLevel]), [['awaiting_approval', 'high'], ['pending', null]]);
  assert.equal(executors.payment.calls, 0);
  assert.ok(audit.readAll().some((e) => e.action === 'workflow.approval_requested'));
});

withApi('starting the same workflow again returns it without doing anything twice', async ({ call, people, audit }) => {
  const first = await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  const again = await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.workflow, first.json.workflow);
  assert.equal(audit.readAll().filter((e) => e.action === 'workflow.started').length, 1);
  assert.equal(audit.readAll().filter((e) => e.action === 'workflow.replayed').length, 1);

  const changed = await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: { ...PAY_AND_NOTIFY, name: 'Something else' } });
  assert.equal(changed.status, 400);
  assert.match(changed.json.error, /already used with different actions/);
});

withApi('only process and operations managers may start workflows', async ({ call, people }) => {
  const r = await call('POST', '/api/v1/workflows', { as: people['da.analyst'], body: PAY_AND_NOTIFY });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Role "data analyst" may not start workflows/);
  const bad = await call('POST', '/api/v1/workflows', { as: people['ops.manager'], body: { workflowId: 'WF-X', name: 'x', actions: [] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /actions must be a non-empty list/);
  assert.equal((await call('POST', '/api/v1/workflows', { body: PAY_AND_NOTIFY })).status, 401, 'not signed in');
});

withApi('another process manager approves; the action runs and the workflow finishes', async ({ call, people, executors, audit }) => {
  await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  const r = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as: people['pm.approver'], body: { decision: 'approve', note: 'Invoice checked' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.workflow.run.status, 'completed');
  assert.equal(r.json.workflow.actions[0].decidedBy, 'pm.approver');
  assert.equal(executors.payment.done().length, 1);
  const approved = audit.readAll().find((e) => e.action === 'workflow.action_approved');
  assert.deepEqual([approved.actor.id, approved.rationale], ['pm.approver', 'Invoice checked']);

  const repeat = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as: people['pm.approver'], body: { decision: 'approve', note: 'again' } });
  assert.equal(repeat.status, 200, 'the same decision again is harmless');
  assert.equal(executors.payment.done().length, 1, 'and pays nothing more');
});

withApi('a rejection stops the workflow; later steps never run', async ({ call, people, executors }) => {
  await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  const r = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as: people['pm.approver'], body: { decision: 'reject', note: 'No invoice' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.workflow.actions.map((a) => a.status), ['rejected', 'skipped']);
  assert.equal(executors.payment.calls + executors.notify.calls, 0);
  const flip = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as: people['pm.approver'], body: { decision: 'approve', note: 'changed my mind' } });
  assert.equal(flip.status, 400);
  assert.match(flip.json.error, /already rejected/);
});

withApi('the engine\'s rules hold over the API: the starter cannot approve, nor can a role that may not', async ({ call, people, executors }) => {
  await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  const own = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as: people['pm.starter'], body: { decision: 'approve', note: 'mine' } });
  assert.equal(own.status, 400);
  assert.match(own.json.error, /person who started a workflow may not decide/);
  const ops = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as: people['ops.manager'], body: { decision: 'approve', note: 'ok' } });
  assert.equal(ops.status, 403, 'an operations manager only once it is escalated');
  assert.equal(executors.payment.calls, 0);
});

withApi('a decision needs a note, a real step and the CSRF token', async ({ call, people, url }) => {
  await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  const as = people['pm.approver'];
  const noNote = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as, body: { decision: 'approve' } });
  assert.equal(noNote.status, 400);
  assert.match(noNote.json.error, /a note is required/);
  for (const step of ['0', 'abc', '1.5', '-1', '9999999']) {
    assert.equal((await call('POST', `/api/v1/workflows/WF-WEB-1/steps/${step}/decision`, { as, body: { decision: 'approve', note: 'x' } })).status, 400, step);
  }
  assert.equal((await call('POST', '/api/v1/workflows/WF-WEB-1/steps/7/decision', { as, body: { decision: 'approve', note: 'x' } })).status, 400, 'no step 7');
  assert.equal((await call('POST', '/api/v1/workflows/WF-NONE/steps/1/decision', { as, body: { decision: 'approve', note: 'x' } })).status, 400);
  const noCsrf = await fetch(`${url}/api/v1/workflows/WF-WEB-1/steps/1/decision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: as.cookie },
    body: JSON.stringify({ decision: 'approve', note: 'x' }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(noCsrf.status, 403);
});

withApi('viewing a workflow is checked and logged; a missing one is 404', async ({ call, people, audit }) => {
  await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  const seen = await call('GET', '/api/v1/workflows/WF-WEB-1', { as: people['co.officer'] });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.workflow.run.id, 'WF-WEB-1');
  const viewed = audit.readAll().find((e) => e.action === 'workflow.viewed');
  assert.deepEqual([viewed.actor.id, viewed.correlationId], ['co.officer', 'WF-WEB-1']);

  const denied = await call('GET', '/api/v1/workflows/WF-WEB-1', { as: people['da.analyst'] });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /may not view workflows/);
  assert.equal((await call('GET', '/api/v1/workflows/WF-NONE', { as: people['ops.manager'] })).status, 404);
  assert.equal((await call('GET', '/api/v1/workflows/WF-WEB-1')).status, 401);
});

withApi('a failed workflow is resumed from the failed step, without repeating what already ran', async ({ call, people, executors, notifyBehaviour }) => {
  notifyBehaviour.fail = 'mail server down';
  await call('POST', '/api/v1/workflows', { as: people['pm.starter'], body: PAY_AND_NOTIFY });
  const approved = await call('POST', '/api/v1/workflows/WF-WEB-1/steps/1/decision', { as: people['pm.approver'], body: { decision: 'approve', note: 'ok' } });
  assert.equal(approved.json.workflow.run.status, 'failed');
  assert.deepEqual(approved.json.workflow.actions.map((a) => a.status), ['succeeded', 'failed']);

  const tooSoon = await call('POST', '/api/v1/workflows/WF-WEB-1/resume', { as: people['da.analyst'], body: {} });
  assert.equal(tooSoon.status, 403);

  delete notifyBehaviour.fail;
  const resumed = await call('POST', '/api/v1/workflows/WF-WEB-1/resume', { as: people['pm.starter'], body: {} });
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.json.workflow.run.status, 'completed');
  assert.equal(executors.payment.done().length, 1, 'the payment was not made again');
  assert.equal(executors.notify.done().length, 1);

  const again = await call('POST', '/api/v1/workflows/WF-WEB-1/resume', { as: people['pm.starter'], body: {} });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /only a failed workflow can be resumed/);
});
