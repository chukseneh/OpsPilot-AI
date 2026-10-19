// Running simulations and keeping their reports (STORY-010, REQ-014).
//
//   runSimulation({ user, runId, scenario })                 → the saved report
//   runSimulation({ user, runId, generate: { seed, workflows } })
//   getSimulation({ user, runId }) / listSimulations({ user })
//
// Who (the student's choice): a system tester or a process manager. Anyone else —
// or a request with no user — is refused, and the refusal logged.
//
//   validate  — incorrect synthetic data (or a generator producing it) is refused
//               with every problem listed; nothing runs
//   run       — in an isolated sandbox (sandbox.js): never in this system's database
//   compare   — against the scenario's expectations (compare.js)
//   save      — the scenario, verdict, summary, every mismatch, each workflow's
//               actual steps, and the sandbox's own log, for review
//
// Trust: the main audit log records each run (simulation.started) and its result
// (simulation.completed, a decision whose rationale states the verdict and every
// critical mismatch). Every entry says the data was synthetic.
//
// Idempotent: the same runId with the same scenario returns the saved report
// without running again; a different scenario under that id is refused; two
// identical requests at once run once.

import { fingerprint } from '../lib/fingerprint.js';
import { roleAllowed } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { validateScenario, generateScenario, ScenarioError } from './scenario.js';
import { runInSandbox, DEFAULT_TIMEOUT_MS } from './sandbox.js';
import { compareResults } from './compare.js';

export { PermissionDeniedError, ScenarioError };
export const SIMULATION_ROLES = Object.freeze(['system tester', 'process manager']);
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const VERDICTS = ['passed', 'failed', 'timed_out', 'error'];

export class SimulationRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'SimulationRequestError'; }
}
export class SimulationNotFoundError extends Error {
  constructor(message, options) { super(message, options); this.name = 'SimulationNotFoundError'; }
}

const list = (values) => values.map((v) => `'${v}'`).join(', ');
export const SIMULATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS simulation_runs (
  id           text PRIMARY KEY CHECK (btrim(id) <> ''),
  scenario_id  text NOT NULL,
  requested_by text NOT NULL,
  verdict      text NOT NULL CHECK (verdict IN (${list(VERDICTS)})),
  summary      jsonb NOT NULL,
  report       jsonb NOT NULL,
  scenario     jsonb NOT NULL,
  sandbox_log  jsonb NOT NULL,
  fingerprint  text NOT NULL,
  duration_ms  integer NOT NULL,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  -- Only synthetic scenarios are ever stored here.
  CONSTRAINT synthetic_only CHECK ((scenario ->> 'synthetic') = 'true')
);
`;
export async function migrateSimulations(db) { await db.exec(SIMULATION_SCHEMA_SQL); }

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const fromRow = (r) => ({
  runId: r.id, scenarioId: r.scenario_id, requestedBy: r.requested_by, verdict: r.verdict, summary: r.summary,
  report: r.report, scenario: r.scenario, sandboxLog: r.sandbox_log, durationMs: r.duration_ms, ranAt: iso(r.ran_at),
});

// The audit rationale: the verdict in words, and every critical mismatch.
function describe(comparison, run) {
  const s = comparison.summary;
  const head = {
    passed: `passed: all ${s.workflows.total} workflow(s) executed as expected (${s.steps.checked} step(s) checked)`,
    failed: `failed: ${s.workflows.failed} of ${s.workflows.total} workflow(s) did not behave as expected`,
    timed_out: `timed out: ${String(run.error).replace(/\.$/, '')}`,
    error: `error: ${String(run.error).replace(/\.$/, '')}`,
  }[comparison.verdict];
  const critical = comparison.workflows.flatMap((w) => w.mismatches).filter((m) => m.severity === 'critical');
  const others = comparison.workflows.flatMap((w) => w.mismatches).filter((m) => m.severity !== 'critical');
  return [
    `Simulation on SYNTHETIC data ${head}.`,
    critical.length ? `${critical.length} CRITICAL: ${critical.map((m) => m.message).join(' | ')}.` : null,
    others.length ? `${others.length} other mismatch(es): ${others.slice(0, 5).map((m) => m.message).join(' | ')}${others.length > 5 ? ' | …' : ''}.` : null,
  ].filter(Boolean).join(' ');
}

export function createSimulationService({ db, audit, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
  const inFlight = new Map(); // runId → { fingerprint, promise }

  function authorise(user, correlationId, what) {
    if (!isNonEmpty(user?.id)) {
      const why = 'No user was given; simulations are only run for a known person.';
      audit.append({ correlationId, actor: { type: 'system', id: 'unknown-requester' }, action: 'simulation.denied', rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    const actor = { type: 'person', id: user.id };
    if (!roleAllowed(user.role, SIMULATION_ROLES)) {
      const why = `Role "${user.role ?? 'none'}" may not ${what}; allowed roles: ${SIMULATION_ROLES.join(', ')}.`;
      audit.append({ correlationId, actor, action: 'simulation.denied', rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    return actor;
  }

  async function runSimulation({ user, runId, scenario: given, generate, timeoutMs = defaultTimeoutMs } = {}) {
    const correlationId = `simulation:${isNonEmpty(runId) ? runId : 'invalid'}`;
    const actor = authorise(user, correlationId, 'run simulations');
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, subject: runId ?? null, ...fields });
    const reject = (why, detail = {}) => {
      log('simulation.rejected', { rationale: why, detail });
      return new SimulationRequestError(`Simulation rejected: ${why}`);
    };

    if (!isNonEmpty(runId)) throw reject('runId must be a non-empty string');
    if ((given === undefined) === (generate === undefined)) throw reject('give either a scenario or generate: { seed, workflows }, not both or neither');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw reject(`timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`);

    // ---- The synthetic data: given, or generated. Either way it is checked first. ----
    let scenario = given;
    if (generate !== undefined) {
      try {
        scenario = generateScenario(generate);
      } catch (err) {
        if (!(err instanceof ScenarioError)) throw err;
        log('simulation.rejected', { rationale: err.message, detail: { generate, problems: err.problems, dataGenerationError: true } });
        throw err;
      }
    }
    const check = validateScenario(scenario);
    if (!check.ok) {
      const err = new ScenarioError(check.problems);
      log('simulation.rejected', { rationale: err.message, detail: { problems: check.problems, scenarioId: scenario?.id ?? null } });
      throw err;
    }

    // ---- Already run, or running? ----
    const fp = fingerprint({ scenario, timeoutMs });
    const running = inFlight.get(runId);
    if (running) {
      if (running.fingerprint !== fp) throw reject('this run id is already running a different scenario; use a new id');
      log('simulation.joined', { rationale: 'Already running; waiting for the same run instead of starting a second one.' });
      return running.promise;
    }
    // Registered BEFORE the first wait, so a second identical request arriving while
    // this one looks for a saved report joins it instead of starting a second run.
    const promise = (async () => {
      const { rows: [saved] } = await db.query('SELECT * FROM simulation_runs WHERE id = $1', [runId]);
      if (saved) {
        if (saved.fingerprint !== fp) throw reject('this run id was already used for a different scenario; use a new id so both reports stay on record');
        log('simulation.replayed', { rationale: 'Already run with exactly this scenario; returning the saved report.' });
        return fromRow(saved);
      }
      log('simulation.started', {
        detail: { scenarioId: scenario.id, synthetic: true, label: scenario.label, policy: typeof scenario.policy === 'string' ? scenario.policy : scenario.policy ? 'custom' : null, workflows: scenario.workflows.length, timeoutMs },
      });
      let run;
      try {
        run = await runInSandbox(scenario, { timeoutMs });
      } catch (err) {
        // The sandbox could not even be set up: say so, so "started" never stands alone.
        log('simulation.failed', { rationale: `The sandbox could not run: ${err?.name ?? 'Error'}: ${err?.message ?? err}`, detail: { scenarioId: scenario.id } });
        throw err;
      }
      const comparison = compareResults(scenario, run);
      const report = { comparison, workflows: run.workflows, sandboxStatus: run.status, ...(run.error ? { error: run.error } : {}) };

      // Saved and logged together; a failed commit after the log entry gets a correcting entry.
      let logged = null;
      try {
        return await db.transaction(async (tx) => {
          const { rows: [row] } = await tx.query(
            `INSERT INTO simulation_runs (id, scenario_id, requested_by, verdict, summary, report, scenario, sandbox_log, fingerprint, duration_ms)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10) RETURNING *`,
            [runId, scenario.id, user.id, comparison.verdict, JSON.stringify(comparison.summary), JSON.stringify(report),
              JSON.stringify(scenario), JSON.stringify(run.sandboxLog), fp, run.durationMs],
          );
          logged = log('simulation.completed', {
            rationale: describe(comparison, run),
            detail: {
              scenarioId: scenario.id, synthetic: true, verdict: comparison.verdict, summary: comparison.summary, durationMs: run.durationMs,
              mismatches: comparison.workflows.flatMap((w) => w.mismatches.map((m) => ({ workflow: w.id, ...m }))),
            },
          });
          return fromRow(row);
        });
      } catch (err) {
        if (logged) log('simulation.change_failed', { rationale: `The result logged as #${logged.seq} was NOT saved: ${err?.name ?? 'Error'}: ${err?.message ?? err}` });
        throw err;
      }
    })();
    inFlight.set(runId, { fingerprint: fp, promise });
    const cleanup = () => { inFlight.delete(runId); };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async function getSimulation({ user, runId } = {}) {
    const actor = authorise(user, `simulation:${runId ?? 'unknown'}`, 'view simulation reports');
    const { rows: [row] } = await db.query('SELECT * FROM simulation_runs WHERE id = $1', [runId]);
    if (!row) throw new SimulationNotFoundError(`No simulation run ${runId}.`);
    audit.append({ correlationId: `simulation:${runId}`, actor, action: 'simulation.viewed', subject: runId });
    return fromRow(row);
  }

  async function listSimulations({ user } = {}) {
    const actor = authorise(user, 'simulations', 'view simulation reports');
    const { rows } = await db.query('SELECT * FROM simulation_runs ORDER BY ran_at, id');
    audit.append({ correlationId: 'simulations', actor, action: 'simulation.listed', detail: { returned: rows.length } });
    return rows.map(fromRow);
  }

  return { runSimulation, getSimulation, listSimulations };
}
