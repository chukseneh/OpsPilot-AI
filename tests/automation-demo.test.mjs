// The STORY-005 demo runs end to end. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAutomationDemo } from '../src/demo/automation.js';

test('demo: low runs unattended, high waits for a second person, delays expire, failures resume, all logged with risk', async () => {
  const r = await runAutomationDemo({ print: () => {} });

  // Acceptance 2: low risk executes automatically.
  assert.equal(r.low.run.status, 'completed');
  assert.ok(r.low.actions.every((a) => a.riskLevel === 'low' && a.status === 'succeeded' && !a.decidedBy));

  // Acceptance 1: high risk requires human approval — and not the starter's.
  assert.match(r.selfApproval, /person who started a workflow may not decide/);
  assert.equal(r.cvAfterApproval.status, 'paused');

  // Failure path: approval delays — escalated, then expired; the payment never ran.
  assert.equal(r.expiredWorkflow.run.status, 'expired');
  assert.deepEqual(r.expiredWorkflow.actions.map((a) => a.status), ['succeeded', 'succeeded', 'expired', 'skipped']);
  assert.equal(r.executors.payment.calls, 0);
  assert.match(r.lateApproval, /not waiting for approval \(it is expired\)/);

  // Failure path: incorrect risk categorisation — the "low" label is overruled.
  assert.equal(r.mislabelled.actions[0].status, 'awaiting_approval');
  assert.ok(r.mislabelled.actions[0].riskReasons.some((x) => x.rule === 'declared.low_ignored'));

  // Failure path: automation failure — stopped, then resumed to completion.
  assert.equal(r.failed.run.status, 'failed');
  assert.equal(r.resumed.run.status, 'completed');

  // Trust: every action entry carries a risk level; the chain verifies.
  const actionEntries = r.entries.filter((e) => /^workflow\.(action_|approval_)/.test(e.action));
  assert.ok(actionEntries.length > 10);
  assert.ok(actionEntries.every((e) => ['low', 'high'].includes(e.detail.riskLevel)), 'every action entry has a risk level');
  const executed = r.entries.filter((e) => e.action === 'workflow.action_executed');
  assert.ok(executed.some((e) => e.detail.automatic === true));
  assert.ok(executed.some((e) => e.detail.automatic === false && e.detail.approvedBy === 'process-manager-2'));
  assert.equal(r.audit.ok, true);
});
