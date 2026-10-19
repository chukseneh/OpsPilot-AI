// The simulation service: roles, refusals, saved reports, audit, idempotency (STORY-010). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  createSimulationService, migrateSimulations, PermissionDeniedError, ScenarioError, SimulationRequestError, SimulationNotFoundError,
} from '../src/simulation/service.js';
import { openPGlite } from '../src/inventory/db.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { isDecision } from '../src/audit/decisions.js';
import { startOpsPilot } from '../src/system.js';

const TESTER = { id: 'tester-1', role: 'system tester' };
const PM = { id: 'pm-1', role: 'process manager' };

const sys = (id, riskLevel) => ({
  id, name: `${id} (SYNTHETIC)`, department: 'Sim', purpose: 'Simulated', owner: 'SYN-owner', status: 'active',
  dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false, riskLevel,
});
const scenario = (expectFirst = { riskLevel: 'high', outcome: 'awaiting_approval' }) => ({
  id: 'SIM-pay', synthetic: true, label: 'SYNTHETIC — invented for simulation',
  systems: [sys('SYN-low', 'low')],
  workflows: [{
    id: 'SYN-WF-pay', name: 'Pay', actions: [{ type: 'payment', params: { amount: 500 } }, { type: 'notify', params: { systemId: 'SYN-low' } }],
    expect: { steps: [expectFirst, { outcome: 'pending' }], final: 'awaiting_approval' },
  }],
});

let pg;
before(async () => { pg = await openPGlite(); await migrateSimulations(pg); });
after(async () => { await pg.close(); });
async function setup() {
  await pg.exec('TRUNCATE simulation_runs');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'sim-svc-')), 'audit.jsonl') });
  return { audit, sim: createSimulationService({ db: pg, audit }), entries: () => audit.readAll() };
}

// ---- Acceptance 1 + Trust ----

test('a passing simulation is saved with its report and sandbox log, and logged for review', async () => {
  const { sim, entries } = await setup();
  const r = await sim.runSimulation({ user: TESTER, runId: 'RUN-1', scenario: scenario() });
  assert.equal(r.verdict, 'passed');
  assert.deepEqual(r.summary.workflows, { total: 1, passed: 1, failed: 0, unchecked: 0 });
  assert.ok(r.sandboxLog.some((e) => e.action === 'workflow.approval_requested'), 'the sandbox\'s own log is kept for review');
  assert.equal(r.report.workflows[0].actions[0].outcome, 'awaiting_approval');

  const [started, completed] = entries();
  assert.deepEqual([started.action, started.detail.synthetic, started.detail.scenarioId], ['simulation.started', true, 'SIM-pay']);
  assert.equal(completed.action, 'simulation.completed');
  assert.match(completed.rationale, /^Simulation on SYNTHETIC data passed: all 1 workflow\(s\) executed as expected \(2 step\(s\) checked\)\.$/);
  assert.equal(completed.actor.id, 'tester-1');
});

test('unexpected behaviour: the run is saved as failed and the audit rationale names the critical mismatch', async () => {
  const { sim, entries } = await setup();
  // Expect the payment to run unattended — the engine (correctly) holds it for approval.
  const r = await sim.runSimulation({ user: PM, runId: 'RUN-2', scenario: scenario({ riskLevel: 'low', outcome: 'succeeded' }) });
  assert.equal(r.verdict, 'failed');
  const done = entries().find((e) => e.action === 'simulation.completed');
  assert.match(done.rationale, /failed: 1 of 1 workflow\(s\) did not behave as expected/);
  assert.match(done.rationale, /SYN-WF-pay step 1: expected low risk, succeeded; got high risk, waiting for approval/);
  assert.equal(done.detail.mismatches[0].workflow, 'SYN-WF-pay');
});

// ---- Acceptance 2 + data generation errors ----

test('incorrect synthetic data is refused with every problem listed, nothing runs, and the refusal is logged', async () => {
  const { sim, entries } = await setup();
  const bad = scenario();
  bad.synthetic = false;
  bad.systems[0].id = 'ai-real';
  await assert.rejects(sim.runSimulation({ user: TESTER, runId: 'RUN-3', scenario: bad }), (err) => err instanceof ScenarioError && err.problems.length >= 2);
  const rejected = entries().find((e) => e.action === 'simulation.rejected');
  assert.match(rejected.rationale, /only data marked as synthetic may be simulated/);
  assert.ok(!entries().some((e) => e.action === 'simulation.started'), 'nothing ran');
  await assert.rejects(sim.getSimulation({ user: TESTER, runId: 'RUN-3' }), SimulationNotFoundError);
});

test('a generated scenario runs and is saved; a generator error is refused as a data generation error', async () => {
  const { sim, entries } = await setup();
  const r = await sim.runSimulation({ user: TESTER, runId: 'RUN-4', generate: { seed: 5, workflows: 4 } });
  assert.equal(r.verdict, 'passed');
  assert.equal(r.scenario.synthetic, true);
  await assert.rejects(sim.runSimulation({ user: TESTER, runId: 'RUN-5', generate: { seed: 5, workflows: 0 } }), (err) => err instanceof ScenarioError && err.generated);
  assert.equal(entries().filter((e) => e.action === 'simulation.rejected').at(-1).detail.dataGenerationError, true);
});

// ---- Simulation timeout ----

test('a run that times out is saved as timed_out, with unfinished workflows unchecked', async () => {
  const { sim } = await setup();
  const r = await sim.runSimulation({ user: TESTER, runId: 'RUN-6', scenario: scenario(), timeoutMs: 1 });
  assert.equal(r.verdict, 'timed_out');
  assert.equal(r.summary.workflows.unchecked, 1);
});

// ---- Idempotency, requests, access ----

test('the same run id and scenario returns the saved report; a different scenario under it is refused; two at once run once', async () => {
  const { sim, entries } = await setup();
  const [a, b] = await Promise.all([
    sim.runSimulation({ user: TESTER, runId: 'RUN-7', scenario: scenario() }),
    sim.runSimulation({ user: TESTER, runId: 'RUN-7', scenario: scenario() }),
  ]);
  const c = await sim.runSimulation({ user: TESTER, runId: 'RUN-7', scenario: scenario() });
  assert.equal(a.ranAt, b.ranAt);
  assert.equal(c.ranAt, a.ranAt);
  assert.equal(entries().filter((e) => e.action === 'simulation.started').length, 1, 'ran once');
  await assert.rejects(sim.runSimulation({ user: TESTER, runId: 'RUN-7', scenario: scenario({ riskLevel: 'low', outcome: 'succeeded' }) }), /already used for a different scenario/);
});

test('requests must name a run, and give a scenario or a generator — not both', async () => {
  const { sim } = await setup();
  await assert.rejects(sim.runSimulation({ user: TESTER, scenario: scenario() }), /runId must be a non-empty string/);
  await assert.rejects(sim.runSimulation({ user: TESTER, runId: 'R' }), /either a scenario or generate/);
  await assert.rejects(sim.runSimulation({ user: TESTER, runId: 'R', scenario: scenario(), generate: { seed: 1 } }), SimulationRequestError);
  await assert.rejects(sim.runSimulation({ user: TESTER, runId: 'R', scenario: scenario(), timeoutMs: 0 }), /timeoutMs must be/);
});

test('only system testers and process managers may run or view simulations; refusals are logged', async () => {
  const { sim, entries } = await setup();
  await assert.rejects(sim.runSimulation({ user: { id: 'co-1', role: 'compliance officer' }, runId: 'R', scenario: scenario() }), PermissionDeniedError);
  await assert.rejects(sim.listSimulations({}), PermissionDeniedError);
  await sim.runSimulation({ user: PM, runId: 'RUN-8', scenario: scenario() });
  assert.equal((await sim.listSimulations({ user: TESTER })).length, 1);
  assert.equal(entries().filter((e) => e.action === 'simulation.denied').length, 2);
  assert.ok(entries().every((e) => e.at && e.actor.id && (!isDecision(e.action) || e.rationale)));
});

test('the database only ever holds synthetic scenarios', async () => {
  await pg.exec('TRUNCATE simulation_runs');
  await assert.rejects(pg.query(
    "INSERT INTO simulation_runs (id, scenario_id, requested_by, verdict, summary, report, scenario, sandbox_log, fingerprint, duration_ms) VALUES ('x','x','x','passed','{}','{}','{\"synthetic\":false}','[]','f',1)",
  ), /synthetic_only/);
});

test('if the audit log fails, the report is not saved', async () => {
  await pg.exec('TRUNCATE simulation_runs');
  const audit = { append: (e) => { if (e.action === 'simulation.completed') throw new AuditWriteError('disk full'); return { seq: 1, ...e }; } };
  const sim = createSimulationService({ db: pg, audit });
  await assert.rejects(sim.runSimulation({ user: TESTER, runId: 'RUN-9', scenario: scenario() }), AuditWriteError);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM simulation_runs')).rows[0].n, 0);
});

test('through the started system: a simulation runs in its sandbox, touching nothing in the live inventory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-e2e-'));
  const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
  const sysd = await startOpsPilot({
    env: { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl') },
    timers: { approvals: idle, anchors: idle, governance: idle },
  });
  try {
    const r = await sysd.services.simulation.runSimulation({ user: TESTER, runId: 'RUN-e2e', scenario: scenario() });
    assert.equal(r.verdict, 'passed');
    assert.deepEqual((await sysd.services.inventory.listSystems({ user: { id: 'it-1', role: 'IT manager' } })).systems, [], 'the live inventory is untouched');
    const live = sysd.audit.readAll();
    assert.ok(live.some((e) => e.action === 'simulation.completed' && e.alg === 'hmac-sha256'), 'the result is in the keyed main log');
    assert.ok(!live.some((e) => e.action.startsWith('workflow.')), 'the sandbox\'s workflow entries stay in the sandbox log');
  } finally {
    await sysd.stop();
  }
});
