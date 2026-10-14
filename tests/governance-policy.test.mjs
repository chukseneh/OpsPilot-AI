// Governance policy packs and misconfiguration alerts (STORY-009). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validatePolicy } from '../src/governance/policy.js';

const TODAY = new Date('2026-10-12T00:00:00Z');
const pack = (over = {}) => ({
  jurisdiction: { code: 'UK', name: 'United Kingdom' },
  illustrative: true,
  sources: [{ id: 'src-a', title: 'Example regulation A', url: 'https://example.org/a' }, { id: 'src-b', title: 'Example regulation B' }],
  reviewBy: '2027-03-31',
  controls: {
    approvals: { highRiskActionsNeedApproval: true, personalDataActionsNeedApproval: true, approvalDeadlineHours: 24, escalateAfterHours: 4, source: 'src-a' },
    riskRules: { highRiskDataCategories: ['sensitive_personal'], humanOversightRequiredFor: ['significant', 'critical'], source: 'src-a' },
    recordKeeping: { auditRetentionDays: 2190, documentRetentionDays: 2190, auditReaderRoles: ['security officer', 'compliance officer'], source: 'src-b' },
  },
  ...over,
});
const withControl = (name, over) => { const p = pack(); p.controls[name] = { ...p.controls[name], ...over }; return p; };
const check = (p) => validatePolicy(p, { today: TODAY });
const errors = (p) => check(p).alerts.filter((a) => a.severity === 'error').map((a) => `${a.control}: ${a.message}`);
const warnings = (p) => check(p).alerts.filter((a) => a.severity === 'warning').map((a) => `${a.control}: ${a.message}`);

test('a well-formed pack is accepted with no alerts', () => {
  const r = check(pack());
  assert.deepEqual(r.alerts, []);
  assert.equal(r.ok, true);
  assert.equal(r.policy.controls.approvals.approvalDeadlineHours, 24);
});

// ---- Acceptance 2 / failure path: misconfiguration alerts ----

test('a jurisdiction can never switch off approval of high-risk actions (system floor, REQ-007)', () => {
  const r = check(withControl('approvals', { highRiskActionsNeedApproval: false }));
  assert.equal(r.ok, false);
  const alert = r.alerts.find((a) => a.control === 'controls.approvals.highRiskActionsNeedApproval');
  assert.match(alert.message, /cannot be switched off: human approval of high-risk actions is required everywhere/);
  assert.equal(alert.source, 'src-a', 'the alert names the source the control cites');
});

test('audit retention below a year is refused (system floor, REQ-008)', () => {
  assert.match(errors(withControl('recordKeeping', { auditRetentionDays: 180, documentRetentionDays: 90 })).join(), /180 days is below the system floor of 365/);
});

test('contradictions are caught: escalation after the deadline; documents outliving their audit trail', () => {
  assert.match(errors(withControl('approvals', { escalateAfterHours: 48 })).join(), /escalation \(48 h\) must come before the deadline \(24 h\)/);
  assert.match(errors(withControl('recordKeeping', { documentRetentionDays: 3000 })).join(), /documents would be kept \(3000 days\) longer than the audit trail about them \(2190 days\)/);
});

test('unknown names, wrong kinds and broken references are each named', () => {
  assert.match(errors(withControl('approvals', { approvalDeadlineHour: 24 })).join(), /approvalDeadlineHour: is not a known setting/);
  assert.match(errors(withControl('approvals', { personalDataActionsNeedApproval: 'yes' })).join(), /must be true or false \(got "yes"\)/);
  assert.match(errors(withControl('approvals', { approvalDeadlineHours: 0 })).join(), /must be a number above 0/);
  assert.match(errors(withControl('riskRules', { highRiskDataCategories: ['health'] })).join(), /unknown value\(s\) "health"; allowed: public, internal/);
  assert.match(errors(withControl('riskRules', { humanOversightRequiredFor: ['huge'] })).join(), /unknown value\(s\) "huge"/);
  assert.match(errors(withControl('recordKeeping', { auditReaderRoles: ['auditor'] })).join(), /unknown value\(s\) "auditor"/);
  assert.match(errors(withControl('recordKeeping', { auditReaderRoles: [] })).join(), /must not be empty/);
  assert.match(errors(withControl('recordKeeping', { auditRetentionDays: 365.5 })).join(), /must be a whole number above 0/);
  assert.match(errors(withControl('riskRules', { source: 'src-z' })).join(), /"src-z" is not one of the listed sources/);
  const p = pack(); p.controls.dataResidency = {};
  assert.match(errors(p).join(), /controls.dataResidency: is not a known control/);
  const missing = pack(); delete missing.controls.recordKeeping;
  assert.match(errors(missing).join(), /controls.recordKeeping: is missing/);
});

test('the pack itself: jurisdiction, illustrative flag, sources and review date are checked', () => {
  assert.match(errors(pack({ jurisdiction: { code: 'uk', name: 'UK' } })).join(), /"uk" must look like UK, EU or US-CA/);
  assert.match(errors(pack({ illustrative: 'maybe' })).join(), /must say true \(an example, not legal advice\) or false/);
  assert.match(errors(pack({ sources: [] })).join(), /at least one legal or regulatory source/);
  assert.match(errors(pack({ sources: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }], controls: undefined })).join(), /"a" is listed twice/);
  assert.match(errors(pack({ sources: [{ id: 'src-a', title: 'A', url: 'http://insecure' }, { id: 'src-b', title: 'B' }] })).join(), /must be an https:\/\/ link/);
  assert.match(errors(pack({ reviewBy: '31/03/2027' })).join(), /reviewBy: must be a date written YYYY-MM-DD/);
  assert.match(errors(pack({ jurisdcition: 'x' })).join(), /jurisdcition: is not a known part of a policy/);
  assert.deepEqual(check('nope').alerts.map((a) => a.message), ['must be an object']);
});

// ---- Failure path: regulatory updates (out-of-date rules are flagged) ----

test('a review date in the past warns that the rules may be out of date; one far away warns too', () => {
  assert.match(warnings(pack({ reviewBy: '2026-01-01' })).join(), /review date 2026-01-01 has passed: the rules may be out of date/);
  assert.match(warnings(pack({ reviewBy: '2030-01-01' })).join(), /more than 2 years away/);
  assert.equal(check(pack({ reviewBy: '2026-01-01' })).ok, true, 'a warning does not block approval');
});

test('warnings: a control with no source, and very long retention', () => {
  const p = pack(); delete p.controls.riskRules.source;
  assert.match(warnings(p).join(), /controls.riskRules: cites no source/);
  assert.match(warnings(withControl('recordKeeping', { auditRetentionDays: 4000, documentRetentionDays: 4000 })).join(), /4000 days is more than 10 years/);
});

test('every alert is named, explained and graded', () => {
  for (const a of check(withControl('approvals', { highRiskActionsNeedApproval: false, escalateAfterHours: 30 })).alerts) {
    assert.ok(['error', 'warning'].includes(a.severity) && a.control && a.message);
  }
});
