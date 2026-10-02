// The input to process analysis: a process EVENT LOG — one row per step taken in
// one case of the process. This is the shape a future Microsoft 365 / Google
// Workspace connector would produce; until one exists, it arrives as JSON.
//
//   {
//     "process": "Invoice approval",
//     "events": [
//       { "caseId": "INV-1001", "activity": "Receive invoice", "actor": "ap-clerk-1",
//         "startedAt": "2026-09-01T09:00:00Z", "endedAt": "2026-09-01T09:05:00Z" },
//       ...
//     ]
//   }
//
// validateDataset() never guesses. If anything required is missing or malformed it
// returns ok: false with an exact list of what is wrong (field, row, case), and the
// caller must not analyse — a report built on gaps could point at the wrong
// bottleneck. missingDataNotice() turns that list into a message for the user.

export const REQUIRED_FIELDS = Object.freeze(['caseId', 'activity', 'actor', 'startedAt', 'endedAt']);
export const MIN_CASES = 3;

// ISO 8601 with an explicit time zone. "2026-09-01 09:00" is refused: without a
// zone the same text means different instants on different machines.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function parseTimestamp(value) {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// Returns { ok, process, events, problems, summary }.
//   events   — normalised rows ({ row, caseId, activity, actor, start, end } with
//              start/end in epoch ms), only when ok is true
//   problems — [{ scope: 'dataset' | 'row', row?, caseId?, field?, problem }]
export function validateDataset(dataset, { minCases = MIN_CASES } = {}) {
  const problems = [];
  const datasetProblem = (field, problem) => problems.push({ scope: 'dataset', field, problem });

  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    datasetProblem(null, 'the data is not a process event log (expected an object with "process" and "events")');
    return { ok: false, process: null, events: [], problems, summary: { rows: 0, cases: 0 } };
  }
  if (isBlank(dataset.process) || typeof dataset.process !== 'string') datasetProblem('process', 'the process name is missing');
  if (!Array.isArray(dataset.events)) {
    datasetProblem('events', 'the list of events is missing');
    return { ok: false, process: dataset.process ?? null, events: [], problems, summary: { rows: 0, cases: 0 } };
  }
  if (dataset.events.length === 0) datasetProblem('events', 'the list of events is empty');

  const events = [];
  dataset.events.forEach((raw, i) => {
    const row = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push({ scope: 'row', row, caseId: null, field: null, problem: 'is not an event object' });
      return;
    }
    const caseId = isBlank(raw.caseId) ? null : String(raw.caseId);
    const rowProblem = (field, problem) => problems.push({ scope: 'row', row, caseId, field, problem });
    let rowOk = true;

    for (const field of REQUIRED_FIELDS) {
      if (isBlank(raw[field])) { rowProblem(field, 'is missing'); rowOk = false; }
    }
    const start = isBlank(raw.startedAt) ? null : parseTimestamp(raw.startedAt);
    const end = isBlank(raw.endedAt) ? null : parseTimestamp(raw.endedAt);
    if (!isBlank(raw.startedAt) && start === null) { rowProblem('startedAt', 'is not an ISO 8601 timestamp with a time zone'); rowOk = false; }
    if (!isBlank(raw.endedAt) && end === null) { rowProblem('endedAt', 'is not an ISO 8601 timestamp with a time zone'); rowOk = false; }
    if (start !== null && end !== null && end < start) { rowProblem('endedAt', 'is before startedAt'); rowOk = false; }

    if (rowOk) {
      events.push({ row, caseId, activity: String(raw.activity).trim(), actor: String(raw.actor).trim(), start, end });
    }
  });

  const cases = new Set(events.map((e) => e.caseId)).size;
  if (dataset.events.length > 0 && problems.every((p) => p.scope === 'dataset') && cases < minCases) {
    datasetProblem('events', `only ${cases} complete case${cases === 1 ? '' : 's'}; at least ${minCases} are needed to compare cases`);
  }

  const ok = problems.length === 0;
  return {
    ok,
    process: typeof dataset.process === 'string' ? dataset.process.trim() : null,
    events: ok ? events : [],
    problems,
    summary: { rows: dataset.events.length, cases: new Set(dataset.events.map((e) => e?.caseId).filter((c) => !isBlank(c))).size },
  };
}

// A plain-language notice for the user, grouped so it is readable even with
// hundreds of problems: one line per kind of problem, with the first rows and cases.
export function missingDataNotice(validation, { maxListed = 10 } = {}) {
  if (validation.ok) return null;
  const lines = ['The analysis was not run because the data is incomplete or invalid. Fix the following and try again:'];

  for (const p of validation.problems.filter((x) => x.scope === 'dataset')) {
    lines.push(`- ${p.problem}.`);
  }

  const groups = new Map();
  for (const p of validation.problems.filter((x) => x.scope === 'row')) {
    const key = p.field ? `"${p.field}" ${p.problem}` : p.problem;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const list = (items) => (items.length > maxListed
    ? `${items.slice(0, maxListed).join(', ')} and ${items.length - maxListed} more`
    : items.join(', '));
  for (const [key, ps] of groups) {
    const rows = ps.map((p) => p.row);
    const cases = [...new Set(ps.map((p) => p.caseId).filter(Boolean))];
    lines.push(`- ${key} in ${ps.length} row${ps.length === 1 ? '' : 's'} (row${rows.length === 1 ? '' : 's'} ${list(rows)}${cases.length ? `; case${cases.length === 1 ? '' : 's'} ${list(cases)}` : ''}).`);
  }
  return lines.join('\n');
}
