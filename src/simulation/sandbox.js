// Running a scenario in a sandbox (STORY-010). Every run gets its OWN world and
// nothing else: a fresh in-memory PostgreSQL (PGlite), its own audit log in a
// temporary folder, the scenario's synthetic AI systems in its own inventory, the
// real STORY-005 workflow engine, and stand-in executors. A simulation can never
// reach a real system or a real record — there is no connection to one.
//
//   await runInSandbox(scenario, { timeoutMs }) → {
//     status: 'ran' | 'timed_out' | 'error', scenarioId, durationMs,
//     workflows: [{ id, name, status, actions: [{ step, type, riskLevel, outcome, reasons, error }], decisionErrors }],
//     sandboxLog: [ …every audit entry the sandbox wrote… ],
//     error?: '…' }
//
// The scenario is validated first (ScenarioError) — invalid data never runs.
// Workflows are started by a synthetic process manager (SYN-starter); scripted
// decisions are made by a DIFFERENT synthetic person (SYN-approver), so the
// engine's rule that nobody approves their own workflow still applies.
//
// Simulation timeout: the whole run has a time limit. When it is reached the run
// stops at the next step and reports 'timed_out' with whatever finished. Whatever
// happens — success, failure, timeout — the sandbox is torn down: its database
// closed and its folder deleted. Its log entries are kept in the result.
//
// No verdict here: comparing what happened with what was expected is compare.js.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuditLog } from '../audit/auditLog.js';
import { openPGlite, migrate } from '../inventory/db.js';
import { createInventoryService } from '../inventory/service.js';
import { createWorkflowEngine, migrateWorkflows } from '../automation/workflows.js';
import { createStandInExecutor, createInventoryStatusExecutor } from '../automation/executors.js';
import { examplePack } from '../governance/packs/index.js';
import { validateScenario, ScenarioError } from './scenario.js';

export const DEFAULT_TIMEOUT_MS = 60000;
const CLEANUP_GRACE_MS = 15000; // after a timeout, how long to wait for the step in progress before closing anyway
const SETUP_ALLOWANCE_MS = 30000; // the backstop timer's extra time for creating the sandbox
const SIM_IT = { id: 'SYN-inventory-admin', role: 'IT manager' };
const SIM_STARTER = { id: 'SYN-starter', role: 'process manager' };
const SIM_APPROVER = { id: 'SYN-approver', role: 'process manager' };

class SimulationTimeout extends Error {}

// `workRoot` is the folder the sandbox's temporary folder is made in (default: the
// system temp folder); tests pass their own so they can check it is cleaned up.
export async function runInSandbox(scenario, {
  timeoutMs = DEFAULT_TIMEOUT_MS, executors: extraExecutors = {}, runOptions = { timeoutMs: 5000, retryDelayMs: 10 }, workRoot = tmpdir(),
} = {}) {
  const check = validateScenario(scenario);
  if (!check.ok) throw new ScenarioError(check.problems);

  const started = Date.now();
  const dir = mkdtempSync(join(workRoot, 'opspilot-sandbox-'));
  const audit = createAuditLog({ file: join(dir, 'sandbox-audit.jsonl') });
  const db = await openPGlite();
  const results = [];
  let stopped = false;
  // The limit covers RUNNING THE WORKFLOWS, counted from the end of setup (creating
  // the sandbox's tables takes a second or more the first time). It is checked
  // between every step: a timer alone is not enough, because PGlite's work can run
  // without ever letting a timer fire. The timer below is only a backstop for a
  // genuine hang, and allows for setup.
  let deadline = Infinity;
  const stopIfTimedOut = () => { if (stopped || Date.now() > deadline) throw new SimulationTimeout(); };

  const work = (async () => {
    await migrate(db);
    await migrateWorkflows(db);
    deadline = Date.now() + timeoutMs; // setup is done: the simulation's own clock starts now
    const inventory = createInventoryService({ db, audit });

    // ---- The scenario's synthetic systems, with their given risk ratings ----
    for (const { riskLevel, ...system } of scenario.systems) {
      stopIfTimedOut();
      await inventory.registerSystem({ user: SIM_IT, system, reason: `Synthetic system for simulation ${scenario.id}` });
      if (riskLevel !== 'unassessed') {
        await db.query("UPDATE ai_systems SET risk_level = $2, risk_assessment_id = $3, risk_assessed_at = now() WHERE id = $1",
          [system.id, riskLevel, `${scenario.id}:given`]);
      }
    }

    // ---- The policy to simulate under, if any (STORY-009) ----
    const pack = typeof scenario.policy === 'string' ? examplePack(scenario.policy) : scenario.policy;
    const governance = pack ? { current: () => ({ jurisdiction: pack.jurisdiction, version: 1, controls: pack.controls }) } : null;

    const engine = createWorkflowEngine({
      db, audit, governance, runOptions,
      executors: {
        notify: createStandInExecutor('notify'),
        create_ticket: createStandInExecutor('create_ticket'),
        payment: createStandInExecutor('payment'),
        'inventory.update_status': createInventoryStatusExecutor({ inventory }),
        ...extraExecutors,
      },
    });

    // ---- Each workflow, then its scripted decisions ----
    for (const w of scenario.workflows) {
      stopIfTimedOut();
      await engine.startWorkflow({ user: SIM_STARTER, workflowId: w.id, name: w.name, actions: w.actions });
      const decisionErrors = [];
      for (const d of w.decide ?? []) {
        stopIfTimedOut();
        try {
          await engine.decide({ user: SIM_APPROVER, workflowId: w.id, step: d.step, decision: d.decision, note: `Scripted ${d.decision} in simulation ${scenario.id}` });
        } catch (err) {
          // A decision the engine refused is itself a result (e.g. the step was not waiting).
          decisionErrors.push({ step: d.step, decision: d.decision, error: `${err.name}: ${err.message}` });
        }
      }
      const final = await engine.getWorkflow(w.id);
      stopIfTimedOut(); // a workflow that finished after the limit does not count as on time
      results.push({
        id: w.id,
        name: w.name,
        status: final.run.status,
        actions: final.actions.map((a) => ({
          step: a.step, type: a.type, riskLevel: a.riskLevel, outcome: a.status,
          reasons: (a.riskReasons ?? []).filter((x) => x.effect !== 'base').map((x) => x.rule), error: a.error,
        })),
        decisionErrors,
      });
    }
  })();

  let status = 'ran';
  let error;
  let timer;
  let reported = results; // on a timeout: frozen at that moment (see below)
  try {
    await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new SimulationTimeout()), timeoutMs + SETUP_ALLOWANCE_MS); })]);
  } catch (err) {
    if (err instanceof SimulationTimeout) {
      status = 'timed_out';
      // Only what finished within the limit counts. A step still running is allowed to
      // finish before the sandbox closes, but its result is not reported as on time;
      // the sandbox log still records everything that happened.
      reported = results.slice();
      error = `The simulation took longer than ${timeoutMs} ms and was stopped after ${reported.length} of ${scenario.workflows.length} workflow(s).`;
    } else {
      status = 'error';
      error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
    }
  } finally {
    clearTimeout(timer);
    stopped = true;
    // Let the step in progress finish (bounded), so the database is not closed under it.
    await Promise.race([work.catch(() => {}), new Promise((r) => { setTimeout(r, CLEANUP_GRACE_MS).unref?.(); })]);
  }

  const sandboxLog = audit.readAll();
  try {
    await db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    status, scenarioId: scenario.id, durationMs: Date.now() - started, workflows: reported, sandboxLog,
    ...(error ? { error } : {}),
  };
}
