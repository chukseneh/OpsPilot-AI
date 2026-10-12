// The ROI calculation and calculation errors (STORY-008). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAssumptions } from '../src/roi/assumptions.js';
import { calculateRoi, checkNetBenefit, formatMoney, CalculationError } from '../src/roi/calculate.js';

const assumptions = (over = {}) => {
  const r = validateAssumptions({
    name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
    timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32 }],
    otherSavings: [{ label: 'Fewer late-payment fees', amountPerYear: 1500 }],
    costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800 }] },
    uncertainty: { savings: 0.2, costs: 0.1 },
    ...over,
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  return r.assumptions;
};

// ---- Acceptance 1: estimated savings are shown ----

test('the expected case, worked by hand', () => {
  const r = calculateRoi(assumptions());
  // 6000 × 6 min × 0.8 = 28,800 min = 480 h × £32 = £15,360; + £1,500 = £16,860 a year.
  assert.equal(r.savings[0].hoursSavedPerYear, 480);
  assert.equal(r.savings[0].savingPerYear, 1536000);
  const e = r.expected;
  assert.equal(e.annualSavings, 1686000);
  assert.equal(e.totalSavings, 5058000); // × 3 years
  assert.equal(e.totalCosts, 2640000); // 12,000 + 4,800 × 3
  assert.equal(e.netBenefit, 2418000);
  assert.equal(e.roiPercent, 91.6); // 24,180 ÷ 26,400
  assert.equal(e.paybackMonths, 11.9); // 12,000 ÷ (16,860 − 4,800) = 0.995 years × 12
  assert.deepEqual(e.notes, []);
});

test('every figure carries its formula with the real numbers', () => {
  const r = calculateRoi(assumptions());
  assert.equal(r.savings[0].formula, '6000 cases × 6 min × 80% ÷ 60 = 480 h × GBP 32.00/h = GBP 15,360.00');
  assert.equal(r.expected.formulas.netBenefit, 'GBP 50,580.00 − GBP 26,400.00 = GBP 24,180.00');
  assert.equal(r.expected.formulas.roi, 'GBP 24,180.00 ÷ GBP 26,400.00 = 91.6%');
  assert.equal(r.expected.formulas.payback, 'GBP 12,000.00 ÷ (GBP 16,860.00 − GBP 4,800.00) × 12 = 11.9 months');
});

test('the low and high cases apply the stated uncertainty in opposite directions', () => {
  const r = calculateRoi(assumptions());
  assert.equal(r.low.annualSavings, 1348800); // −20 %
  assert.equal(r.low.oneOffCosts, 1320000); // +10 %
  assert.equal(r.high.annualSavings, 2023200); // +20 %
  assert.equal(r.high.yearlyCosts, 432000); // −10 %
  assert.ok(r.low.netBenefit < r.expected.netBenefit && r.expected.netBenefit < r.high.netBenefit);
  assert.equal(r.range, 'low: savings −20%, costs +10%; high: savings +20%, costs −10%');
});

test('with no uncertainty stated, low = expected = high', () => {
  const r = calculateRoi(assumptions({ uncertainty: undefined }));
  assert.equal(r.low.netBenefit, r.expected.netBenefit);
  assert.equal(r.high.netBenefit, r.expected.netBenefit);
});

// ---- Failure path: calculation errors (never shown as numbers) ----

test('zero total costs: ROI cannot be calculated (not Infinity)', () => {
  const r = calculateRoi(assumptions({ costs: { oneOff: [{ label: 'Free pilot', amount: 0 }] } }));
  assert.equal(r.expected.roiPercent, null);
  assert.match(r.expected.notes[0], /ROI cannot be calculated: total costs are zero/);
  assert.equal(r.expected.formulas.roi, 'not calculable (total costs are zero)');
  assert.equal(r.expected.paybackMonths, 0, 'nothing to pay back');
});

test('yearly costs above savings: never pays back (not a negative number of months)', () => {
  const r = calculateRoi(assumptions({ costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 20000 }] } }));
  assert.equal(r.expected.paybackMonths, null);
  assert.match(r.expected.notes.join(), /Never pays back/);
  assert.ok(r.expected.netBenefit < 0);
  assert.ok(r.expected.roiPercent < 0, 'a negative ROI is a real result, shown as such');
});

test('payback beyond the horizon is noted', () => {
  const r = calculateRoi(assumptions({ horizonYears: 1, costs: { oneOff: [{ label: 'Implementation', amount: 30000 }] } }));
  assert.match(r.expected.notes.join(), /Does not pay back within the 1-year horizon/);
});

test('figures too large to hold exactly raise CalculationError instead of a rounded guess', () => {
  const huge = assumptions({ timeSavings: [{ label: 'Everything', casesPerYear: 1e8, minutesPerCase: 10080, automationRate: 1, costPerHour: 1e12 }] });
  assert.throws(() => calculateRoi(huge), (err) => err instanceof CalculationError && /cannot be represented exactly/.test(err.message));
});

test('if the cash flows disagree with the net benefit, the result is refused', () => {
  assert.doesNotThrow(() => checkNetBenefit(100, [-50, 75, 75]));
  assert.throws(() => checkNetBenefit(100, [-50, 75, 74]), (err) => err instanceof CalculationError && /does not agree with its year-by-year cash flows \(100 vs 99\)/.test(err.message));
});

test('money is shown in major units with the currency', () => {
  assert.equal(formatMoney(123456789, 'GBP'), 'GBP 1,234,567.89');
  assert.equal(formatMoney(-500, 'EUR'), '−EUR 5.00');
  assert.equal(formatMoney(7, 'USD'), 'USD 0.07');
});
