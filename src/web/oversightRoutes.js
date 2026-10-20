// /api/v1/governance/*, /api/v1/audit and /api/v1/simulations/* (web access, step 4d).
// The services make every check and decision; these routes pass the signed-in user.
//
//   POST /api/v1/governance/proposals                              { policy, effectiveFrom, reason }
//   POST /api/v1/governance/:jurisdiction/versions/:version/approve  { note }
//   POST /api/v1/governance/:jurisdiction/versions/:version/reject   { note }
//   GET  /api/v1/governance/:jurisdiction/versions                 every version (approvers)
//   GET  /api/v1/governance/:jurisdiction/active                   the policy in force (any role)
//
//   GET  /api/v1/audit?correlationId=&actorId=&action=&from=&to=&after=&limit=
//        A page of the audit log with its integrity check (security and compliance
//        officers). Repairing the log is deliberately NOT offered here: it rewrites
//        the file the running server appends to, so it is done with the system stopped.
//
//   POST /api/v1/simulations                  { runId, scenario | generate, timeoutMs }
//        Waits up to waitMs (20 s) for the run. Finished: 200 with the report.
//        Still running: 202 { runId, status: 'running' }; the run carries on, and
//        GET /api/v1/simulations/:runId answers 202 until the report is saved.
//        Safe to repeat: the same runId and scenario joins or returns the same run.
//   GET  /api/v1/simulations                  every saved report
//   GET  /api/v1/simulations/:runId           one report (or 202 while it runs)

import { ApiRequestError } from './errors.js';
import { SimulationNotFoundError } from '../simulation/service.js';

const versionNumber = (text) => {
  if (!/^[1-9][0-9]{0,5}$/.test(text)) throw new ApiRequestError(400, 'The version must be a whole number from 1.');
  return Number(text);
};
const wholeNumber = (query, name) => {
  const text = query.get(name);
  if (text === null) return undefined;
  if (!/^[0-9]{1,9}$/.test(text)) throw new ApiRequestError(400, `${name} must be a whole number.`);
  return Number(text);
};

export function oversightRoutes({ governance, auditReader, simulations, audit, waitMs = 20000 }) {
  // Runs answered with 202 and still going, so a GET can say "running" rather than "not found".
  const running = new Map(); // runId → promise
  const FILTERS = ['correlationId', 'actorId', 'action', 'from', 'to'];
  const PAGE = ['after', 'limit'];

  const decision = (verb) => ({
    method: 'POST', path: `/api/v1/governance/:jurisdiction/versions/:version/${verb}`, auth: 'session',
    handle: async ({ user, params, body }) => {
      const args = { user, jurisdiction: params.jurisdiction, version: versionNumber(params.version), note: body.note };
      return { body: { version: await (verb === 'approve' ? governance.approveProposal(args) : governance.rejectProposal(args)) } };
    },
  });

  return [
    {
      method: 'POST', path: '/api/v1/governance/proposals', auth: 'session',
      handle: async ({ user, body }) => ({
        body: { version: await governance.proposePolicy({ user, policy: body.policy, effectiveFrom: body.effectiveFrom, reason: body.reason }) },
      }),
    },
    decision('approve'),
    decision('reject'),
    {
      method: 'GET', path: '/api/v1/governance/:jurisdiction/versions', auth: 'session',
      handle: async ({ user, params }) => ({ body: { versions: await governance.listVersions({ user, jurisdiction: params.jurisdiction }) } }),
    },
    {
      method: 'GET', path: '/api/v1/governance/:jurisdiction/active', auth: 'session',
      handle: async ({ user, params }) => ({ body: { policy: await governance.viewActivePolicy({ user, jurisdiction: params.jurisdiction }) } }),
    },

    {
      method: 'GET', path: '/api/v1/audit', auth: 'session',
      handle: async ({ user, query }) => {
        const unknown = [...new Set(query.keys())].filter((k) => !FILTERS.includes(k) && !PAGE.includes(k));
        if (unknown.length) throw new ApiRequestError(400, `Unknown query parameter(s): ${unknown.join(', ')}; allowed: ${[...FILTERS, ...PAGE].join(', ')}.`);
        const filter = Object.fromEntries(FILTERS.filter((k) => query.has(k)).map((k) => [k, query.get(k)]));
        const page = Object.fromEntries(PAGE.map((k) => [k, wholeNumber(query, k)]).filter(([, v]) => v !== undefined));
        return { body: await auditReader.readAuditLog({ user, filter, page }) };
      },
    },

    {
      method: 'POST', path: '/api/v1/simulations', auth: 'session',
      handle: async ({ user, body }) => {
        const runId = body.runId;
        const run = simulations.runSimulation({ user, runId, scenario: body.scenario, generate: body.generate, ...(body.timeoutMs !== undefined && { timeoutMs: body.timeoutMs }) });
        let timer;
        const later = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
        const report = await Promise.race([run, later]).finally(() => clearTimeout(timer));
        if (report) return { body: { simulation: report } };

        // Still running: answer now, and let it finish. Its outcome is logged by the
        // service; a failure the service could not log is reported here, never dropped.
        running.set(runId, run);
        run.then(() => running.delete(runId), (err) => {
          running.delete(runId);
          try {
            audit.append({
              correlationId: `simulation:${runId}`, actor: { type: 'person', id: user.id }, action: 'simulation.background_failed',
              subject: runId, rationale: `The simulation answered with 202 then failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}`,
            });
          } catch (logErr) {
            console.error(`Simulation ${runId} failed in the background, and the failure could not be logged`, err, logErr);
          }
        });
        return { status: 202, body: { runId, status: 'running', poll: `/api/v1/simulations/${encodeURIComponent(runId)}` } };
      },
    },
    {
      method: 'GET', path: '/api/v1/simulations', auth: 'session',
      handle: async ({ user }) => ({ body: { simulations: await simulations.listSimulations({ user }) } }),
    },
    {
      method: 'GET', path: '/api/v1/simulations/:runId', auth: 'session',
      handle: async ({ user, params }) => {
        try {
          return { body: { simulation: await simulations.getSimulation({ user, runId: params.runId }) } };
        } catch (err) {
          // The permission check comes first inside getSimulation, so only an allowed
          // reader ever learns that a run is in progress.
          if (err instanceof SimulationNotFoundError && running.has(params.runId)) return { status: 202, body: { runId: params.runId, status: 'running' } };
          throw err;
        }
      },
    },
  ];
}
