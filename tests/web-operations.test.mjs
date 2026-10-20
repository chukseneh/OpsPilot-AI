// Web access, step 4c: the inventory, risk and ROI endpoints, over real HTTP.
// Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createInventoryService } from '../src/inventory/service.js';
import { createRiskAssessmentService } from '../src/risk/service.js';
import { createRoiService, migrateRoi } from '../src/roi/service.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';
import { openPGlite, migrate } from '../src/inventory/db.js';
import { migrateAccounts } from '../src/web/accounts.js';
import { migrateSessions } from '../src/web/sessions.js';
import { operationsRoutes } from '../src/web/operationsRoutes.js';
import { startHarness } from './helpers/webHarness.mjs';

const PEOPLE = {
  'it.manager': 'IT manager',
  'co.officer': 'compliance officer',
  'fa.analyst': 'financial analyst',
  'pm.manager': 'process manager',
};
const CV = {
  id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications', owner: 'hr-lead-1',
  status: 'active', dataCategories: ['personal'], decisionImpact: 'significant', humanOversight: 'none', userFacing: false,
};
const CHAT = {
  id: 'ai-chat', name: 'Help chatbot', department: 'Support', purpose: 'Answers FAQs', owner: 'support-lead',
  status: 'active', dataCategories: ['public'], decisionImpact: 'low', humanOversight: 'review', userFacing: true,
};
const ASSUMPTIONS = {
  name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
  timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32 }],
  otherSavings: [{ label: 'Fewer late-payment fees', amountPerYear: 1500 }],
  costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800 }] },
  uncertainty: { savings: 0.2, costs: 0.1 },
};

let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); await migrateRoi(pg); await migrateAccounts(pg); await migrateSessions(pg); });
after(async () => { await pg.close(); });

async function setup() {
  await pg.exec('TRUNCATE ai_systems, roi_scenarios');
  const h = await startHarness({
    db: pg, people: PEOPLE,
    routes: (audit) => operationsRoutes({
      inventory: createInventoryService({ db: pg, audit }),
      risk: createRiskAssessmentService({ audit, store: createMemoryResultStore() }),
      roi: createRoiService({ db: pg, audit }),
    }),
  });
  const people = {};
  for (const name of Object.keys(PEOPLE)) people[name] = await h.signIn(name);
  const register = (system, as = people['it.manager']) => h.call('POST', '/api/v1/inventory/systems', { as, body: { system, reason: 'New system' } });
  return { ...h, people, register };
}
const withApi = (name, fn) => test(name, async () => {
  const ctx = await setup();
  try { await fn(ctx); } finally { await ctx.close(); }
});

// ---- Inventory ----

withApi('an IT manager registers systems (201, then 200 unchanged); others may list them', async ({ call, people, register }) => {
  const first = await register(CV);
  assert.equal(first.status, 201, first.text);
  assert.deepEqual([first.json.created, first.json.system.id, first.json.system.version], [true, 'ai-cv-screen', 1]);
  const again = await register(CV);
  assert.deepEqual([again.status, again.json.created], [200, false]);
  const conflict = await register({ ...CV, purpose: 'Something else' });
  assert.equal(conflict.status, 409);

  await register(CHAT);
  const list = await call('GET', '/api/v1/inventory', { as: people['co.officer'] });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.systems.map((s) => s.id), ['ai-cv-screen', 'ai-chat']);
  assert.equal((await call('GET', '/api/v1/inventory', { as: people['fa.analyst'] })).status, 403);
});

withApi('registering needs the IT manager role and complete data', async ({ people, register }) => {
  const denied = await register(CV, people['co.officer']);
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /may not register AI systems/);
  const incomplete = await register({ ...CV, owner: '' });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.json.error, /"owner"/);
});

withApi('a status change needs the version read and a reason; a stale version is a 409', async ({ call, people, register, audit }) => {
  await register(CV);
  const path = '/api/v1/inventory/systems/ai-cv-screen/status';
  const as = people['it.manager'];
  assert.equal((await call('POST', path, { as, body: { status: 'paused', expectedVersion: 1 } })).status, 400, 'no reason');
  const paused = await call('POST', path, { as, body: { status: 'paused', expectedVersion: 1, reason: 'Bias review' } });
  assert.equal(paused.status, 200, paused.text);
  assert.deepEqual([paused.json.changed, paused.json.system.status, paused.json.system.version], [true, 'paused', 2]);
  assert.equal(audit.readAll().find((e) => e.action === 'inventory.status_changed').rationale, 'Bias review');
  assert.equal((await call('POST', path, { as, body: { status: 'active', expectedVersion: 1, reason: 'x' } })).status, 409);
  assert.equal((await call('POST', '/api/v1/inventory/systems/ghost/status', { as, body: { status: 'paused', expectedVersion: 1, reason: 'x' } })).status, 404);
});

// ---- Risk ----

withApi('assessing the inventory rates each system and records the rating back', async ({ call, people, register }) => {
  await register(CV);
  await register(CHAT);
  const r = await call('POST', '/api/v1/risk/assessments/inventory', { as: people['co.officer'], body: { assessmentId: 'RA-WEB-1' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.assessment.status, 'completed');
  assert.deepEqual(r.json.recorded.recorded.sort(), ['ai-chat', 'ai-cv-screen']);
  const levels = Object.fromEntries((await call('GET', '/api/v1/inventory', { as: people['co.officer'] })).json.systems.map((s) => [s.id, s.riskLevel]));
  assert.equal(levels['ai-cv-screen'], 'high');
  assert.notEqual(levels['ai-chat'], 'unassessed');
});

withApi('assessing the inventory again with the same id reuses the assessment and changes nothing', async ({ call, people, register, audit }) => {
  await register(CV);
  const as = people['co.officer'];
  await call('POST', '/api/v1/risk/assessments/inventory', { as, body: { assessmentId: 'RA-WEB-2' } });
  const again = await call('POST', '/api/v1/risk/assessments/inventory', { as, body: { assessmentId: 'RA-WEB-2' } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.assessment.replayed, true);
  assert.deepEqual([again.json.recorded.recorded, again.json.recorded.unchanged], [[], ['ai-cv-screen']]);
  assert.equal(audit.readAll().filter((e) => e.action === 'inventory.risk_recorded').length, 1);
  assert.equal(audit.readAll().filter((e) => e.action === 'risk.completed').length, 1);
});

withApi('an empty inventory is reported, not recorded', async ({ call, people }) => {
  const r = await call('POST', '/api/v1/risk/assessments/inventory', { as: people['co.officer'], body: { assessmentId: 'RA-WEB-3' } });
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.json.assessment.status, 'completed');
  assert.equal(r.json.recorded, null);
});

withApi('assessing given systems works for risk roles only; a reused id with other systems is refused', async ({ call, people }) => {
  const ok = await call('POST', '/api/v1/risk/assessments', { as: people['co.officer'], body: { assessmentId: 'RA-WEB-4', systems: [CV] } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.assessment.report.systems[0].riskLevel, 'high');
  const reused = await call('POST', '/api/v1/risk/assessments', { as: people['co.officer'], body: { assessmentId: 'RA-WEB-4', systems: [CHAT] } });
  assert.equal(reused.status, 400);
  assert.match(reused.json.error, /already used with different systems/);
  const denied = await call('POST', '/api/v1/risk/assessments', { as: people['pm.manager'], body: { assessmentId: 'RA-WEB-5', systems: [CV] } });
  assert.equal(denied.status, 403);
  assert.equal((await call('POST', '/api/v1/risk/assessments/inventory', { as: people['fa.analyst'], body: { assessmentId: 'RA-WEB-6' } })).status, 403);
});

// ---- ROI ----

withApi('a financial analyst calculates an ROI estimate, then lists and reads it', async ({ call, people, audit }) => {
  const as = people['fa.analyst'];
  const r = await call('POST', '/api/v1/roi/scenarios', { as, body: { scenarioId: 'ROI-WEB-1', assumptions: ASSUMPTIONS } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.scenario.status, r.json.scenario.createdBy, r.json.scenario.result.expected.netBenefit], ['ok', 'fa.analyst', 2418000]);
  assert.deepEqual((await call('GET', '/api/v1/roi/scenarios', { as })).json.scenarios.map((s) => s.id), ['ROI-WEB-1']);
  assert.equal((await call('GET', '/api/v1/roi/scenarios/ROI-WEB-1', { as })).json.scenario.result.expected.netBenefit, 2418000);
  assert.equal(audit.readAll().filter((e) => e.action === 'roi.calculated').length, 1);

  const again = await call('POST', '/api/v1/roi/scenarios', { as, body: { scenarioId: 'ROI-WEB-1', assumptions: ASSUMPTIONS } });
  assert.equal(again.status, 200, 'the same calculation again is harmless');
  assert.equal(audit.readAll().filter((e) => e.action === 'roi.calculated').length, 1);
});

withApi('ROI refusals: bad assumptions 400, a missing estimate 404, the wrong role 403', async ({ call, people }) => {
  const as = people['fa.analyst'];
  const bad = await call('POST', '/api/v1/roi/scenarios', { as, body: { scenarioId: 'ROI-WEB-2', assumptions: { ...ASSUMPTIONS, horizonYears: -1 } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /horizonYears/);
  assert.equal((await call('GET', '/api/v1/roi/scenarios/ROI-NONE', { as })).status, 404);
  const denied = await call('POST', '/api/v1/roi/scenarios', { as: people['pm.manager'], body: { scenarioId: 'ROI-WEB-3', assumptions: ASSUMPTIONS } });
  assert.equal(denied.status, 403);
  assert.equal((await call('GET', '/api/v1/roi/scenarios', { as: people['it.manager'] })).status, 403);
});
