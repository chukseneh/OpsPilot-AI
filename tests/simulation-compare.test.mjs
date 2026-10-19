// Comparing simulated workflows with their expectations (STORY-010). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareResults } from '../src/simulation/compare.js';
import { runInSandbox } from '../src/simulation/sandbox.js';
import { generateScenario } from '../src/simulation/scenario.js';

// A scenario and run written by hand, so each mismatch is exactly controlled.
const scenario = {
  id: 'SIM-1', synthetic: true, label: 'SYNTHETIC',
  systems: [],
  workflows: [
    { id: 'SYN-A', name: 'A', actions: [{}, {}], expect: { steps: [{ riskLevel: 'low', outcome: 'succeeded' }, { riskLevel: 'high', outcome: 'awaiting_approval' }], final: 'awaiting_approval' } },
    { id: 'SYN-B', name: 'B', actions: [{}], expect: { steps: [{ riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' } },
  ],
};
const run = (overA = {}, overB = {}, status = 'ran') => ({
  status,
  workflows: [
    { id: 'SYN-A', status: 'awaiting_approval', actions: [{ step: 1, riskLevel: 'low', outcome: 'succeeded', reasons: [] }, { step: 2, riskLevel: 'high', outcome: 'awaiting_approval', reasons: ['payment.over_limit'] }], decisionErrors: [], ...overA },
    { id: 'SYN-B', status: 'completed', actions: [{ step: 1, riskLevel: 'low', outcome: 'succeeded', reasons: [] }], decisionErrors: [], ...overB },
  ],
});

// ---- Acceptance 1: executes as expected ----

test('when every step and final status matches, the verdict is passed', () => {
  const r = compareResults(scenario, run());
  assert.equal(r.verdict, 'passed');
  assert.deepEqual(r.summary, { workflows: { total: 2, passed: 2, failed: 0, unchecked: 0 }, steps: { checked: 3, matched: 3, mismatched: 0 }, critical: 0 });
});

// ---- Failure path: unexpected workflow behaviour ----

test('a high-risk step that ran unattended is a CRITICAL mismatch, with what was expected and what happened', () => {
  const r = compareResults(scenario, run({ status: 'completed', actions: [
    { step: 1, riskLevel: 'low', outcome: 'succeeded', reasons: [] },
    { step: 2, riskLevel: 'low', outcome: 'succeeded', reasons: [] },
  ] }));
  assert.equal(r.verdict, 'failed');
  const [step, final] = r.workflows[0].mismatches;
  assert.equal(step.severity, 'critical');
  assert.equal(step.message, 'SYN-A step 2: expected high risk, waiting for approval; got low risk, succeeded (it ran without a person)');
  assert.equal(final.message, 'SYN-A: expected the workflow to end awaiting_approval; it ended completed');
  assert.equal(r.summary.critical, 1);
  assert.deepEqual(r.summary.workflows, { total: 2, passed: 1, failed: 1, unchecked: 0 });
});

test('other mismatches are normal, and carry the engine\'s reasons and errors', () => {
  const r = compareResults(scenario, run({}, { status: 'failed', actions: [{ step: 1, riskLevel: 'low', outcome: 'failed', reasons: [], error: 'create_ticket failed (gave up after 3 attempts)' }] }));
  const m = r.workflows[1].mismatches;
  assert.equal(m[0].severity, 'normal');
  assert.match(m[0].message, /expected low risk, succeeded; got low risk, failed \[error: create_ticket failed/);
  assert.match(m[1].message, /expected the workflow to end completed; it ended failed/);
});

test('missing steps, extra steps and refused scripted decisions are all reported', () => {
  const r = compareResults(scenario, run(
    { actions: [{ step: 1, riskLevel: 'low', outcome: 'succeeded', reasons: [] }], decisionErrors: [{ step: 2, decision: 'approve', error: 'GovernanceRequestError: not waiting' }] },
    { actions: [{ step: 1, riskLevel: 'low', outcome: 'succeeded' }, { step: 2, riskLevel: 'low', outcome: 'succeeded' }] },
  ));
  const messages = r.workflows.flatMap((w) => w.mismatches.map((x) => x.message)).join('\n');
  assert.match(messages, /SYN-A step 2: expected high risk, waiting for approval; the step does not exist in the run/);
  assert.match(messages, /the scripted approve of step 2 was refused/);
  assert.match(messages, /SYN-B: the run has 1 more step\(s\) than expected/);
});

test('a timed-out run lists unfinished workflows as unchecked, never as passing', () => {
  const r = compareResults(scenario, { status: 'timed_out', error: 'took longer than 1000 ms', workflows: run().workflows.slice(0, 1) });
  assert.equal(r.verdict, 'timed_out');
  assert.deepEqual(r.workflows.map((w) => w.verdict), ['passed', 'unchecked']);
  assert.equal(r.workflows[1].reason, 'did not finish before the time limit');
  assert.equal(r.error, 'took longer than 1000 ms');
});

test('a run that failed outright checks nothing', () => {
  const r = compareResults(scenario, { status: 'error', error: 'Error: database unavailable', workflows: [] });
  assert.equal(r.verdict, 'error');
  assert.ok(r.workflows.every((w) => w.verdict === 'unchecked'));
});

// ---- End to end: the engine against the generator's independent expectations ----

test('the real engine passes generated scenarios whose expectations come from independent rules', async () => {
  for (const seed of [21, 22, 23]) {
    const s = generateScenario({ seed, workflows: 8 });
    const r = compareResults(s, await runInSandbox(s));
    assert.equal(r.verdict, 'passed', `seed ${seed}: ${r.workflows.flatMap((w) => w.mismatches.map((m) => m.message)).join('; ')}`);
  }
});

test('a wrong expectation in a real run is caught', async () => {
  const s = generateScenario({ seed: 21, workflows: 3 });
  // Claim a low-risk first step should have needed approval.
  const w = s.workflows.find((x) => x.expect.steps[0].riskLevel === 'low');
  w.expect.steps = w.expect.steps.map((e, j) => (j === 0 ? { riskLevel: 'high', outcome: 'awaiting_approval' } : { outcome: 'pending' }));
  w.expect.final = 'awaiting_approval';
  const r = compareResults(s, await runInSandbox(s));
  assert.equal(r.verdict, 'failed');
  assert.ok(r.workflows.find((x) => x.id === w.id).mismatches.some((m) => m.severity === 'critical'));
});
