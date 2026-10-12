// Property tests for the ROI calculation (STORY-008). Run with: npm test
//
// The example tests check figures worked out by hand. These check rules that must
// hold for EVERY valid estimate, over thousands of random ones: a formula bug that
// happens to give the right answer for the hand-picked examples is caught here.
//
// The random numbers come from a fixed seed, so a failure is always reproducible:
// the message names the run and prints the assumptions that broke the rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAssumptions } from '../src/roi/assumptions.js';
import { calculateRoi } from '../src/roi/calculate.js';

const RUNS = 2000;

// mulberry32: a small, well-known seeded random number generator.
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

// A random VALID set of assumptions, across realistic and awkward ranges
// (zero amounts, 0 % and 100 % automation, one item or many, tiny and large costs).
function randomAssumptions(r) {
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const money = (hi) => int(0, hi * 100) / 100; // up to 2 decimal places
  const pick = (xs) => xs[int(0, xs.length - 1)];
  const n = (lo, hi, make) => Array.from({ length: int(lo, hi) }, (_, i) => make(i));
  const timeSavings = n(0, 4, (i) => ({
    label: `Step ${i}`,
    casesPerYear: pick([0, 1, int(1, 100), int(100, 50000)]),
    minutesPerCase: pick([0.5, 1, int(1, 120), int(1, 600)]),
    automationRate: pick([0, 1, int(0, 100) / 100]),
    costPerHour: pick([0, money(20), money(250)]),
  }));
  const otherSavings = n(timeSavings.length ? 0 : 1, 3, (i) => ({ label: `Other ${i}`, amountPerYear: pick([0, money(1000), money(500000)]) }));
  const oneOff = n(0, 3, (i) => ({ label: `Once ${i}`, amount: pick([0, money(5000), money(2000000)]) }));
  const perYear = n(oneOff.length ? 0 : 1, 3, (i) => ({ label: `Yearly ${i}`, amount: pick([0, money(5000), money(500000)]) }));
  return {
    name: 'Random estimate', currency: 'GBP', horizonYears: int(1, 10),
    timeSavings, otherSavings, costs: { oneOff, perYear },
    uncertainty: { savings: pick([0, int(0, 100) / 100]), costs: pick([0, int(0, 100) / 100]) },
  };
}

// Runs `check` on RUNS random estimates; on failure, says which one and why.
function forAll(seed, check) {
  const r = rng(seed);
  for (let run = 1; run <= RUNS; run += 1) {
    const input = randomAssumptions(r);
    const valid = validateAssumptions(input);
    assert.equal(valid.ok, true, `run ${run}: the generator made invalid assumptions: ${JSON.stringify(valid.problems)}`);
    const result = calculateRoi(valid.assumptions);
    try {
      check(result, valid.assumptions, input);
    } catch (err) {
      err.message = `run ${run} of seed ${seed}: ${err.message}\nassumptions: ${JSON.stringify(input)}`;
      throw err;
    }
  }
}
const SCENARIOS = ['low', 'expected', 'high'];

test('every money figure is an exact whole number of minor units', () => {
  forAll(1, (res) => {
    for (const k of SCENARIOS) {
      for (const f of ['annualSavings', 'oneOffCosts', 'yearlyCosts', 'totalSavings', 'totalCosts', 'netBenefit']) {
        assert.ok(Number.isSafeInteger(res[k][f]), `${k}.${f} = ${res[k][f]}`);
      }
    }
    for (const s of res.savings) assert.ok(Number.isSafeInteger(s.savingPerYear));
  });
});

test('the totals follow from their parts, in every case', () => {
  forAll(2, (res, a) => {
    for (const k of SCENARIOS) {
      const x = res[k];
      assert.equal(x.totalSavings, x.annualSavings * a.horizonYears, `${k}: total savings`);
      assert.equal(x.totalCosts, x.oneOffCosts + x.yearlyCosts * a.horizonYears, `${k}: total costs`);
      assert.equal(x.netBenefit, x.totalSavings - x.totalCosts, `${k}: net benefit`);
    }
    assert.equal(res.expected.annualSavings, res.savings.reduce((s, i) => s + i.savingPerYear, 0), 'annual savings = sum of the items');
  });
});

test('net benefit equals the year-by-year cash flows added up', () => {
  forAll(3, (res, a) => {
    for (const k of SCENARIOS) {
      const x = res[k];
      const flows = [-x.oneOffCosts, ...Array.from({ length: a.horizonYears }, () => x.annualSavings - x.yearlyCosts)];
      assert.equal(flows.reduce((s, f) => s + f, 0), x.netBenefit, k);
    }
  });
});

test('low ≤ expected ≤ high, for savings, costs and net benefit', () => {
  forAll(4, (res) => {
    assert.ok(res.low.annualSavings <= res.expected.annualSavings && res.expected.annualSavings <= res.high.annualSavings, 'savings');
    assert.ok(res.low.totalCosts >= res.expected.totalCosts && res.expected.totalCosts >= res.high.totalCosts, 'costs (low case has the HIGHEST costs)');
    assert.ok(res.low.netBenefit <= res.expected.netBenefit && res.expected.netBenefit <= res.high.netBenefit, 'net benefit');
  });
});

test('ROI has the sign of the net benefit, and is missing only when there are no costs', () => {
  forAll(5, (res) => {
    for (const k of SCENARIOS) {
      const x = res[k];
      if (x.totalCosts === 0) {
        assert.equal(x.roiPercent, null, `${k}: zero costs`);
        assert.ok(x.notes.some((n) => /ROI cannot be calculated/.test(n)));
      } else {
        assert.ok(Number.isFinite(x.roiPercent), `${k}: ROI is a number`);
        if (x.netBenefit > 0) assert.ok(x.roiPercent >= 0, `${k}: positive net, ROI ${x.roiPercent}`);
        if (x.netBenefit < 0) assert.ok(x.roiPercent <= 0, `${k}: negative net, ROI ${x.roiPercent}`);
        assert.ok(Math.abs(x.roiPercent - (x.netBenefit / x.totalCosts) * 100) <= 0.05 + 1e-9, `${k}: ROI is net ÷ costs, to 0.1 %`);
      }
    }
  });
});

test('payback: missing exactly when it never pays back; otherwise one-off ÷ yearly net, to 0.1 month', () => {
  forAll(6, (res) => {
    for (const k of SCENARIOS) {
      const x = res[k];
      const yearlyNet = x.annualSavings - x.yearlyCosts;
      if (yearlyNet <= 0) {
        assert.equal(x.paybackMonths, null, `${k}: never pays back`);
        assert.ok(x.notes.some((n) => /Never pays back/.test(n)));
      } else {
        assert.ok(x.paybackMonths >= 0, `${k}: payback ${x.paybackMonths}`);
        assert.ok(Math.abs(x.paybackMonths - (x.oneOffCosts / yearlyNet) * 12) <= 0.05 + 1e-9, `${k}: payback formula`);
      }
    }
  });
});

test('more of a saving never lowers the result; more cost never raises it', () => {
  const r = rng(7);
  for (let run = 1; run <= RUNS; run += 1) {
    const input = randomAssumptions(r);
    const base = calculateRoi(validateAssumptions(input).assumptions).expected;
    const moreSaving = structuredClone(input);
    if (moreSaving.otherSavings.length) moreSaving.otherSavings[0].amountPerYear += 100;
    else moreSaving.timeSavings[0].casesPerYear += 100;
    const moreCost = structuredClone(input);
    if (moreCost.costs.perYear.length) moreCost.costs.perYear[0].amount += 100; else moreCost.costs.oneOff[0].amount += 100;
    const up = calculateRoi(validateAssumptions(moreSaving).assumptions).expected;
    const down = calculateRoi(validateAssumptions(moreCost).assumptions).expected;
    assert.ok(up.netBenefit >= base.netBenefit, `run ${run}: more saving lowered net benefit`);
    assert.ok(down.netBenefit < base.netBenefit, `run ${run}: more cost did not lower net benefit`);
  }
});

test('the input check never throws, whatever it is given — it only reports problems', () => {
  const r = rng(8);
  const junk = [undefined, null, '', 'x', -1, 0, 1e309, Number.NaN, true, [], {}, [1, 2], { a: 1 }, '12', ' ', -0.001, 1.234567];
  const pickJunk = () => junk[Math.floor(r() * junk.length)];
  for (let run = 1; run <= RUNS; run += 1) {
    const input = randomAssumptions(r);
    // Replace one random field, at any depth, with junk.
    const paths = [];
    const walk = (o, p) => { for (const [k, v] of Object.entries(o)) { paths.push([...p, k]); if (v && typeof v === 'object') walk(v, [...p, k]); } };
    walk(input, []);
    const path = paths[Math.floor(r() * paths.length)];
    let target = input;
    for (const k of path.slice(0, -1)) target = target[k];
    target[path.at(-1)] = pickJunk();
    let out;
    assert.doesNotThrow(() => { out = validateAssumptions(input); }, `run ${run}: threw for ${path.join('.')}`);
    if (out.ok) assert.doesNotThrow(() => calculateRoi(out.assumptions), `run ${run}: accepted input that then failed to calculate`);
    else assert.ok(out.problems.length > 0 && out.problems.every((p) => p.path && p.problem));
  }
});
