// The STORY-009 demo runs end to end. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runGovernanceDemo } from '../src/demo/governance.js';
import { isDecision } from '../src/audit/decisions.js';

test('demo: EU controls change behaviour, misconfiguration and unauthorised changes refused, updates dated, all logged', async () => {
  const r = await runGovernanceDemo({ print: () => {} });

  // Acceptance 1: once the EU policy is approved, the controls reflect it.
  assert.deepEqual([r.before.riskLevel, r.before.approval, r.before.keepUntil], ['medium', 'runs automatically', 'not set']);
  assert.deepEqual([r.after.riskLevel, r.after.approval, r.after.riskModel], ['high', 'needs approval (deadline 48 h)', '1+EU.v1']);
  assert.match(r.after.policyReason, /Under the EU governance policy \(version 1\)/);
  assert.notEqual(r.after.keepUntil, 'not set');

  // Acceptance 2: misconfiguration alerts the user, every alert.
  assert.equal(r.misconfigured.name, 'PolicyMisconfiguredError');
  assert.equal(r.misconfigured.alerts.filter((a) => a.severity === 'error').length, 3);

  // Unauthorised configuration changes.
  assert.match(r.selfApproval, /two-person rule/);
  assert.match(r.unauthorised, /PermissionDeniedError/);

  // Regulatory updates: dated version takes over on its date; review overdue alerted.
  assert.deepEqual([r.afterUpdate.version, r.afterUpdate.controls.approvals.approvalDeadlineHours], [2, 24]);
  assert.deepEqual(r.overdue, [{ jurisdiction: 'EU', version: 2, reviewBy: '2027-06-30' }]);

  // Trust: configuration changes logged, with diffs and rationale; chain intact.
  const actions = r.entries.map((e) => e.action);
  for (const a of ['governance.proposal_refused', 'governance.proposed', 'governance.decision_refused', 'governance.denied', 'governance.approved', 'governance.applied', 'governance.review_overdue']) {
    assert.ok(actions.includes(a), a);
  }
  const v2 = r.entries.filter((e) => e.action === 'governance.approved').at(-1);
  assert.deepEqual(v2.detail.diff.map((d) => d.path), ['controls.approvals.approvalDeadlineHours', 'reviewBy']);
  assert.ok(r.entries.every((e) => e.at && e.actor.id && (!isDecision(e.action) || e.rationale)));
  assert.equal(r.audit.ok, true);
});
