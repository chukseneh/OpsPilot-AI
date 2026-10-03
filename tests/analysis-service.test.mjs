// Analysis service and process agent (STORY-002). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnalysisService, PermissionDeniedError, AnalysisRequestError } from '../src/analysis/service.js';
import { createProcessAnalystAgent } from '../src/analysis/processAgent.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';
import { createRegistry } from '../src/orchestration/agents.js';
import { createOrchestrator } from '../src/orchestration/orchestrator.js';

const MIN = 60 * 1000;
const analyst = { id: 'analyst-7', role: 'process analyst' };

function dataset(cases = 10) {
  const events = [];
  for (let i = 0; i < cases; i += 1) {
    const base = Date.UTC(2026, 8, 1 + (i % 28), 9) + Math.floor(i / 28) * 1000;
    const at = (m) => new Date(base + m * MIN).toISOString();
    const approve = [10, 40, 90, 5, 60, 20, 75, 15, 50, 30][i % 10];
    events.push(
      { caseId: `C${i + 1}`, activity: 'Receive', actor: 'clerk-1', startedAt: at(0), endedAt: at(5) },
      { caseId: `C${i + 1}`, activity: 'Approve', actor: 'manager-1', startedAt: at(125), endedAt: at(125 + approve) },
      { caseId: `C${i + 1}`, activity: 'Pay', actor: 'clerk-2', startedAt: at(130 + approve), endedAt: at(133 + approve) },
    );
  }
  return { process: 'Invoice approval', events };
}

function setup(options = {}) {
  const audit = options.audit ?? createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'svc-')), 'audit.jsonl') });
  const store = options.store ?? createMemoryResultStore();
  const service = createAnalysisService({ audit, store, timeoutMs: options.timeoutMs ?? 5000 });
  const actions = (id) => audit.readAll().filter((e) => !id || e.correlationId === id).map((e) => e.action);
  return { service, audit, store, actions };
}

// ---- Acceptance 1: a detailed report of inefficiencies ----

test('an analyst gets a detailed report of inefficiencies', async () => {
  const { service, actions } = setup();
  const r = await service.runAnalysis({ analysisId: 'AN-1', user: analyst, dataset: dataset() });

  assert.equal(r.status, 'completed');
  assert.equal(r.report.process, 'Invoice approval');
  assert.equal(r.report.findings[0].title, 'Cases wait a long time before "Approve"');
  assert.ok(r.report.findings.some((f) => f.type === 'automation'));
  assert.deepEqual(r.report.requestedBy, { type: 'person', id: 'analyst-7' });
  assert.match(r.text, /## Bottlenecks/);
  assert.deepEqual(actions('AN-1'), ['analysis.requested', 'analysis.started', 'analysis.completed']);
});

// ---- Acceptance 2: incomplete data → the user is told what is missing ----

test('incomplete data produces no report and tells the user exactly what is missing', async () => {
  const { service, store, audit, actions } = setup();
  const data = dataset();
  delete data.events[4].endedAt;
  data.events[7].actor = '';

  const r = await service.runAnalysis({ analysisId: 'AN-2', user: analyst, dataset: data });

  assert.equal(r.status, 'missing_data');
  assert.equal(r.report, undefined);
  assert.match(r.notice, /^The analysis was not run because the data is incomplete/);
  assert.match(r.notice, /"endedAt" is missing in 1 row \(row 5; case C2\)/);
  assert.match(r.notice, /"actor" is missing in 1 row \(row 8; case C3\)/);
  assert.equal(r.problems.length, 2);
  assert.equal(store.get('AN-2'), null, 'nothing saved');
  assert.deepEqual(actions('AN-2'), ['analysis.requested', 'analysis.missing_data']);
  const logged = audit.readAll().find((e) => e.action === 'analysis.missing_data');
  assert.equal(logged.detail.totalProblems, 2);

  // Fixed data under a new id goes through.
  assert.equal((await service.runAnalysis({ analysisId: 'AN-2b', user: analyst, dataset: dataset() })).status, 'completed');
});

// ---- Acceptance 3: every activity logged with a timestamp and a user id ----

test('every analysis activity is logged with a timestamp and the user id — including refusals and failures', async () => {
  const { service, audit } = setup();
  await service.runAnalysis({ analysisId: 'AN-3', user: analyst, dataset: dataset() });
  await service.runAnalysis({ analysisId: 'AN-3', user: analyst, dataset: dataset() }); // replay
  await service.runAnalysis({ analysisId: 'AN-3c', user: analyst, dataset: { process: 'x', events: [] } }); // missing data
  await assert.rejects(service.runAnalysis({ analysisId: 'AN-3d', user: { id: 'intern-1', role: 'intern' }, dataset: dataset() }));

  const entries = audit.readAll();
  assert.ok(entries.length >= 9);
  for (const e of entries) {
    assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `#${e.seq} has a timestamp`);
    assert.ok(['analyst-7', 'intern-1'].includes(e.actor.id), `#${e.seq} ${e.action} has the user id, got ${e.actor.id}`);
    assert.equal(e.actor.type, 'person');
  }
  assert.equal(audit.verify().ok, true);
});

// ---- Failure path: no permission ----

test('a user without an allowed role is refused before anything is analysed, and the refusal is logged', async () => {
  const { service, store, audit, actions } = setup();
  for (const user of [{ id: 'intern-1', role: 'intern' }, { id: 'nobody-1' }]) {
    await assert.rejects(service.runAnalysis({ analysisId: `AN-4-${user.id}`, user, dataset: dataset() }), PermissionDeniedError);
    assert.deepEqual(actions(`AN-4-${user.id}`), ['analysis.requested', 'analysis.denied']);
    assert.equal(store.get(`AN-4-${user.id}`), null);
  }
  assert.match(audit.readAll().find((e) => e.action === 'analysis.denied').rationale, /Role "intern" may not run process analysis/);
});

test('roles are matched regardless of case, spaces or underscores', async () => {
  const { service } = setup();
  const r = await service.runAnalysis({ analysisId: 'AN-5', user: { id: 'om-1', role: ' Operations_Manager ' }, dataset: dataset() });
  assert.equal(r.status, 'completed');
});

test("a user without permission cannot read someone else's saved report by replaying its id", async () => {
  const { service } = setup();
  await service.runAnalysis({ analysisId: 'AN-6', user: analyst, dataset: dataset() });
  await assert.rejects(service.runAnalysis({ analysisId: 'AN-6', user: { id: 'intern-1', role: 'intern' }, dataset: dataset() }), PermissionDeniedError);
});

// ---- Failure path: analysis interrupted ----

test('an analysis cancelled by the caller is interrupted, logged, saves nothing, and can be re-run', async () => {
  const { service, store, actions } = setup();
  const controller = new AbortController();
  controller.abort();
  const r = await service.runAnalysis({ analysisId: 'AN-7', user: analyst, dataset: dataset(), signal: controller.signal });

  assert.equal(r.status, 'interrupted');
  assert.match(r.message, /interrupted .* nothing was saved\. Run it again to retry\./);
  assert.equal(store.get('AN-7'), null);
  assert.deepEqual(actions('AN-7'), ['analysis.requested', 'analysis.started', 'analysis.interrupted']);

  const again = await service.runAnalysis({ analysisId: 'AN-7', user: analyst, dataset: dataset() });
  assert.equal(again.status, 'completed');
});

test('an analysis that runs past its time limit is interrupted, not left hanging', async () => {
  const { service, audit } = setup({ timeoutMs: 5 });
  const r = await service.runAnalysis({ analysisId: 'AN-8', user: analyst, dataset: dataset(20000) });
  assert.equal(r.status, 'interrupted');
  assert.match(r.message, /timed out after 5 ms/);
  assert.match(audit.readAll().at(-1).rationale, /^Stopped \(timed out after 5 ms\) after \d+ of 20000 cases; nothing was saved\.$/);
});

// ---- Running it twice ----

test('the same analysis asked for again returns the saved report without analysing again', async () => {
  const { service, actions } = setup();
  const first = await service.runAnalysis({ analysisId: 'AN-9', user: analyst, dataset: dataset() });
  const second = await service.runAnalysis({ analysisId: 'AN-9', user: analyst, dataset: dataset() });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.report, first.report);
  assert.equal(actions('AN-9').filter((a) => a === 'analysis.started').length, 1);
  assert.equal(actions('AN-9').at(-1), 'analysis.replayed');
});

test('an analysis id reused with different data is refused', async () => {
  const { service, actions } = setup();
  await service.runAnalysis({ analysisId: 'AN-10', user: analyst, dataset: dataset() });
  await assert.rejects(service.runAnalysis({ analysisId: 'AN-10', user: analyst, dataset: dataset(11) }), AnalysisRequestError);
  assert.equal(actions('AN-10').at(-1), 'analysis.rejected');
});

test('two requests for the same analysis at once run it only once', async () => {
  const { service, actions } = setup();
  const [a, b] = await Promise.all([
    service.runAnalysis({ analysisId: 'AN-11', user: analyst, dataset: dataset(500) }),
    service.runAnalysis({ analysisId: 'AN-11', user: analyst, dataset: dataset(500) }),
  ]);
  assert.equal(a, b);
  assert.equal(actions('AN-11').filter((x) => x === 'analysis.started').length, 1);
  assert.ok(actions('AN-11').includes('analysis.joined'));
});

// ---- Guardrail and bad requests ----

test('if the audit log cannot be written, the analysis does not run', async () => {
  const real = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'svc-')), 'audit.jsonl') });
  const failing = { append: () => { throw new AuditWriteError('disk full'); }, readAll: () => real.readAll() };
  const { service, store } = setup({ audit: failing });
  await assert.rejects(service.runAnalysis({ analysisId: 'AN-12', user: analyst, dataset: dataset() }), AuditWriteError);
  assert.equal(store.get('AN-12'), null);
});

test('invalid thresholds are refused as a bad request before anything is analysed', async () => {
  const { service, actions } = setup();
  await assert.rejects(
    service.runAnalysis({ analysisId: 'AN-14', user: analyst, dataset: dataset(), thresholds: { bottleneckRatio: 'two' } }),
    (err) => err instanceof AnalysisRequestError && /"bottleneckRatio" cannot be "two"/.test(err.message),
  );
  assert.deepEqual(actions('AN-14'), ['analysis.requested', 'analysis.rejected']);
});

test('a request with no analysis id or no user is refused and logged', async () => {
  const { service, audit } = setup();
  await assert.rejects(service.runAnalysis({ user: analyst, dataset: dataset() }), /analysisId/);
  await assert.rejects(service.runAnalysis({ analysisId: 'AN-13', dataset: dataset() }), /user\.id is required/);
  assert.deepEqual(audit.readAll().map((e) => [e.correlationId, e.actor.id, e.action]), [
    ['invalid-request', 'analyst-7', 'analysis.rejected'],
    ['AN-13', 'unknown-requester', 'analysis.rejected'],
  ]);
});

// ---- Through the STORY-001 orchestrator ----

test('the process analyst runs as a real agent under the orchestrator; refused requests do not count as agent failures', async () => {
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'svc-')), 'audit.jsonl') });
  const service = createAnalysisService({ audit, store: createMemoryResultStore() });
  const registry = createRegistry([createProcessAnalystAgent({ service })]);
  const orchestrator = createOrchestrator({ registry, audit, store: createMemoryResultStore() });
  const requestedBy = { type: 'person', id: 'operations_manager' };

  const ok = await orchestrator.runOperation({
    operationId: 'op-analyse', requestedBy,
    tasks: [{ id: 'analyse', capability: 'process', input: { user: analyst, dataset: dataset() } }],
  });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.tasks[0].agentId, 'process-analyst');
  assert.equal(ok.tasks[0].output.status, 'completed');
  assert.equal(ok.tasks[0].output.analysisId, 'op-analyse:analyse');

  const refused = await orchestrator.runOperation({
    operationId: 'op-refused', requestedBy,
    tasks: [
      { id: 'no-permission', capability: 'process', input: { user: { id: 'intern-1', role: 'intern' }, dataset: dataset() } },
      { id: 'no-data', capability: 'process', input: { user: analyst, dataset: { process: 'x', events: [] } } },
    ],
  });
  assert.deepEqual(refused.tasks.map((t) => t.output.status), ['permission_denied', 'missing_data']);
  assert.equal(registry.isHealthy('process-analyst'), true, 'a refused request did not take the agent out of rotation');
  assert.equal(audit.verify().ok, true);
});
