// The STORY-003 report text and demo. Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRiskDemo } from '../src/demo/riskAssessment.js';
import { sampleAiSystems } from '../src/demo/sampleAiSystems.js';
import { renderRiskReportText } from '../src/risk/report.js';

const quiet = () => {};

test('demo: planted risks found and categorised with mitigations, gap reported, analyst refused, audit verifies', async () => {
  const r = await runRiskDemo({ outDir: mkdtempSync(join(tmpdir(), 'risk-demo-')), print: quiet });
  assert.equal(r.first.status, 'completed');
  const { report } = r.first;
  const level = Object.fromEntries(report.systems.map((s) => [s.systemId, s.riskLevel]));
  assert.deepEqual(level, {
    'ai-cv-screen': 'high', 'ai-claims-triage': 'high', 'ai-help-chat': 'low', 'ai-demand-forecast': 'low',
  });
  const claims = report.systems.find((s) => s.systemId === 'ai-claims-triage');
  assert.deepEqual(claims.risks.map((x) => `${x.category}:${x.severity}`),
    ['fairness:high', 'privacy:medium', 'human_oversight:medium', 'security:medium']); // equal severity: category order
  assert.ok(report.systems.every((s) => s.risks.every((x) => x.mitigations.length > 0)));
  assert.deepEqual(report.unassessed.map((u) => u.systemId), ['ai-sentiment']);

  assert.equal(r.again.replayed, true);
  assert.equal(r.refused.status, 'permission_denied');
  assert.equal(r.entries.filter((e) => e.action === 'risk.system_assessed').length, 4);
  assert.ok(r.entries.every((e) => e.actor.type === 'person' && e.actor.id && e.at));
  assert.equal(r.audit.ok, true);
});

test('the report text shows each system worst first, its risks by category, mitigations, the gap and the limits', async () => {
  const r = await runRiskDemo({ outDir: mkdtempSync(join(tmpdir(), 'risk-demo-')), print: quiet });
  const text = renderRiskReportText(r.first.report);
  assert.match(text, /Registered: 5 {3}Assessed: 4 {3}Not assessed \(incomplete data\): 1/);
  assert.ok(text.indexOf('[HIGH] CV screener') < text.indexOf('[LOW] Demand forecast'));
  assert.match(text, /1\. human oversight — high: .*no person involved/);
  assert.match(text, /→ Require a named person to approve each high-impact output/);
  assert.match(text, /\[LOW\] Demand forecast .*\n {2}No rule raised a risk\./);
  assert.match(text, /"Call sentiment scorer" \(ai-sentiment\) was not assessed: "humanOversight" is missing; "userFacing" is missing/);
  assert.match(text, /What this report cannot tell you:/);
});

test('demo run twice in one folder replays the saved assessment instead of redoing it', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'risk-demo-'));
  await runRiskDemo({ outDir, print: quiet });
  const second = await runRiskDemo({ outDir, print: quiet });
  assert.equal(second.first.replayed, true);
  assert.equal(second.entries.filter((e) => e.action === 'risk.system_assessed').length, 0);
  assert.equal(second.audit.ok, true);
});

test('the sample systems are identical on every run', () => {
  assert.deepEqual(sampleAiSystems(), sampleAiSystems());
});
