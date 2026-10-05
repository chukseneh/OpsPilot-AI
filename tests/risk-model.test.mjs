// Rule-based risk model (STORY-003). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRuleBasedRiskModel, checkModelOutput, overallRiskLevel, RiskModelError, RISK_CATEGORIES, SEVERITIES,
} from '../src/risk/riskModel.js';

const system = (over = {}) => ({
  id: 'ai-x', name: 'X', department: 'Ops', purpose: 'p', owner: 'o', status: 'active',
  dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false, ...over,
});
const model = createRuleBasedRiskModel();
const rulesFired = (s) => model.assess(s).risks.map((r) => r.rule);

test('a high-impact system deciding about people with no oversight gets categorised risks, worst first', () => {
  const { risks } = model.assess(system({
    dataCategories: ['personal'], decisionImpact: 'significant', humanOversight: 'none', userFacing: true,
  }));
  assert.deepEqual(risks.map((r) => [r.category, r.severity]), [
    ['human_oversight', 'high'],
    ['privacy', 'medium'],
    ['fairness', 'medium'],
    ['transparency', 'medium'],
  ]);
  for (const r of risks) {
    assert.ok(RISK_CATEGORIES.includes(r.category));
    assert.ok(SEVERITIES.includes(r.severity));
    assert.ok(r.why.length > 0);
    assert.ok(r.mitigations.length > 0, `${r.rule} suggests a mitigation`);
  }
  assert.equal(overallRiskLevel(risks), 'high');
});

test('sensitive personal data raises privacy, fairness and security risks', () => {
  const { risks } = model.assess(system({ dataCategories: ['sensitive_personal'], decisionImpact: 'significant', humanOversight: 'approval' }));
  const byRule = Object.fromEntries(risks.map((r) => [r.rule, r.severity]));
  assert.deepEqual(byRule, { 'privacy.personal-data': 'high', 'fairness.decisions-about-people': 'high', 'security.sensitive-data': 'medium' });
  assert.match(risks.find((r) => r.category === 'security').why, /sensitive personal data/);
});

test('oversight: approval clears it, review is only enough below critical', () => {
  assert.ok(!rulesFired(system({ decisionImpact: 'critical', humanOversight: 'approval' })).includes('human_oversight.missing'));
  assert.ok(!rulesFired(system({ decisionImpact: 'significant', humanOversight: 'review' })).includes('human_oversight.missing'));
  const critical = model.assess(system({ decisionImpact: 'critical', humanOversight: 'review' })).risks;
  assert.equal(critical.find((r) => r.rule === 'human_oversight.missing').severity, 'medium');
});

test('a low-impact internal system raises nothing and rates low', () => {
  const { risks } = model.assess(system());
  assert.deepEqual(risks, []);
  assert.equal(overallRiskLevel(risks), 'low');
});

test('a retired system is flagged for accountability', () => {
  assert.deepEqual(rulesFired(system({ status: 'retired' })), ['accountability.inactive-status']);
});

test('an aborted signal stops the model', () => {
  const ac = new AbortController();
  ac.abort(new Error('timed out'));
  assert.throws(() => model.assess(system(), { signal: ac.signal }), /timed out/);
});

test('a malformed model output is refused as a RiskModelError, never reported as a finding', () => {
  const ok = { category: 'privacy', severity: 'low', rule: 'r', why: 'w', mitigations: ['m'] };
  const bad = [
    [null, /did not return/],
    [{ risks: 'none' }, /did not return/],
    [{ risks: [{ ...ok, category: 'vibes' }] }, /unknown category/],
    [{ risks: [{ ...ok, severity: 'extreme' }] }, /unknown severity/],
    [{ risks: [{ ...ok, why: '' }] }, /say why/],
    [{ risks: [{ ...ok, rule: undefined }] }, /name the rule/],
    [{ risks: [{ ...ok, mitigations: [] }] }, /no suggested mitigation/],
    [{ risks: [ok, 7] }, /risk #2 is not an object/],
  ];
  for (const [output, message] of bad) {
    assert.throws(() => checkModelOutput(output), (err) => err instanceof RiskModelError && message.test(err.message));
  }
});

test('a well-formed model output comes back sorted worst first', () => {
  const out = checkModelOutput({ risks: [
    { category: 'transparency', severity: 'low', rule: 'a', why: 'w', mitigations: ['m'] },
    { category: 'security', severity: 'high', rule: 'b', why: 'w', mitigations: ['m'] },
  ] });
  assert.deepEqual(out.risks.map((r) => r.rule), ['b', 'a']);
});
