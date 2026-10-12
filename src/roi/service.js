// Calculating, saving and reading ROI estimates (STORY-008, REQ-009).
//
//   calculateRoiScenario({ user, scenarioId, assumptions }) → the saved scenario
//   getRoiScenario({ user, scenarioId })                    → one scenario
//   listRoiScenarios({ user })                              → all scenarios
//
// Who (the student's choice): a financial analyst or an operations manager.
// Anyone else — or a request with no user — is refused, and the refusal logged.
//
//   validate   — data input errors refuse the request (RoiInputError, every problem listed)
//   calculate  — calculation errors refuse it (CalculationError); no number is shown
//   check      — incorrect-looking assumptions become WARNINGS beside the result;
//                a scenario with any warning has status 'needs_review'
//   save       — the assumptions exactly as submitted, the result with its formulas,
//                the warnings, who and when
//
// Trust: every calculation is logged as roi.calculated WITH THE FULL ASSUMPTIONS,
// the headline figures and every warning, inside the database transaction; every
// refusal is logged with its reason.
//
// Idempotent: the same scenarioId with the same assumptions returns the saved
// scenario; the same id with different assumptions is refused (use a new id).

import { fingerprint } from '../lib/fingerprint.js';
import { roleAllowed } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { validateAssumptions, RoiInputError } from './assumptions.js';
import { calculateRoi, formatMoney, CalculationError } from './calculate.js';
import { checkAssumptions } from './checks.js';

export { PermissionDeniedError, RoiInputError, CalculationError };
export const ROI_ROLES = Object.freeze(['financial analyst', 'operations manager']);

export class RoiRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'RoiRequestError'; }
}
export class RoiScenarioNotFoundError extends Error {
  constructor(message, options) { super(message, options); this.name = 'RoiScenarioNotFoundError'; }
}

export const ROI_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roi_scenarios (
  id            text PRIMARY KEY CHECK (btrim(id) <> ''),
  name          text NOT NULL,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by    text NOT NULL,
  assumptions   jsonb NOT NULL,
  result        jsonb NOT NULL,
  warnings      jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('ok', 'needs_review')),
  fingerprint   text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  -- "ok" means nothing was flagged; "needs_review" must say why.
  CONSTRAINT status_matches_warnings CHECK ((status = 'ok') = (jsonb_array_length(warnings) = 0))
);
`;
export async function migrateRoi(db) { await db.exec(ROI_SCHEMA_SQL); }

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const fromRow = (r) => ({
  id: r.id, name: r.name, currency: r.currency, createdBy: r.created_by, assumptions: r.assumptions,
  result: r.result, warnings: r.warnings, status: r.status, calculatedAt: iso(r.calculated_at),
});

// The headline of a result, in words, for the audit rationale.
function summarise(result, warnings) {
  const e = result.expected;
  const m = (x) => formatMoney(x, result.currency);
  const roi = e.roiPercent === null ? 'ROI not calculable' : `ROI ${e.roiPercent}%`;
  const payback = e.paybackMonths === null ? 'never pays back' : `payback ${e.paybackMonths} months`;
  const head = `Estimated savings ${m(e.annualSavings)} a year; over ${result.horizonYears} years net benefit ${m(e.netBenefit)} (range ${m(result.low.netBenefit)} to ${m(result.high.netBenefit)}), ${roi}, ${payback}.`;
  return warnings.length ? `${head} ${warnings.length} warning(s) need review: ${warnings.map((w) => w.message).join(' | ')}` : `${head} No warnings.`;
}

// lookupAnalysis(id) / lookupDocument(id, user) give the checks their evidence.
export function createRoiService({ db, audit, lookupAnalysis = async () => null, lookupDocument = async () => null, thresholds }) {
  function authorise(user, correlationId, what) {
    if (!isNonEmpty(user?.id)) {
      const why = 'No user was given; ROI estimates are only made for a known user.';
      audit.append({ correlationId, actor: { type: 'system', id: 'unknown-requester' }, action: 'roi.denied', rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    const actor = { type: 'person', id: user.id };
    if (!roleAllowed(user.role, ROI_ROLES)) {
      const why = `Role "${user.role ?? 'none'}" may not ${what}; allowed roles: ${ROI_ROLES.join(', ')}.`;
      audit.append({ correlationId, actor, action: 'roi.denied', rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    return actor;
  }

  async function calculateRoiScenario({ user, scenarioId, assumptions } = {}) {
    const correlationId = `roi:${isNonEmpty(scenarioId) ? scenarioId : 'invalid'}`;
    const actor = authorise(user, correlationId, 'calculate ROI');
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, subject: scenarioId ?? null, ...fields });

    if (!isNonEmpty(scenarioId)) {
      log('roi.rejected', { rationale: 'scenarioId must be a non-empty string', detail: { assumptions: assumptions ?? null } });
      throw new RoiRequestError('ROI request rejected: scenarioId must be a non-empty string');
    }

    // ---- Already calculated? Same assumptions → the saved scenario; different → refused. ----
    const fp = fingerprint(assumptions ?? null);
    const { rows: [existing] } = await db.query('SELECT * FROM roi_scenarios WHERE id = $1', [scenarioId]);
    if (existing) {
      if (existing.fingerprint !== fp) {
        const why = 'This scenario id was already used with different assumptions; use a new id so both estimates stay on record.';
        log('roi.rejected', { rationale: why, detail: { assumptions } });
        throw new RoiRequestError(`ROI request rejected: ${why}`);
      }
      log('roi.replayed', { rationale: 'Already calculated with exactly these assumptions; returning the saved scenario.' });
      return fromRow(existing);
    }

    // ---- 1. Data input errors: refused, every problem listed ----
    const valid = validateAssumptions(assumptions);
    if (!valid.ok) {
      log('roi.rejected', { rationale: `The assumptions have ${valid.problems.length} problem(s): ${valid.problems.map((p) => `${p.path} ${p.problem}`).join('; ')}`, detail: { assumptions, problems: valid.problems } });
      throw new RoiInputError(valid.problems);
    }

    // ---- 2. Calculation errors: refused; no number is shown ----
    let result;
    try {
      result = calculateRoi(valid.assumptions);
    } catch (err) {
      if (!(err instanceof CalculationError)) throw err;
      log('roi.calculation_failed', { rationale: err.message, detail: { assumptions } });
      throw err;
    }

    // ---- 3. Incorrect-looking assumptions: warnings beside the result ----
    const warnings = await checkAssumptions(valid.assumptions, result, {
      lookupAnalysis, lookupDocument: (id) => lookupDocument(id, user), thresholds,
    });
    const status = warnings.length ? 'needs_review' : 'ok';

    // ---- 4. Save and log, together ----
    const logged = [];
    try {
      const saved = await db.transaction(async (tx) => {
        const { rows: [row] } = await tx.query(
          `INSERT INTO roi_scenarios (id, name, currency, created_by, assumptions, result, warnings, status, fingerprint)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9) ON CONFLICT (id) DO NOTHING RETURNING *`,
          [scenarioId, valid.assumptions.name, valid.assumptions.currency, user.id, JSON.stringify(assumptions), JSON.stringify(result), JSON.stringify(warnings), status, fp],
        );
        if (!row) return null; // the same request finished first elsewhere
        logged.push(log('roi.calculated', {
          rationale: summarise(result, warnings),
          detail: {
            status,
            assumptions,
            headline: Object.fromEntries(['low', 'expected', 'high'].map((k) => [k, {
              annualSavings: result[k].annualSavings, totalCosts: result[k].totalCosts, netBenefit: result[k].netBenefit,
              roiPercent: result[k].roiPercent, paybackMonths: result[k].paybackMonths,
            }])),
            warnings,
          },
        }));
        return fromRow(row);
      });
      if (saved) return saved;
    } catch (err) {
      if (logged.length) log('roi.change_failed', { rationale: `The calculation logged as #${logged[0].seq} was NOT saved: ${err?.name ?? 'Error'}: ${err?.message ?? err}` });
      throw err;
    }
    return getRoiScenario({ user, scenarioId });
  }

  async function getRoiScenario({ user, scenarioId } = {}) {
    const actor = authorise(user, `roi:${scenarioId ?? 'unknown'}`, 'view ROI estimates');
    const { rows: [row] } = await db.query('SELECT * FROM roi_scenarios WHERE id = $1', [scenarioId]);
    if (!row) throw new RoiScenarioNotFoundError(`No ROI scenario ${scenarioId}.`);
    audit.append({ correlationId: `roi:${scenarioId}`, actor, action: 'roi.viewed', subject: scenarioId });
    return fromRow(row);
  }

  async function listRoiScenarios({ user } = {}) {
    const actor = authorise(user, 'roi', 'view ROI estimates');
    const { rows } = await db.query('SELECT * FROM roi_scenarios ORDER BY calculated_at, id');
    audit.append({ correlationId: 'roi', actor, action: 'roi.listed', detail: { returned: rows.length } });
    return rows.map(fromRow);
  }

  return { calculateRoiScenario, getRoiScenario, listRoiScenarios };
}

// ---------------------------------------------------------------------------
// Evidence lookups for a running system.

// A saved STORY-002 analysis report from its result store, or null.
export const analysisLookupFrom = (analysisStore) => async (analysisId) => analysisStore.get(analysisId)?.result?.report ?? null;

// A STORY-007 document, read AS THE USER asking for the estimate, so its access rules
// apply: a document they may not see is treated as not found.
export const documentLookupFrom = (documents) => async (documentId, user) => {
  try {
    return await documents.getDocument({ user, documentId });
  } catch (err) {
    if (err?.name === 'DocumentNotFoundError' || err?.name === 'PermissionDeniedError') return null;
    throw err;
  }
};
