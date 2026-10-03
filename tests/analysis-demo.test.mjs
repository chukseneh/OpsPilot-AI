// The STORY-002 demo runs end to end. Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAnalysisDemo } from '../src/demo/analyse.js';
import { sampleInvoiceProcess } from '../src/demo/sampleProcessData.js';

test('the sample data is identical on every run and labelled as synthetic', () => {
  assert.deepEqual(sampleInvoiceProcess(), sampleInvoiceProcess());
  assert.match(sampleInvoiceProcess()._note, /SYNTHETIC/);
});

test('demo: report finds the planted problems, gaps give a notice, intern is refused, audit verifies', async () => {
  const r = await runAnalysisDemo({ outDir: mkdtempSync(join(tmpdir(), 'an-demo-')), print: () => {} });

  assert.equal(r.full.status, 'completed');
  const titles = r.full.report.findings.map((f) => f.title);
  assert.equal(titles[0], 'Cases wait a long time before "Manager approval"');
  assert.ok(titles.includes('"Check purchase order" is redone'));
  assert.ok(titles.includes('"Manager approval" is done twice at the same time'));
  assert.ok(titles.includes('"Enter invoice into system" may be a candidate for automation'));

  assert.equal(r.gaps.status, 'missing_data');
  assert.equal(r.gaps.problems.length, 3);
  assert.equal(r.refused.status, 'permission_denied');

  assert.ok(r.entries.every((e) => e.actor.type === 'person' && e.actor.id && e.at));
  assert.equal(r.audit.ok, true);
});

test('demo run twice in one folder replays, and does not show the first run\'s audit entries as new', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'an-demo-'));
  await runAnalysisDemo({ outDir, print: () => {} });
  const printed = [];
  const second = await runAnalysisDemo({ outDir, print: (line) => printed.push(line) });
  assert.equal(second.full.replayedFromEarlierRun, true);
  assert.deepEqual(second.entries, []);
  assert.ok(printed.some((l) => /No new analysis entries/.test(l)));
  assert.equal(second.audit.ok, true);
});
