// Analysis report (STORY-002). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateDataset } from '../src/analysis/processData.js';
import { analyse } from '../src/analysis/analyse.js';
import { buildReport, renderReportText, formatDuration } from '../src/analysis/report.js';

const MIN = 60 * 1000;
const analyst = { type: 'person', id: 'analyst-7' };

async function analysisOf(cases) {
  const events = cases.flatMap((steps, i) => steps.map(([activity, s, e, actor = 'clerk-1']) => {
    const base = Date.UTC(2026, 8, 1 + i, 9);
    return { caseId: `C${i + 1}`, activity, actor, startedAt: new Date(base + s * MIN).toISOString(), endedAt: new Date(base + e * MIN).toISOString() };
  }));
  return analyse(validateDataset({ process: 'Invoice approval', events }));
}

const invoiceCases = () => [10, 40, 90, 5, 60, 20, 75, 15, 50, 30].map((m, i) => [
  ['Receive', 0, 5], ['Approve', 125, 125 + m, 'manager-1'], ['Pay', 130 + m, 133 + m],
  ...(i < 2 ? [['Pay', 140 + m, 143 + m]] : []), // paid twice in two cases
]);

test('formatDuration reads like a person wrote it', () => {
  assert.equal(formatDuration(45 * 1000), '45 s');
  assert.equal(formatDuration(5 * MIN), '5 min');
  assert.equal(formatDuration(125 * MIN), '2 h 5 min');
  assert.equal(formatDuration(26 * 60 * MIN), '1 d 2 h');
  assert.equal(formatDuration(null), 'n/a');
});

test('the report lists every finding with an id, an explanation, its numbers and example cases', async () => {
  const report = buildReport(await analysisOf(invoiceCases()), {
    analysisId: 'AN-1', requestedBy: analyst, generatedAt: new Date('2026-10-03T08:00:00Z'),
  });

  assert.equal(report.analysisId, 'AN-1');
  assert.deepEqual(report.requestedBy, analyst);
  assert.equal(report.generatedAt, '2026-10-03T08:00:00.000Z');
  assert.deepEqual(report.findings.map((f) => f.id), report.findings.map((_, i) => `F${i + 1}`));

  const wait = report.findings[0];
  assert.equal(wait.type, 'bottleneck');
  assert.equal(wait.title, 'Cases wait a long time before "Approve"');
  assert.match(wait.explanation, /median of 2 h 0 min before "Approve"/);
  // 17.14×, not 24×: the two extra "Pay" steps add 7-minute waits, which move the
  // process's typical wait from 5 to 7 minutes (120 / 7 = 17.14).
  assert.match(wait.explanation, /Flagged because: median wait before it is 17\.14× the typical wait; 69% of all case time/);
  assert.equal(wait.evidence.median, '2 h 0 min');
  assert.equal(wait.exampleCases.length, 3);

  const redo = report.findings.find((f) => f.type === 'duplicate');
  assert.equal(redo.title, '"Pay" is redone');
  assert.match(redo.explanation, /in 2 cases \(2 extra times\), costing 6 min/);

  assert.ok(report.findings.some((f) => f.type === 'automation' && f.activity === 'Receive'));
  assert.match(report.summary.headline, /^Biggest issue: cases wait a long time before "Approve"/);
  assert.equal(report.summary.bottlenecks + report.summary.duplicates + report.summary.automationCandidates, report.findings.length);
});

test('the report states its method and what it cannot tell you', async () => {
  const report = buildReport(await analysisOf(invoiceCases()), { analysisId: 'AN-2', requestedBy: analyst });
  assert.match(report.method.rules[0], /at least 2× .* or takes at least 25% of all case time/);
  assert.equal(report.method.thresholds.minOccurrences, 3);
  assert.ok(report.limitations.some((l) => /does not estimate savings/.test(l)));
  assert.ok(report.limitations.some((l) => /nights and weekends/.test(l)));
});

test('the readable version has every section, in plain units', async () => {
  const text = renderReportText(buildReport(await analysisOf(invoiceCases()), { analysisId: 'AN-3', requestedBy: analyst }));
  for (const heading of ['# Process analysis: Invoice approval', '## Summary', '## Bottlenecks', '## Duplicated work',
    '## Automation candidates', '## Activities', '## Method', '## What this report does not tell you']) {
    assert.ok(text.includes(heading), `missing ${heading}`);
  }
  assert.match(text, /### F1\. Cases wait a long time before "Approve"/);
  assert.match(text, /Example cases: C\d+ \(2 h 0 min\)/);
  assert.match(text, /\| Approve \| 10 \| 10 \|/);
  assert.ok(!/\d{6,}/.test(text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '')), 'no raw millisecond numbers');
});

test('when nothing meets the rules, the report says so instead of looking empty', async () => {
  const smooth = Array.from({ length: 4 }, () => [['A', 0, 30], ['B', 30, 60], ['C', 60, 90], ['D', 90, 120], ['E', 120, 150]]);
  const report = buildReport(await analysisOf(smooth), { analysisId: 'AN-4', requestedBy: analyst });
  assert.deepEqual(report.findings, []);
  assert.match(report.summary.headline, /No inefficiencies met the rules/);
  const text = renderReportText(report);
  assert.match(text, /No step met the bottleneck rule\./);
  assert.match(text, /No duplicated work was found\./);
});

test('buildReport refuses to make a report without an analysis, an id or a requester', async () => {
  const a = await analysisOf(invoiceCases());
  assert.throws(() => buildReport(undefined, { analysisId: 'x', requestedBy: analyst }), /result of analyse/);
  assert.throws(() => buildReport(a, { requestedBy: analyst }), /analysisId/);
  assert.throws(() => buildReport(a, { analysisId: 'x' }), /requestedBy/);
});
