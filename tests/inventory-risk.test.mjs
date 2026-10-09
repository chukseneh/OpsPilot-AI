// The inventory and risk assessment together (STORY-004 with STORY-003). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInventoryService, PermissionDeniedError, InventoryRequestError } from '../src/inventory/service.js';
import { openPGlite, migrate } from '../src/inventory/db.js';
import { createRiskAssessmentService } from '../src/risk/service.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';

const IT = { id: 'it-mgr-1', role: 'IT manager' };
const OFFICER = { id: 'co-3', role: 'compliance officer' };

const system = (over = {}) => ({
  id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications',
  owner: 'hr-lead-1', status: 'active', dataCategories: ['personal'], decisionImpact: 'significant',
  humanOversight: 'none', userFacing: false, ...over,
});
const forecast = () => system({ id: 'ai-forecast', name: 'Demand forecast', department: 'Ops', dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'approval' });

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); });
after(async () => { await pg.close(); });

async function setup() {
  await pg.exec('TRUNCATE ai_systems');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'inv-risk-')), 'audit.jsonl') });
  const inventory = createInventoryService({ db: pg, audit });
  const risk = createRiskAssessmentService({ audit, store: createMemoryResultStore() });
  await inventory.registerSystem({ user: IT, system: system() });
  await inventory.registerSystem({ user: IT, system: forecast() });
  const assess = async (id) => risk.runAssessment({ assessmentId: id, user: OFFICER, systems: await inventory.systemsForAssessment({ user: OFFICER }) });
  const risks = async () => Object.fromEntries((await inventory.listSystems({ user: IT })).systems.map((s) => [s.id, s.riskLevel]));
  return { audit, inventory, risk, assess, risks };
}

test('the inventory is assessed as it stands, and the ratings land in its risk field', async () => {
  const { inventory, assess, risks, audit } = await setup();
  assert.deepEqual(await risks(), { 'ai-cv-screen': 'unassessed', 'ai-forecast': 'unassessed' });

  const result = await assess('RA-1');
  assert.equal(result.status, 'completed');
  const outcome = await inventory.recordRiskAssessment({ user: OFFICER, result });
  assert.deepEqual(outcome.recorded.sort(), ['ai-cv-screen', 'ai-forecast']);
  assert.deepEqual(await risks(), { 'ai-cv-screen': 'high', 'ai-forecast': 'low' });

  const cv = (await inventory.listSystems({ user: IT })).systems.find((s) => s.id === 'ai-cv-screen');
  assert.equal(cv.riskAssessmentId, 'RA-1');
  assert.equal(cv.riskAssessedAt, result.report.assessedAt);

  const logged = audit.readAll().filter((e) => e.action === 'inventory.risk_recorded');
  assert.deepEqual(logged.map((e) => [e.subject, e.detail.from, e.detail.to, e.actor.id]).sort(), [
    ['ai-cv-screen', 'unassessed', 'high', 'co-3'], ['ai-forecast', 'unassessed', 'low', 'co-3'],
  ]);
});

test('recording the same assessment twice changes nothing', async () => {
  const { inventory, assess } = await setup();
  const result = await assess('RA-2');
  await inventory.recordRiskAssessment({ user: OFFICER, result });
  const before = (await inventory.listSystems({ user: IT })).systems;
  const again = await inventory.recordRiskAssessment({ user: OFFICER, result });
  assert.deepEqual(again.recorded, []);
  assert.equal(again.unchanged.length, 2);
  assert.deepEqual((await inventory.listSystems({ user: IT })).systems, before);
});

test('an older assessment cannot overwrite a newer one', async () => {
  const { inventory, assess, risks } = await setup();
  const older = await assess('RA-old');
  const newer = await assess('RA-new');
  await inventory.recordRiskAssessment({ user: OFFICER, result: newer });
  const outcome = await inventory.recordRiskAssessment({ user: OFFICER, result: older });
  assert.deepEqual(outcome.recorded, []);
  assert.match(outcome.skipped[0].reason, /newer assessment \(RA-new\)/);
  const cv = (await inventory.listSystems({ user: IT })).systems.find((s) => s.id === 'ai-cv-screen');
  assert.equal(cv.riskAssessmentId, 'RA-new');
  assert.equal((await risks())['ai-cv-screen'], 'high');
});

test('a system changed after it was assessed keeps its old rating and is reported', async () => {
  const { inventory, assess } = await setup();
  const result = await assess('RA-3');
  await new Promise((r) => { setTimeout(r, 5); });
  await inventory.updateStatus({ user: IT, systemId: 'ai-forecast', status: 'retired', expectedVersion: 1, reason: 'test' });
  const outcome = await inventory.recordRiskAssessment({ user: OFFICER, result });
  assert.deepEqual(outcome.recorded, ['ai-cv-screen']);
  assert.deepEqual(outcome.skipped, [{ systemId: 'ai-forecast', reason: 'it was changed after it was assessed; assess it again' }]);
});

test('a system no longer in the inventory is reported, not invented', async () => {
  const { inventory, assess } = await setup();
  const result = await assess('RA-4');
  await pg.query("DELETE FROM ai_systems WHERE id = 'ai-forecast'");
  const outcome = await inventory.recordRiskAssessment({ user: OFFICER, result });
  assert.deepEqual(outcome.skipped, [{ systemId: 'ai-forecast', reason: 'it is not in the inventory' }]);
  assert.equal((await inventory.listSystems({ user: IT })).systems.length, 1);
});

test('only a completed assessment is recorded, only by permitted roles; refusals are logged', async () => {
  const { inventory, audit } = await setup();
  await assert.rejects(inventory.recordRiskAssessment({ user: OFFICER, result: { status: 'interrupted', message: 'timed out' } }),
    (err) => err instanceof InventoryRequestError && /only a completed risk assessment/.test(err.message));
  await assert.rejects(inventory.recordRiskAssessment({ user: { id: 'pa-1', role: 'process analyst' }, result: {} }), PermissionDeniedError);
  const actions = audit.readAll().map((e) => e.action);
  assert.ok(actions.includes('inventory.risk_rejected'));
  assert.ok(actions.includes('inventory.denied'));
});
