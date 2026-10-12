// ROI assumptions and data input errors (STORY-008). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAssumptions, RoiInputError } from '../src/roi/assumptions.js';

const sample = (over = {}) => ({
  name: 'Automate invoice entry',
  currency: 'GBP',
  horizonYears: 3,
  timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32 }],
  otherSavings: [{ label: 'Fewer late-payment fees', amountPerYear: 1500 }],
  costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800 }] },
  uncertainty: { savings: 0.2, costs: 0.1 },
  ...over,
});
const problemsOf = (input) => validateAssumptions(input).problems?.map((p) => `${p.path} ${p.problem}`) ?? [];

test('valid assumptions are accepted, with money in whole minor units', () => {
  const r = validateAssumptions(sample());
  assert.equal(r.ok, true);
  const a = r.assumptions;
  assert.equal(a.timeSavings[0].costPerHourMinor, 3200);
  assert.equal(a.otherSavings[0].amountPerYearMinor, 150000);
  assert.deepEqual(a.costs.oneOff[0], { label: 'Implementation', amountMinor: 1200000, evidence: undefined });
  assert.deepEqual(a.uncertainty, { savings: 0.2, costs: 0.1 });
});

test('minor units make totals exact: 0.10 + 0.20 is exactly 0.30', () => {
  const r = validateAssumptions(sample({ costs: { perYear: [{ label: 'A', amount: 0.1 }, { label: 'B', amount: 0.2 }] } }));
  const total = r.assumptions.costs.perYear.reduce((s, c) => s + c.amountMinor, 0);
  assert.equal(total, 30);
  assert.notEqual(0.1 + 0.2, 0.3, 'whereas plain floating point is not');
});

test('uncertainty and other savings are optional; evidence links are accepted in either form', () => {
  const r = validateAssumptions(sample({
    uncertainty: undefined, otherSavings: undefined,
    timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32, evidence: { analysisId: 'AN-1', activity: 'Enter invoice' } }],
    costs: { perYear: [{ label: 'Licence', amount: 4800, evidence: { documentId: 'doc_abc', field: 'contract_value' } }] },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.assumptions.uncertainty, { savings: 0, costs: 0 });
  assert.deepEqual(r.assumptions.timeSavings[0].evidence, { analysisId: 'AN-1', activity: 'Enter invoice' });
});

// ---- Failure path: data input errors ----

test('every problem is reported at once, each with its exact place', () => {
  const problems = problemsOf(sample({
    currency: 'pounds',
    horizonYears: 2.5,
    timeSavings: [{ label: 'Enter invoice', casesPerYear: -5, minutesPerCase: 0, automationRate: 1.5, costPerHour: '32' }],
  }));
  assert.deepEqual(problems, [
    'currency must be a 3-letter code such as GBP (got "pounds")',
    'horizonYears must be a whole number (got 2.5)',
    'timeSavings[0].casesPerYear must be at least 0 (got -5)',
    'timeSavings[0].minutesPerCase must be more than 0 (got 0)',
    'timeSavings[0].automationRate must be at most 1 (got 1.5)',
    'timeSavings[0].costPerHour must be a number (got "32")',
  ]);
});

test('impossible or broken numbers are refused, never coerced', () => {
  assert.match(problemsOf(sample({ horizonYears: 11 })).join(), /horizonYears must be at most 10/);
  assert.match(problemsOf(sample({ horizonYears: 0 })).join(), /horizonYears must be at least 1/);
  assert.match(problemsOf(sample({ otherSavings: [{ label: 'X', amountPerYear: Number.NaN }] })).join(), /must be a finite number \(got NaN\)/);
  assert.match(problemsOf(sample({ otherSavings: [{ label: 'X', amountPerYear: Infinity }] })).join(), /finite number/);
  assert.match(problemsOf(sample({ costs: { oneOff: [{ label: 'X', amount: 10.005 }] } })).join(), /more than 2 decimal places/);
  assert.match(problemsOf(sample({ costs: { oneOff: [{ label: 'X', amount: -1 }] } })).join(), /amount must be at least 0/);
  assert.match(problemsOf(sample({ costs: { oneOff: [{ label: 'X', amount: 5e12 }] } })).join(), /must be at most/);
  assert.match(problemsOf(sample({ uncertainty: { savings: 1.2 } })).join(), /uncertainty.savings must be at most 1/);
});

test('missing pieces, typos and duplicates are named', () => {
  assert.match(problemsOf(sample({ name: '  ' })).join(), /^name is missing/);
  assert.match(problemsOf(sample({ horizonYear: 3 })).join(), /horizonYear is not a known assumption/);
  assert.match(problemsOf(sample({ costs: { oneOf: [] } })).join(), /costs.oneOf is not a known cost list/);
  assert.match(problemsOf(sample({ timeSavings: [{ label: 'A', casesPerYear: 1, minutesPerCase: 1, automationRate: 1, costPerHour: 1 }, { label: 'a', casesPerYear: 1, minutesPerCase: 1, automationRate: 1, costPerHour: 1 }] })).join(), /"a" is used twice in timeSavings/);
  assert.match(problemsOf(sample({ timeSavings: [{ label: 'A', casesPerYear: 1, minutesPerCase: 1, automationRate: 1, costPerHour: 1, evidence: { analysisId: 'x' } }] })).join(), /evidence must be \{ analysisId, activity \} or \{ documentId, field \}/);
});

test('there must be something saved and something spent', () => {
  assert.match(problemsOf(sample({ timeSavings: [], otherSavings: [] })).join(), /at least one saving/);
  assert.match(problemsOf(sample({ costs: { oneOff: [], perYear: [] } })).join(), /at least one cost; ROI cannot be estimated without one/);
  assert.match(problemsOf(sample({ costs: undefined })).join(), /^costs is missing/);
  assert.deepEqual(problemsOf('not an object'), ['assumptions must be an object']);
});

test('RoiInputError carries the problem list for the caller', () => {
  const { problems } = validateAssumptions(sample({ currency: 'x' }));
  const err = new RoiInputError(problems);
  assert.equal(err.problems.length, 1);
  assert.match(err.message, /1 problem\(s\): currency must be a 3-letter code/);
});
