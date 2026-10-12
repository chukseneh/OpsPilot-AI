// Flagging incorrect ROI assumptions: plausibility and evidence (STORY-008). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAssumptions } from '../src/roi/assumptions.js';
import { calculateRoi } from '../src/roi/calculate.js';
import { checkAssumptions, resolveThresholds, RoiThresholdError } from '../src/roi/checks.js';

const build = (over = {}) => {
  const r = validateAssumptions({
    name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
    timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32 }],
    costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800 }] },
    uncertainty: { savings: 0.2, costs: 0.1 },
    ...over,
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  return r.assumptions;
};
const check = async (a, lookups) => checkAssumptions(a, calculateRoi(a), lookups);
const codes = (ws) => ws.map((w) => w.code);

// A saved STORY-002 report: 500 "Enter invoice" steps in 30 days, median 6 minutes.
const REPORT = {
  scope: { period: { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' } },
  activities: [{ activity: 'Enter invoice', occurrences: 500, cases: 500, medianDuration: '6 min', medianDurationMs: 6 * 60000 }],
};
// A STORY-007 contract: 14,400 GBP over 36 months = 4,800 a year.
const CONTRACT = { status: 'extracted', kind: 'contract', fields: { contract_value: { value: 14400 }, currency: { value: 'GBP' }, term: { value: { months: 36 } } } };
const lookups = { lookupAnalysis: async (id) => (id === 'AN-1' ? REPORT : null), lookupDocument: async (id) => (id === 'doc_msa' ? CONTRACT : null) };

test('sensible assumptions backed by matching evidence raise no warnings', async () => {
  const a = build({
    timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32, evidence: { analysisId: 'AN-1', activity: 'enter invoice' } }],
    costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800, evidence: { documentId: 'doc_msa', field: 'contract_value' } }] },
  });
  assert.deepEqual(await check(a, lookups), []);
});

// ---- Acceptance 2 / failure path: incorrect assumptions ----

test('implausible assumptions are flagged, each saying which threshold and why', async () => {
  const ws = await check(build({
    timeSavings: [{ label: 'Enter invoice', casesPerYear: 60000, minutesPerCase: 6, automationRate: 0.98, costPerHour: 400 }],
    costs: { oneOff: [{ label: 'Implementation', amount: 0 }], perYear: [{ label: 'Licence', amount: 4800 }] },
    uncertainty: undefined,
  }));
  assert.deepEqual(codes(ws).sort(), ['automation_rate_high', 'cost_per_hour_unusual', 'hours_saved_high', 'no_uncertainty', 'roi_very_high', 'zero_cost']);
  assert.match(ws.find((w) => w.code === 'automation_rate_high').message, /98% of the work automated is unusually high \(above 90%\)/);
  assert.match(ws.find((w) => w.code === 'hours_saved_high').message, /5880 hours saved a year is more than 2.9 full-time people/);
  assert.ok(ws.every((w) => w.kind === 'plausibility' && w.path && w.message));
});

test('a result that is too good, or bad even at best, is flagged', async () => {
  const tooGood = await check(build({ costs: { oneOff: [{ label: 'Implementation', amount: 100 }], perYear: [{ label: 'Licence', amount: 10 }] } }));
  assert.ok(codes(tooGood).includes('roi_very_high'));
  assert.ok(codes(tooGood).includes('payback_very_fast'));
  const hopeless = await check(build({ costs: { oneOff: [{ label: 'Implementation', amount: 90000 }] } }));
  assert.ok(codes(hopeless).includes('loses_even_at_best'));
});

test('an assumption that disagrees with the process analysis is flagged with both figures', async () => {
  const ws = await check(build({
    timeSavings: [{ label: 'Enter invoice', casesPerYear: 20000, minutesPerCase: 20, automationRate: 0.8, costPerHour: 32, evidence: { analysisId: 'AN-1', activity: 'Enter invoice' } }],
  }), lookups).then((all) => all.filter((w) => w.kind === 'evidence')); // the inflated figures also trip plausibility rules
  assert.deepEqual(codes(ws), ['volume_differs', 'duration_differs']);
  assert.match(ws[0].message, /assumes 20000 cases a year, but analysis AN-1 saw 500 in 30 days \(about 6083 a year\)/);
  assert.match(ws[1].message, /assumes 20 minutes a case, but the observed median for "Enter invoice" is 6 minutes/);
});

test('a cost that disagrees with the contract is flagged (contract value spread over its term)', async () => {
  const ws = await check(build({ costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 3000, evidence: { documentId: 'doc_msa', field: 'contract_value' } }] } }), lookups);
  assert.deepEqual(codes(ws), ['amount_differs']);
  assert.match(ws[0].message, /assumes GBP 3,000.00 a year, but document doc_msa says contract_value GBP 14,400.00 over 36 months = GBP 4,800.00 a year/);
});

test('evidence that is missing, unconfirmed, in another currency or of the wrong kind is flagged — never skipped', async () => {
  const at = (evidence, list = 'perYear') => build({ costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], [list]: [{ label: 'Licence', amount: 4800, evidence }] } });
  assert.deepEqual(codes(await check(at({ documentId: 'doc_nope', field: 'contract_value' }), lookups)), ['evidence_missing']);
  assert.deepEqual(codes(await check(at({ documentId: 'doc_msa', field: 'total' }), lookups)), ['evidence_missing']);
  assert.deepEqual(codes(await check(at({ analysisId: 'AN-1', activity: 'x' }), lookups)), ['evidence_wrong_kind']);

  const flaggedDoc = { lookupDocument: async () => ({ ...CONTRACT, status: 'flagged_for_review' }) };
  assert.match((await check(at({ documentId: 'd', field: 'contract_value' }), flaggedDoc))[0].message, /is flagged for review, so its figures are not confirmed/);
  const euroDoc = { lookupDocument: async () => ({ ...CONTRACT, fields: { ...CONTRACT.fields, currency: { value: 'EUR' } } }) };
  assert.deepEqual(codes(await check(at({ documentId: 'd', field: 'contract_value' }), euroDoc)), ['currency_differs']);

  const noStep = build({ timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32, evidence: { analysisId: 'AN-1', activity: 'Approve' } }] });
  assert.match((await check(noStep, lookups))[0].message, /has no step "Approve"/);
});

test('a short observation period is noted as unreliable to scale up', async () => {
  const shortReport = { ...REPORT, scope: { period: { from: '2026-08-01T00:00:00Z', to: '2026-08-08T00:00:00Z' } }, activities: [{ ...REPORT.activities[0], occurrences: 115 }] };
  const ws = await check(build({ timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32, evidence: { analysisId: 'AN-1', activity: 'Enter invoice' } }] }), { lookupAnalysis: async () => shortReport });
  assert.match(ws[0].message, /covers only 7 days; scaling it to a year is unreliable/);
});

test('a lookup that fails or hangs becomes a warning, not a crash and not a silent pass', async () => {
  const a = build({ costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800, evidence: { documentId: 'd', field: 'contract_value' } }] } });
  const failing = await check(a, { lookupDocument: async () => { throw new Error('database unavailable'); } });
  assert.match(failing[0].message, /could not be checked \(database unavailable\); the assumption is unconfirmed/);
  const hanging = await checkAssumptions(a, calculateRoi(a), { lookupDocument: () => new Promise(() => {}), thresholds: { lookupTimeoutMs: 20 } });
  assert.match(hanging[0].message, /took longer than 20 ms/);
});

test('thresholds can be set for an organisation, and change which warnings appear', async () => {
  const a = build({ timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32 }] });
  assert.ok(!codes(await check(a)).includes('cost_per_hour_unusual'), 'GBP 32 an hour is fine by default');
  const strict = await checkAssumptions(a, calculateRoi(a), { thresholds: { minCostPerHour: 40, maxCostPerHour: 120 } });
  assert.match(strict.find((w) => w.code === 'cost_per_hour_unusual').message, /outside the usual 40–120/);
});

test('impossible thresholds are refused, every problem listed, so a typo cannot switch a check off', () => {
  assert.equal(resolveThresholds().maxAutomationRate, 0.9, 'defaults when nothing is set');
  assert.equal(resolveThresholds({ maxCostPerHour: 120 }).maxCostPerHour, 120);
  assert.ok(Object.isFrozen(resolveThresholds()));
  assert.throws(() => resolveThresholds({ minCostPerHour: 200, maxCostPerHour: 100, maxAutomationRate: 1.5, lookupTimeoutMs: 0, maxCostPerHuor: 50 }),
    (err) => err instanceof RoiThresholdError && err.problems.length === 4
      && /"maxCostPerHuor" is not a threshold/.test(err.message)
      && /maxAutomationRate must be more than 0 and at most 1 \(got 1.5\)/.test(err.message)
      && /minCostPerHour \(200\) must be below maxCostPerHour \(100\)/.test(err.message)
      && /lookupTimeoutMs must be a whole number of milliseconds/.test(err.message));
  assert.throws(() => resolveThresholds({ maxRoiPercent: Number.NaN }), /maxRoiPercent must be a finite number/);
  assert.throws(() => resolveThresholds('strict'), /must be an object/);
});

test('warnings never change the numbers', async () => {
  const a = build({ timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.99, costPerHour: 32 }] });
  const result = calculateRoi(a);
  const before = JSON.stringify(result);
  await checkAssumptions(a, result);
  assert.equal(JSON.stringify(result), before);
});
