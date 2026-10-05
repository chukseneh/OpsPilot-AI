// Risk assessment service (STORY-003). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRiskAssessmentService, PermissionDeniedError, RiskRequestError } from '../src/risk/service.js';
import { createRuleBasedRiskModel } from '../src/risk/riskModel.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';

const officer = { id: 'co-3', role: 'Compliance_Officer' };

const system = (over = {}) => ({
  id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications',
  owner: 'hr-lead-1', status: 'active', dataCategories: ['personal'], decisionImpact: 'significant',
  humanOversight: 'none', userFacing: false, ...over,
});
const registered = () => [
  system(),
  system({ id: 'ai-chat', name: 'Help chatbot', department: 'Support', dataCategories: ['public'], decisionImpact: 'low', humanOversight: 'review', userFacing: true }),
  system({ id: 'ai-forecast', name: 'Demand forecast', department: 'Ops', dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'approval' }),
];

function setup({ model, timeoutMs = 5000 } = {}) {
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'risk-')), 'audit.jsonl') });
  const store = createMemoryResultStore();
  const service = createRiskAssessmentService({ audit, store, model, timeoutMs });
  const entries = (id) => audit.readAll().filter((e) => e.correlationId === id);
  const actions = (id) => entries(id).map((e) => e.action);
  return { audit, store, service, entries, actions };
}

// ---- Acceptance 1 and 2: risks identified and categorised, mitigations suggested ----

test('registered systems are assessed: risks identified, categorised, rated, with mitigations', async () => {
  const { service, store } = setup();
  const r = await service.runAssessment({ assessmentId: 'RA-1', user: officer, systems: registered() });
  assert.equal(r.status, 'completed');
  const { report } = r;
  assert.equal(report.summary.assessed, 3);
  assert.deepEqual(report.summary.systemsByRiskLevel, { high: 1, medium: 0, low: 2 });

  const cv = report.systems.find((s) => s.systemId === 'ai-cv-screen');
  assert.equal(cv.riskLevel, 'high');
  assert.deepEqual(cv.risks.map((x) => x.category), ['human_oversight', 'privacy', 'fairness']);
  for (const risk of cv.risks) assert.ok(risk.mitigations.length > 0);
  assert.equal(report.systems.find((s) => s.systemId === 'ai-chat').risks[0].category, 'transparency');
  assert.equal(report.summary.risksByCategory.human_oversight, 1);
  assert.ok(report.limits.length > 0);
  assert.ok(store.get('RA-1'), 'a completed assessment is saved');
});

// ---- Trust: results are logged for audit ----

test('every step and every system result is in the audit log, with the requester as actor, before it is returned', async () => {
  const { service, audit, entries, actions } = setup();
  const r = await service.runAssessment({ assessmentId: 'RA-2', user: officer, systems: registered() });
  assert.deepEqual(actions('RA-2'), [
    'risk.requested', 'risk.started', 'risk.system_assessed', 'risk.system_assessed', 'risk.system_assessed', 'risk.completed',
  ]);
  for (const e of entries('RA-2')) {
    assert.deepEqual(e.actor, { type: 'person', id: 'co-3' });
    assert.ok(!Number.isNaN(Date.parse(e.at)));
  }
  const logged = entries('RA-2').find((e) => e.subject === 'ai-cv-screen').detail;
  const returned = r.report.systems.find((s) => s.systemId === 'ai-cv-screen');
  assert.deepEqual(logged, returned, 'the logged result is exactly the returned one, mitigations included');
  assert.deepEqual(entries('RA-2').at(-1).detail, r.report.summary);
  assert.equal(audit.verify().ok, true);
});

// ---- Failure path: incomplete system data ----

test('a system with incomplete data is unassessed and named; the others are still assessed', async () => {
  const { service, actions, entries } = setup();
  const { humanOversight, ...partial } = system({ id: 'ai-fraud', name: 'Fraud scorer' });
  const r = await service.runAssessment({ assessmentId: 'RA-3', user: officer, systems: [...registered(), partial] });
  assert.equal(r.status, 'completed');
  assert.equal(r.report.summary.assessed, 3);
  assert.equal(r.report.summary.unassessed, 1);
  assert.equal(r.report.unassessed[0].systemId, 'ai-fraud');
  assert.match(r.report.notice, /"Fraud scorer" \(ai-fraud\) was not assessed: "humanOversight" is missing/);
  assert.ok(actions('RA-3').includes('risk.system_unassessed'));
  assert.equal(entries('RA-3').find((e) => e.action === 'risk.system_unassessed').subject, 'ai-fraud');
});

test('when no system has complete data, nothing is assessed and the user is told what is missing', async () => {
  const { service, store, actions } = setup();
  const r = await service.runAssessment({ assessmentId: 'RA-4', user: officer, systems: [{ id: 'ai-x' }] });
  assert.equal(r.status, 'missing_data');
  assert.match(r.notice, /^No risk assessment was produced/);
  assert.deepEqual(actions('RA-4'), ['risk.requested', 'risk.missing_data']);
  assert.equal(store.get('RA-4'), null);
});

// ---- Failure path: risk model errors ----

const flaky = (failOn) => {
  const real = createRuleBasedRiskModel();
  return { id: 'flaky', version: '1', assess: (s, o) => {
    if (s.id === failOn) throw new Error('model crashed');
    return real.assess(s, o);
  } };
};

test('a model error on one system marks it failed, keeps the rest, and is not saved so a re-run retries it', async () => {
  const { service, store, entries } = setup({ model: flaky('ai-chat') });
  const r = await service.runAssessment({ assessmentId: 'RA-5', user: officer, systems: registered() });
  assert.equal(r.status, 'partial');
  assert.equal(r.report.summary.assessed, 2);
  assert.deepEqual(r.report.failed, [{ systemId: 'ai-chat', name: 'Help chatbot', reason: 'Error: model crashed' }]);
  assert.match(entries('RA-5').find((e) => e.action === 'risk.system_failed').rationale, /model crashed/);
  assert.equal(entries('RA-5').at(-1).action, 'risk.partial');
  assert.equal(store.get('RA-5'), null);
});

test('a malformed model answer is a model error, not a finding', async () => {
  const liar = { id: 'liar', version: '1', assess: () => ({ risks: [{ category: 'vibes', severity: 'high', rule: 'r', why: 'w', mitigations: ['m'] }] }) };
  const { service, actions } = setup({ model: liar });
  const r = await service.runAssessment({ assessmentId: 'RA-6', user: officer, systems: registered() });
  assert.equal(r.status, 'model_error');
  assert.equal(r.report.systems.length, 0);
  assert.match(r.report.failed[0].reason, /RiskModelError: risk #1 has unknown category/);
  assert.equal(actions('RA-6').at(-1), 'risk.model_error');
});

// ---- Failure path: assessment timeout ----

test('a model that hangs is timed out: interrupted, logged, nothing saved, and a re-run works', async () => {
  const hang = { id: 'rule-based', version: '1', assess: () => new Promise(() => {}) }; // ignores the signal entirely
  const t = setup({ model: hang, timeoutMs: 20 });
  const r = await t.service.runAssessment({ assessmentId: 'RA-7', user: officer, systems: registered() });
  assert.equal(r.status, 'interrupted');
  assert.match(r.message, /timed out after 20 ms.*nothing was saved\. Run it again/);
  assert.deepEqual(t.actions('RA-7'), ['risk.requested', 'risk.started', 'risk.interrupted']);
  assert.equal(t.store.get('RA-7'), null);

  // Same id, same systems, same model identity, working model: assessed for real.
  const retry = createRiskAssessmentService({ audit: t.audit, store: t.store });
  const again = await retry.runAssessment({ assessmentId: 'RA-7', user: officer, systems: registered() });
  assert.equal(again.status, 'completed');
});

test('a caller cancel interrupts the assessment', async () => {
  const { service, store } = setup();
  const ac = new AbortController();
  ac.abort(); // no reason given: Node supplies "This operation was aborted", which is passed on
  const r = await service.runAssessment({ assessmentId: 'RA-8', user: officer, systems: registered(), signal: ac.signal });
  assert.equal(r.status, 'interrupted');
  assert.match(r.message, /interrupted \(This operation was aborted\)/);
  assert.equal(store.get('RA-8'), null);
});

// ---- Idempotency ----

test('the same request twice replays the saved result; a running one is joined, not run twice', async () => {
  let calls = 0;
  const real = createRuleBasedRiskModel();
  const counting = { id: 'rule-based', version: '1', assess: (s, o) => { calls += 1; return real.assess(s, o); } };
  const { service, actions } = setup({ model: counting });
  const [a, b] = await Promise.all([
    service.runAssessment({ assessmentId: 'RA-9', user: officer, systems: registered() }),
    service.runAssessment({ assessmentId: 'RA-9', user: officer, systems: registered() }),
  ]);
  const c = await service.runAssessment({ assessmentId: 'RA-9', user: officer, systems: registered() });
  assert.equal(calls, 3, 'each system assessed once');
  assert.deepEqual(a.report, b.report);
  assert.deepEqual(c.report, a.report);
  assert.equal(c.replayed, true);
  assert.deepEqual(actions('RA-9').filter((x) => x !== 'risk.system_assessed'),
    ['risk.requested', 'risk.started', 'risk.requested', 'risk.joined', 'risk.completed', 'risk.requested', 'risk.replayed']);
});

test('reusing an id with different systems is refused and logged', async () => {
  const { service, actions } = setup();
  await service.runAssessment({ assessmentId: 'RA-10', user: officer, systems: registered() });
  await assert.rejects(
    service.runAssessment({ assessmentId: 'RA-10', user: officer, systems: [system()] }),
    (err) => err instanceof RiskRequestError && /different systems/.test(err.message),
  );
  assert.equal(actions('RA-10').at(-1), 'risk.rejected');
});

// ---- Access and request checks ----

test('a role not allowed is refused and the refusal is logged; nothing is assessed', async () => {
  const { service, actions, entries } = setup();
  await assert.rejects(
    service.runAssessment({ assessmentId: 'RA-11', user: { id: 'pa-1', role: 'process analyst' }, systems: registered() }),
    PermissionDeniedError,
  );
  assert.deepEqual(actions('RA-11'), ['risk.requested', 'risk.denied']);
  assert.match(entries('RA-11')[1].rationale, /compliance officer, security officer, operations manager/);
});

test('security officers and operations managers may also assess', async () => {
  const { service } = setup();
  for (const [i, role] of ['security officer', 'operations manager'].entries()) {
    const r = await service.runAssessment({ assessmentId: `RA-12-${i}`, user: { id: `u${i}`, role }, systems: registered() });
    assert.equal(r.status, 'completed');
  }
});

test('a request with no id or no user is rejected and still logged', async () => {
  const { service, audit } = setup();
  await assert.rejects(service.runAssessment({ user: officer, systems: registered() }), RiskRequestError);
  await assert.rejects(service.runAssessment({ assessmentId: 'RA-13', systems: registered() }), RiskRequestError);
  assert.deepEqual(audit.readAll().map((e) => [e.correlationId, e.action, e.actor.id]), [
    ['invalid-request', 'risk.rejected', 'co-3'],
    ['RA-13', 'risk.rejected', 'unknown-requester'],
  ]);
});

test('if the audit log cannot be written, the assessment stops (fail closed) and nothing is saved', async () => {
  const store = createMemoryResultStore();
  let writes = 0;
  const audit = { append: () => { writes += 1; if (writes === 3) throw new AuditWriteError('disk full'); } };
  const service = createRiskAssessmentService({ audit, store });
  await assert.rejects(service.runAssessment({ assessmentId: 'RA-14', user: officer, systems: registered() }), AuditWriteError);
  assert.equal(store.get('RA-14'), null);
});
