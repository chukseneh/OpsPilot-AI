// Randomised stress test for process analysis (STORY-002). Seeded, so any failure
// can be replayed from the seed in its message.
//
// Checks, on hundreds of random event logs:
//   - the engine agrees with an independent reference calculation, written here
//     from the rules in analyse.js's header (medians, waits, repeats, overlaps,
//     which steps are flagged and which are not)
//   - shuffling the rows does not change the result (order independence)
//   - writing the same instants in other time zones does not change the result
//   - validation reports every problem planted in a log, and nothing else
//   - reports never contain undefined / NaN
//   - the service, under concurrent load with mixed roles, gaps and cancellations,
//     returns a sane status for every request and audits every one correctly

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateDataset } from '../src/analysis/processData.js';
import { analyse, DEFAULT_THRESHOLDS } from '../src/analysis/analyse.js';
import { buildReport, renderReportText } from '../src/analysis/report.js';
import { createAnalysisService, PermissionDeniedError } from '../src/analysis/service.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';

const MIN = 60 * 1000;

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

// "2026-09-01T10:00:00+02:00" for the same instant as 08:00Z.
function isoWithOffset(ms, offsetMin) {
  if (offsetMin === 0) return new Date(ms).toISOString();
  const d = new Date(ms + offsetMin * MIN).toISOString().slice(0, 23);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${d}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// A random but well-formed log. Events carry true epoch ms in _start/_end for the reference.
function randomLog(random, { cases = 20 + Math.floor(random() * 60), zoned = false } = {}) {
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const acts = Array.from({ length: int(3, 7) }, (_, i) => `Step ${String.fromCharCode(65 + i)}`);
  const events = [];
  for (let c = 0; c < cases; c += 1) {
    const caseId = `K${c + 1}`;
    let t = Date.UTC(2026, 8, 1) + c * 24 * 60 * MIN;
    const push = (activity, actor, start, end) => {
      const off = zoned ? [0, 60, -300, 330, 540][int(0, 4)] : 0;
      events.push({ caseId, activity, actor, startedAt: isoWithOffset(start, off), endedAt: isoWithOffset(end, off), _start: start, _end: end });
    };
    for (const activity of acts) {
      if (random() < 0.15) continue; // not every case does every step
      t += int(0, 3) === 0 ? 0 : int(1, 300) * MIN; // sometimes no wait at all
      const dur = int(1, 60) * MIN;
      push(activity, `p${int(1, 4)}`, t, t + dur);
      if (random() < 0.1) push(activity, `q${int(1, 2)}`, t + int(0, 5) * MIN, t + int(6, 70) * MIN); // overlap, other person
      if (random() < 0.1) push(`${activity} check`, `p${int(1, 4)}`, t, t + int(1, 10) * MIN); // starts at the same instant
      t += dur;
      if (random() < 0.1) { // rework: done again later
        t += int(5, 120) * MIN;
        const d2 = int(1, 40) * MIN;
        push(activity, `p${int(1, 4)}`, t, t + d2);
        t += d2;
      }
    }
  }
  if (!events.length) return randomLog(random, { cases, zoned });
  return { process: 'Random process', events };
}

const strip = (log) => ({ process: log.process, events: log.events.map(({ _start, _end, ...e }) => e) });

function shuffled(random, log) {
  const events = [...log.events];
  for (let i = events.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }
  return { ...log, events };
}

// ---- Independent reference, from the documented rules ----

const quantile = (xs, q) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const median = (xs) => quantile(xs, 0.5);

function reference(log) {
  const byCase = new Map();
  for (const e of log.events) {
    if (!byCase.has(e.caseId)) byCase.set(e.caseId, []);
    byCase.get(e.caseId).push(e);
  }
  const acts = new Map();
  const a = (n) => { if (!acts.has(n)) acts.set(n, { durations: [], waits: [], cases: new Set(), repeats: 0, repeatCases: new Set(), parallel: 0, parallelCases: new Set() }); return acts.get(n); };
  let totalCase = 0;
  for (const [caseId, evs] of byCase) {
    totalCase += Math.max(...evs.map((e) => e._end)) - Math.min(...evs.map((e) => e._start));
    const firstStart = Math.min(...evs.map((e) => e._start));
    for (const e of evs) {
      const s = a(e.activity);
      s.durations.push(e._end - e._start);
      s.cases.add(caseId);
      // Wait before e: idle time since everything that STARTED BEFORE it finished.
      // Steps starting at the same instant are concurrent: neither waits for the other.
      // The case's first step(s) have no wait.
      if (e._start !== firstStart) {
        const before = evs.filter((p) => p._start < e._start);
        s.waits.push(Math.max(0, e._start - Math.max(...before.map((p) => p._end))));
      }
      // Repeat: an earlier occurrence started before it and had finished by its start.
      if (evs.some((p) => p !== e && p.activity === e.activity && p._start < e._start && p._end <= e._start)) {
        s.repeats += 1; s.repeatCases.add(caseId);
      }
    }
    // Parallel: each PAIR of occurrences of one activity, by different people, that share time.
    for (let i = 0; i < evs.length; i += 1) {
      for (let j = i + 1; j < evs.length; j += 1) {
        const [p, q] = [evs[i], evs[j]];
        if (p.activity === q.activity && p.actor !== q.actor && Math.min(p._end, q._end) - Math.max(p._start, q._start) > 0) {
          const s = a(p.activity);
          s.parallel += 1; s.parallelCases.add(caseId);
        }
      }
    }
  }
  return { acts, totalCase, cases: byCase.size };
}

function checkAgainstReference(result, ref, seed) {
  const t = DEFAULT_THRESHOLDS;
  const where = (m) => `seed ${seed}: ${m}`;
  assert.equal(result.totals.cases, ref.cases, where('cases'));
  assert.equal(result.totals.activities, ref.acts.size, where('activities'));
  const allWaits = [...ref.acts.values()].flatMap((s) => s.waits);
  const allDur = [...ref.acts.values()].flatMap((s) => s.durations);
  assert.equal(result.typical.waitMs, median(allWaits), where('typical wait'));
  assert.equal(result.typical.stepMs, median(allDur), where('typical step'));

  for (const [name, s] of ref.acts) {
    const row = result.activities.find((x) => x.activity === name);
    assert.equal(row.medianDurationMs, median(s.durations), where(`${name} median duration`));
    assert.equal(row.medianWaitMs, s.waits.length ? median(s.waits) : null, where(`${name} median wait`));

    for (const [kind, values, typical] of [['wait', s.waits, median(allWaits)], ['step', s.durations, median(allDur)]]) {
      const expected = values.length >= t.minOccurrences && (
        (typical > 0 && median(values) / typical >= t.bottleneckRatio)
        || (ref.totalCase > 0 && values.reduce((x, y) => x + y, 0) / ref.totalCase >= t.bottleneckShare));
      const got = result.bottlenecks.some((b) => b.activity === name && b.kind === kind);
      assert.equal(got, expected, where(`${name} ${kind} bottleneck flagged=${got}, expected ${expected}`));
    }

    const rep = result.duplicates.find((d) => d.activity === name && d.kind === 'repeated');
    assert.equal(rep?.extraOccurrences ?? 0, s.repeats, where(`${name} repeats`));
    assert.equal(rep?.casesAffected ?? 0, s.repeatCases.size, where(`${name} repeat cases`));
    const par = result.duplicates.find((d) => d.activity === name && d.kind === 'parallel');
    assert.equal(par?.extraOccurrences ?? 0, s.parallel, where(`${name} parallel occurrences`));
    assert.equal(par?.casesAffected ?? 0, s.parallelCases.size, where(`${name} parallel cases`));

    const mean = s.durations.reduce((x, y) => x + y, 0) / s.durations.length;
    const cv = mean === 0 ? 0 : Math.sqrt(s.durations.reduce((x, d) => x + (d - mean) ** 2, 0) / s.durations.length) / mean;
    const auto = s.durations.length >= t.minOccurrences && s.cases.size / ref.cases >= t.automationMinFrequency
      && median(s.durations) <= t.automationMaxMedianMs && cv <= t.automationMaxVariation;
    assert.equal(result.automationCandidates.some((c) => c.activity === name), auto, where(`${name} automation candidate`));
  }
}

const comparable = (r) => JSON.stringify({ ...r, bottlenecks: r.bottlenecks.map(({ exampleCases, ...b }) => b), duplicates: r.duplicates.map(({ exampleCases, ...d }) => d) });

// Names the first part of two results that differs, so a failure says what changed.
function firstDiff(a, b) {
  const [x, y] = [JSON.parse(comparable(a)), JSON.parse(comparable(b))];
  for (const key of Object.keys(x)) {
    if (JSON.stringify(x[key]) === JSON.stringify(y[key])) continue;
    const show = (v) => (Array.isArray(v) ? v.map((i) => [i.activity, i.kind].filter(Boolean).join('/')).join(', ') : JSON.stringify(v));
    return `"${key}" differs — one run: ${show(x[key])} | other run: ${show(y[key])}`;
  }
  return 'no difference';
}

for (const seed of [3, 11, 29, 101]) {
  test(`analysis stress (seed ${seed}): 40 random logs agree with the reference, ignore row order and time zones`, { timeout: 120000 }, async () => {
    const random = rng(seed);
    for (let i = 0; i < 40; i += 1) {
      const log = randomLog(random, { zoned: i % 2 === 1 });
      const v = validateDataset(strip(log));
      assert.equal(v.ok, true, `seed ${seed} log ${i}: a well-formed log was refused: ${JSON.stringify(v.problems.slice(0, 3))}`);
      const result = await analyse(v);
      checkAgainstReference(result, reference(log), `${seed}/${i}`);

      const again = await analyse(validateDataset(strip(shuffled(random, log))));
      assert.ok(comparable(again) === comparable(result), `seed ${seed} log ${i}: shuffling the rows changed the result: ${firstDiff(again, result)}`);

      const utc = { ...log, events: log.events.map((e) => ({ ...e, startedAt: new Date(e._start).toISOString(), endedAt: new Date(e._end).toISOString() })) };
      const inUtc = await analyse(validateDataset(strip(utc)));
      assert.ok(comparable(inUtc) === comparable(result), `seed ${seed} log ${i}: time zones changed the result: ${firstDiff(inUtc, result)}`);

      const text = renderReportText(buildReport(result, { analysisId: `S${i}`, requestedBy: { type: 'person', id: 'a' } }));
      assert.ok(!/undefined|NaN|Infinity/.test(text), `seed ${seed} log ${i}: report contains undefined/NaN`);
    }
  });

  test(`validation stress (seed ${seed}): every planted problem is reported, and nothing else`, () => {
    const random = rng(seed * 31);
    for (let i = 0; i < 40; i += 1) {
      const data = strip(randomLog(random));
      const planted = new Set();
      for (const [idx, e] of data.events.entries()) {
        if (random() > 0.05) continue;
        const field = ['caseId', 'activity', 'actor', 'startedAt', 'endedAt'][Math.floor(random() * 5)];
        const how = Math.floor(random() * 3);
        if (how === 0) delete e[field];
        else if (how === 1) e[field] = '   ';
        else if (field.endsWith('At')) e[field] = e[field].slice(0, 16).replace('T', ' '); // no zone
        else e[field] = null;
        planted.add(`${idx + 1}:${field}`);
      }
      const v = validateDataset(data);
      const reported = new Set(v.problems.filter((p) => p.scope === 'row').map((p) => `${p.row}:${p.field}`));
      for (const p of planted) assert.ok(reported.has(p), `seed ${seed} log ${i}: planted ${p} not reported`);
      for (const r of reported) assert.ok(planted.has(r), `seed ${seed} log ${i}: reported ${r}, which was not planted`);
      assert.equal(v.ok, planted.size === 0 && v.problems.length === 0);
    }
  });
}

test('service stress: 150 concurrent requests with mixed roles, gaps and cancellations are all handled and audited', { timeout: 120000 }, async () => {
  const random = rng(77);
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'an-stress-')), 'audit.jsonl') });
  const store = createMemoryResultStore();
  const service = createAnalysisService({ audit, store, timeoutMs: 2000 });
  const unhandled = [];
  const onUnhandled = (r) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);

  const roles = ['process analyst', 'operations manager', 'intern', undefined];
  const requests = Array.from({ length: 150 }, (_, i) => {
    const data = strip(randomLog(random, { cases: 5 + Math.floor(random() * 20) }));
    const gap = random() < 0.25;
    if (gap) delete data.events[0].endedAt;
    const controller = new AbortController();
    const cancel = random() < 0.15;
    if (cancel) controller.abort();
    return { analysisId: `R${i}`, user: { id: `u${i}`, role: roles[Math.floor(random() * roles.length)] }, dataset: data, signal: controller.signal, gap, cancel };
  });

  try {
    const outcomes = await Promise.all(requests.map((r) => service.runAnalysis(r).then(
      (value) => ({ value }), (error) => ({ error }),
    )));
    await new Promise((r) => setTimeout(r, 50));

    const entries = audit.readAll();
    for (const [i, r] of requests.entries()) {
      const o = outcomes[i];
      const mine = entries.filter((e) => e.correlationId === r.analysisId);
      const actions = mine.map((e) => e.action);
      const allowed = ['process analyst', 'operations manager'].includes(r.user.role);
      assert.ok(mine.every((e) => e.actor.type === 'person' && e.actor.id === r.user.id && e.at), `R${i}: entry without the user id`);
      assert.equal(actions[0], 'analysis.requested', `R${i}`);
      if (!allowed) {
        assert.ok(o.error instanceof PermissionDeniedError, `R${i}: should be denied`);
        assert.deepEqual(actions, ['analysis.requested', 'analysis.denied'], `R${i}`);
      } else if (r.gap) {
        assert.equal(o.value.status, 'missing_data', `R${i}`);
        assert.ok(!actions.includes('analysis.started'), `R${i}: analysed despite missing data`);
      } else if (r.cancel) {
        assert.equal(o.value.status, 'interrupted', `R${i}`);
        assert.equal(store.get(r.analysisId), null, `R${i}: interrupted run was saved`);
      } else {
        assert.equal(o.value.status, 'completed', `R${i}: ${o.error?.message ?? o.value?.status}`);
        assert.deepEqual(actions, ['analysis.requested', 'analysis.started', 'analysis.completed'], `R${i}`);
        assert.ok(store.get(r.analysisId), `R${i}: completed run not saved`);
      }
    }
    assert.equal(audit.verify().ok, true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
