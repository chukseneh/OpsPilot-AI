// Property tests for STORY-009's central safety promise: a jurisdiction's policy
// can only ADD to the built-in rules, never remove or weaken one. Run with: npm test
//
// Over thousands of random policies, AI systems and actions (seeded, so any
// failure can be reproduced from the run number it prints).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validatePolicy, KNOWN_ROLES } from '../src/governance/policy.js';
import { examplePack } from '../src/governance/packs/index.js';
import { createRuleBasedRiskModel, createPolicyAwareRiskModel, overallRiskLevel, SEVERITIES } from '../src/risk/riskModel.js';
import { classifyAction } from '../src/automation/actionRisk.js';
import { DATA_CATEGORIES, DECISION_IMPACTS, HUMAN_OVERSIGHT, SYSTEM_STATUSES } from '../src/risk/systemData.js';

const RUNS = 2000;
const TODAY = new Date('2026-10-14T00:00:00Z');

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
const gen = (r) => {
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (xs) => xs[int(0, xs.length - 1)];
  const subset = (xs, { nonEmpty = false } = {}) => { const s = xs.filter(() => r() < 0.5); return nonEmpty && !s.length ? [pick(xs)] : s; };

  // A random VALID policy, as validatePolicy accepts and services see it.
  const policy = () => {
    const p = examplePack(pick(['UK', 'EU']));
    const deadline = int(2, 720);
    const audit = int(365, 4000);
    p.controls.approvals = { ...p.controls.approvals, personalDataActionsNeedApproval: r() < 0.5, approvalDeadlineHours: deadline, escalateAfterHours: int(1, deadline - 1) };
    p.controls.riskRules = { ...p.controls.riskRules, highRiskDataCategories: subset(DATA_CATEGORIES), humanOversightRequiredFor: subset(DECISION_IMPACTS) };
    p.controls.recordKeeping = { ...p.controls.recordKeeping, auditRetentionDays: audit, documentRetentionDays: int(1, audit), auditReaderRoles: subset(KNOWN_ROLES, { nonEmpty: true }) };
    return p;
  };
  const inForce = (p) => ({ jurisdiction: p.jurisdiction, version: int(1, 9), controls: p.controls });
  const system = () => ({
    id: 'ai-x', name: 'X', department: 'D', purpose: 'P', owner: 'O',
    status: pick(SYSTEM_STATUSES), dataCategories: subset(DATA_CATEGORIES, { nonEmpty: true }),
    decisionImpact: pick(DECISION_IMPACTS), humanOversight: pick(HUMAN_OVERSIGHT), userFacing: r() < 0.5,
    riskLevel: pick(['low', 'medium', 'high', 'unassessed']),
  });
  const action = () => {
    const type = pick(['notify', 'create_ticket', 'inventory.update_status', 'payment', 'something_unknown']);
    const params = r() < 0.7 ? { systemId: 'ai-x' } : {};
    if (type === 'inventory.update_status' && r() < 0.8) params.status = pick(SYSTEM_STATUSES);
    if (type === 'payment') params.amount = pick([undefined, 10, 500, 5000]);
    return { type, params, irreversible: r() < 0.1, ...(r() < 0.2 ? { declaredRisk: pick(['low', 'high']) } : {}) };
  };
  return { policy, inForce, system, action, int, pick };
};
const rank = (sev) => SEVERITIES.indexOf(sev);
const fail = (run, seed, what, data) => `run ${run} of seed ${seed}: ${what}\n${JSON.stringify(data)}`;

test('the generator makes valid policies (so the properties below test real ones)', () => {
  const g = gen(rng(1));
  for (let run = 1; run <= RUNS; run += 1) {
    const p = g.policy();
    const v = validatePolicy(p, { today: TODAY });
    assert.equal(v.ok, true, fail(run, 1, 'generated policy invalid', v.alerts));
  }
});

test('risk: a policy never lowers a rating, and every built-in risk survives at the same or higher severity', () => {
  const g = gen(rng(2));
  for (let run = 1; run <= RUNS; run += 1) {
    const p = g.inForce(g.policy());
    const s = g.system();
    const base = createRuleBasedRiskModel().assess(s).risks;
    const withPolicy = createPolicyAwareRiskModel({ current: () => p }).assess(s).risks;
    assert.ok(rank(overallRiskLevel(withPolicy)) >= rank(overallRiskLevel(base)), fail(run, 2, 'overall rating went down', { p: p.controls.riskRules, s }));
    for (const b of base) {
      const kept = withPolicy.find((x) => x.rule === b.rule);
      assert.ok(kept && rank(kept.severity) >= rank(b.severity), fail(run, 2, `built-in risk ${b.rule} removed or weakened`, { p: p.controls.riskRules, s }));
    }
  }
});

test('approvals: a policy never lowers an action\'s level, and every built-in reason for approval survives', () => {
  const g = gen(rng(3));
  for (let run = 1; run <= RUNS; run += 1) {
    const p = g.inForce(g.policy());
    const s = g.system();
    const a = g.action();
    const base = classifyAction(a, { system: s });
    const withPolicy = classifyAction(a, { system: s, policy: p });
    if (base.level === 'high') assert.equal(withPolicy.level, 'high', fail(run, 3, 'a high-risk action became low', { a, s, p: p.controls.approvals }));
    const raised = (x) => x.reasons.filter((y) => y.effect === 'high').map((y) => y.rule);
    for (const rule of raised(base)) assert.ok(raised(withPolicy).includes(rule), fail(run, 3, `reason ${rule} removed`, { a, s }));
  }
});

test('system floors: no policy that switches off high-risk approval or keeps audit records under a year ever validates', () => {
  const g = gen(rng(4));
  for (let run = 1; run <= RUNS; run += 1) {
    const p = g.policy();
    if (g.pick([true, false])) p.controls.approvals.highRiskActionsNeedApproval = false;
    else { p.controls.recordKeeping.auditRetentionDays = g.int(1, 364); p.controls.recordKeeping.documentRetentionDays = 1; }
    assert.equal(validatePolicy(p, { today: TODAY }).ok, false, fail(run, 4, 'a floor-breaching policy validated', p.controls));
  }
});

test('validation never throws, whatever it is given; it only returns alerts', () => {
  const r = rng(5);
  const g = gen(r);
  const junk = [undefined, null, '', 'x', -1, 0, 1e309, Number.NaN, true, [], {}, [1, 2], { a: 1 }, '12', ' ', 3.5];
  for (let run = 1; run <= RUNS; run += 1) {
    const p = g.policy();
    const paths = [];
    const walk = (o, at) => { for (const [k, v] of Object.entries(o)) { paths.push([...at, k]); if (v && typeof v === 'object') walk(v, [...at, k]); } };
    walk(p, []);
    const path = paths[Math.floor(r() * paths.length)];
    let target = p;
    for (const k of path.slice(0, -1)) target = target[k];
    target[path.at(-1)] = junk[Math.floor(r() * junk.length)];
    let out;
    assert.doesNotThrow(() => { out = validatePolicy(p, { today: TODAY }); }, fail(run, 5, `threw for ${path.join('.')}`, null));
    assert.ok(Array.isArray(out.alerts) && out.alerts.every((a) => ['error', 'warning'].includes(a.severity) && a.control && a.message));
  }
});
