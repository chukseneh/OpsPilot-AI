// The ROI service: roles, refusals, warnings, idempotency, audit with assumptions (STORY-008). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRoiService, migrateRoi, documentLookupFrom, analysisLookupFrom,
  PermissionDeniedError, RoiInputError, CalculationError, RoiRequestError, RoiScenarioNotFoundError, RoiThresholdError,
} from '../src/roi/service.js';
import { createDocumentService, migrateDocuments } from '../src/documents/service.js';
import { createFileBlobStore } from '../src/documents/blobStore.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';
import { openPGlite } from '../src/inventory/db.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { isDecision } from '../src/audit/decisions.js';

const ANALYST = { id: 'fa-1', role: 'financial analyst' };
const OPS = { id: 'ops-1', role: 'operations manager' };
const PM = { id: 'pm-1', role: 'process manager' };

const ASSUMPTIONS = {
  name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
  timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.8, costPerHour: 32 }],
  otherSavings: [{ label: 'Fewer late-payment fees', amountPerYear: 1500 }],
  costs: { oneOff: [{ label: 'Implementation', amount: 12000 }], perYear: [{ label: 'Licence', amount: 4800 }] },
  uncertainty: { savings: 0.2, costs: 0.1 },
};

let pg;
before(async () => { pg = await openPGlite(); await migrateRoi(pg); await migrateDocuments(pg); });
after(async () => { await pg.close(); });

async function setup(options = {}) {
  await pg.exec('TRUNCATE roi_scenarios, documents');
  const dir = mkdtempSync(join(tmpdir(), 'roi-'));
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const service = createRoiService({ db: pg, audit, ...options });
  const entries = () => audit.readAll();
  return { service, audit, entries, dir };
}

// ---- Acceptance 1: estimated savings shown ----

test('a calculation is saved with its savings, range, formulas and status ok', async () => {
  const { service } = await setup();
  const s = await service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-1', assumptions: ASSUMPTIONS });
  assert.deepEqual([s.status, s.warnings, s.createdBy, s.currency], ['ok', [], 'fa-1', 'GBP']);
  assert.equal(s.result.expected.annualSavings, 1686000);
  assert.equal(s.result.expected.netBenefit, 2418000);
  assert.ok(s.result.low.netBenefit < s.result.high.netBenefit);
  assert.match(s.result.expected.formulas.roi, /= 91.6%$/);
  assert.deepEqual(s.assumptions, ASSUMPTIONS, 'the assumptions are saved exactly as submitted');
});

// ---- Trust: logged with assumptions ----

test('the calculation is logged with the FULL assumptions, the headline figures and the warnings', async () => {
  const { service, entries } = await setup();
  await service.calculateRoiScenario({ user: OPS, scenarioId: 'ROI-2', assumptions: ASSUMPTIONS });
  const e = entries().find((x) => x.action === 'roi.calculated');
  assert.deepEqual(e.detail.assumptions, ASSUMPTIONS);
  assert.equal(e.detail.headline.expected.netBenefit, 2418000);
  assert.deepEqual(e.detail.warnings, []);
  assert.equal(e.actor.id, 'ops-1');
  assert.match(e.rationale, /^Estimated savings GBP 16,860.00 a year; over 3 years net benefit GBP 24,180.00 \(range .* to .*\), ROI 91.6%, payback 11.9 months\. No warnings\.$/);
});

// ---- Acceptance 2: incorrect assumptions flagged ----

test('incorrect-looking assumptions are flagged: status needs_review, warnings saved and logged', async () => {
  const { service, entries } = await setup();
  const s = await service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-3', assumptions: {
    ...ASSUMPTIONS, timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6, automationRate: 0.99, costPerHour: 32 }],
  } });
  assert.equal(s.status, 'needs_review');
  assert.deepEqual(s.warnings.map((w) => w.code), ['automation_rate_high']);
  const e = entries().find((x) => x.action === 'roi.calculated');
  assert.equal(e.detail.status, 'needs_review');
  assert.match(e.rationale, /1 warning\(s\) need review: "Enter invoice": 99% of the work automated is unusually high/);
});

test('evidence from a process analysis and a real uploaded document is used, read with the user\'s access', async () => {
  const { audit, dir } = await setup();
  const documents = createDocumentService({ db: pg, audit, blobs: createFileBlobStore({ dir: join(dir, 'files') }) });
  const contract = await documents.uploadDocument({ user: PM, fileName: 'msa.txt', bytes: new TextEncoder().encode(
    'Party A: Us\nParty B: Vendor\nEffective date: 2026-10-01\nTerm: 36 months\nContract value: 14,400.00 GBP\nRenewal: none\n') });
  const analyses = createMemoryResultStore();
  analyses.put('AN-1', { status: 'completed', result: { report: {
    scope: { period: { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' } },
    activities: [{ activity: 'Enter invoice', occurrences: 500, medianDurationMs: 6 * 60000 }],
  } } });
  const service = createRoiService({ db: pg, audit, lookupAnalysis: analysisLookupFrom(analyses), lookupDocument: documentLookupFrom(documents) });
  const withEvidence = {
    ...ASSUMPTIONS,
    timeSavings: [{ ...ASSUMPTIONS.timeSavings[0], evidence: { analysisId: 'AN-1', activity: 'Enter invoice' } }],
    costs: { ...ASSUMPTIONS.costs, perYear: [{ label: 'Licence', amount: 3000, evidence: { documentId: contract.id, field: 'contract_value' } }] },
  };
  // The analyst (a document reviewer) can see the contract: its figure disagrees with the assumed licence.
  const seen = await service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-4', assumptions: withEvidence });
  assert.deepEqual(seen.warnings.map((w) => w.code), ['amount_differs']);
  // An operations manager did not upload it and may not see it: to them the evidence is missing.
  const unseen = await service.calculateRoiScenario({ user: OPS, scenarioId: 'ROI-5', assumptions: withEvidence });
  assert.deepEqual(unseen.warnings.map((w) => w.code), ['evidence_missing']);
});

// ---- Failure paths: data input errors, calculation errors ----

test('data input errors refuse the request, list every problem, save nothing, and are logged with the assumptions', async () => {
  const { service, entries } = await setup();
  const bad = { ...ASSUMPTIONS, currency: 'pounds', horizonYears: 0 };
  await assert.rejects(service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-6', assumptions: bad }),
    (err) => err instanceof RoiInputError && err.problems.length === 2);
  await assert.rejects(service.getRoiScenario({ user: ANALYST, scenarioId: 'ROI-6' }), RoiScenarioNotFoundError);
  const e = entries().find((x) => x.action === 'roi.rejected');
  assert.match(e.rationale, /2 problem\(s\): currency must be a 3-letter code .*; horizonYears must be at least 1/);
  assert.deepEqual(e.detail.assumptions, bad);
});

test('a calculation error refuses the request; no number is saved or shown; it is logged', async () => {
  const { service, entries } = await setup();
  const huge = { ...ASSUMPTIONS, timeSavings: [{ label: 'Everything', casesPerYear: 1e8, minutesPerCase: 10080, automationRate: 1, costPerHour: 1e12 }] };
  await assert.rejects(service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-7', assumptions: huge }), CalculationError);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM roi_scenarios')).rows[0].n, 0);
  assert.match(entries().find((x) => x.action === 'roi.calculation_failed').rationale, /cannot be represented exactly/);
});

// ---- Idempotency ----

test('the same id and assumptions return the saved scenario; different assumptions under the same id are refused', async () => {
  const { service, entries } = await setup();
  const [a, b] = await Promise.all([
    service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-8', assumptions: ASSUMPTIONS }),
    service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-8', assumptions: ASSUMPTIONS }),
  ]);
  const c = await service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-8', assumptions: ASSUMPTIONS });
  assert.equal(a.calculatedAt, b.calculatedAt);
  assert.equal(c.calculatedAt, a.calculatedAt);
  assert.equal(entries().filter((x) => x.action === 'roi.calculated').length, 1, 'calculated once');
  await assert.rejects(service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-8', assumptions: { ...ASSUMPTIONS, horizonYears: 5 } }),
    (err) => err instanceof RoiRequestError && /already used with different assumptions/.test(err.message));
});

// ---- Access ----

test('only financial analysts and operations managers may calculate or view; refusals are logged', async () => {
  const { service, entries } = await setup();
  await assert.rejects(service.calculateRoiScenario({ user: PM, scenarioId: 'ROI-9', assumptions: ASSUMPTIONS }), PermissionDeniedError);
  await assert.rejects(service.listRoiScenarios({ user: { id: 'co-1', role: 'compliance officer' } }), PermissionDeniedError);
  await assert.rejects(service.calculateRoiScenario({ scenarioId: 'ROI-9', assumptions: ASSUMPTIONS }), PermissionDeniedError);
  await service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-10', assumptions: ASSUMPTIONS });
  assert.equal((await service.listRoiScenarios({ user: OPS })).length, 1);
  assert.equal((await service.getRoiScenario({ user: OPS, scenarioId: 'ROI-10' })).id, 'ROI-10');
  const denied = entries().filter((x) => x.action === 'roi.denied');
  assert.equal(denied.length, 3);
  assert.ok(entries().every((x) => x.at && x.actor.id && (!isDecision(x.action) || x.rationale)));
});

test('the thresholds applied are logged with each calculation, and a bad setting fails when the service is created', async () => {
  const { audit } = await setup();
  const service = createRoiService({ db: pg, audit, thresholds: { maxCostPerHour: 30 } });
  const s = await service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-12', assumptions: ASSUMPTIONS });
  assert.deepEqual(s.warnings.map((w) => w.code), ['cost_per_hour_unusual'], 'GBP 32 an hour is above this organisation\'s 30');
  const logged = audit.readAll().find((e) => e.action === 'roi.calculated').detail.thresholds;
  assert.equal(logged.maxCostPerHour, 30);
  assert.equal(logged.maxAutomationRate, 0.9, 'the full set is logged, defaults included');
  assert.throws(() => createRoiService({ db: pg, audit, thresholds: { maxCostPerHour: -1 } }), RoiThresholdError);
});

test('if the audit log fails, the scenario is not saved', async () => {
  await pg.exec('TRUNCATE roi_scenarios');
  const audit = { append: (e) => { if (e.action === 'roi.calculated') throw new AuditWriteError('disk full'); return { seq: 1, ...e }; } };
  const service = createRoiService({ db: pg, audit });
  await assert.rejects(service.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-11', assumptions: ASSUMPTIONS }), AuditWriteError);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM roi_scenarios')).rows[0].n, 0);
});
