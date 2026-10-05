// The AI system inventory (STORY-004, REQ-006): every AI system in the
// organisation with its department, purpose, risk, owner and status, kept in
// PostgreSQL (db.js). What a caller can do:
//
//   listSystems({ user })                     → { systems, inconsistencies }  — view the inventory
//   registerSystem({ user, system })          → { system, created }           — add a system
//   updateStatus({ user, systemId, status, expectedVersion, reason }) → { system, changed }
//   systemsForAssessment({ user })            → the inventory as STORY-003 risk-assessment input
//   recordRiskAssessment({ user, result })    → { recorded, unchanged, skipped } — fill the risk field
//
// Who may do what (the student's choice): the IT manager registers and updates;
// the IT manager, compliance officer, security officer and operations manager may
// view. Anyone else — or a request with no user — is refused and the refusal logged.
//
// Every view and every change is written to the audit log (REQ-008) with the
// user as actor. A change is logged INSIDE its database transaction, before the
// commit: if the audit write fails the change is rolled back (no unrecorded
// change), and if the commit fails after the entry was written, an
// "inventory.change_failed" entry follows it so the log never claims a change
// that did not happen.
//
// Idempotent: registering the same system twice, or setting a status it already
// has, changes nothing and says so. Data inconsistency is refused, not merged:
//   - an id reused with different details              → InventoryConflictError
//   - a status change based on an out-of-date read      → InventoryConflictError
//     (expectedVersion must match; re-read and decide again)
//   - a stored row that breaks the rules (e.g. a table created without the
//     constraints) is shown in `inconsistencies`, never silently dropped.
// Limit: identity is whatever the caller says it is — there is no login yet.

import { roleAllowed } from '../lib/roles.js';
import { fingerprint } from '../lib/fingerprint.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { validateSystems, SYSTEM_STATUSES } from '../risk/systemData.js';
import { RISK_ROLES } from '../risk/service.js';
import { DatabaseUnavailableError, RISK_LEVELS } from './db.js';

export { PermissionDeniedError };
export const EDIT_ROLES = Object.freeze(['IT manager']);
export const VIEW_ROLES = Object.freeze(['IT manager', 'compliance officer', 'security officer', 'operations manager']);
// Recording a finished risk assessment copies its result; it is not a hand edit,
// so the roles that may run assessments may record them, as may the IT manager.
export const RECORD_RISK_ROLES = Object.freeze(['IT manager', ...RISK_ROLES]);

export class InventoryRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'InventoryRequestError'; }
}
export class InventoryConflictError extends Error {
  constructor(message, options) { super(message, options); this.name = 'InventoryConflictError'; }
}
export class SystemNotFoundError extends Error {
  constructor(message, options) { super(message, options); this.name = 'SystemNotFoundError'; }
}

const UNKNOWN_REQUESTER = { type: 'system', id: 'unknown-requester' };
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const UNIQUE_VIOLATION = '23505';

// A database row as the rest of the code sees it.
export const fromRow = (r) => ({
  id: r.id,
  name: r.name,
  department: r.department,
  purpose: r.purpose,
  owner: r.owner,
  status: r.status,
  riskLevel: r.risk_level,
  riskAssessmentId: r.risk_assessment_id,
  riskAssessedAt: iso(r.risk_assessed_at),
  dataCategories: r.data_categories,
  decisionImpact: r.decision_impact,
  humanOversight: r.human_oversight,
  userFacing: r.user_facing,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

// The fields a person registers. Two registrations are "the same system" when these match.
const registeredFields = (s) => ({
  id: s.id, name: s.name, department: s.department, purpose: s.purpose, owner: s.owner, status: s.status,
  dataCategories: s.dataCategories, decisionImpact: s.decisionImpact, humanOversight: s.humanOversight, userFacing: s.userFacing,
});

export function createInventoryService({
  db, audit, editRoles = EDIT_ROLES, viewRoles = VIEW_ROLES, recordRiskRoles = RECORD_RISK_ROLES,
}) {
  // ---- Who is asking, and may they? Logs the request and any refusal. ----
  function authorise(user, allowed, { correlationId, action, subject }) {
    if (!isNonEmpty(user?.id)) {
      const why = 'No user was given; the inventory needs to know who is asking.';
      audit.append({ correlationId, actor: UNKNOWN_REQUESTER, action: 'inventory.denied', subject, rationale: why, detail: { attempted: action } });
      throw new PermissionDeniedError(why);
    }
    const actor = { type: 'person', id: user.id };
    if (!roleAllowed(user.role, allowed)) {
      const why = `Role "${user.role ?? 'none'}" may not ${action}; allowed roles: ${allowed.join(', ')}.`;
      audit.append({ correlationId, actor, action: 'inventory.denied', subject, rationale: why, detail: { attempted: action } });
      throw new PermissionDeniedError(why);
    }
    return actor;
  }

  // A database that cannot be reached is logged, then reported to the caller.
  async function guarded(log, attempted, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) log('inventory.db_unavailable', { rationale: err.message, detail: { attempted } });
      throw err;
    }
  }

  // Runs one change: the audit entry is written inside the transaction, and a
  // commit that fails after it is followed by a correcting entry.
  async function change(log, fn) {
    const logged = [];
    const logChange = (action, fields) => { const entry = log(action, fields); logged.push(entry); return entry; };
    try {
      return await db.transaction((tx) => fn(tx, logChange));
    } catch (err) {
      if (logged.length) {
        log('inventory.change_failed', {
          subject: logged.length === 1 ? logged[0].subject : null,
          rationale: `The change(s) logged as ${logged.map((e) => `#${e.seq} (${e.action})`).join(', ')} were NOT saved: ${err?.name ?? 'Error'}: ${err?.message ?? err}`,
        });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------

  async function listSystems({ user, requestId = 'inventory' } = {}) {
    const actor = authorise(user, viewRoles, { correlationId: requestId, action: 'view the AI system inventory' });
    const log = (action, fields = {}) => audit.append({ correlationId: requestId, actor, action, ...fields });

    const { rows } = await guarded(log, 'view', () => db.query('SELECT * FROM ai_systems ORDER BY lower(name), id'));
    const systems = rows.map(fromRow);

    // Re-check every stored row against the same rules registration uses.
    const check = validateSystems(systems.map(registeredFields));
    const inconsistencies = check.incomplete.map((p) => ({ systemId: p.systemId, problems: p.problems }));
    for (const s of systems) {
      if (!RISK_LEVELS.includes(s.riskLevel)) inconsistencies.push({ systemId: s.id, problems: [{ field: 'riskLevel', problem: `has unknown value ${JSON.stringify(s.riskLevel)}` }] });
    }

    log('inventory.viewed', { detail: { systems: systems.length, inconsistencies: inconsistencies.length } });
    return { systems, inconsistencies };
  }

  async function registerSystem({ user, system, reason = null, requestId } = {}) {
    const correlationId = requestId ?? `inventory:${isNonEmpty(system?.id) ? system.id.trim() : 'new'}`;
    const actor = authorise(user, editRoles, { correlationId, action: 'register AI systems', subject: system?.id ?? null });
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, ...fields });

    const check = validateSystems([system]);
    if (!check.ok) {
      const problems = check.incomplete[0]?.problems ?? [];
      const what = problems.map((p) => (p.field ? `"${p.field}" ${p.problem}` : p.problem)).join('; ');
      log('inventory.register_rejected', { subject: system?.id ?? null, rationale: 'Incomplete or invalid system data.', detail: { problems } });
      const label = isNonEmpty(system?.name) ? system.name : isNonEmpty(system?.id) ? system.id : null;
      throw new InventoryRequestError(`AI system${label ? ` "${label}"` : ''} was not registered because its data is incomplete or invalid: ${what}.`);
    }
    const wanted = check.systems[0];

    const attempt = () => change(log, async (tx, logChange) => {
      const { rows: [existing] } = await tx.query('SELECT * FROM ai_systems WHERE id = $1 FOR UPDATE', [wanted.id]);
      if (existing) {
        const current = fromRow(existing);
        if (fingerprint(registeredFields(current)) !== fingerprint(registeredFields(wanted))) {
          log('inventory.register_conflict', { subject: wanted.id, rationale: 'This id is already registered with different details; update the system instead, or use a new id.' });
          throw new InventoryConflictError(`AI system ${wanted.id} is already registered with different details.`);
        }
        log('inventory.register_unchanged', { subject: wanted.id, rationale: 'Already registered with exactly these details; nothing changed.' });
        return { system: current, created: false };
      }
      const { rows: [inserted] } = await tx.query(
        `INSERT INTO ai_systems (id, name, department, purpose, owner, status, data_categories, decision_impact, human_oversight, user_facing)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [wanted.id, wanted.name, wanted.department, wanted.purpose, wanted.owner, wanted.status,
          wanted.dataCategories, wanted.decisionImpact, wanted.humanOversight, wanted.userFacing],
      );
      const created = fromRow(inserted);
      logChange('inventory.registered', { subject: created.id, rationale: reason, detail: { after: created } });
      return { system: created, created: true };
    });

    return guarded(log, 'register', async () => {
      try {
        return await attempt();
      } catch (err) {
        // Someone registered the same id between our read and our insert: look again, once.
        if (err?.code === UNIQUE_VIOLATION) return attempt();
        throw err;
      }
    });
  }

  async function updateStatus({ user, systemId, status, expectedVersion, reason = null, requestId } = {}) {
    const correlationId = requestId ?? `inventory:${isNonEmpty(systemId) ? systemId : 'unknown'}`;
    const actor = authorise(user, editRoles, { correlationId, action: 'change AI system status', subject: systemId ?? null });
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, ...fields });

    const bad = !isNonEmpty(systemId) ? 'systemId is required'
      : !SYSTEM_STATUSES.includes(status) ? `status must be one of: ${SYSTEM_STATUSES.join(', ')}`
        : !Number.isInteger(expectedVersion) ? 'expectedVersion is required: the version of the system you last read' : null;
    if (bad) {
      log('inventory.update_rejected', { subject: systemId ?? null, rationale: bad, detail: { status: status ?? null } });
      throw new InventoryRequestError(`Status change rejected: ${bad}`);
    }

    return guarded(log, 'update status', () => change(log, async (tx, logChange) => {
      const { rows: [row] } = await tx.query('SELECT * FROM ai_systems WHERE id = $1 FOR UPDATE', [systemId]);
      if (!row) {
        log('inventory.update_rejected', { subject: systemId, rationale: 'No AI system with this id is registered.' });
        throw new SystemNotFoundError(`No AI system with id ${systemId} is registered.`);
      }
      const current = fromRow(row);

      // Already in the wanted state: a retry of a change that landed, or a no-op. Nothing to do.
      if (current.status === status) {
        log('inventory.status_unchanged', { subject: systemId, rationale: `Already ${status}; nothing changed.`, detail: { version: current.version } });
        return { system: current, changed: false };
      }
      if (current.version !== expectedVersion) {
        const why = `The system changed since it was read (you read version ${expectedVersion}, it is now version ${current.version}, status ${current.status}). Re-read it and decide again.`;
        log('inventory.update_conflict', { subject: systemId, rationale: why, detail: { expectedVersion, actualVersion: current.version, wanted: status } });
        throw new InventoryConflictError(why);
      }

      const { rows: [updated] } = await tx.query(
        'UPDATE ai_systems SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 AND version = $3 RETURNING *',
        [systemId, status, expectedVersion],
      );
      const after = fromRow(updated);
      logChange('inventory.status_changed', {
        subject: systemId,
        rationale: reason,
        detail: { from: current.status, to: after.status, version: after.version },
      });
      return { system: after, changed: true };
    }));
  }

  // ---------------------------------------------------------------------------
  // The link to risk assessment (STORY-003).

  // The inventory in exactly the shape the risk assessment takes as input, so an
  // assessment runs against what is registered. Reading it is a logged view.
  async function systemsForAssessment({ user, requestId } = {}) {
    const { systems } = await listSystems({ user, requestId });
    return systems.map(registeredFields);
  }

  // Copies each assessed system's overall rating from a COMPLETED risk assessment
  // into the inventory's risk field, with the assessment id and time. All in one
  // transaction: either every rating in the assessment is recorded, or none.
  // A system is left alone, and the reason reported, when
  //   - it is no longer in the inventory,
  //   - a newer assessment is already recorded for it, or
  //   - it was changed after it was assessed (the rating may no longer fit it).
  // Recording the same assessment again changes nothing.
  async function recordRiskAssessment({ user, result, requestId } = {}) {
    const report = result?.report;
    const assessmentId = isNonEmpty(report?.assessmentId) ? report.assessmentId : null;
    const correlationId = requestId ?? `inventory:risk:${assessmentId ?? 'unknown'}`;
    const actor = authorise(user, recordRiskRoles, { correlationId, action: 'record risk assessments in the inventory', subject: assessmentId });
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, ...fields });

    const assessedAt = Date.parse(report?.assessedAt ?? '');
    const bad = result?.status !== 'completed' ? `only a completed risk assessment can be recorded (this one is "${result?.status ?? 'missing'}")`
      : !assessmentId ? 'the assessment has no id'
        : Number.isNaN(assessedAt) ? 'the assessment has no valid assessedAt time'
          : !Array.isArray(report.systems) ? 'the assessment lists no systems' : null;
    if (bad) {
      log('inventory.risk_rejected', { subject: assessmentId, rationale: bad });
      throw new InventoryRequestError(`Risk assessment not recorded: ${bad}`);
    }

    return guarded(log, 'record risk', () => change(log, async (tx, logChange) => {
      const outcome = { assessmentId, recorded: [], unchanged: [], skipped: [] };
      for (const assessed of report.systems) {
        const { rows: [row] } = await tx.query('SELECT * FROM ai_systems WHERE id = $1 FOR UPDATE', [assessed.systemId]);
        const skip = (reason) => outcome.skipped.push({ systemId: assessed.systemId, reason });
        if (!row) { skip('it is not in the inventory'); continue; }
        const current = fromRow(row);
        if (current.riskAssessmentId === assessmentId) { outcome.unchanged.push(current.id); continue; }
        if (current.riskAssessedAt && Date.parse(current.riskAssessedAt) > assessedAt) {
          skip(`a newer assessment (${current.riskAssessmentId}) is already recorded`);
          continue;
        }
        if (Date.parse(current.updatedAt) > assessedAt) { skip('it was changed after it was assessed; assess it again'); continue; }

        const { rows: [updated] } = await tx.query(
          `UPDATE ai_systems SET risk_level = $2, risk_assessment_id = $3, risk_assessed_at = $4, version = version + 1, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [current.id, assessed.riskLevel, assessmentId, new Date(assessedAt).toISOString()],
        );
        const after = fromRow(updated);
        logChange('inventory.risk_recorded', {
          subject: current.id,
          detail: { from: current.riskLevel, to: after.riskLevel, assessmentId, version: after.version },
        });
        outcome.recorded.push(current.id);
      }
      log('inventory.risk_assessment_recorded', {
        subject: assessmentId,
        detail: { recorded: outcome.recorded.length, unchanged: outcome.unchanged.length, skipped: outcome.skipped },
      });
      return outcome;
    }));
  }

  return { listSystems, registerSystem, updateStatus, systemsForAssessment, recordRiskAssessment };
}
