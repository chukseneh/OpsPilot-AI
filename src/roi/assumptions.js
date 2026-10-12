// The assumptions an ROI estimate is calculated from (STORY-008, REQ-009), and
// the "data input errors" failure path: anything malformed is refused, with an
// exact list of every problem, before any calculation happens.
//
//   {
//     name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
//     timeSavings: [{ label: 'Enter invoice', casesPerYear: 6000, minutesPerCase: 6,
//                     automationRate: 0.8, costPerHour: 32, evidence? }],
//     otherSavings: [{ label: 'Fewer late-payment fees', amountPerYear: 1500, evidence? }],
//     costs: { oneOff:  [{ label: 'Implementation', amount: 12000, evidence? }],
//              perYear: [{ label: 'Licence', amount: 4800, evidence? }] },
//     uncertainty: { savings: 0.2, costs: 0.1 },   // optional: ±20 % savings, ±10 % costs
//   }
//
// evidence links an assumption to something the system has observed, for the
// checks in step 3:  { analysisId, activity }   — a STORY-002 process analysis step
//                    { documentId, field }      — a STORY-007 document field
//
// validateAssumptions() never corrects anything. On success it returns a
// normalised copy in which every money amount is a whole number of MINOR units
// (pence, cents), so totals are exact: 0.10 + 0.20 is 30, not 0.30000000000000004.
// Limit: currencies with two decimal places only (not e.g. JPY).

export const MAX_HORIZON_YEARS = 10;
const MAX_MONEY = 1e12; // in major units: far above any real estimate, well inside exact integer range
const MAX_CASES = 1e8;
const MAX_MINUTES_PER_CASE = 7 * 24 * 60; // a week

export class RoiInputError extends Error {
  constructor(problems) {
    super(`The ROI assumptions have ${problems.length} problem(s): ${problems.map((p) => `${p.path} ${p.problem}`).join('; ')}`);
    this.name = 'RoiInputError';
    this.problems = problems;
  }
}

const TOP_LEVEL = ['name', 'currency', 'horizonYears', 'timeSavings', 'otherSavings', 'costs', 'uncertainty'];
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateAssumptions(input) {
  const problems = [];
  const problem = (path, text) => problems.push({ path, problem: text });

  if (!isObject(input)) return { ok: false, problems: [{ path: 'assumptions', problem: 'must be an object' }] };
  for (const key of Object.keys(input)) if (!TOP_LEVEL.includes(key)) problem(key, `is not a known assumption (known: ${TOP_LEVEL.join(', ')})`);

  // ---- Readers: each returns the clean value, or undefined after recording the problem ----
  const number = (path, v, { min = 0, max = Infinity, integer = false, above = false } = {}) => {
    if (typeof v !== 'number') { problem(path, v === undefined ? 'is missing' : `must be a number (got ${JSON.stringify(v)})`); return undefined; }
    if (!Number.isFinite(v)) { problem(path, `must be a finite number (got ${v})`); return undefined; }
    if (above ? v <= min : v < min) { problem(path, `must be ${above ? 'more than' : 'at least'} ${min} (got ${v})`); return undefined; }
    if (v > max) { problem(path, `must be at most ${max} (got ${v})`); return undefined; }
    if (integer && !Number.isInteger(v)) { problem(path, `must be a whole number (got ${v})`); return undefined; }
    return v;
  };
  const money = (path, v) => {
    const n = number(path, v, { max: MAX_MONEY });
    if (n === undefined) return undefined;
    const minor = Math.round(n * 100);
    if (Math.abs(n * 100 - minor) > 1e-6) { problem(path, `has more than 2 decimal places (got ${v})`); return undefined; }
    return minor;
  };
  const label = (path, v) => (isNonEmpty(v) ? v.trim() : (problem(path, 'is missing'), undefined));
  const evidence = (path, v) => {
    if (v === undefined) return undefined;
    if (isObject(v) && isNonEmpty(v.analysisId) && isNonEmpty(v.activity) && Object.keys(v).length === 2) return { analysisId: v.analysisId, activity: v.activity };
    if (isObject(v) && isNonEmpty(v.documentId) && isNonEmpty(v.field) && Object.keys(v).length === 2) return { documentId: v.documentId, field: v.field };
    problem(path, 'must be { analysisId, activity } or { documentId, field }');
    return undefined;
  };
  const list = (path, v, readItem) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { problem(path, 'must be a list'); return []; }
    const seen = new Set();
    return v.map((item, i) => {
      const at = `${path}[${i}]`;
      if (!isObject(item)) { problem(at, 'must be an object'); return null; }
      const read = readItem(at, item);
      if (read.label !== undefined) {
        if (seen.has(read.label.toLowerCase())) problem(`${at}.label`, `"${read.label}" is used twice in ${path}`);
        seen.add(read.label.toLowerCase());
      }
      return read;
    });
  };

  // ---- The assumptions ----
  const name = label('name', input.name);
  const currency = isNonEmpty(input.currency) && /^[A-Z]{3}$/.test(input.currency) ? input.currency
    : (problem('currency', input.currency === undefined ? 'is missing' : `must be a 3-letter code such as GBP (got ${JSON.stringify(input.currency)})`), undefined);
  const horizonYears = number('horizonYears', input.horizonYears, { min: 1, max: MAX_HORIZON_YEARS, integer: true });

  const timeSavings = list('timeSavings', input.timeSavings, (at, t) => ({
    label: label(`${at}.label`, t.label),
    casesPerYear: number(`${at}.casesPerYear`, t.casesPerYear, { max: MAX_CASES }),
    minutesPerCase: number(`${at}.minutesPerCase`, t.minutesPerCase, { min: 0, above: true, max: MAX_MINUTES_PER_CASE }),
    automationRate: number(`${at}.automationRate`, t.automationRate, { max: 1 }),
    costPerHourMinor: money(`${at}.costPerHour`, t.costPerHour),
    evidence: evidence(`${at}.evidence`, t.evidence),
  }));
  const otherSavings = list('otherSavings', input.otherSavings, (at, s) => ({
    label: label(`${at}.label`, s.label),
    amountPerYearMinor: money(`${at}.amountPerYear`, s.amountPerYear),
    evidence: evidence(`${at}.evidence`, s.evidence),
  }));

  let oneOff = [];
  let perYear = [];
  if (!isObject(input.costs)) problem('costs', input.costs === undefined ? 'is missing' : 'must be { oneOff: [...], perYear: [...] }');
  else {
    for (const key of Object.keys(input.costs)) if (!['oneOff', 'perYear'].includes(key)) problem(`costs.${key}`, 'is not a known cost list (oneOff, perYear)');
    const cost = (at, c) => ({ label: label(`${at}.label`, c.label), amountMinor: money(`${at}.amount`, c.amount), evidence: evidence(`${at}.evidence`, c.evidence) });
    oneOff = list('costs.oneOff', input.costs.oneOff, cost);
    perYear = list('costs.perYear', input.costs.perYear, cost);
  }

  let uncertainty = { savings: 0, costs: 0 };
  if (input.uncertainty !== undefined) {
    if (!isObject(input.uncertainty)) problem('uncertainty', 'must be { savings, costs }');
    else {
      for (const key of Object.keys(input.uncertainty)) if (!['savings', 'costs'].includes(key)) problem(`uncertainty.${key}`, 'is not known (savings, costs)');
      uncertainty = {
        savings: input.uncertainty.savings === undefined ? 0 : number('uncertainty.savings', input.uncertainty.savings, { max: 1 }),
        costs: input.uncertainty.costs === undefined ? 0 : number('uncertainty.costs', input.uncertainty.costs, { max: 1 }),
      };
    }
  }

  // ---- Something to weigh against something ----
  if (timeSavings.length + otherSavings.length === 0) problem('timeSavings', 'there must be at least one saving (timeSavings or otherSavings)');
  if (isObject(input.costs) && oneOff.length + perYear.length === 0) problem('costs', 'there must be at least one cost; ROI cannot be estimated without one');

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    assumptions: { name, currency, horizonYears, timeSavings, otherSavings, costs: { oneOff, perYear }, uncertainty },
  };
}
