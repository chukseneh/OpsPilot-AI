// Process analysis (REQ-003, REQ-004). Takes a VALIDATED event log (see
// processData.js) and finds three kinds of thing, each by an explicit rule so
// every finding can be explained:
//
//   bottlenecks          where cases wait longest before a step, and the slowest
//                        steps: flagged when the median is at least
//                        bottleneckRatio × the process's typical value, or the
//                        total is at least bottleneckShare of all case time.
//   duplicates           the same activity more than once in a case (repeat or
//                        rework loop), and the same activity done by two people
//                        at the same time in one case (duplicated effort).
//   automation candidates steps in at least automationMinFrequency of cases,
//                        with a median of at most automationMaxMedianMs and a
//                        consistent duration (coefficient of variation at most
//                        automationMaxVariation). "Candidate" only — no savings
//                        are estimated here (that is ROI, STORY-008).
//
// Anything needs at least minOccurrences observations before it is flagged, so
// one odd case cannot become a finding on its own.
//
// Interruption: analyse() is async and yields between cases. If `signal` aborts,
// it throws AnalysisInterruptedError — never a half-finished result.

export const DEFAULT_THRESHOLDS = Object.freeze({
  bottleneckRatio: 2,
  bottleneckShare: 0.25,
  automationMinFrequency: 0.3,
  automationMaxMedianMs: 15 * 60 * 1000,
  automationMaxVariation: 0.5,
  minOccurrences: 3,
});

const YIELD_EVERY_CASES = 200;

export class AnalysisInterruptedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AnalysisInterruptedError';
  }
}

// ---- small statistics helpers (all inputs are arrays of milliseconds) ----

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
function quantile(xs, q) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]; // nearest rank
}
const median = (xs) => quantile(xs, 0.5);
function variation(xs) {
  const m = mean(xs);
  if (m === 0) return 0;
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m;
}
const round2 = (x) => Math.round(x * 100) / 100;
// Loops, not Math.min(...xs): spreading a very large array overflows the call stack.
const minOf = (xs) => xs.reduce((a, b) => (b < a ? b : a), Infinity);
const maxOf = (xs) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

// Up to `n` case ids with the largest value, for evidence in the report.
// Fixed tie-breaks, so equal-ranked items come out in the same order whatever
// order the rows were in (finding numbers F1, F2… must not depend on the export).
// Plain code-point comparison, not localeCompare, so it is the same on every machine.
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const byName = (a, b) => cmp(a.activity, b.activity) || cmp(a.kind ?? '', b.kind ?? '');

const topCases = (pairs, n = 3) => [...pairs]
  .sort((a, b) => b.ms - a.ms || cmp(a.caseId, b.caseId))
  .slice(0, n).map((p) => ({ caseId: p.caseId, ms: p.ms }));

export async function analyse(validation, { thresholds = {}, signal } = {}) {
  if (!validation?.ok) throw new TypeError('analyse() needs a validated data set: call validateDataset() and check ok first');
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const checkpoint = async (where) => {
    if (signal?.aborted) {
      throw new AnalysisInterruptedError(`Analysis interrupted ${where}`, { cause: signal.reason });
    }
  };
  await checkpoint('before it started');

  // ---- 1. Walk each case in time order ----
  const byCase = new Map();
  for (const e of validation.events) {
    if (!byCase.has(e.caseId)) byCase.set(e.caseId, []);
    byCase.get(e.caseId).push(e);
  }

  const act = new Map(); // activity → observations
  const stat = (name) => {
    if (!act.has(name)) {
      act.set(name, { durations: [], waits: [], cases: new Set(), actors: new Set(), durationsByCase: [], waitsByCase: [], perCase: new Map() });
    }
    return act.get(name);
  };
  const caseDurations = [];
  const parallel = new Map(); // activity → [{ caseId, overlapMs, actors }]
  let processed = 0;

  for (const [caseId, events] of byCase) {
    events.sort((a, b) => a.start - b.start || a.row - b.row);
    const caseStart = events[0].start;
    const caseEnd = maxOf(events.map((e) => e.end));
    caseDurations.push({ caseId, ms: caseEnd - caseStart });

    // Nothing below may depend on the order rows appear in the file: steps that
    // start at the same instant are concurrent, and are treated identically.
    let groupStart = null; // start time of the group of steps being processed
    let endBeforeGroup = null; // latest end among steps that started BEFORE that group
    let latestEnd = -Infinity; // latest end among all steps processed so far
    events.forEach((e, i) => {
      const s = stat(e.activity);
      const duration = e.end - e.start;
      s.durations.push(duration);
      s.durationsByCase.push({ caseId, ms: duration });
      s.cases.add(caseId);
      s.actors.add(e.actor);
      s.perCase.set(caseId, [...(s.perCase.get(caseId) ?? []), e]);

      if (e.start !== groupStart) { // events are sorted, so everything seen so far started earlier
        groupStart = e.start;
        endBeforeGroup = latestEnd;
      }
      if (e.start !== caseStart) {
        // Waiting = idle time since everything that started before it had finished.
        const wait = Math.max(0, e.start - endBeforeGroup);
        s.waits.push(wait);
        s.waitsByCase.push({ caseId, ms: wait });
      }
      latestEnd = Math.max(latestEnd, e.end);

      // Same activity, different person, sharing time: duplicated effort. Each
      // pair is counted once; zero-length steps share no time.
      for (const other of events.slice(0, i)) {
        const overlapMs = Math.min(e.end, other.end) - Math.max(e.start, other.start);
        if (other.activity === e.activity && other.actor !== e.actor && overlapMs > 0) {
          if (!parallel.has(e.activity)) parallel.set(e.activity, []);
          parallel.get(e.activity).push({ caseId, overlapMs, actors: [other.actor, e.actor].sort() });
        }
      }
    });

    processed += 1;
    if (processed % YIELD_EVERY_CASES === 0) {
      await new Promise((r) => setImmediate(r)); // let a cancel or timeout land
      await checkpoint(`after ${processed} of ${byCase.size} cases`);
    }
  }
  await checkpoint('after reading the cases');

  // ---- 2. Typical values for the whole process ----
  const allDurations = [...act.values()].flatMap((s) => s.durations);
  const allWaits = [...act.values()].flatMap((s) => s.waits);
  const totalCaseMs = sum(caseDurations.map((c) => c.ms));
  const typical = { stepMs: median(allDurations), waitMs: median(allWaits) };
  const totalCases = byCase.size;

  // ---- 3. Bottlenecks ----
  const bottlenecks = [];
  for (const [activity, s] of act) {
    for (const kind of ['wait', 'step']) {
      const values = kind === 'wait' ? s.waits : s.durations;
      if (values.length < t.minOccurrences) continue;
      const med = median(values);
      const total = sum(values);
      const typicalMs = kind === 'wait' ? typical.waitMs : typical.stepMs;
      const timesTypical = typicalMs > 0 ? med / typicalMs : null;
      const share = totalCaseMs > 0 ? total / totalCaseMs : 0;
      const reasons = [];
      if (timesTypical !== null && timesTypical >= t.bottleneckRatio) {
        reasons.push(`median ${kind === 'wait' ? 'wait before it' : 'duration'} is ${round2(timesTypical)}× the typical ${kind === 'wait' ? 'wait' : 'step'}`);
      }
      if (share >= t.bottleneckShare) reasons.push(`${Math.round(share * 100)}% of all case time is spent ${kind === 'wait' ? 'waiting for it' : 'on it'}`);
      if (!reasons.length) continue;
      bottlenecks.push({
        activity, kind, occurrences: values.length,
        medianMs: med, p90Ms: quantile(values, 0.9), totalMs: total,
        timesTypical: timesTypical === null ? null : round2(timesTypical), shareOfCaseTime: round2(share),
        reasons, exampleCases: topCases(kind === 'wait' ? s.waitsByCase : s.durationsByCase),
      });
    }
  }
  bottlenecks.sort((a, b) => b.totalMs - a.totalMs || byName(a, b));
  await checkpoint('after finding bottlenecks');

  // ---- 4. Duplicated activities ----
  const duplicates = [];
  for (const [activity, s] of act) {
    // A repeat is the activity done AGAIN: an earlier occurrence started before it
    // and had finished by the time it started. Overlapping occurrences are the
    // "parallel" kind below, not counted twice.
    const extra = [];
    for (const [caseId, evs] of s.perCase) {
      const again = evs.filter((e) => evs.some((p) => p !== e && p.start < e.start && p.end <= e.start));
      if (again.length) extra.push({ caseId, ms: sum(again.map((e) => e.end - e.start)), again: again.length });
    }
    if (extra.length) {
      duplicates.push({
        activity, kind: 'repeated',
        casesAffected: extra.length,
        extraOccurrences: sum(extra.map((x) => x.again)),
        extraTimeMs: sum(extra.map((x) => x.ms)),
        reasons: [`done again after it had finished in ${extra.length} case${extra.length === 1 ? '' : 's'} — rework or a loop back to an earlier step`],
        exampleCases: topCases(extra),
      });
    }
  }
  for (const [activity, pairs] of parallel) {
    const cases = new Set(pairs.map((p) => p.caseId));
    duplicates.push({
      activity, kind: 'parallel',
      casesAffected: cases.size,
      extraOccurrences: pairs.length,
      extraTimeMs: sum(pairs.map((p) => p.overlapMs)),
      reasons: [`done by two people at the same time in ${cases.size} case${cases.size === 1 ? '' : 's'} — duplicated effort`],
      exampleCases: topCases(pairs.map((p) => ({ caseId: p.caseId, ms: p.overlapMs }))),
    });
  }
  duplicates.sort((a, b) => b.extraTimeMs - a.extraTimeMs || byName(a, b));
  await checkpoint('after finding duplicates');

  // ---- 5. Automation candidates ----
  const automationCandidates = [];
  for (const [activity, s] of act) {
    const frequency = s.cases.size / totalCases;
    const med = median(s.durations);
    const cv = variation(s.durations);
    if (s.durations.length < t.minOccurrences) continue;
    if (frequency < t.automationMinFrequency || med > t.automationMaxMedianMs || cv > t.automationMaxVariation) continue;
    automationCandidates.push({
      activity, occurrences: s.durations.length,
      frequency: round2(frequency), medianMs: med, variation: round2(cv), totalMs: sum(s.durations), distinctActors: s.actors.size,
      reasons: [
        `happens in ${Math.round(frequency * 100)}% of cases`,
        `usually takes ${Math.round(med / 60000)} min or less`,
        `takes a consistent time (variation ${round2(cv)})`,
      ],
    });
  }
  automationCandidates.sort((a, b) => b.totalMs - a.totalMs || byName(a, b));
  await checkpoint('after finding automation candidates');

  return {
    process: validation.process,
    period: {
      from: new Date(minOf(validation.events.map((e) => e.start))).toISOString(),
      to: new Date(maxOf(validation.events.map((e) => e.end))).toISOString(),
    },
    totals: {
      cases: totalCases,
      events: validation.events.length,
      activities: act.size,
      actors: new Set(validation.events.map((e) => e.actor)).size,
      medianCaseMs: median(caseDurations.map((c) => c.ms)),
      totalCaseMs,
    },
    typical,
    bottlenecks,
    duplicates,
    automationCandidates,
    activities: [...act].map(([activity, s]) => ({
      activity, occurrences: s.durations.length, cases: s.cases.size,
      medianDurationMs: median(s.durations), medianWaitMs: s.waits.length ? median(s.waits) : null,
    })).sort((a, b) => b.occurrences - a.occurrences || byName(a, b)),
    thresholds: t,
  };
}
