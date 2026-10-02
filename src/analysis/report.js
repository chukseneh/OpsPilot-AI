// Turns an analysis (analyse.js) into a report a person can act on: a structured
// JSON report, and the same thing as readable text. Every finding says what was
// found, the numbers behind it and example cases, and the report states the exact
// rules used and what it cannot tell you — so nobody mistakes a pattern in the
// data for a measured saving.

export function formatDuration(ms) {
  if (ms == null) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const examples = (cases) => cases.map((c) => ({ caseId: c.caseId, duration: formatDuration(c.ms) }));

function bottleneckFinding(b) {
  const where = `"${b.activity}"`;
  const title = b.kind === 'wait' ? `Cases wait a long time before ${where}` : `${where} takes a long time`;
  const what = b.kind === 'wait'
    ? `Cases waited a median of ${formatDuration(b.medianMs)} before ${where} started (90th percentile ${formatDuration(b.p90Ms)}), across ${b.occurrences} occurrences — ${formatDuration(b.totalMs)} of waiting in total.`
    : `${where} took a median of ${formatDuration(b.medianMs)} (90th percentile ${formatDuration(b.p90Ms)}), across ${b.occurrences} occurrences — ${formatDuration(b.totalMs)} in total.`;
  return {
    type: 'bottleneck', subtype: b.kind, activity: b.activity, title,
    explanation: `${what} Flagged because: ${b.reasons.join('; ')}.`,
    evidence: {
      occurrences: b.occurrences, median: formatDuration(b.medianMs), p90: formatDuration(b.p90Ms),
      total: formatDuration(b.totalMs), timesTypical: b.timesTypical, shareOfCaseTime: pct(b.shareOfCaseTime),
    },
    exampleCases: examples(b.exampleCases),
  };
}

function duplicateFinding(d) {
  const where = `"${d.activity}"`;
  const repeated = d.kind === 'repeated';
  return {
    type: 'duplicate', subtype: d.kind, activity: d.activity,
    title: repeated ? `${where} is redone` : `${where} is done twice at the same time`,
    explanation: repeated
      ? `${where} was done again after it had finished in ${plural(d.casesAffected, 'case', 'cases')} (${plural(d.extraOccurrences, 'extra time', 'extra times')}), costing ${formatDuration(d.extraTimeMs)} of repeated work. This usually means rework or a loop back to an earlier step.`
      : `In ${plural(d.casesAffected, 'case', 'cases')} two people did ${where} at the same time (${plural(d.extraOccurrences, 'overlap', 'overlaps')}), duplicating ${formatDuration(d.extraTimeMs)} of effort.`,
    evidence: { casesAffected: d.casesAffected, extraOccurrences: d.extraOccurrences, extraTime: formatDuration(d.extraTimeMs) },
    exampleCases: examples(d.exampleCases),
  };
}

function automationFinding(a) {
  return {
    type: 'automation', subtype: 'candidate', activity: a.activity,
    title: `"${a.activity}" may be a candidate for automation`,
    explanation: `It ${a.reasons.join(', ')}. Seen ${plural(a.occurrences, 'time', 'times')}, ${formatDuration(a.totalMs)} in total, done by ${plural(a.distinctActors, 'person', 'people')}. A candidate only: check the step's rules and exceptions before automating it.`,
    evidence: {
      occurrences: a.occurrences, frequency: pct(a.frequency), median: formatDuration(a.medianMs),
      variation: a.variation, total: formatDuration(a.totalMs), distinctActors: a.distinctActors,
    },
    exampleCases: [],
  };
}

function headline(findings) {
  const first = findings.find((f) => f.type === 'bottleneck') ?? findings.find((f) => f.type === 'duplicate');
  if (first) return `Biggest issue: ${first.title.charAt(0).toLowerCase()}${first.title.slice(1)}. ${first.explanation.split(' Flagged because')[0]}`;
  if (findings.length) return 'No bottlenecks or duplicated work met the rules; see the automation candidates below.';
  return 'No inefficiencies met the rules for this data. That is a result, not a missing report: see Method for what was checked.';
}

export function buildReport(analysis, { analysisId, requestedBy, generatedAt = new Date() } = {}) {
  if (!analysis?.totals) throw new TypeError('buildReport needs the result of analyse()');
  if (typeof analysisId !== 'string' || !analysisId) throw new TypeError('buildReport needs an analysisId');
  if (!requestedBy?.id) throw new TypeError('buildReport needs requestedBy (who ran the analysis)');

  const findings = [
    ...analysis.bottlenecks.map(bottleneckFinding),
    ...analysis.duplicates.map(duplicateFinding),
    ...analysis.automationCandidates.map(automationFinding),
  ].map((f, i) => ({ id: `F${i + 1}`, ...f }));

  const t = analysis.thresholds;
  return {
    reportVersion: 1,
    analysisId,
    process: analysis.process,
    generatedAt: generatedAt.toISOString(),
    requestedBy: { type: requestedBy.type, id: requestedBy.id },
    scope: {
      period: analysis.period,
      cases: analysis.totals.cases,
      events: analysis.totals.events,
      activities: analysis.totals.activities,
      people: analysis.totals.actors,
      medianCaseDuration: formatDuration(analysis.totals.medianCaseMs),
      typicalStep: formatDuration(analysis.typical.stepMs),
      typicalWait: formatDuration(analysis.typical.waitMs),
    },
    summary: {
      bottlenecks: analysis.bottlenecks.length,
      duplicates: analysis.duplicates.length,
      automationCandidates: analysis.automationCandidates.length,
      headline: headline(findings),
    },
    findings,
    activities: analysis.activities.map((a) => ({
      activity: a.activity, occurrences: a.occurrences, cases: a.cases,
      medianDuration: formatDuration(a.medianDurationMs), medianWaitBefore: formatDuration(a.medianWaitMs),
    })),
    method: {
      thresholds: t,
      rules: [
        `Bottleneck: the median wait before a step, or the step itself, is at least ${t.bottleneckRatio}× the process's typical value, or takes at least ${pct(t.bottleneckShare)} of all case time.`,
        'Duplicated work: a step done again after it had finished in the same case, or done by two people at the same time.',
        `Automation candidate: a step in at least ${pct(t.automationMinFrequency)} of cases, usually ${formatDuration(t.automationMaxMedianMs)} or less, with a consistent duration (variation at most ${t.automationMaxVariation}).`,
        `Nothing is flagged on fewer than ${t.minOccurrences} observations.`,
      ],
    },
    limitations: [
      `Based only on the event log supplied (${plural(analysis.totals.cases, 'case', 'cases')}, ${analysis.period.from} to ${analysis.period.to}); work that was not recorded in it is invisible here.`,
      'Durations are measured from recorded start and end times on the clock, so waiting includes nights and weekends.',
      'Automation candidates are suggestions from timing patterns. This report does not estimate savings.',
      'The thresholds above are fixed settings; different settings would flag different things.',
    ],
  };
}

export function renderReportText(r) {
  const out = [];
  out.push(`# Process analysis: ${r.process}`, '');
  out.push(`Analysis ${r.analysisId}, run by ${r.requestedBy.id} at ${r.generatedAt}.`);
  out.push(`Covers ${r.scope.cases} cases and ${r.scope.events} events from ${r.scope.period.from} to ${r.scope.period.to}; median case took ${r.scope.medianCaseDuration}.`, '');
  out.push('## Summary', '', r.summary.headline, '');
  out.push(`- Bottlenecks: ${r.summary.bottlenecks}`, `- Duplicated work: ${r.summary.duplicates}`, `- Automation candidates: ${r.summary.automationCandidates}`, '');

  const section = (title, type, none) => {
    out.push(`## ${title}`, '');
    const fs = r.findings.filter((f) => f.type === type);
    if (!fs.length) { out.push(none, ''); return; }
    for (const f of fs) {
      out.push(`### ${f.id}. ${f.title}`, '', f.explanation, '');
      if (f.exampleCases.length) out.push(`Example cases: ${f.exampleCases.map((c) => `${c.caseId} (${c.duration})`).join(', ')}`, '');
    }
  };
  section('Bottlenecks', 'bottleneck', 'No step met the bottleneck rule.');
  section('Duplicated work', 'duplicate', 'No duplicated work was found.');
  section('Automation candidates', 'automation', 'No step met the automation-candidate rule.');

  out.push('## Activities', '', '| Activity | Occurrences | Cases | Median duration | Median wait before |', '|---|---|---|---|---|');
  for (const a of r.activities) out.push(`| ${a.activity} | ${a.occurrences} | ${a.cases} | ${a.medianDuration} | ${a.medianWaitBefore} |`);
  out.push('', '## Method', '', ...r.method.rules.map((x) => `- ${x}`), '');
  out.push('## What this report does not tell you', '', ...r.limitations.map((x) => `- ${x}`), '');
  return out.join('\n');
}
