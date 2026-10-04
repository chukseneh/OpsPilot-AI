// Dashboard data layer (STORY-011). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDashboardData, DashboardDataError } from '../src/dashboard/data.js';
import { createMemoryResultStore, createFileResultStore } from '../src/orchestration/resultStore.js';
import { createAnalysisService } from '../src/analysis/service.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { sampleInvoiceProcess } from '../src/demo/sampleProcessData.js';

const analyst = { id: 'analyst-7', role: 'process analyst' };
const tmp = () => mkdtempSync(join(tmpdir(), 'dash-'));

// Real reports, made by the real STORY-002 service.
async function storeWithAnalyses(ids) {
  const store = createMemoryResultStore();
  const service = createAnalysisService({ audit: createAuditLog({ file: join(tmp(), 'audit.jsonl') }), store });
  for (const id of ids) await service.runAnalysis({ analysisId: id, user: analyst, dataset: sampleInvoiceProcess() });
  return store;
}

test('lists completed analyses, newest first, with their headline and counts', async () => {
  const store = await storeWithAnalyses(['AN-1', 'AN-2']);
  const { analyses, skipped } = await createDashboardData({ store }).listAnalyses();

  assert.equal(skipped, 0);
  assert.deepEqual(analyses.map((a) => a.analysisId), ['AN-2', 'AN-1']);
  const a = analyses[0];
  assert.equal(a.process, 'Invoice approval');
  assert.equal(a.requestedBy, 'analyst-7');
  assert.equal(a.cases, 30);
  assert.match(a.headline, /^Biggest issue: cases wait a long time before "Manager approval"/);
  assert.deepEqual(a.counts, { bottlenecks: 3, duplicates: 2, automationCandidates: 3 });
});

test('an empty store lists nothing (the "no data" case)', async () => {
  assert.deepEqual(await createDashboardData({ store: createMemoryResultStore() }).listAnalyses(), { analyses: [], skipped: 0 });
});

test('analyses that never produced a report are not listed', async () => {
  const store = createMemoryResultStore();
  const service = createAnalysisService({ audit: createAuditLog({ file: join(tmp(), 'audit.jsonl') }), store });
  await service.runAnalysis({ analysisId: 'AN-gaps', user: analyst, dataset: { process: 'x', events: [] } }); // missing data
  store.put('AN-running', { status: 'running' });
  assert.deepEqual((await createDashboardData({ store }).listAnalyses()).analyses, []);
});

test('a damaged record is skipped and counted, and the rest still show', async () => {
  const store = await storeWithAnalyses(['AN-ok']);
  store.put('AN-broken', { status: 'completed', result: { report: { analysisId: 'AN-broken' } } });
  const data = createDashboardData({ store });
  const { analyses, skipped } = await data.listAnalyses();
  assert.deepEqual(analyses.map((a) => a.analysisId), ['AN-ok']);
  assert.equal(skipped, 1);
  await assert.rejects(data.getAnalysis('AN-broken'), (err) => err instanceof DashboardDataError && /damaged/.test(err.message));
});

test('getAnalysis returns the full report, or null if there is none', async () => {
  const store = await storeWithAnalyses(['AN-1']);
  const data = createDashboardData({ store });
  const report = await data.getAnalysis('AN-1');
  assert.ok(report.findings.some((f) => f.type === 'automation'));
  assert.equal(await data.getAnalysis('AN-nope'), null);
  assert.equal(await data.getAnalysis(''), null);
});

// ---- Data retrieval failure ----

test('a corrupted store file is a DashboardDataError with a plain message, not a crash', async () => {
  const file = join(tmp(), 'analyses.json');
  writeFileSync(file, '{ this is not json');
  await assert.rejects(
    createDashboardData({ store: createFileResultStore({ file }) }).listAnalyses(),
    (err) => err instanceof DashboardDataError && /^Could not read the saved analyses/.test(err.message) && err.cause instanceof SyntaxError,
  );
});

test('a store that throws, or returns the wrong shape, is a DashboardDataError', async () => {
  const throwing = { list: () => { throw new Error('disk unplugged'); }, get: () => { throw new Error('disk unplugged'); } };
  await assert.rejects(createDashboardData({ store: throwing }).listAnalyses(), /Could not read the saved analyses: disk unplugged/);
  await assert.rejects(createDashboardData({ store: throwing }).getAnalysis('x'), /Could not read analysis x: disk unplugged/);
  const odd = { list: () => 'nope', get: () => null };
  await assert.rejects(createDashboardData({ store: odd }).listAnalyses(), /not in the expected format/);
});

test('a store slower than the time limit is a DashboardDataError, not a hang', async () => {
  const slow = { list: () => new Promise(() => {}), get: () => new Promise(() => {}) };
  await assert.rejects(createDashboardData({ store: slow, timeoutMs: 20 }).listAnalyses(), /took longer than 20 ms/);
});

test('refuses to start without a usable store', () => {
  assert.throws(() => createDashboardData({ store: { get() {} } }), /list\(\) and get\(\)/);
});
