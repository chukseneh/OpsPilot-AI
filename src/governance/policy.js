// Governance policy packs (STORY-009, REQ-015): one jurisdiction's controls, as data.
//
//   {
//     jurisdiction: { code: 'UK', name: 'United Kingdom' },
//     illustrative: true,               // true: an example, NOT legal advice
//     sources: [{ id: 'uk-gdpr-22', title: 'UK GDPR Article 22', url: '…' }],
//     reviewBy: '2027-03-31',           // after this date the rules may be out of date
//     controls: {
//       approvals:     { highRiskActionsNeedApproval: true, personalDataActionsNeedApproval: true,
//                        approvalDeadlineHours: 24, escalateAfterHours: 4, source: 'uk-gdpr-22' },
//       riskRules:     { highRiskDataCategories: ['sensitive_personal'],
//                        humanOversightRequiredFor: ['significant', 'critical'], source: '…' },
//       recordKeeping: { auditRetentionDays: 2190, documentRetentionDays: 2190,
//                        auditReaderRoles: ['security officer', 'compliance officer'], source: '…' },
//     },
//   }
//
// The content of a pack — what the law says — comes from people, not from this
// code: a compliance officer writes it, cites a source for each control, and a
// second person approves it (service.js). This file only checks that a pack is
// well formed, internally consistent, and does not weaken the project's own
// guardrails.
//
// validatePolicy() returns alerts, each { severity, control, message, source? }:
//   error   — the pack cannot be approved: malformed values, unknown names, broken
//             source references, contradictions, or breaching a SYSTEM FLOOR
//   warning — allowed, but shown: unusual retention, a control without a source,
//             a review date in the past (rules may be out of date) or far away
//
// System floors no jurisdiction can lower:
//   - high-risk actions always need human approval (REQ-007);
//   - audit records are kept for at least a year (REQ-008).

import { DATA_CATEGORIES, DECISION_IMPACTS } from '../risk/systemData.js';
import { PROJECT_ROLES } from '../lib/roles.js';

// The roles a policy may name: every role in the project (one shared list).
export const KNOWN_ROLES = PROJECT_ROLES;
export const SYSTEM_FLOORS = Object.freeze({ highRiskActionsNeedApproval: true, minAuditRetentionDays: 365 });
const LONG_RETENTION_DAYS = 3650;
const MAX_REVIEW_AHEAD_DAYS = 730;
const DAY_MS = 24 * 60 * 60 * 1000;

// `note` (optional, every control) says which parts the cited source supports and
// which values are this organisation's own choices — so nobody mistakes an example
// number for a legal requirement.
const CONTROL_FIELDS = {
  approvals: ['highRiskActionsNeedApproval', 'personalDataActionsNeedApproval', 'approvalDeadlineHours', 'escalateAfterHours', 'source', 'note'],
  riskRules: ['highRiskDataCategories', 'humanOversightRequiredFor', 'source', 'note'],
  recordKeeping: ['auditRetentionDays', 'documentRetentionDays', 'auditReaderRoles', 'source', 'note'],
};
const TOP_LEVEL = ['jurisdiction', 'illustrative', 'sources', 'reviewBy', 'controls', 'notes'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export function validatePolicy(pack, { today = new Date() } = {}) {
  const alerts = [];
  const error = (control, message, source) => alerts.push({ severity: 'error', control, message, ...(source ? { source } : {}) });
  const warning = (control, message, source) => alerts.push({ severity: 'warning', control, message, ...(source ? { source } : {}) });

  if (!isObject(pack)) return { ok: false, policy: null, alerts: [{ severity: 'error', control: 'policy', message: 'must be an object' }] };
  for (const k of Object.keys(pack)) if (!TOP_LEVEL.includes(k)) error(k, `is not a known part of a policy (known: ${TOP_LEVEL.join(', ')})`);

  // ---- Jurisdiction, status, sources, review date ----
  const j = pack.jurisdiction;
  if (!isObject(j) || !isNonEmpty(j.code) || !isNonEmpty(j.name)) error('jurisdiction', 'must be { code, name }');
  else if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(j.code)) error('jurisdiction.code', `"${j.code}" must look like UK, EU or US-CA`);
  if (typeof pack.illustrative !== 'boolean') error('illustrative', 'must say true (an example, not legal advice) or false (approved as this organisation\'s policy)');

  const sourceIds = new Set();
  if (!Array.isArray(pack.sources) || pack.sources.length === 0) error('sources', 'must list at least one legal or regulatory source');
  else {
    pack.sources.forEach((s, i) => {
      if (!isObject(s) || !isNonEmpty(s.id) || !isNonEmpty(s.title)) { error(`sources[${i}]`, 'must be { id, title, url? }'); return; }
      if (sourceIds.has(s.id)) error(`sources[${i}].id`, `"${s.id}" is listed twice`);
      sourceIds.add(s.id);
      if (s.url !== undefined && !/^https:\/\//.test(s.url)) error(`sources[${i}].url`, 'must be an https:// link');
    });
  }

  const reviewBy = Date.parse(`${pack.reviewBy}T00:00:00Z`);
  if (!isNonEmpty(pack.reviewBy) || !/^\d{4}-\d{2}-\d{2}$/.test(pack.reviewBy) || Number.isNaN(reviewBy)) error('reviewBy', 'must be a date written YYYY-MM-DD');
  else if (reviewBy < today.getTime()) warning('reviewBy', `the review date ${pack.reviewBy} has passed: the rules may be out of date; have them reviewed against the current law`);
  else if (reviewBy - today.getTime() > MAX_REVIEW_AHEAD_DAYS * DAY_MS) warning('reviewBy', `the review date ${pack.reviewBy} is more than 2 years away; regulations change faster than that`);

  // ---- Controls ----
  const c = pack.controls;
  if (!isObject(c)) { error('controls', 'is missing'); return finish(); }
  for (const k of Object.keys(c)) if (!(k in CONTROL_FIELDS)) error(`controls.${k}`, `is not a known control (known: ${Object.keys(CONTROL_FIELDS).join(', ')})`);
  for (const [name, fields] of Object.entries(CONTROL_FIELDS)) {
    const ctl = c[name];
    if (!isObject(ctl)) { error(`controls.${name}`, 'is missing'); continue; }
    for (const k of Object.keys(ctl)) if (!fields.includes(k)) error(`controls.${name}.${k}`, `is not a known setting (known: ${fields.join(', ')})`);
    if (ctl.source === undefined) warning(`controls.${name}`, 'cites no source: say which law or rule this control comes from');
    else if (!sourceIds.has(ctl.source)) error(`controls.${name}.source`, `"${ctl.source}" is not one of the listed sources`);
    if (ctl.note !== undefined && !isNonEmpty(ctl.note)) error(`controls.${name}.note`, 'must be text when given');
  }
  const cite = (name) => (sourceIds.has(c[name]?.source) ? c[name].source : undefined);
  const bool = (path, v) => (typeof v === 'boolean' ? true : (error(path, `must be true or false (got ${JSON.stringify(v)})`), false));
  const num = (path, v, { integer = false } = {}) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && (!integer || Number.isInteger(v))
    ? true : (error(path, `must be a ${integer ? 'whole ' : ''}number above 0 (got ${JSON.stringify(v)})`), false));
  const listOf = (path, v, allowed, { nonEmpty = false } = {}) => {
    if (!Array.isArray(v)) { error(path, 'must be a list'); return false; }
    if (nonEmpty && v.length === 0) { error(path, 'must not be empty'); return false; }
    const unknown = v.filter((x) => !allowed.includes(x));
    if (unknown.length) { error(path, `has unknown value(s) ${unknown.map((x) => JSON.stringify(x)).join(', ')}; allowed: ${allowed.join(', ')}`); return false; }
    return true;
  };

  const a = c.approvals;
  if (isObject(a)) {
    if (bool('controls.approvals.highRiskActionsNeedApproval', a.highRiskActionsNeedApproval) && a.highRiskActionsNeedApproval !== SYSTEM_FLOORS.highRiskActionsNeedApproval) {
      error('controls.approvals.highRiskActionsNeedApproval', 'cannot be switched off: human approval of high-risk actions is required everywhere (REQ-007); a jurisdiction may add approvals, never remove this one', cite('approvals'));
    }
    bool('controls.approvals.personalDataActionsNeedApproval', a.personalDataActionsNeedApproval);
    const okDeadline = num('controls.approvals.approvalDeadlineHours', a.approvalDeadlineHours);
    const okEscalate = num('controls.approvals.escalateAfterHours', a.escalateAfterHours);
    if (okDeadline && okEscalate && a.escalateAfterHours >= a.approvalDeadlineHours) {
      error('controls.approvals', `escalation (${a.escalateAfterHours} h) must come before the deadline (${a.approvalDeadlineHours} h), or nobody else gets the chance to decide`, cite('approvals'));
    }
  }

  const r = c.riskRules;
  if (isObject(r)) {
    listOf('controls.riskRules.highRiskDataCategories', r.highRiskDataCategories, DATA_CATEGORIES);
    listOf('controls.riskRules.humanOversightRequiredFor', r.humanOversightRequiredFor, DECISION_IMPACTS);
  }

  const k = c.recordKeeping;
  if (isObject(k)) {
    const okAudit = num('controls.recordKeeping.auditRetentionDays', k.auditRetentionDays, { integer: true });
    const okDocs = num('controls.recordKeeping.documentRetentionDays', k.documentRetentionDays, { integer: true });
    listOf('controls.recordKeeping.auditReaderRoles', k.auditReaderRoles, KNOWN_ROLES, { nonEmpty: true });
    if (okAudit && k.auditRetentionDays < SYSTEM_FLOORS.minAuditRetentionDays) {
      error('controls.recordKeeping.auditRetentionDays', `${k.auditRetentionDays} days is below the system floor of ${SYSTEM_FLOORS.minAuditRetentionDays}; audit records must be kept for at least a year (REQ-008)`, cite('recordKeeping'));
    }
    if (okAudit && okDocs && k.documentRetentionDays > k.auditRetentionDays) {
      error('controls.recordKeeping', `documents would be kept (${k.documentRetentionDays} days) longer than the audit trail about them (${k.auditRetentionDays} days)`, cite('recordKeeping'));
    }
    for (const [field, v] of [['auditRetentionDays', k.auditRetentionDays], ['documentRetentionDays', k.documentRetentionDays]]) {
      if (Number.isInteger(v) && v > LONG_RETENTION_DAYS) warning(`controls.recordKeeping.${field}`, `${v} days is more than 10 years; check the law asks for this long (keeping data longer than needed is itself a risk)`, cite('recordKeeping'));
    }
  }
  return finish();

  function finish() {
    const ok = !alerts.some((x) => x.severity === 'error');
    return { ok, policy: ok ? structuredClone(pack) : null, alerts };
  }
}
