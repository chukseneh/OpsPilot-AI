// The STORY-008 demo runs end to end. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runRoiDemo } from '../src/demo/roi.js';

test('demo: savings shown, optimism flagged against evidence, errors refused, all logged with assumptions', async () => {
  const r = await runRoiDemo({ print: () => {} });

  // Acceptance 1: estimated savings shown — and evidence that MATCHES raises no false alarm.
  assert.equal(r.base.status, 'ok');
  assert.deepEqual(r.base.warnings, []);
  assert.ok(r.base.assumptions.timeSavings.every((t) => t.evidence?.analysisId === 'AN-invoices-year'), 'the sensible estimate is linked to a year of observed processing');
  assert.equal(r.base.result.expected.annualSavings, 3766000);
  assert.ok(r.base.result.low.netBenefit < r.base.result.expected.netBenefit);
  assert.ok(r.base.result.savings.every((s) => s.formula));

  // Acceptance 2: incorrect assumptions flagged, against both kinds of evidence.
  assert.equal(r.optimistic.status, 'needs_review');
  const codes = r.optimistic.warnings.map((w) => w.code);
  for (const c of ['automation_rate_high', 'volume_differs', 'duration_differs', 'amount_differs', 'roi_very_high']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('evidence_period_short'), 'a year of evidence is long enough to scale');

  // Failure paths.
  assert.equal(r.inputError.name, 'RoiInputError');
  assert.equal(r.inputError.problems.length, 3);
  assert.match(r.calculationError, /^CalculationError:/);
  assert.equal(r.repeat.calculatedAt, r.base.calculatedAt);
  assert.match(r.refused, /PermissionDeniedError/);

  // Trust: every calculation (and refusal) logged with its assumptions.
  const calculated = r.entries.filter((e) => e.action === 'roi.calculated');
  assert.equal(calculated.length, 2);
  assert.ok(calculated.every((e) => e.detail.assumptions && e.rationale));
  assert.ok(r.entries.find((e) => e.action === 'roi.rejected').detail.assumptions.horizonYear === 3, 'even the mistyped input is logged as submitted');
  assert.equal(r.audit.ok, true);
});
