// Simulation scenarios (STORY-010, REQ-014): synthetic AI systems and workflows to
// run in a sandbox, with what each workflow is EXPECTED to do.
//
//   {
//     id: 'SIM-invoice-approvals', synthetic: true, label: 'SYNTHETIC — invented for simulation',
//     policy: 'EU',                       // optional: an illustrative STORY-009 pack (UK, EU) or a policy object
//     systems: [{ id: 'SYN-claims', name: 'Claims triage (SYNTHETIC)', riskLevel: 'high', …inventory fields }],
//     workflows: [{
//       id: 'SYN-WF-1', name: '…', actions: [ …STORY-005 actions… ],
//       decide: [{ step: 1, decision: 'approve' }],          // optional: scripted approvers
//       expect: { steps: [{ riskLevel: 'high', outcome: 'succeeded' }, { outcome: 'pending' }],
//                 final: 'completed' },
//     }],
//   }
//
// validateScenario() runs BEFORE anything is simulated and lists every problem
// with its place. "Incorrect synthetic data" never runs:
//   - data not clearly marked synthetic (synthetic: true, ids starting "SYN-",
//     names containing "(SYNTHETIC)") — so real records cannot be fed in by mistake;
//   - systems the inventory would refuse, or with an unknown risk level;
//   - actions naming a system that is not in the scenario; an unknown policy;
//   - expectations that cannot be checked (wrong number of steps, unknown outcome,
//     a decision for a step that is not expected to have been decided).
//
// generateScenario() makes larger synthetic scenarios from a seed. It works out the
// expected outcomes with its OWN simple rules (a recipe table below), not by
// calling the system's classifier — so a simulation of a generated scenario is a
// real second opinion on the engine, not the engine agreeing with itself. Its
// output goes through validateScenario too, so a generator bug is caught as a
// data generation error before anything runs.

import { validateSystems } from '../risk/systemData.js';
import { RUN_STATUSES, ACTION_STATUSES } from '../automation/workflows.js';
import { validatePolicy } from '../governance/policy.js';
import { EXAMPLE_JURISDICTIONS } from '../governance/packs/index.js';

export const SYNTHETIC_PREFIX = 'SYN-';
export const SYNTHETIC_MARK = '(SYNTHETIC)';
export const LIMITS = Object.freeze({ systems: 500, workflows: 200, actionsPerWorkflow: 20 });
const RISK_LEVELS = ['low', 'medium', 'high', 'unassessed'];
const DECIDED = { approve: ['succeeded', 'failed'], reject: ['rejected'] };
// Steps that never ran have no risk level to compare.
const NOT_REACHED = ['pending', 'skipped'];

export class ScenarioError extends Error {
  constructor(problems, { generated = false } = {}) {
    super(`${generated ? 'The synthetic data generator produced invalid data' : 'The scenario is invalid'} (${problems.length} problem(s)): ${problems.map((p) => `${p.path} ${p.problem}`).join('; ')}`);
    this.name = 'ScenarioError';
    this.problems = problems;
    this.generated = generated;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export function validateScenario(scenario, { today = new Date() } = {}) {
  const problems = [];
  const problem = (path, text) => problems.push({ path, problem: text });
  if (!isObject(scenario)) return { ok: false, problems: [{ path: 'scenario', problem: 'must be an object' }] };

  // ---- Clearly synthetic ----
  if (scenario.synthetic !== true) problem('synthetic', 'must be true: only data marked as synthetic may be simulated');
  if (!isNonEmpty(scenario.id)) problem('id', 'is missing');
  if (!isNonEmpty(scenario.label) || !scenario.label.includes('SYNTHETIC')) problem('label', 'must say SYNTHETIC, so nobody mistakes the scenario for real records');

  // ---- Policy (optional) ----
  if (scenario.policy !== undefined) {
    if (typeof scenario.policy === 'string') {
      if (!EXAMPLE_JURISDICTIONS.includes(scenario.policy)) problem('policy', `"${scenario.policy}" is not an example pack (available: ${EXAMPLE_JURISDICTIONS.join(', ')})`);
    } else {
      const v = validatePolicy(scenario.policy, { today });
      for (const a of v.alerts.filter((x) => x.severity === 'error')) problem(`policy.${a.control}`, a.message);
    }
  }

  // ---- Systems ----
  const systemIds = new Set();
  if (!Array.isArray(scenario.systems)) problem('systems', 'must be a list (it may be empty)');
  else {
    if (scenario.systems.length > LIMITS.systems) problem('systems', `has ${scenario.systems.length} entries; the limit is ${LIMITS.systems}`);
    scenario.systems.forEach((s, i) => {
      const at = `systems[${i}]`;
      if (!isObject(s)) { problem(at, 'must be an object'); return; }
      if (!isNonEmpty(s.id) || !s.id.startsWith(SYNTHETIC_PREFIX)) problem(`${at}.id`, `must start with "${SYNTHETIC_PREFIX}" (got ${JSON.stringify(s.id)})`);
      if (!isNonEmpty(s.name) || !s.name.includes(SYNTHETIC_MARK)) problem(`${at}.name`, `must contain "${SYNTHETIC_MARK}" (got ${JSON.stringify(s.name)})`);
      if (!RISK_LEVELS.includes(s.riskLevel)) problem(`${at}.riskLevel`, `must be one of: ${RISK_LEVELS.join(', ')}`);
      if (isNonEmpty(s.id)) {
        if (systemIds.has(s.id)) problem(`${at}.id`, `"${s.id}" is used twice`);
        systemIds.add(s.id);
      }
      const { riskLevel, ...record } = s;
      const v = validateSystems([record]);
      for (const p of v.incomplete[0]?.problems ?? []) problem(`${at}.${p.field ?? ''}`.replace(/\.$/, ''), p.problem);
    });
  }

  // ---- Workflows and what they are expected to do ----
  if (!Array.isArray(scenario.workflows) || scenario.workflows.length === 0) problem('workflows', 'must list at least one workflow to simulate');
  else {
    if (scenario.workflows.length > LIMITS.workflows) problem('workflows', `has ${scenario.workflows.length} entries; the limit is ${LIMITS.workflows}`);
    const wfIds = new Set();
    scenario.workflows.forEach((w, i) => {
      const at = `workflows[${i}]`;
      if (!isObject(w)) { problem(at, 'must be an object'); return; }
      if (!isNonEmpty(w.id) || !w.id.startsWith(SYNTHETIC_PREFIX)) problem(`${at}.id`, `must start with "${SYNTHETIC_PREFIX}" (got ${JSON.stringify(w.id)})`);
      else if (wfIds.has(w.id)) problem(`${at}.id`, `"${w.id}" is used twice`);
      else wfIds.add(w.id);
      if (!isNonEmpty(w.name)) problem(`${at}.name`, 'is missing');

      const actions = Array.isArray(w.actions) ? w.actions : null;
      if (!actions || actions.length === 0) problem(`${at}.actions`, 'must list at least one action');
      else if (actions.length > LIMITS.actionsPerWorkflow) problem(`${at}.actions`, `has ${actions.length}; the limit is ${LIMITS.actionsPerWorkflow}`);
      (actions ?? []).forEach((a, j) => {
        if (!isObject(a) || !isNonEmpty(a.type)) problem(`${at}.actions[${j}]`, 'must have a type');
        else if (a.params?.systemId !== undefined && !systemIds.has(a.params.systemId)) problem(`${at}.actions[${j}].params.systemId`, `"${a.params.systemId}" is not one of the scenario's synthetic systems`);
      });

      const e = w.expect;
      if (!isObject(e) || !Array.isArray(e.steps)) { problem(`${at}.expect`, 'must be { steps: [...], final }'); return; }
      if (actions && e.steps.length !== actions.length) problem(`${at}.expect.steps`, `has ${e.steps.length} expectation(s) for ${actions.length} action(s)`);
      if (!RUN_STATUSES.includes(e.final)) problem(`${at}.expect.final`, `must be one of: ${RUN_STATUSES.join(', ')}`);
      e.steps.forEach((s, j) => {
        const sat = `${at}.expect.steps[${j}]`;
        if (!isObject(s) || !ACTION_STATUSES.includes(s.outcome) || s.outcome === 'running') { problem(`${sat}.outcome`, `must be one of: ${ACTION_STATUSES.filter((x) => x !== 'running').join(', ')}`); return; }
        if (NOT_REACHED.includes(s.outcome)) { if (s.riskLevel !== undefined) problem(`${sat}.riskLevel`, `a step that is ${s.outcome} never ran, so it has no risk level to expect`); }
        else if (s.riskLevel !== 'low' && s.riskLevel !== 'high') problem(`${sat}.riskLevel`, 'must be low or high');
      });

      (w.decide ?? []).forEach((d, j) => {
        const dat = `${at}.decide[${j}]`;
        if (!isObject(d) || !Number.isInteger(d.step) || !DECIDED[d.decision]) { problem(dat, 'must be { step, decision: "approve" | "reject" }'); return; }
        const expected = e.steps[d.step - 1];
        if (!expected) { problem(`${dat}.step`, `there is no step ${d.step}`); return; }
        if (expected.riskLevel !== 'high' || !DECIDED[d.decision].includes(expected.outcome)) {
          problem(`${dat}.step`, `step ${d.step} is expected to be ${expected.riskLevel ?? 'never reached'} risk and ${expected.outcome}, which a person who ${d.decision}s it cannot produce`);
        }
      });
    });
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// The generator. Each recipe makes one action and says, by its OWN rule, what risk
// level it must get. The rules are deliberately few and unambiguous.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RECIPES = Object.freeze([
  // A notification about a low-risk, internal-data system: low.
  { make: ({ low }) => ({ type: 'notify', params: { systemId: low.id, to: 'owner' } }), expectedRisk: 'low' },
  // A ticket about nothing in particular: low.
  { make: () => ({ type: 'create_ticket', params: { title: 'Routine check' } }), expectedRisk: 'low' },
  // Any payment: high (payments always need a person).
  { make: ({ int }) => ({ type: 'payment', params: { amount: int(10, 5000), to: 'SYN-vendor' } }), expectedRisk: 'high' },
  // A notification about a high-risk system: high.
  { make: ({ high }) => ({ type: 'notify', params: { systemId: high.id, to: 'owner' } }), expectedRisk: 'high' },
]);

const baseSystem = (id, name, riskLevel, over = {}) => ({
  id, name: `${name} ${SYNTHETIC_MARK}`, department: 'Simulation', purpose: 'Invented for simulation', owner: 'SYN-owner',
  status: 'active', dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false, riskLevel, ...over,
});

export function generateScenario({ seed = 1, workflows = 5, recipes = RECIPES } = {}) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const systems = [
    baseSystem('SYN-sys-low', 'Generated low-risk system', 'low'),
    baseSystem('SYN-sys-high', 'Generated high-risk system', 'high', { dataCategories: ['personal'], decisionImpact: 'significant' }),
  ];
  const ctx = { low: systems[0], high: systems[1], int };

  const wfs = Array.from({ length: workflows }, (_, i) => {
    const steps = Array.from({ length: int(1, 4) }, () => recipes[int(0, recipes.length - 1)]);
    const actions = steps.map((rec) => rec.make(ctx));
    // The expected flow, by the engine's documented contract: low steps run until
    // the first high one, which waits; everything after it stays pending.
    const firstHigh = steps.findIndex((rec) => rec.expectedRisk === 'high');
    const expectSteps = steps.map((rec, j) => (firstHigh === -1 || j < firstHigh ? { riskLevel: 'low', outcome: 'succeeded' }
      : j === firstHigh ? { riskLevel: 'high', outcome: 'awaiting_approval' } : { outcome: 'pending' }));
    return {
      id: `SYN-WF-${seed}-${i + 1}`, name: `Generated workflow ${i + 1} ${SYNTHETIC_MARK}`, actions,
      expect: { steps: expectSteps, final: firstHigh === -1 ? 'completed' : 'awaiting_approval' },
    };
  });

  const scenario = { id: `SIM-generated-${seed}`, synthetic: true, label: `SYNTHETIC — generated from seed ${seed}`, systems, workflows: wfs };
  const v = validateScenario(scenario);
  if (!v.ok) throw new ScenarioError(v.problems, { generated: true });
  return scenario;
}
