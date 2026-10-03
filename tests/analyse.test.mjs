// Process analysis engine (STORY-002). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateDataset } from '../src/analysis/processData.js';
import { analyse, AnalysisInterruptedError } from '../src/analysis/analyse.js';

const MIN = 60 * 1000;

// cases: array of cases; each case is a list of [activity, startMinute, endMinute, actor?].
// Case i starts on day i, so cases never overlap each other.
function log(cases) {
  const events = cases.flatMap((steps, i) => steps.map(([activity, s, e, actor = 'clerk-1']) => {
    const base = Date.UTC(2026, 8, 1 + i, 9);
    return {
      caseId: `C${i + 1}`, activity, actor,
      startedAt: new Date(base + s * MIN).toISOString(), endedAt: new Date(base + e * MIN).toISOString(),
    };
  }));
  const v = validateDataset({ process: 'Invoice approval', events });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  return v;
}

// Receive (5 min) → waits 2 h → Approve (5–90 min, very uneven) → waits 5 min → Pay (3 min)
const APPROVE_MINUTES = [10, 40, 90, 5, 60, 20, 75, 15, 50, 30];
const invoiceCases = () => APPROVE_MINUTES.map((m) => [
  ['Receive', 0, 5], ['Approve', 125, 125 + m, 'manager-1'], ['Pay', 130 + m, 133 + m],
]);

test('finds the long wait before approval as the top bottleneck, with the reasons and example cases', async () => {
  const r = await analyse(log(invoiceCases()));
  const top = r.bottlenecks[0];
  assert.equal(top.activity, 'Approve');
  assert.equal(top.kind, 'wait');
  assert.equal(top.medianMs, 120 * MIN);
  assert.equal(top.timesTypical, 24); // 120 min vs a typical 5-min wait
  assert.ok(top.shareOfCaseTime > 0.6);
  assert.equal(top.reasons.length, 2);
  assert.match(top.reasons[0], /24× the typical wait/);
  assert.equal(top.exampleCases.length, 3);
  assert.ok(r.bottlenecks.some((b) => b.activity === 'Approve' && b.kind === 'step'), 'the slow approval step itself');
  assert.ok(!r.bottlenecks.some((b) => b.activity === 'Pay'), 'Pay is not a bottleneck');
  assert.equal(r.totals.cases, 10);
  assert.equal(r.typical.waitMs, 5 * MIN);
});

test('suggests frequent, short, consistent steps for automation — and not the uneven one', async () => {
  const r = await analyse(log(invoiceCases()));
  assert.deepEqual(r.automationCandidates.map((c) => c.activity).sort(), ['Pay', 'Receive']);
  const receive = r.automationCandidates.find((c) => c.activity === 'Receive');
  assert.equal(receive.frequency, 1);
  assert.equal(receive.variation, 0);
  assert.deepEqual(receive.reasons, ['happens in 100% of cases', 'usually takes 5 min or less', 'takes a consistent time (variation 0)']);
});

test('finds repeated work and parallel duplicated effort, without counting one as the other', async () => {
  const cases = [
    [['Receive', 0, 5], ['Check PO', 10, 20], ['Approve', 30, 40], ['Check PO', 50, 60], ['Pay', 70, 73]],
    [['Receive', 0, 5], ['Check PO', 10, 20], ['Approve', 30, 40], ['Check PO', 50, 58], ['Pay', 70, 73]],
    [['Receive', 0, 5], ['Check PO', 10, 20], ['Approve', 30, 40], ['Pay', 70, 73]],
    [['Receive', 0, 5], ['Approve', 30, 50, 'manager-1'], ['Approve', 35, 45, 'manager-2'], ['Pay', 70, 73]],
  ];
  const r = await analyse(log(cases));

  const rework = r.duplicates.find((d) => d.kind === 'repeated');
  assert.equal(rework.activity, 'Check PO');
  assert.equal(rework.casesAffected, 2);
  assert.equal(rework.extraOccurrences, 2);
  assert.equal(rework.extraTimeMs, 18 * MIN);

  const parallel = r.duplicates.find((d) => d.kind === 'parallel');
  assert.equal(parallel.activity, 'Approve');
  assert.equal(parallel.casesAffected, 1);
  assert.equal(parallel.extraTimeMs, 10 * MIN); // the overlap, 35–45
  assert.ok(!r.duplicates.some((d) => d.kind === 'repeated' && d.activity === 'Approve'), 'parallel is not also counted as a repeat');
});

test('steps starting at the same moment get the same wait, whatever order the rows are in', async () => {
  // Found by the stress test: the row listed first used to get the whole wait and
  // the other 0, so the report could blame a different step for the same data.
  const at = (d, h, m) => new Date(Date.UTC(2026, 8, d, h, m)).toISOString();
  const make = (logFirst) => ({
    process: 'p',
    events: [1, 2, 3].flatMap((d) => {
      const approve = { caseId: `C${d}`, activity: 'Approve', actor: 'm', startedAt: at(d, 11, 0), endedAt: at(d, 11, 30) };
      const logged = { caseId: `C${d}`, activity: 'Log', actor: 'c', startedAt: at(d, 11, 0), endedAt: at(d, 11, 5) };
      return [{ caseId: `C${d}`, activity: 'Receive', actor: 'c', startedAt: at(d, 9, 0), endedAt: at(d, 9, 5) },
        ...(logFirst ? [logged, approve] : [approve, logged])];
    }),
  });
  const a = await analyse(validateDataset(make(false)));
  const b = await analyse(validateDataset(make(true)));
  const waits = (r) => Object.fromEntries(r.activities.map((x) => [x.activity, x.medianWaitMs]));
  assert.deepEqual(waits(a), { Receive: null, Approve: 115 * MIN, Log: 115 * MIN });
  assert.deepEqual(waits(b), waits(a));
  assert.deepEqual(b.bottlenecks.map((x) => `${x.activity}/${x.kind}`).sort(), a.bottlenecks.map((x) => `${x.activity}/${x.kind}`).sort());
});

test('a smooth process produces no findings — nothing is invented', async () => {
  const smooth = Array.from({ length: 6 }, () => [['A', 0, 30], ['B', 30, 60], ['C', 60, 90], ['D', 90, 120], ['E', 120, 150]]);
  const r = await analyse(log(smooth));
  assert.deepEqual(r.bottlenecks, []);
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(r.automationCandidates, [], '30-minute steps are too long to suggest');
});

test('one odd case is not enough to flag anything', async () => {
  const cases = invoiceCases().map((c) => c.map(([a, s, e, who]) => [a, s, e, who]));
  cases[0].push(['Escalate', 300, 900]); // a single huge step in one case
  cases[1].push(['Escalate', 300, 310]);
  const r = await analyse(log(cases));
  assert.ok(!r.bottlenecks.some((b) => b.activity === 'Escalate'), 'only 2 observations, below minOccurrences');
});

test('thresholds can be changed and are reported back', async () => {
  const r = await analyse(log(invoiceCases()), { thresholds: { automationMaxMedianMs: 4 * MIN } });
  assert.deepEqual(r.automationCandidates.map((c) => c.activity), ['Pay']);
  assert.equal(r.thresholds.automationMaxMedianMs, 4 * MIN);
  assert.equal(r.thresholds.bottleneckRatio, 2);
});

test('an analysis cancelled before it starts is interrupted, not half-done', async () => {
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  await assert.rejects(analyse(log(invoiceCases()), { signal: controller.signal }), AnalysisInterruptedError);
});

test('an analysis cancelled part-way stops at the next checkpoint', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => [['Receive', 0, 5], ['Pay', 10, 10 + (i % 7)]]);
  const v = log(many);
  const controller = new AbortController();
  const running = analyse(v, { signal: controller.signal });
  controller.abort(new Error('timeout'));
  await assert.rejects(running, (err) => err instanceof AnalysisInterruptedError && /after 200 of 1000 cases/.test(err.message));
});

test('refuses data that has not been validated', async () => {
  await assert.rejects(analyse({ ok: false, events: [] }), TypeError);
  await assert.rejects(analyse(undefined), /validated data set/);
});
