// The one way to run a process analysis (STORY-002). It ties the pieces together:
//
//   request → permission → validate data → analyse → report
//
// and writes every step to the audit log (REQ-008). Every entry for an analysis
// names the requesting user as the actor, and the audit log stamps it with the
// time — so each activity is recorded with a timestamp and a user id.
//
// What the caller gets back (runAnalysis resolves with one of these):
//   { status: 'completed',    report, text }        — the detailed report
//   { status: 'missing_data', notice, problems }    — nothing analysed; tells the user what is missing
//   { status: 'interrupted',  message }             — timed out or cancelled; nothing saved, safe to re-run
// and it rejects with:
//   PermissionDeniedError — the user's role may not run analyses
//   AnalysisRequestError  — malformed request, or an id reused with different data
//   AuditWriteError       — the audit log failed, so the analysis stopped (fail closed)
//
// Idempotent: a completed analysis is saved by analysisId; asking again with the
// same data returns the saved report, and a call while it is still running joins
// that run. Who may see a saved report is checked again on every request.
// Limit: identity is whatever the caller says it is — there is no login yet.

import { fingerprint } from '../lib/fingerprint.js';
import { roleAllowed } from '../lib/roles.js';
import { validateDataset, missingDataNotice } from './processData.js';
import { analyse, AnalysisInterruptedError, resolveThresholds } from './analyse.js';
import { buildReport, renderReportText } from './report.js';

export const ANALYSIS_ROLES = Object.freeze(['process analyst', 'operations manager']);
export const DEFAULT_TIMEOUT_MS = 60000;
const MAX_PROBLEMS_LOGGED = 50;

export class PermissionDeniedError extends Error {
  constructor(message, options) { super(message, options); this.name = 'PermissionDeniedError'; }
}
export class AnalysisRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'AnalysisRequestError'; }
}

const UNKNOWN_REQUESTER = { type: 'system', id: 'unknown-requester' };
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

const fingerprintOf = (dataset, thresholds) => fingerprint({ dataset, thresholds: thresholds ?? null });

export function createAnalysisService({ audit, store, timeoutMs = DEFAULT_TIMEOUT_MS, roles = ANALYSIS_ROLES }) {
  const inFlight = new Map(); // analysisId → { promise, fingerprint }

  async function runAnalysis({ analysisId, user, dataset, thresholds, signal } = {}) {
    // ---- 1. Is this a well-formed request? ----
    const bad = !isNonEmpty(analysisId) ? 'analysisId must be a non-empty string'
      : !isNonEmpty(user?.id) ? 'user.id is required (who is asking?)' : null;
    if (bad) {
      audit.append({
        correlationId: isNonEmpty(analysisId) ? analysisId : 'invalid-request',
        actor: isNonEmpty(user?.id) ? { type: 'person', id: user.id } : UNKNOWN_REQUESTER,
        action: 'analysis.rejected', rationale: bad,
      });
      throw new AnalysisRequestError(`Analysis request rejected: ${bad}`);
    }

    const actor = { type: 'person', id: user.id };
    const log = (action, fields = {}) => audit.append({ correlationId: analysisId, actor, action, ...fields });
    log('analysis.requested', {
      detail: {
        role: user.role ?? null,
        process: typeof dataset?.process === 'string' ? dataset.process : null,
        rows: Array.isArray(dataset?.events) ? dataset.events.length : null,
      },
    });

    // ---- 2. May this user run (or read) an analysis? ----
    if (!roleAllowed(user.role, roles)) {
      const why = `Role "${user.role ?? 'none'}" may not run process analysis; allowed roles: ${roles.join(', ')}.`;
      log('analysis.denied', { rationale: why });
      throw new PermissionDeniedError(why);
    }

    // ---- 3. Are the settings valid? A bad threshold would silently switch a rule off. ----
    try {
      resolveThresholds(thresholds);
    } catch (err) {
      log('analysis.rejected', { rationale: err.message });
      throw new AnalysisRequestError(`Analysis ${analysisId} rejected: ${err.message}`, { cause: err });
    }

    // ---- 4. Already running, or already done? ----
    const fingerprint = fingerprintOf(dataset, thresholds);
    const conflict = () => {
      const why = 'This analysis id was already used with different data or settings; use a new id.';
      log('analysis.rejected', { rationale: why });
      return new AnalysisRequestError(`Analysis ${analysisId} rejected: ${why}`);
    };
    const running = inFlight.get(analysisId);
    if (running) {
      if (running.fingerprint !== fingerprint) throw conflict();
      log('analysis.joined', { rationale: 'Already running; waiting for the same run instead of starting a second one.' });
      return running.promise;
    }
    const saved = store.get(analysisId);
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw conflict();
      log('analysis.replayed', { rationale: 'Already completed; returning the saved report without analysing again.' });
      return { ...saved.result, replayed: true };
    }

    const promise = execute({ analysisId, dataset, thresholds, signal, fingerprint, actor, log });
    inFlight.set(analysisId, { promise, fingerprint });
    const cleanup = () => { inFlight.delete(analysisId); };
    promise.then(cleanup, cleanup); // not finally(): that would leave an unhandled rejection
    return promise;
  }

  async function execute({ analysisId, dataset, thresholds, signal, fingerprint, actor, log }) {
    // ---- 5. Is the data complete? If not, say exactly what is missing. ----
    const validation = validateDataset(dataset);
    if (!validation.ok) {
      log('analysis.missing_data', {
        rationale: `${validation.problems.length} problem(s) in the data; no report was produced.`,
        detail: { totalProblems: validation.problems.length, problems: validation.problems.slice(0, MAX_PROBLEMS_LOGGED) },
      });
      return { status: 'missing_data', analysisId, notice: missingDataNotice(validation), problems: validation.problems, replayed: false };
    }

    // ---- 6. Analyse, within a time limit and cancellable by the caller ----
    log('analysis.started', { detail: { process: validation.process, cases: validation.summary.cases, events: validation.events.length, timeoutMs } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    const onCallerAbort = () => controller.abort(signal.reason instanceof Error ? signal.reason : new Error('cancelled by the caller'));
    if (signal?.aborted) onCallerAbort();
    else signal?.addEventListener('abort', onCallerAbort, { once: true });

    let analysis;
    try {
      analysis = await analyse(validation, { thresholds, signal: controller.signal });
    } catch (err) {
      if (err instanceof AnalysisInterruptedError) {
        const reason = controller.signal.reason?.message ?? 'interrupted';
        log('analysis.interrupted', { rationale: `Stopped (${reason}) ${err.message.replace('Analysis interrupted ', '')}; nothing was saved.` });
        return {
          status: 'interrupted', analysisId, replayed: false,
          message: `The analysis was interrupted (${reason}) and nothing was saved. Run it again to retry.`,
        };
      }
      log('analysis.failed', { rationale: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` });
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }

    // ---- 7. Report. Logged before it is saved and returned: no unrecorded result. ----
    const report = buildReport(analysis, { analysisId, requestedBy: actor });
    const result = { status: 'completed', analysisId, report, text: renderReportText(report), replayed: false };
    log('analysis.completed', {
      detail: { bottlenecks: report.summary.bottlenecks, duplicates: report.summary.duplicates, automationCandidates: report.summary.automationCandidates },
    });
    store.put(analysisId, { status: 'completed', fingerprint, result });
    return result;
  }

  return { runAnalysis };
}
