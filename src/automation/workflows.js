// Workflow automation with human oversight (STORY-005, REQ-007).
//
// A workflow is an ordered list of actions. The engine runs them one at a time:
//
//   classify (actionRisk.js) ─┬─ low  → run it now (executors.js)
//                             └─ high → stop and wait for a person to approve it
//
// Runs and their actions live in PostgreSQL (two tables, below), so a workflow
// waiting for approval survives a restart. Every action is written to the audit
// log WITH ITS RISK LEVEL and the reasons for it: when it is classified, when it
// waits for approval, when it runs (and whether that was automatic), when it fails.
//
// What a caller can do:
//   startWorkflow({ user, workflowId, name, actions }) → the workflow, as far as it got
//   decide({ user, workflowId, step, decision: 'approve' | 'reject', note }) → the workflow after the decision
//   checkApprovalDelays()                               → escalate / expire approvals that waited too long
//   resumeWorkflow({ user, workflowId })                → retry a failed workflow from the failed step
//   getWorkflow(workflowId)                             → { run, actions }
//
// Idempotent: the same workflowId with the same actions returns the existing run;
// each action runs with the idempotency key "<workflowId>:<step>", so a retry,
// a resume or a crash-and-rerun never performs an action twice.
// Automation failure: a failed action stops the workflow at that step — later
// steps never run on top of a failure — and is logged with the reason.
// Limit: one process runs a given workflow at a time (an in-process lock).

import { roleAllowed } from '../lib/roles.js';
import { fingerprint } from '../lib/fingerprint.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { fromRow as systemFromRow } from '../inventory/service.js';
import { classifyAction, DEFAULT_PAYMENT_LIMIT } from './actionRisk.js';
import { runAction, ActionFailedError, AUTOMATION_AGENT } from './executors.js';

export { PermissionDeniedError };
export const START_ROLES = Object.freeze(['process manager', 'operations manager']);
// Who may approve or reject a high-risk action (the student's choice): a process
// manager; once the approval has been escalated, also an operations manager or a
// compliance officer. Never the person who started the workflow.
export const APPROVER_ROLES = Object.freeze(['process manager']);
export const ESCALATED_APPROVER_ROLES = Object.freeze(['process manager', 'operations manager', 'compliance officer']);

export const RUN_STATUSES = Object.freeze(['running', 'awaiting_approval', 'completed', 'failed', 'rejected', 'expired']);

// Approval delays (the student's choice): after ESCALATE_AFTER the approval is
// escalated to more approver roles and a reminder is sent; at the DEADLINE it
// expires as rejected. A waiting high-risk action is never approved by time passing.
const HOUR = 60 * 60 * 1000;
export const ESCALATE_AFTER_MS = 4 * HOUR;
export const DEADLINE_MS = 24 * HOUR;
export const ACTION_STATUSES = Object.freeze(['pending', 'awaiting_approval', 'approved', 'running', 'succeeded', 'failed', 'rejected', 'expired', 'skipped']);

export class WorkflowRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'WorkflowRequestError'; }
}

const list = (values) => values.map((v) => `'${v}'`).join(', ');

export const WORKFLOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id            text PRIMARY KEY CHECK (btrim(id) <> ''),
  name          text NOT NULL CHECK (btrim(name) <> ''),
  requested_by  text NOT NULL,
  status        text NOT NULL CHECK (status IN (${list(RUN_STATUSES)})),
  fingerprint   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_actions (
  run_id                text NOT NULL REFERENCES workflow_runs(id),
  step                  integer NOT NULL CHECK (step >= 1),
  type                  text NOT NULL,
  params                jsonb NOT NULL,
  declared_risk         text,
  irreversible          boolean NOT NULL DEFAULT false,
  status                text NOT NULL CHECK (status IN (${list(ACTION_STATUSES)})),
  risk_level            text CHECK (risk_level IN ('low', 'high')),
  risk_reasons          jsonb,
  attempts              integer NOT NULL DEFAULT 0,
  result                jsonb,
  error                 text,
  approval_requested_at timestamptz,
  deadline_at           timestamptz,
  escalated_at          timestamptz,
  decided_by            text,
  decided_at            timestamptz,
  decision_note         text,
  PRIMARY KEY (run_id, step),
  -- An action cannot wait for approval, be approved or run unattended without a risk level.
  CONSTRAINT classified_before_acting CHECK (status IN ('pending', 'skipped') OR risk_level IS NOT NULL)
);
`;

export async function migrateWorkflows(db) {
  await db.exec(WORKFLOW_SCHEMA_SQL);
}

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const errorText = (err) => `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;

const actionFromRow = (r) => ({
  step: r.step,
  type: r.type,
  params: r.params,
  declaredRisk: r.declared_risk,
  irreversible: r.irreversible,
  status: r.status,
  riskLevel: r.risk_level,
  riskReasons: r.risk_reasons,
  attempts: r.attempts,
  result: r.result,
  error: r.error,
  approvalRequestedAt: iso(r.approval_requested_at),
  deadlineAt: iso(r.deadline_at),
  escalatedAt: iso(r.escalated_at),
  decidedBy: r.decided_by,
  decidedAt: iso(r.decided_at),
  decisionNote: r.decision_note,
});
const runFromRow = (r) => ({
  id: r.id, name: r.name, requestedBy: r.requested_by, status: r.status, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

// What the author wrote for one action, in a fixed shape (also what is fingerprinted).
const normaliseAction = (a) => ({
  type: a.type,
  params: a.params && typeof a.params === 'object' && !Array.isArray(a.params) ? a.params : {},
  declaredRisk: a.declaredRisk ?? null,
  irreversible: a.irreversible === true,
});

export function createWorkflowEngine({
  db, audit, executors = {}, agent = AUTOMATION_AGENT, startRoles = START_ROLES,
  paymentLimit = DEFAULT_PAYMENT_LIMIT, runOptions = {}, now = () => new Date(),
  escalateAfterMs = ESCALATE_AFTER_MS, deadlineMs = DEADLINE_MS,
}) {
  const locks = new Map(); // workflowId → promise of the advance in progress

  const logFor = (workflowId, actor) => (action, fields = {}) => audit.append({ correlationId: workflowId, actor, action, ...fields });

  // One database change with its audit entry written inside the transaction:
  // a failed audit write rolls the change back; a failed commit after the entry
  // was written is followed by a correcting entry.
  async function change(log, fn) {
    const logged = [];
    try {
      return await db.transaction((tx) => fn(tx, (action, fields) => { const e = log(action, fields); logged.push(e); return e; }));
    } catch (err) {
      if (logged.length) {
        log('workflow.change_failed', {
          rationale: `The change(s) logged as ${logged.map((e) => `#${e.seq} (${e.action})`).join(', ')} were NOT saved: ${errorText(err)}`,
        });
      }
      throw err;
    }
  }

  async function getWorkflow(workflowId) {
    const { rows: [run] } = await db.query('SELECT * FROM workflow_runs WHERE id = $1', [workflowId]);
    if (!run) return null;
    const { rows } = await db.query('SELECT * FROM workflow_actions WHERE run_id = $1 ORDER BY step', [workflowId]);
    return { run: runFromRow(run), actions: rows.map(actionFromRow) };
  }

  function authorise(user, allowed, workflowId, what) {
    const correlationId = isNonEmpty(workflowId) ? workflowId : 'invalid-request';
    if (!isNonEmpty(user?.id)) {
      const why = 'No user was given; workflows need to know who is asking.';
      audit.append({ correlationId, actor: { type: 'system', id: 'unknown-requester' }, action: 'workflow.denied', rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    const actor = { type: 'person', id: user.id };
    if (!roleAllowed(user.role, allowed)) {
      const why = `Role "${user.role ?? 'none'}" may not ${what}; allowed roles: ${allowed.join(', ')}.`;
      audit.append({ correlationId, actor, action: 'workflow.denied', rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    return actor;
  }

  // ---------------------------------------------------------------------------

  async function startWorkflow({ user, workflowId, name, actions } = {}) {
    const actor = authorise(user, startRoles, workflowId, 'start workflows');
    const log = logFor(isNonEmpty(workflowId) ? workflowId : 'invalid-request', actor);

    const bad = !isNonEmpty(workflowId) ? 'workflowId must be a non-empty string'
      : !isNonEmpty(name) ? 'name must be a non-empty string'
        : !Array.isArray(actions) || actions.length === 0 ? 'actions must be a non-empty list'
          : actions.findIndex((a) => !a || typeof a !== 'object' || !isNonEmpty(a.type)) >= 0
            ? `action ${actions.findIndex((a) => !a || typeof a !== 'object' || !isNonEmpty(a.type)) + 1} has no type` : null;
    if (bad) {
      log('workflow.rejected', { rationale: bad });
      throw new WorkflowRequestError(`Workflow rejected: ${bad}`);
    }

    const steps = actions.map(normaliseAction);
    const fp = fingerprint({ name, steps });
    const existing = await getWorkflow(workflowId);
    if (existing) {
      const { rows: [r] } = await db.query('SELECT fingerprint FROM workflow_runs WHERE id = $1', [workflowId]);
      if (r.fingerprint !== fp) {
        const why = 'This workflow id was already used with different actions; use a new id.';
        log('workflow.rejected', { rationale: why });
        throw new WorkflowRequestError(`Workflow ${workflowId} rejected: ${why}`);
      }
      log('workflow.replayed', { rationale: `Already started (status ${existing.run.status}); returning it without starting again.` });
      return existing;
    }

    try {
      await change(log, async (tx, logChange) => {
        await tx.query('INSERT INTO workflow_runs (id, name, requested_by, status, fingerprint) VALUES ($1, $2, $3, $4, $5)',
          [workflowId, name.trim(), user.id, 'running', fp]);
        for (const [i, s] of steps.entries()) {
          await tx.query(
            'INSERT INTO workflow_actions (run_id, step, type, params, declared_risk, irreversible, status) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)',
            [workflowId, i + 1, s.type, JSON.stringify(s.params), s.declaredRisk, s.irreversible, 'pending'],
          );
        }
        logChange('workflow.started', { detail: { name: name.trim(), steps: steps.map((s, i) => ({ step: i + 1, type: s.type })) } });
      });
    } catch (err) {
      // The same id was started by someone else between our check and our insert:
      // look again, which replays it (or refuses it if the actions differ).
      if (err?.code === '23505') return startWorkflow({ user, workflowId, name, actions });
      throw err;
    }
    return advance(workflowId);
  }

  async function resumeWorkflow({ user, workflowId } = {}) {
    const actor = authorise(user, startRoles, workflowId, 'resume workflows');
    const log = logFor(workflowId, actor);
    const wf = await getWorkflow(workflowId);
    if (!wf || wf.run.status !== 'failed') {
      const why = !wf ? 'no such workflow' : `only a failed workflow can be resumed (this one is ${wf.run.status})`;
      log('workflow.rejected', { rationale: why });
      throw new WorkflowRequestError(`Workflow ${workflowId} not resumed: ${why}`);
    }
    const failed = wf.actions.find((a) => a.status === 'failed');
    await change(log, async (tx, logChange) => {
      // Back to pending: it is classified again, because the risk may have changed meanwhile.
      await tx.query("UPDATE workflow_actions SET status = 'pending', risk_level = NULL, risk_reasons = NULL, error = NULL WHERE run_id = $1 AND step = $2", [workflowId, failed.step]);
      await tx.query("UPDATE workflow_runs SET status = 'running', updated_at = now() WHERE id = $1", [workflowId]);
      logChange('workflow.resumed', { detail: { step: failed.step, type: failed.type, previousError: failed.error } });
    });
    return advance(workflowId);
  }

  // ---------------------------------------------------------------------------
  // A person approves or rejects the high-risk action a workflow is waiting on.
  //   approve → the action runs, and the workflow carries on to its next step
  //   reject  → the action and every step after it are not run; the workflow stops
  // Deciding the same way again changes nothing; a different decision on a step
  // already decided is refused.

  async function decide({ user, workflowId, step, decision, note = null } = {}) {
    const correlationId = isNonEmpty(workflowId) ? workflowId : 'invalid-request';
    if (!isNonEmpty(user?.id)) authorise(user, ESCALATED_APPROVER_ROLES, workflowId, 'decide on high-risk actions'); // logs and throws
    const actor = { type: 'person', id: user.id };
    const log = logFor(correlationId, actor);
    const refuse = (why, detail = {}) => {
      log('workflow.decision_refused', { subject: Number.isInteger(step) ? `step ${step}` : null, rationale: why, detail: { decision: decision ?? null, ...detail } });
      return new WorkflowRequestError(`Decision refused: ${why}`);
    };
    if (decision !== 'approve' && decision !== 'reject') throw refuse('decision must be "approve" or "reject"');

    const outcome = await change(log, async (tx, logChange) => {
      const { rows: [run] } = await tx.query('SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE', [workflowId]);
      const { rows: [row] } = run ? await tx.query('SELECT * FROM workflow_actions WHERE run_id = $1 AND step = $2', [workflowId, step]) : { rows: [] };
      if (!row) throw refuse(run ? `workflow ${workflowId} has no step ${step}` : `there is no workflow ${workflowId}`);
      const action = actionFromRow(row);
      const about = { step: action.step, type: action.type, riskLevel: action.riskLevel };

      // Already decided? The same decision again is a harmless repeat.
      const earlier = action.status === 'rejected' ? 'reject'
        : action.decidedBy && ['approved', 'running', 'succeeded', 'failed'].includes(action.status) ? 'approve' : null;
      if (earlier) {
        if (earlier === decision && action.decidedBy === user.id) {
          log('workflow.decision_unchanged', { subject: `step ${step}`, rationale: `Already ${decision === 'approve' ? 'approved' : 'rejected'} by ${user.id}; nothing changed.`, detail: about });
          return 'unchanged';
        }
        throw refuse(`step ${step} was already ${earlier === 'approve' ? 'approved' : 'rejected'} by ${action.decidedBy}`, about);
      }
      if (action.status !== 'awaiting_approval') throw refuse(`step ${step} is not waiting for approval (it is ${action.status})`, about);

      // Too late? The sweep may not have run yet; expire it now, then refuse below.
      if (action.deadlineAt && now().getTime() >= Date.parse(action.deadlineAt)) {
        await expireInTx(tx, logChange, workflowId, action);
        return 'expired';
      }

      // May THIS person decide it?
      const allowed = action.escalatedAt ? ESCALATED_APPROVER_ROLES : APPROVER_ROLES;
      if (!roleAllowed(user.role, allowed)) {
        log('workflow.denied', {
          subject: `step ${step}`,
          rationale: `Role "${user.role ?? 'none'}" may not decide this action${action.escalatedAt ? '' : ' before it is escalated'}; allowed roles: ${allowed.join(', ')}.`,
          detail: { attempted: decision, ...about },
        });
        throw new PermissionDeniedError(`Role "${user.role ?? 'none'}" may not decide step ${step} of ${workflowId}.`);
      }
      if (user.id === run.requested_by) throw refuse('the person who started a workflow may not decide its high-risk actions', about);

      const fields = { subject: `step ${step}`, rationale: note, detail: { ...about, escalated: Boolean(action.escalatedAt) } };
      if (decision === 'approve') {
        await tx.query("UPDATE workflow_actions SET status = 'approved', decided_by = $3, decided_at = now(), decision_note = $4 WHERE run_id = $1 AND step = $2",
          [workflowId, step, user.id, note]);
        await tx.query("UPDATE workflow_runs SET status = 'running', updated_at = now() WHERE id = $1", [workflowId]);
        logChange('workflow.action_approved', fields);
        return 'approved';
      }
      await tx.query("UPDATE workflow_actions SET status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4 WHERE run_id = $1 AND step = $2",
        [workflowId, step, user.id, note]);
      const { rows: skipped } = await tx.query("UPDATE workflow_actions SET status = 'skipped' WHERE run_id = $1 AND step > $2 AND status = 'pending' RETURNING step", [workflowId, step]);
      await tx.query("UPDATE workflow_runs SET status = 'rejected', updated_at = now() WHERE id = $1", [workflowId]);
      logChange('workflow.action_rejected', fields);
      logChange('workflow.stopped', {
        rationale: `Step ${step} was rejected; ${skipped.length} later step(s) were not run.`,
        detail: { reason: 'rejected', step, skippedSteps: skipped.map((r) => r.step).sort((a, b) => a - b) },
      });
      return 'rejected';
    });

    if (outcome === 'expired') throw refuse(`step ${step} passed its approval deadline and has expired; start the workflow again if it is still needed`);
    return outcome === 'approved' ? advance(workflowId) : getWorkflow(workflowId);
  }

  // ---------------------------------------------------------------------------
  // Approval delays. checkApprovalDelays() is what a scheduler runs every few
  // minutes. For each action waiting for approval:
  //   past its deadline              → expire it (as rejected); later steps are skipped
  //   waiting longer than escalation → escalate it (more roles may decide) and send a reminder
  // Each happens once, however often the sweep runs.

  async function checkApprovalDelays() {
    const log = (workflowId) => logFor(workflowId, { type: 'agent', id: agent.id });
    const { rows } = await db.query("SELECT * FROM workflow_actions WHERE status = 'awaiting_approval' ORDER BY run_id, step");
    const t = now().getTime();
    const outcome = { escalated: [], expired: [] };

    for (const row of rows.map((r) => ({ runId: r.run_id, ...actionFromRow(r) }))) {
      const id = `${row.runId}:${row.step}`;
      if (t >= Date.parse(row.deadlineAt)) {
        const done = await change(log(row.runId), async (tx, logChange) => {
          const fresh = await lockedAction(tx, row.runId, row.step);
          if (fresh?.status !== 'awaiting_approval') return false; // decided meanwhile
          await expireInTx(tx, logChange, row.runId, fresh);
          return true;
        });
        if (done) outcome.expired.push(id);
      } else if (!row.escalatedAt && t >= Date.parse(row.approvalRequestedAt) + escalateAfterMs) {
        const done = await change(log(row.runId), async (tx, logChange) => {
          const fresh = await lockedAction(tx, row.runId, row.step);
          if (fresh?.status !== 'awaiting_approval' || fresh.escalatedAt) return false;
          await tx.query('UPDATE workflow_actions SET escalated_at = $3 WHERE run_id = $1 AND step = $2', [row.runId, row.step, new Date(t).toISOString()]);
          logChange('workflow.approval_escalated', {
            subject: `step ${row.step}`,
            rationale: `Waiting ${waited(fresh, t)} for approval; now ${ESCALATED_APPROVER_ROLES.join(', ')} may decide. It expires at ${fresh.deadlineAt}.`,
            detail: { step: row.step, type: fresh.type, riskLevel: fresh.riskLevel, waitedMs: t - Date.parse(fresh.approvalRequestedAt), deadlineAt: fresh.deadlineAt },
          });
          return true;
        });
        if (done) {
          outcome.escalated.push(id);
          await sendReminder(row, log(row.runId));
        }
      }
    }
    return outcome;
  }

  async function lockedAction(tx, workflowId, step) {
    await tx.query('SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE', [workflowId]);
    const { rows: [row] } = await tx.query('SELECT * FROM workflow_actions WHERE run_id = $1 AND step = $2', [workflowId, step]);
    return row ? actionFromRow(row) : null;
  }

  const waited = (action, t) => `${Math.round((t - Date.parse(action.approvalRequestedAt)) / 60000)} min`;

  // Expires a waiting action as rejected and stops its workflow. Inside a transaction.
  async function expireInTx(tx, logChange, workflowId, action) {
    const t = now().getTime();
    await tx.query("UPDATE workflow_actions SET status = 'expired' WHERE run_id = $1 AND step = $2", [workflowId, action.step]);
    const { rows: skipped } = await tx.query("UPDATE workflow_actions SET status = 'skipped' WHERE run_id = $1 AND step > $2 AND status = 'pending' RETURNING step", [workflowId, action.step]);
    await tx.query("UPDATE workflow_runs SET status = 'expired', updated_at = now() WHERE id = $1", [workflowId]);
    logChange('workflow.approval_expired', {
      subject: `step ${action.step}`,
      rationale: `Nobody decided within the deadline (waited ${waited(action, t)}); treated as rejected — it was not run.`,
      detail: { step: action.step, type: action.type, riskLevel: action.riskLevel, waitedMs: t - Date.parse(action.approvalRequestedAt) },
    });
    logChange('workflow.stopped', {
      rationale: `Step ${action.step} expired without a decision; ${skipped.length} later step(s) were not run.`,
      detail: { reason: 'expired', step: action.step, skippedSteps: skipped.map((r) => r.step).sort((a, b) => a - b) },
    });
  }

  // The reminder is best-effort: the escalation stands even if it cannot be sent,
  // and a failure to send it is logged, never swallowed.
  async function sendReminder(action, log) {
    const params = { to: ESCALATED_APPROVER_ROLES, subject: `Approval needed: ${action.runId} step ${action.step} (${action.type}, ${action.riskLevel} risk)`, deadlineAt: action.deadlineAt };
    try {
      await runAction(executors.notify, params, { idempotencyKey: `${action.runId}:${action.step}:escalation`, ...runOptions });
      log('workflow.reminder_sent', { subject: `step ${action.step}`, detail: { step: action.step, riskLevel: action.riskLevel, to: params.to } });
    } catch (err) {
      if (!(err instanceof ActionFailedError)) throw err;
      log('workflow.reminder_failed', { subject: `step ${action.step}`, rationale: err.message, detail: { step: action.step, riskLevel: action.riskLevel } });
    }
  }

  // ---------------------------------------------------------------------------
  // Moves a workflow forward as far as it can go without a person. One at a time
  // per workflow, so two callers cannot both run the same step.

  function advance(workflowId) {
    const previous = locks.get(workflowId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => advanceNow(workflowId));
    locks.set(workflowId, next);
    const release = () => { if (locks.get(workflowId) === next) locks.delete(workflowId); };
    next.then(release, release);
    return next;
  }

  async function advanceNow(workflowId) {
    const log = logFor(workflowId, { type: 'agent', id: agent.id });
    for (;;) {
      const wf = await getWorkflow(workflowId);
      if (wf.run.status !== 'running') return wf;
      const action = wf.actions.find((a) => ['pending', 'approved', 'running'].includes(a.status));
      if (!action) {
        await change(log, async (tx, logChange) => {
          await tx.query("UPDATE workflow_runs SET status = 'completed', updated_at = now() WHERE id = $1", [workflowId]);
          logChange('workflow.completed', { detail: { steps: wf.actions.length } });
        });
        return getWorkflow(workflowId);
      }

      if (action.status === 'pending') {
        const decided = await classify(workflowId, action, log);
        if (decided.riskLevel === 'high') return getWorkflow(workflowId);
        await execute(workflowId, decided, log);
      } else {
        // 'approved', or 'running' left behind by a crash: the idempotency key makes re-running safe.
        await execute(workflowId, action, log);
      }
    }
  }

  async function classify(workflowId, action, log) {
    const params = { ...action.params };
    let system;
    if (params.systemId !== undefined) {
      const { rows: [row] } = await db.query('SELECT * FROM ai_systems WHERE id = $1', [params.systemId]);
      system = row ? systemFromRow(row) : undefined;
      // Pin the version the decision was made on: if the system changes before the
      // action runs, the inventory refuses it instead of acting on stale information.
      if (action.type === 'inventory.update_status' && system && params.expectedVersion === undefined) params.expectedVersion = system.version;
    }
    // The database stores "not declared" as null; the classifier expects undefined.
    const { level, reasons } = classifyAction(
      { type: action.type, params, irreversible: action.irreversible, declaredRisk: action.declaredRisk ?? undefined },
      { system, paymentLimit },
    );
    const at = now();

    await change(log, async (tx, logChange) => {
      const high = level === 'high';
      await tx.query(
        `UPDATE workflow_actions SET params = $3::jsonb, risk_level = $4, risk_reasons = $5::jsonb, status = $6,
           approval_requested_at = $7, deadline_at = $8 WHERE run_id = $1 AND step = $2`,
        [workflowId, action.step, JSON.stringify(params), level, JSON.stringify(reasons), high ? 'awaiting_approval' : 'pending',
          high ? at.toISOString() : null, high ? new Date(at.getTime() + deadlineMs).toISOString() : null],
      );
      logChange('workflow.action_classified', { subject: `step ${action.step}`, detail: { step: action.step, type: action.type, riskLevel: level, reasons } });
      if (high) {
        await tx.query("UPDATE workflow_runs SET status = 'awaiting_approval', updated_at = now() WHERE id = $1", [workflowId]);
        logChange('workflow.approval_requested', {
          subject: `step ${action.step}`,
          rationale: 'High-risk action: it will not run until a person approves it.',
          detail: { step: action.step, type: action.type, riskLevel: level },
        });
      }
    });
    return { ...action, params, riskLevel: level, riskReasons: reasons };
  }

  async function execute(workflowId, action, log) {
    const automatic = action.riskLevel === 'low';
    const about = { step: action.step, type: action.type, riskLevel: action.riskLevel, automatic, approvedBy: action.decidedBy ?? null };
    await change(log, async (tx, logChange) => {
      await tx.query("UPDATE workflow_actions SET status = 'running' WHERE run_id = $1 AND step = $2", [workflowId, action.step]);
      logChange('workflow.action_started', { subject: `step ${action.step}`, detail: about });
    });

    let outcome;
    try {
      outcome = await runAction(executors[action.type], action.params, { idempotencyKey: `${workflowId}:${action.step}`, ...runOptions });
    } catch (err) {
      if (!(err instanceof ActionFailedError)) throw err;
      await change(log, async (tx, logChange) => {
        await tx.query("UPDATE workflow_actions SET status = 'failed', error = $3, attempts = attempts + $4 WHERE run_id = $1 AND step = $2",
          [workflowId, action.step, err.message, err.attempts ?? 0]);
        await tx.query("UPDATE workflow_runs SET status = 'failed', updated_at = now() WHERE id = $1", [workflowId]);
        logChange('workflow.action_failed', { subject: `step ${action.step}`, rationale: err.message, detail: { ...about, attempts: err.attempts ?? 0 } });
        logChange('workflow.failed', { rationale: `Stopped at step ${action.step}; later steps were not run. Resume to retry it.` });
      });
      return;
    }

    await change(log, async (tx, logChange) => {
      await tx.query("UPDATE workflow_actions SET status = 'succeeded', result = $3::jsonb, attempts = attempts + $4 WHERE run_id = $1 AND step = $2",
        [workflowId, action.step, JSON.stringify(outcome.result ?? null), outcome.attempts]);
      logChange('workflow.action_executed', { subject: `step ${action.step}`, detail: { ...about, attempts: outcome.attempts, result: outcome.result ?? null } });
    });
  }

  return { startWorkflow, resumeWorkflow, decide, checkApprovalDelays, getWorkflow, advance };
}
