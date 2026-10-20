// Every story's services start through startOpsPilot(), on one keyed, anchored
// audit log (consistency review F1). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { startOpsPilot, StartupRefusedError } from '../src/system.js';
import { sampleYearOfInvoices } from '../src/demo/sampleYearOfInvoices.js';

const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
const timers = { approvals: idle, anchors: idle, governance: idle };
const envFor = (over = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-wiring-'));
  return { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl'), ...over };
};
const OPS = { id: 'ops-1', role: 'operations manager' };
const ANALYST = { id: 'pa-1', role: 'process analyst' };

test('every service from every story is started (guards against one silently going missing)', async () => {
  const sys = await startOpsPilot({ env: envFor(), timers });
  try {
    for (const name of ['inventory', 'documents', 'risk', 'workflows', 'auditReader', 'governance', 'simulation', 'roi', 'analysis', 'orchestrator']) {
      assert.ok(sys.services[name] && typeof sys.services[name] === 'object', `services.${name} is missing`);
    }
    assert.equal(typeof sys.services.roi.calculateRoiScenario, 'function');
    assert.equal(typeof sys.services.orchestrator.runOperation, 'function');
    assert.equal(sys.dashboardUrl, null, 'no DASHBOARD_PORT: nothing listens');
  } finally {
    await sys.stop();
  }
});

test('process analysis runs through the orchestrator on the KEYED log, and ROI can use it as evidence', async () => {
  const sys = await startOpsPilot({ env: envFor(), timers });
  try {
    const op = await sys.services.orchestrator.runOperation({
      operationId: 'OP-year', requestedBy: { type: 'person', id: 'ops-1' },
      tasks: [{ id: 'analyse', capability: 'process', input: { user: ANALYST, dataset: sampleYearOfInvoices() } }],
    });
    assert.equal(op.tasks[0].status, 'completed');
    const entries = sys.audit.readAll();
    assert.ok(entries.some((e) => e.action === 'analysis.completed'));
    assert.ok(entries.some((e) => e.action === 'task.assigned'));
    assert.ok(entries.every((e) => e.alg === 'hmac-sha256'), 'orchestration and analysis entries are signed with the key');

    // The analysis id is the orchestrator's idempotency key for the task.
    const analysisId = op.tasks[0].output.analysisId;
    const roi = await sys.services.roi.calculateRoiScenario({ user: OPS, scenarioId: 'ROI-evidence', assumptions: {
      name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
      timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 7, automationRate: 0.8, costPerHour: 32, evidence: { analysisId, activity: 'Enter invoice into system' } }],
      costs: { oneOff: [{ label: 'Implementation', amount: 12000 }] }, uncertainty: { savings: 0.2 },
    } });
    assert.deepEqual(roi.warnings, [], 'the analysis was found and its volume and minutes match');
  } finally {
    await sys.stop();
  }
});

test('with DASHBOARD_PORT set, the dashboard listens on this machine, logs to the keyed log, and closes on stop', async () => {
  const sys = await startOpsPilot({ env: envFor({ DASHBOARD_PORT: '0' }), timers });
  let url;
  try {
    url = sys.dashboardUrl;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${url}/`, { redirect: 'manual' });
    assert.equal(res.status, 401, 'not signed in');
    await res.text();
    const entries = sys.audit.readAll();
    assert.ok(entries.some((e) => e.action === 'system.dashboard_started'));
    assert.ok(entries.some((e) => e.action.startsWith('dashboard.') && e.alg === 'hmac-sha256'), 'dashboard access is in the keyed main log');
  } finally {
    await sys.stop();
  }
  await assert.rejects(fetch(`${url}/`), 'after stop, nothing is listening');
});

test('a bad DASHBOARD_PORT refuses to start', async () => {
  await assert.rejects(startOpsPilot({ env: envFor({ DASHBOARD_PORT: 'eighty' }), timers }), (err) => err instanceof StartupRefusedError && /must be a port number/.test(err.message));
  await assert.rejects(startOpsPilot({ env: envFor({ DASHBOARD_PORT: '70000' }), timers }), StartupRefusedError);
});
