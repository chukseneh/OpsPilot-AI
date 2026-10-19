// Running scenarios in an isolated sandbox (STORY-010). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInSandbox } from '../src/simulation/sandbox.js';
import { ScenarioError, generateScenario } from '../src/simulation/scenario.js';
import { createStandInExecutor } from '../src/automation/executors.js';

const sys = (id, riskLevel, over = {}) => ({
  id, name: `${id} (SYNTHETIC)`, department: 'Sim', purpose: 'Simulated', owner: 'SYN-owner', status: 'active',
  dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false, riskLevel, ...over,
});
const scenario = (over = {}) => ({
  id: 'SIM-1', synthetic: true, label: 'SYNTHETIC — invented for simulation',
  systems: [sys('SYN-low', 'low'), sys('SYN-high', 'high')],
  workflows: [
    {
      id: 'SYN-WF-low', name: 'Routine', actions: [{ type: 'notify', params: { systemId: 'SYN-low' } }, { type: 'create_ticket', params: {} }],
      expect: { steps: [{ riskLevel: 'low', outcome: 'succeeded' }, { riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' },
    },
    {
      id: 'SYN-WF-pay', name: 'Pay', actions: [{ type: 'payment', params: { amount: 500 } }, { type: 'notify', params: { systemId: 'SYN-low' } }],
      decide: [{ step: 1, decision: 'approve' }],
      expect: { steps: [{ riskLevel: 'high', outcome: 'succeeded' }, { riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' },
    },
  ],
  ...over,
});
// A folder only this test uses, so other test files' sandboxes (running at the same
// time) cannot make it look as if one was left behind, or cleaned up.
const privateRoot = () => mkdtempSync(join(tmpdir(), 'sandbox-root-'));

test('a scenario runs in its own sandbox with the real engine, and reports what actually happened', async () => {
  const r = await runInSandbox(scenario());
  assert.equal(r.status, 'ran');
  assert.deepEqual(r.workflows.map((w) => [w.id, w.status]), [['SYN-WF-low', 'completed'], ['SYN-WF-pay', 'completed']]);
  assert.deepEqual(r.workflows[1].actions.map((a) => [a.riskLevel, a.outcome]), [['high', 'succeeded'], ['low', 'succeeded']]);
  assert.deepEqual(r.workflows[1].decisionErrors, []);
  // Scripted approver is a different synthetic person from the starter.
  const approved = r.sandboxLog.find((e) => e.action === 'workflow.action_approved');
  assert.equal(approved.actor.id, 'SYN-approver');
  assert.equal(r.sandboxLog.find((e) => e.action === 'workflow.started').actor.id, 'SYN-starter');
});

test('the sandbox is new every time: two runs of the same scenario do not see each other', async () => {
  const a = await runInSandbox(scenario());
  const b = await runInSandbox(scenario());
  assert.deepEqual(a.workflows, b.workflows, 'same scenario, same result');
  assert.ok(!b.sandboxLog.some((e) => e.action === 'workflow.replayed'), 'the second run did not find the first one\'s workflows');
});

test('a policy in the scenario is applied (STORY-009): under EU, a personal-data system needs approval', async () => {
  const s = scenario({
    policy: 'EU',
    systems: [sys('SYN-low', 'low'), sys('SYN-high', 'high'), sys('SYN-personal', 'low', { dataCategories: ['personal'] })],
    workflows: [{
      id: 'SYN-WF-eu', name: 'Notify', actions: [{ type: 'notify', params: { systemId: 'SYN-personal' } }],
      expect: { steps: [{ riskLevel: 'high', outcome: 'awaiting_approval' }], final: 'awaiting_approval' },
    }],
  });
  const r = await runInSandbox(s);
  assert.equal(r.workflows[0].actions[0].outcome, 'awaiting_approval');
  assert.ok(r.workflows[0].actions[0].reasons.includes('policy.personal_data'));
});

test('a decision the engine refuses is reported, not crashed on', async () => {
  // The scenario expects step 1 to wait for approval, but a ticket is low risk and
  // runs automatically — so the scripted approval finds nothing waiting.
  const s = scenario({ workflows: [{
    id: 'SYN-WF-x', name: 'Mis-scripted', actions: [{ type: 'create_ticket', params: {} }],
    decide: [{ step: 1, decision: 'approve' }],
    expect: { steps: [{ riskLevel: 'high', outcome: 'succeeded' }], final: 'completed' },
  }] });
  const r = await runInSandbox(s);
  assert.equal(r.status, 'ran');
  assert.equal(r.workflows[0].actions[0].riskLevel, 'low', 'what actually happened is reported as it happened');
  assert.match(r.workflows[0].decisionErrors[0].error, /not waiting for approval \(it is succeeded\)/);
});

test('an invalid scenario never runs, and leaves nothing behind', async () => {
  const workRoot = privateRoot();
  await assert.rejects(runInSandbox(scenario({ synthetic: false }), { workRoot }), ScenarioError);
  assert.deepEqual(readdirSync(workRoot), []);
});

// ---- Failure path: simulation timeout ----

test('a simulation that runs too long is stopped, reports what finished, and is cleaned up', async () => {
  const workRoot = privateRoot();
  const s = scenario({ workflows: [
    { id: 'SYN-WF-fast', name: 'Fast', actions: [{ type: 'create_ticket', params: {} }], expect: { steps: [{ riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' } },
    { id: 'SYN-WF-slow', name: 'Slow', actions: [{ type: 'notify', params: { systemId: 'SYN-low' } }], expect: { steps: [{ riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' } },
  ] });
  const started = Date.now();
  // notify never answers; the engine's own executor limit (2 s) ends that step, the simulation limit (1 s) ends the run.
  const r = await runInSandbox(s, { workRoot, timeoutMs: 1000, executors: { notify: createStandInExecutor('notify', { hang: true }) }, runOptions: { timeoutMs: 2000, maxAttempts: 1, retryDelayMs: 1 } });
  assert.equal(r.status, 'timed_out');
  assert.match(r.error, /took longer than 1000 ms and was stopped after 1 of 2 workflow\(s\)/);
  assert.deepEqual(r.workflows.map((w) => w.id), ['SYN-WF-fast'], 'only what finished within the limit is reported');
  assert.ok(r.sandboxLog.some((e) => e.correlationId === 'SYN-WF-slow'), 'the log still shows the cut-off workflow started');
  assert.ok(Date.now() - started < 10000, 'it did not hang');
  assert.deepEqual(readdirSync(workRoot), [], 'the sandbox folder was removed');
});

test('a generated scenario runs too (the generator\'s output is a real, runnable input)', async () => {
  const r = await runInSandbox(generateScenario({ seed: 11, workflows: 6 }));
  assert.equal(r.status, 'ran');
  assert.equal(r.workflows.length, 6);
});
