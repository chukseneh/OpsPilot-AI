// Configuring governance controls per jurisdiction (STORY-009, REQ-015).
//
//   proposePolicy({ user, policy, effectiveFrom, reason })        → the proposed version
//   approveProposal({ user, jurisdiction, version, note })        → the approved version
//   rejectProposal({ user, jurisdiction, version, note })         → the rejected version
//   getActivePolicy({ jurisdiction, at })                         → the policy in force (or null); internal, unchecked
//   viewActivePolicy({ user, jurisdiction })                      → the same, for people: any project role, logged
//   listVersions({ user, jurisdiction })                          → every version, newest first
//   checkReviewDates()                                            → policies whose review date has passed
//
// Two-person rule (the student's choice): a compliance officer proposes; a
// DIFFERENT compliance or security officer approves or rejects. Nobody approves
// their own proposal — the database refuses it too. Anyone else is refused.
//
// Misconfiguration: a proposal with any error alert (policy.js) is refused and
// the alerts returned to the user (PolicyMisconfiguredError); warnings are kept
// with the version and shown wherever it is used. It is checked again at approval.
//
// Regulatory updates: every change is a new VERSION; old versions are never
// changed or deleted. A version takes effect from its effectiveFrom date — the
// policy in force is the approved version with the latest effectiveFrom not in
// the future, so a dated update switches over by itself. When a version's
// reviewBy date passes, checkReviewDates() alerts once that its rules may be out of date.
//
// Trust: every proposal, approval, rejection and refusal is in the audit log with
// its reason and the DIFF against the version in force (each setting, from → to).

import { fingerprint, stableJson } from '../lib/fingerprint.js';
import { roleAllowed, PROJECT_ROLES } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { validatePolicy } from './policy.js';

export { PermissionDeniedError };
export const PROPOSER_ROLES = Object.freeze(['compliance officer']);
export const APPROVER_ROLES = Object.freeze(['compliance officer', 'security officer']);
// Who may read the policy in force (web access): everyone works under it.
export const POLICY_READER_ROLES = PROJECT_ROLES;

export class PolicyMisconfiguredError extends Error {
  constructor(alerts) {
    const errors = alerts.filter((a) => a.severity === 'error');
    super(`The policy is misconfigured (${errors.length} error(s)): ${errors.map((a) => `${a.control}: ${a.message}`).join('; ')}`);
    this.name = 'PolicyMisconfiguredError';
    this.alerts = alerts;
  }
}
export class GovernanceRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'GovernanceRequestError'; }
}
export class PolicyNotFoundError extends Error {
  constructor(message, options) { super(message, options); this.name = 'PolicyNotFoundError'; }
}

export const GOVERNANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS policy_versions (
  jurisdiction      text NOT NULL,
  version           integer NOT NULL CHECK (version >= 1),
  status            text NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  policy            jsonb NOT NULL,
  alerts            jsonb NOT NULL,
  diff              jsonb NOT NULL,
  effective_from    date NOT NULL,
  reason            text NOT NULL CHECK (btrim(reason) <> ''),
  proposed_by       text NOT NULL,
  proposed_at       timestamptz NOT NULL DEFAULT now(),
  decided_by        text,
  decided_at        timestamptz,
  decision_note     text,
  review_alerted_at timestamptz,
  fingerprint       text NOT NULL,
  PRIMARY KEY (jurisdiction, version),
  CONSTRAINT decided_when_not_proposed CHECK ((status = 'proposed') = (decided_by IS NULL)),
  CONSTRAINT two_person_rule CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
`;
export async function migrateGovernance(db) { await db.exec(GOVERNANCE_SCHEMA_SQL); }

// Every read of a version also returns its effective date AS TEXT ('YYYY-MM-DD').
// The pg driver turns a DATE into a JavaScript Date at LOCAL midnight; converting
// that back with toISOString() gives the day before on a server east of UTC
// (Paris, Tokyo…). Text from the database involves no timezone at all.
const ROW = "*, to_char(effective_from, 'YYYY-MM-DD') AS effective_date";

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const iso = (v) => (v == null ? null : new Date(v).toISOString());
// Today's date for a moment in time. Policy dates are UTC calendar days: a policy
// effective 2026-12-01 applies from 00:00 UTC that day. (Dates READ from the
// database never come through here — see ROW.)
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const fromRow = (r) => ({
  jurisdiction: r.jurisdiction, version: r.version, status: r.status, policy: r.policy, alerts: r.alerts, diff: r.diff,
  effectiveFrom: r.effective_date, reason: r.reason, proposedBy: r.proposed_by, proposedAt: iso(r.proposed_at),
  decidedBy: r.decided_by, decidedAt: iso(r.decided_at), decisionNote: r.decision_note,
});

// Every setting in a policy as path → value, so two versions can be compared.
function flatten(value, path = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  } else out[path] = value;
  return out;
}
// Values are compared with stableJson (keys sorted): a policy read back from
// PostgreSQL's jsonb has its object keys in a different order, and that must not
// show up as a change in the audit trail.
export function diffPolicies(before, after) {
  const a = before ? flatten(before) : {};
  const b = flatten(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter((p) => stableJson(a[p]) !== stableJson(b[p]))
    .map((path) => ({ path, from: a[path] ?? null, to: b[path] ?? null }));
}

export function createGovernanceService({ db, audit, now = () => new Date() }) {
  const today = () => dateOnly(now());
  const log = (correlationId, actor, action, fields = {}) => audit.append({ correlationId, actor, action, ...fields });

  // A change and its audit entry in one transaction. The entry is written before
  // the commit; if the commit then fails, a correcting entry says so, so the log
  // never claims a configuration change that did not happen.
  async function change(correlationId, actor, fn) {
    let logged = null;
    try {
      return await db.transaction((tx) => fn(tx, (action, fields) => { logged = log(correlationId, actor, action, fields); return logged; }));
    } catch (err) {
      if (logged) {
        log(correlationId, actor, 'governance.change_failed', {
          rationale: `The change logged as #${logged.seq} (${logged.action}) was NOT saved: ${err?.name ?? 'Error'}: ${err?.message ?? err}`,
        });
      }
      throw err;
    }
  }

  function authorise(user, roles, correlationId, what) {
    if (!isNonEmpty(user?.id)) {
      const why = 'No user was given; governance configuration is only changed by a known person.';
      log(correlationId, { type: 'system', id: 'unknown-requester' }, 'governance.denied', { rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    const actor = { type: 'person', id: user.id };
    if (!roleAllowed(user.role, roles)) {
      const why = `Role "${user.role ?? 'none'}" may not ${what}; allowed roles: ${roles.join(', ')}.`;
      log(correlationId, actor, 'governance.denied', { rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    return actor;
  }

  async function activeRow(q, jurisdiction, at = today()) {
    const { rows: [r] } = await q.query(
      `SELECT ${ROW} FROM policy_versions WHERE jurisdiction = $1 AND status = 'approved' AND effective_from <= $2::date
       ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [jurisdiction, at],
    );
    return r ?? null;
  }

  // ---------------------------------------------------------------------------

  async function proposePolicy({ user, policy, effectiveFrom, reason } = {}) {
    const code = policy?.jurisdiction?.code ?? 'unknown';
    const correlationId = `governance:${code}`;
    const actor = authorise(user, PROPOSER_ROLES, correlationId, 'propose governance policies');
    const refuse = (why, detail = {}) => {
      log(correlationId, actor, 'governance.proposal_refused', { rationale: why, detail });
      return new GovernanceRequestError(`Proposal refused: ${why}`);
    };

    if (!isNonEmpty(reason)) throw refuse('a reason is required: say why the policy is changing (e.g. which regulatory update)');
    const from = effectiveFrom ?? today();
    if (!isDate(from)) throw refuse(`effectiveFrom must be a date written YYYY-MM-DD (got ${JSON.stringify(effectiveFrom)})`);
    if (from < today()) throw refuse(`effectiveFrom ${from} is in the past; a policy cannot take effect retroactively, because that would rewrite which rules applied`);

    // ---- Misconfiguration: refused, every alert returned and logged ----
    const check = validatePolicy(policy, { today: now() });
    if (!check.ok) {
      log(correlationId, actor, 'governance.proposal_refused', {
        rationale: `Misconfigured: ${check.alerts.filter((a) => a.severity === 'error').map((a) => `${a.control}: ${a.message}`).join('; ')}`,
        detail: { alerts: check.alerts, policy },
      });
      throw new PolicyMisconfiguredError(check.alerts);
    }
    const fp = fingerprint({ policy, effectiveFrom: from });

    const attempt = () => change(correlationId, actor, async (tx, logChange) => {
      // The same proposal still waiting? Return it rather than making a second version.
      const { rows: [pending] } = await tx.query(
        `SELECT ${ROW} FROM policy_versions WHERE jurisdiction = $1 AND status = 'proposed' AND fingerprint = $2`, [code, fp]);
      if (pending) {
        log(correlationId, actor, 'governance.proposal_unchanged', { subject: `${code} v${pending.version}`, rationale: 'This exact proposal is already waiting for approval.' });
        return fromRow(pending);
      }
      const active = await activeRow(tx, code);
      const diff = diffPolicies(active?.policy ?? null, policy);
      const { rows: [{ next }] } = await tx.query('SELECT COALESCE(max(version), 0) + 1 AS next FROM policy_versions WHERE jurisdiction = $1', [code]);
      const { rows: [row] } = await tx.query(
        `INSERT INTO policy_versions (jurisdiction, version, status, policy, alerts, diff, effective_from, reason, proposed_by, fingerprint)
         VALUES ($1, $2, 'proposed', $3::jsonb, $4::jsonb, $5::jsonb, $6::date, $7, $8, $9) RETURNING ${ROW}`,
        [code, next, JSON.stringify(policy), JSON.stringify(check.alerts), JSON.stringify(diff), from, reason.trim(), user.id, fp],
      );
      logChange('governance.proposed', {
        subject: `${code} v${next}`,
        rationale: reason.trim(),
        detail: { jurisdiction: code, version: next, effectiveFrom: from, replaces: active ? active.version : null, diff, warnings: check.alerts },
      });
      return fromRow(row);
    });
    try {
      return await attempt();
    } catch (err) {
      if (err?.code === '23505') return attempt(); // someone else took that version number: number it again
      throw err;
    }
  }

  async function decide(decision, { user, jurisdiction, version, note } = {}) {
    const correlationId = `governance:${jurisdiction ?? 'unknown'}`;
    const actor = authorise(user, APPROVER_ROLES, correlationId, `${decision} governance policies`);
    const refuse = (why) => {
      log(correlationId, actor, 'governance.decision_refused', { subject: `${jurisdiction} v${version}`, rationale: why, detail: { decision } });
      return new GovernanceRequestError(`${decision === 'approve' ? 'Approval' : 'Rejection'} refused: ${why}`);
    };
    if (!isNonEmpty(note)) throw refuse(`a note is required: say why you ${decision} it`);

    return change(correlationId, actor, async (tx, logChange) => {
      const { rows: [row] } = await tx.query(`SELECT ${ROW} FROM policy_versions WHERE jurisdiction = $1 AND version = $2 FOR UPDATE`, [jurisdiction, version]);
      if (!row) throw refuse(`there is no version ${version} for ${jurisdiction}`);
      const done = { approve: 'approved', reject: 'rejected' }[decision];
      if (row.status === done && row.decided_by === user.id) {
        log(correlationId, actor, 'governance.decision_unchanged', { subject: `${jurisdiction} v${version}`, rationale: `Already ${done} by ${user.id}.` });
        return fromRow(row);
      }
      if (row.status !== 'proposed') throw refuse(`version ${version} is not waiting for a decision (it is ${row.status}, by ${row.decided_by})`);
      if (row.proposed_by === user.id) throw refuse('the person who proposed a policy may not decide on it (two-person rule)');

      let alerts = row.alerts;
      if (decision === 'approve') {
        const check = validatePolicy(row.policy, { today: now() }); // the calendar may have moved since it was proposed
        if (!check.ok) throw refuse(`it is no longer valid: ${check.alerts.filter((a) => a.severity === 'error').map((a) => a.message).join('; ')}`);
        alerts = check.alerts;
      }
      const { rows: [updated] } = await tx.query(
        `UPDATE policy_versions SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5, alerts = $6::jsonb
         WHERE jurisdiction = $1 AND version = $2 RETURNING ${ROW}`,
        [jurisdiction, version, done, user.id, note.trim(), JSON.stringify(alerts)],
      );
      logChange(`governance.${done}`, {
        subject: `${jurisdiction} v${version}`,
        rationale: note.trim(),
        detail: { proposedBy: row.proposed_by, effectiveFrom: row.effective_date, diff: row.diff, warnings: alerts },
      });
      return fromRow(updated);
    });
  }

  // The policy in force on a date (default today), with its alerts worked out for
  // that date — so a passed review date shows up wherever the policy is used.
  async function getActivePolicy({ jurisdiction, at } = {}) {
    const r = await activeRow(db, jurisdiction, at ? dateOnly(at) : today());
    if (!r) return null;
    const v = fromRow(r);
    const { alerts } = validatePolicy(v.policy, { today: at ? new Date(at) : now() });
    return { ...v, alerts, reviewOverdue: alerts.some((a) => a.control === 'reviewBy' && /has passed/.test(a.message)) };
  }

  async function viewActivePolicy({ user, jurisdiction } = {}) {
    const correlationId = `governance:${jurisdiction ?? 'unknown'}`;
    const actor = authorise(user, POLICY_READER_ROLES, correlationId, 'view the governance policy in force');
    const active = isNonEmpty(jurisdiction) ? await getActivePolicy({ jurisdiction }) : null;
    if (!active) {
      log(correlationId, actor, 'governance.viewed', { rationale: 'No policy is in force.', detail: { active: true, version: null } });
      throw new PolicyNotFoundError(`No governance policy is in force for ${jurisdiction}.`);
    }
    log(correlationId, actor, 'governance.viewed', { subject: `${jurisdiction} v${active.version}`, detail: { active: true, version: active.version } });
    return active;
  }

  async function listVersions({ user, jurisdiction } = {}) {
    const actor = authorise(user, APPROVER_ROLES, `governance:${jurisdiction}`, 'view governance policies');
    const { rows } = await db.query(`SELECT ${ROW} FROM policy_versions WHERE jurisdiction = $1 ORDER BY version DESC`, [jurisdiction]);
    log(`governance:${jurisdiction}`, actor, 'governance.viewed', { detail: { versions: rows.length } });
    return rows.map(fromRow);
  }

  // Alerts ONCE per version when the policy in force has passed its review date.
  async function checkReviewDates() {
    const { rows } = await db.query("SELECT DISTINCT jurisdiction FROM policy_versions WHERE status = 'approved'");
    const overdue = [];
    for (const { jurisdiction } of rows) {
      const active = await getActivePolicy({ jurisdiction });
      if (!active?.reviewOverdue) continue;
      const { rows: [flagged] } = await db.query(
        'UPDATE policy_versions SET review_alerted_at = now() WHERE jurisdiction = $1 AND version = $2 AND review_alerted_at IS NULL RETURNING version',
        [jurisdiction, active.version],
      );
      if (!flagged) continue; // already alerted
      log(`governance:${jurisdiction}`, { type: 'agent', id: 'governance-agent' }, 'governance.review_overdue', {
        subject: `${jurisdiction} v${active.version}`,
        rationale: `The policy in force for ${jurisdiction} (version ${active.version}) passed its review date ${active.policy.reviewBy}; its rules may no longer match the law. Propose a reviewed update.`,
      });
      overdue.push({ jurisdiction, version: active.version, reviewBy: active.policy.reviewBy });
    }
    return overdue;
  }

  return {
    proposePolicy,
    approveProposal: (args) => decide('approve', args),
    rejectProposal: (args) => decide('reject', args),
    getActivePolicy, viewActivePolicy, listVersions, checkReviewDates,
  };
}
