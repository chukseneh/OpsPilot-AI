// Simulation scenarios: synthetic marking, validation, and the generator (STORY-010). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateScenario, generateScenario, ScenarioError, RECIPES } from '../src/simulation/scenario.js';
import { examplePack } from '../src/governance/packs/index.js';

const system = (over = {}) => ({
  id: 'SYN-claims', name: 'Claims triage (SYNTHETIC)', department: 'Finance', purpose: 'Routes claims', owner: 'SYN-owner',
  status: 'active', dataCategories: ['personal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false, riskLevel: 'high', ...over,
});
const scenario = (over = {}) => ({
  id: 'SIM-1', synthetic: true, label: 'SYNTHETIC — invented for simulation',
  systems: [system()],
  workflows: [{
    id: 'SYN-WF-1', name: 'Notify then pay',
    actions: [{ type: 'notify', params: { systemId: 'SYN-claims' } }, { type: 'payment', params: { amount: 50 } }],
    decide: [{ step: 1, decision: 'approve' }],
    expect: { steps: [{ riskLevel: 'high', outcome: 'succeeded' }, { riskLevel: 'high', outcome: 'awaiting_approval' }], final: 'awaiting_approval' },
  }],
  ...over,
});
const problems = (s) => validateScenario(s).problems.map((p) => `${p.path} ${p.problem}`);
const withWorkflow = (over) => { const s = scenario(); s.workflows[0] = { ...s.workflows[0], ...over }; return s; };

test('a well-formed synthetic scenario is accepted', () => {
  assert.deepEqual(validateScenario(scenario()), { ok: true, problems: [] });
  assert.equal(validateScenario(scenario({ policy: 'EU' })).ok, true);
  assert.equal(validateScenario(scenario({ policy: examplePack('UK') })).ok, true, 'a draft policy object can be simulated too');
});

// ---- Acceptance 2: incorrect synthetic data is flagged; nothing runs ----

test('data not clearly marked synthetic is refused, so real records cannot be fed in by mistake', () => {
  const p = problems(scenario({ synthetic: false, label: 'Invoice workflows', systems: [system({ id: 'ai-claims', name: 'Claims triage' })] }));
  assert.ok(p.includes('synthetic must be true: only data marked as synthetic may be simulated'));
  assert.ok(p.some((x) => /^label must say SYNTHETIC/.test(x)));
  assert.ok(p.some((x) => /systems\[0\].id must start with "SYN-" \(got "ai-claims"\)/.test(x)));
  assert.ok(p.some((x) => /systems\[0\].name must contain "\(SYNTHETIC\)"/.test(x)));
  assert.ok(p.some((x) => /actions\[0\].params.systemId "SYN-claims" is not one of the scenario's synthetic systems/.test(x)));
  assert.match(problems(withWorkflow({ id: 'WF-real' })).join(), /workflows\[0\].id must start with "SYN-"/);
});

test('synthetic systems are checked the way the inventory checks real ones', () => {
  const { owner, ...noOwner } = system();
  assert.match(problems(scenario({ systems: [noOwner] })).join(), /systems\[0\].owner is missing/);
  assert.match(problems(scenario({ systems: [system({ dataCategories: ['health'] })] })).join(), /dataCategories has unknown value\(s\) "health"/);
  assert.match(problems(scenario({ systems: [system({ riskLevel: 'severe' })] })).join(), /riskLevel must be one of: low, medium, high, unassessed/);
  assert.match(problems(scenario({ systems: [system(), system()] })).join(), /"SYN-claims" is used twice/);
});

test('expectations that cannot be checked are refused', () => {
  const steps = [{ riskLevel: 'high', outcome: 'succeeded' }];
  assert.match(problems(withWorkflow({ expect: { steps, final: 'awaiting_approval' } })).join(), /has 1 expectation\(s\) for 2 action\(s\)/);
  const both = problems(withWorkflow({ expect: { steps: [...steps, { outcome: 'done' }], final: 'x' } })).join();
  assert.match(both, /steps\[1\].outcome must be one of/);
  assert.match(both, /expect.final must be one of/);
  assert.match(problems(withWorkflow({ expect: { steps: [{ riskLevel: 'medium', outcome: 'succeeded' }, { riskLevel: 'high', outcome: 'awaiting_approval' }], final: 'awaiting_approval' } })).join(), /riskLevel must be low or high/);
  assert.match(problems(withWorkflow({ expect: { steps: [{ riskLevel: 'high', outcome: 'succeeded' }, { riskLevel: 'low', outcome: 'pending' }], final: 'awaiting_approval' } })).join(), /a step that is pending never ran, so it has no risk level to expect/);
  assert.match(problems(withWorkflow({ expect: undefined })).join(), /expect must be \{ steps: \[\.\.\.\], final \}/);
});

test('scripted decisions must fit the expectations', () => {
  assert.match(problems(withWorkflow({ decide: [{ step: 2, decision: 'approve' }] })).join(), /step 2 is expected to be high risk and awaiting_approval, which a person who approves it cannot produce/);
  assert.match(problems(withWorkflow({ decide: [{ step: 1, decision: 'reject' }] })).join(), /a person who rejects it cannot produce/);
  assert.match(problems(withWorkflow({ decide: [{ step: 7, decision: 'approve' }] })).join(), /there is no step 7/);
  assert.match(problems(withWorkflow({ decide: [{ step: 1, decision: 'maybe' }] })).join(), /must be \{ step, decision: "approve" \| "reject" \}/);
});

test('policy, workflow list and sizes are checked', () => {
  assert.match(problems(scenario({ policy: 'FR' })).join(), /"FR" is not an example pack \(available: UK, EU\)/);
  const bad = examplePack('UK'); bad.controls.approvals.highRiskActionsNeedApproval = false;
  assert.match(problems(scenario({ policy: bad })).join(), /cannot be switched off/);
  assert.match(problems(scenario({ workflows: [] })).join(), /at least one workflow/);
  assert.match(problems(withWorkflow({ actions: Array.from({ length: 21 }, () => ({ type: 'notify' })) })).join(), /has 21; the limit is 20/);
  assert.deepEqual(problems('nope'), ['scenario must be an object']);
});

// ---- The generator, and the data generation errors failure path ----

test('the generator makes valid, clearly synthetic scenarios, the same for the same seed', () => {
  const a = generateScenario({ seed: 7, workflows: 20 });
  assert.deepEqual(a, generateScenario({ seed: 7, workflows: 20 }));
  assert.notDeepEqual(a, generateScenario({ seed: 8, workflows: 20 }));
  assert.equal(validateScenario(a).ok, true);
  assert.equal(a.workflows.length, 20);
  assert.ok(a.workflows.every((w) => w.id.startsWith('SYN-') && w.name.includes('(SYNTHETIC)')));
});

test('generated expectations follow the documented flow: low runs until the first high step, which waits; the rest stay pending', () => {
  for (const w of generateScenario({ seed: 3, workflows: 40 }).workflows) {
    const firstWait = w.expect.steps.findIndex((s) => s.outcome === 'awaiting_approval');
    w.expect.steps.forEach((s, j) => {
      if (firstWait === -1 || j < firstWait) assert.deepEqual(s, { riskLevel: 'low', outcome: 'succeeded' });
      else if (j > firstWait) assert.deepEqual(s, { outcome: 'pending' });
    });
    assert.equal(w.expect.final, firstWait === -1 ? 'completed' : 'awaiting_approval');
  }
});

test('a generator bug is caught as a data generation error before anything runs', () => {
  const broken = [...RECIPES, { make: () => ({ type: 'notify', params: { systemId: 'SYN-does-not-exist' } }), expectedRisk: 'low' }];
  assert.throws(() => { for (let seed = 1; seed < 50; seed += 1) generateScenario({ seed, workflows: 10, recipes: broken }); }, (err) => {
    assert.ok(err instanceof ScenarioError);
    assert.equal(err.generated, true);
    assert.match(err.message, /^The synthetic data generator produced invalid data .*"SYN-does-not-exist" is not one of the scenario's synthetic systems/);
    return true;
  });
});
