// The one way to run a risk assessment of the registered AI systems (STORY-003,
// REQ-005). It ties the pieces together:
//
//   request → permission → check each system's data → assess each system → report
//
// and writes every step to the audit log (REQ-008), with the requesting user as
// the actor. Each system's result — its risks, their categories and severities,
// its overall rating and the suggested mitigations — is logged as soon as it is
// known, and the finished assessment is logged before it is saved or returned:
// no result exists that the audit log does not hold.
//
// What the caller gets back (runAssessment resolves with one of these):
//   { status: 'completed',    report }   — every complete system assessed; saved
//   { status: 'partial',      report }   — the risk model failed on some systems; NOT saved, re-run to retry them
//   { status: 'model_error',  report, message } — the risk model failed on every system; NOT saved
//   { status: 'missing_data', notice, unassessed, problems } — no system had complete data; nothing assessed
//   { status: 'interrupted',  message }  — timed out or cancelled; nothing saved, safe to re-run
// Systems with incomplete data never stop the others: they are listed in the
// report as unassessed, with what is missing (the student's choice, STORY-003).
// and it rejects with:
//   PermissionDeniedError — the user's role may not run risk assessments
//   RiskRequestError      — malformed request, or an id reused with different systems
//   AuditWriteError       — the audit log failed, so the assessment stopped (fail closed)
//
// Idempotent: a completed assessment is saved by assessmentId; asking again with
// the same systems returns the saved result, and a call while it is still running
// joins that run. Nothing is ever created twice by a retry.
// Limit: identity is whatever the caller says it is — there is no login yet.

import { fingerprint } from '../lib/fingerprint.js';
import { roleAllowed } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { validateSystems, incompleteSystemsNotice } from './systemData.js';
import { createRuleBasedRiskModel, checkModelOutput, overallRiskLevel, RISK_CATEGORIES, SEVERITIES } from './riskModel.js';

export { PermissionDeniedError };
export const RISK_ROLES = Object.freeze(['compliance officer', 'security officer', 'operations manager']);
export const DEFAULT_TIMEOUT_MS = 30000;

export class RiskRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'RiskRequestError'; }
}

const UNKNOWN_REQUESTER = { type: 'system', id: 'unknown-requester' };
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const errorText = (err) => `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;

// What this report cannot tell you. Shown with every report so nobody reads more into it.
export const REPORT_LIMITS = Object.freeze([
  'This is a rule-based first screen from the registered details only; it does not inspect the systems themselves.',
  'A system with no risks raised is rated low because no rule fired, not because it was proven safe.',
  'It applies no specific jurisdiction\'s law; configurable governance controls are a later story (STORY-009).',
]);

export function createRiskAssessmentService({
  audit, store, model = createRuleBasedRiskModel(), timeoutMs = DEFAULT_TIMEOUT_MS, roles = RISK_ROLES, now = () => new Date(),
}) {
  const inFlight = new Map(); // assessmentId → { promise, fingerprint }

  async function runAssessment({ assessmentId, user, systems, signal } = {}) {
    // ---- 1. Is this a well-formed request? ----
    const bad = !isNonEmpty(assessmentId) ? 'assessmentId must be a non-empty string'
      : !isNonEmpty(user?.id) ? 'user.id is required (who is asking?)' : null;
    if (bad) {
      audit.append({
        correlationId: isNonEmpty(assessmentId) ? assessmentId : 'invalid-request',
        actor: isNonEmpty(user?.id) ? { type: 'person', id: user.id } : UNKNOWN_REQUESTER,
        action: 'risk.rejected', rationale: bad,
      });
      throw new RiskRequestError(`Risk assessment request rejected: ${bad}`);
    }

    const actor = { type: 'person', id: user.id };
    const log = (action, fields = {}) => audit.append({ correlationId: assessmentId, actor, action, ...fields });
    log('risk.requested', { detail: { role: user.role ?? null, systems: Array.isArray(systems) ? systems.length : null } });

    // ---- 2. May this user run (or read) a risk assessment? ----
    if (!roleAllowed(user.role, roles)) {
      const why = `Role "${user.role ?? 'none'}" may not run risk assessments; allowed roles: ${roles.join(', ')}.`;
      log('risk.denied', { rationale: why });
      throw new PermissionDeniedError(why);
    }

    // ---- 3. Already running, or already done? The model is part of the
    //         fingerprint: a different model would give a different answer. ----
    const fp = fingerprint({ systems: systems ?? null, model: { id: model.id, version: model.version } });
    const conflict = () => {
      const why = 'This assessment id was already used with different systems or a different risk model; use a new id.';
      log('risk.rejected', { rationale: why });
      return new RiskRequestError(`Risk assessment ${assessmentId} rejected: ${why}`);
    };
    const running = inFlight.get(assessmentId);
    if (running) {
      if (running.fingerprint !== fp) throw conflict();
      log('risk.joined', { rationale: 'Already running; waiting for the same run instead of starting a second one.' });
      return running.promise;
    }
    const saved = store.get(assessmentId);
    if (saved) {
      if (saved.fingerprint !== fp) throw conflict();
      log('risk.replayed', { rationale: 'Already completed; returning the saved assessment without assessing again.' });
      return { ...saved.result, replayed: true };
    }

    const promise = execute({ assessmentId, systems, signal, fp, actor, log });
    inFlight.set(assessmentId, { promise, fingerprint: fp });
    const cleanup = () => { inFlight.delete(assessmentId); };
    promise.then(cleanup, cleanup); // not finally(): that would leave an unhandled rejection
    return promise;
  }

  async function execute({ assessmentId, systems, signal, fp, actor, log }) {
    // ---- 4. Which systems have complete data? ----
    const validation = validateSystems(systems);
    const notice = incompleteSystemsNotice(validation);
    if (validation.systems.length === 0) {
      log('risk.missing_data', {
        rationale: 'No AI system had complete data; nothing was assessed.',
        detail: { problems: validation.problems, unassessed: validation.incomplete },
      });
      return { status: 'missing_data', assessmentId, notice, unassessed: validation.incomplete, problems: validation.problems, replayed: false };
    }

    log('risk.started', {
      detail: {
        registered: Array.isArray(systems) ? systems.length : 0,
        assessable: validation.systems.length,
        unassessed: validation.incomplete.length,
        model: { id: model.id, version: model.version },
        timeoutMs,
      },
    });
    for (const s of validation.incomplete) {
      log('risk.system_unassessed', { subject: s.systemId ?? `position ${s.position}`, rationale: 'Incomplete or invalid data.', detail: s });
    }

    // ---- 5. Assess each system, within one time limit, cancellable by the caller.
    //         The race means a model that ignores the signal cannot hang us. ----
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    const onCallerAbort = () => controller.abort(signal.reason instanceof Error ? signal.reason : new Error('cancelled by the caller'));
    if (signal?.aborted) onCallerAbort();
    else signal?.addEventListener('abort', onCallerAbort, { once: true });
    const stopped = new Promise((_, reject) => {
      const fail = () => reject(controller.signal.reason);
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener('abort', fail, { once: true });
    });
    stopped.catch(() => {}); // the races below handle it; this stops an abort with no race running from being reported as unhandled

    const assessed = [];
    const failed = [];
    try {
      for (const system of validation.systems) {
        if (controller.signal.aborted) break;
        let risks;
        try {
          const output = await Promise.race([
            Promise.resolve().then(() => model.assess(structuredClone(system), { signal: controller.signal })),
            stopped,
          ]);
          ({ risks } = checkModelOutput(output));
        } catch (err) {
          if (controller.signal.aborted) break; // a timeout, not the model's fault
          failed.push({ systemId: system.id, name: system.name, reason: errorText(err) });
          log('risk.system_failed', { subject: system.id, rationale: `The risk model failed on this system: ${errorText(err)}` });
          continue;
        }
        const result = {
          systemId: system.id, name: system.name, department: system.department, owner: system.owner,
          systemStatus: system.status, riskLevel: overallRiskLevel(risks), risks,
        };
        assessed.push(result);
        log('risk.system_assessed', { subject: system.id, detail: result });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }

    if (controller.signal.aborted) {
      const reason = controller.signal.reason?.message ?? 'interrupted';
      log('risk.interrupted', {
        rationale: `Stopped (${reason}) after ${assessed.length} of ${validation.systems.length} system(s); nothing was saved.`,
      });
      return {
        status: 'interrupted', assessmentId, replayed: false,
        message: `The risk assessment was interrupted (${reason}) and nothing was saved. Run it again to retry.`,
      };
    }

    // ---- 6. Report. Logged before it is saved and returned: no unrecorded result. ----
    const report = buildReport({ assessmentId, actor, assessed, failed, validation, notice, assessedAt: now().toISOString() });
    if (failed.length === 0) {
      log('risk.completed', { detail: report.summary });
      const result = { status: 'completed', assessmentId, report, replayed: false };
      store.put(assessmentId, { status: 'completed', fingerprint: fp, result });
      return result;
    }
    if (assessed.length === 0) {
      const message = `The risk model failed on every system (${failed.length}); nothing was saved. Run it again to retry.`;
      log('risk.model_error', { rationale: message, detail: report.summary });
      return { status: 'model_error', assessmentId, report, message, replayed: false };
    }
    log('risk.partial', {
      rationale: `The risk model failed on ${failed.length} system(s); the assessment was not saved so a re-run retries them.`,
      detail: report.summary,
    });
    return { status: 'partial', assessmentId, report, replayed: false };
  }

  function buildReport({ assessmentId, actor, assessed, failed, validation, notice, assessedAt }) {
    const count = (keys, pick) => Object.fromEntries(keys.map((k) => [k, pick(k)]));
    const allRisks = assessed.flatMap((s) => s.risks);
    return {
      assessmentId,
      requestedBy: actor,
      assessedAt,
      model: { id: model.id, version: model.version },
      summary: {
        registered: validation.systems.length + validation.incomplete.length,
        assessed: assessed.length,
        unassessed: validation.incomplete.length,
        failed: failed.length,
        systemsByRiskLevel: count([...SEVERITIES].reverse(), (l) => assessed.filter((s) => s.riskLevel === l).length),
        risksByCategory: count(RISK_CATEGORIES, (c) => allRisks.filter((r) => r.category === c).length),
      },
      systems: assessed,
      unassessed: validation.incomplete,
      failed,
      notice,
      limits: [...REPORT_LIMITS],
    };
  }

  return { runAssessment };
}
