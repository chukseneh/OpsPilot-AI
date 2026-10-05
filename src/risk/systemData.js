// The input to risk assessment (STORY-003): the REGISTERED AI SYSTEMS — one record
// per system. The inventory fields match the AISystem entity in
// knowledge/data-model.json; STORY-004 (the inventory) will be what supplies this
// list. Until it exists, the list arrives as JSON:
//
//   [
//     { "id": "ai-cv-screen", "name": "CV screener", "department": "HR",
//       "purpose": "Ranks job applications", "owner": "hr-lead-1", "status": "active",
//       "dataCategories": ["personal"], "decisionImpact": "significant",
//       "humanOversight": "review", "userFacing": false },
//     ...
//   ]
//
// The last four fields are what the risk rules need:
//   dataCategories — what data the system handles (one or more of DATA_CATEGORIES)
//   decisionImpact — how much its outputs affect people (DECISION_IMPACTS, lowest first)
//   humanOversight — how a person is involved before its output takes effect
//   userFacing     — whether people interact with it directly (true / false)
//
// validateSystems() never guesses. Each system is checked on its own: complete
// systems can be assessed, and each incomplete one comes back with an exact list
// of which fields are missing or invalid, so it is reported as unassessed rather
// than assessed on gaps (a missing field could hide the very risk that matters).
// incompleteSystemsNotice() turns that list into a message for the user.

export const SYSTEM_STATUSES = Object.freeze(['proposed', 'active', 'paused', 'retired']);
export const DATA_CATEGORIES = Object.freeze(['public', 'internal', 'confidential', 'financial', 'personal', 'sensitive_personal']);
export const DECISION_IMPACTS = Object.freeze(['none', 'low', 'significant', 'critical']);
export const HUMAN_OVERSIGHT = Object.freeze(['none', 'review', 'approval']);

const TEXT_FIELDS = Object.freeze(['id', 'name', 'department', 'purpose', 'owner']);

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const oneOf = (allowed) => `must be one of: ${allowed.join(', ')}`;

// Checks one record. Returns { system } when complete (strings trimmed, categories
// de-duplicated and sorted so the same system always reads the same), or
// { problems: [{ field, problem }] } when not.
function checkSystem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: [{ field: null, problem: 'is not an AI system record' }] };
  const problems = [];
  const problem = (field, text) => problems.push({ field, problem: text });

  for (const field of TEXT_FIELDS) {
    if (isBlank(raw[field])) problem(field, 'is missing');
    else if (typeof raw[field] !== 'string') problem(field, 'must be text');
  }

  const enumField = (field, allowed) => {
    if (isBlank(raw[field])) problem(field, 'is missing');
    else if (!allowed.includes(raw[field])) problem(field, oneOf(allowed));
  };
  enumField('status', SYSTEM_STATUSES);
  enumField('decisionImpact', DECISION_IMPACTS);
  enumField('humanOversight', HUMAN_OVERSIGHT);

  if (raw.dataCategories === undefined || raw.dataCategories === null) problem('dataCategories', 'is missing');
  else if (!Array.isArray(raw.dataCategories) || raw.dataCategories.length === 0) problem('dataCategories', 'must be a non-empty list');
  else {
    const unknown = raw.dataCategories.filter((c) => !DATA_CATEGORIES.includes(c));
    if (unknown.length) problem('dataCategories', `has unknown value(s) ${unknown.map((c) => JSON.stringify(c)).join(', ')}; ${oneOf(DATA_CATEGORIES)}`);
  }

  if (raw.userFacing === undefined || raw.userFacing === null) problem('userFacing', 'is missing');
  else if (typeof raw.userFacing !== 'boolean') problem('userFacing', 'must be true or false');

  if (problems.length) return { problems };
  return {
    system: {
      id: raw.id.trim(),
      name: raw.name.trim(),
      department: raw.department.trim(),
      purpose: raw.purpose.trim(),
      owner: raw.owner.trim(),
      status: raw.status,
      dataCategories: [...new Set(raw.dataCategories)].sort(),
      decisionImpact: raw.decisionImpact,
      humanOversight: raw.humanOversight,
      userFacing: raw.userFacing,
    },
  };
}

// Returns { ok, systems, incomplete, problems }.
//   systems    — complete, normalised records, ready to assess
//   incomplete — [{ position, systemId, name, problems: [{ field, problem }] }]
//                position is 1-based in the list as given
//   problems   — problems with the list itself (not a list, empty)
// ok is true only when there is at least one system to assess and nothing is wrong.
export function validateSystems(list) {
  if (!Array.isArray(list)) {
    return { ok: false, systems: [], incomplete: [], problems: ['the AI systems are not a list (expected an array of AI system records)'] };
  }
  if (list.length === 0) {
    return { ok: false, systems: [], incomplete: [], problems: ['no AI systems are registered, so there is nothing to assess'] };
  }

  const systems = [];
  const incomplete = [];
  const seen = new Set();
  list.forEach((raw, i) => {
    const position = i + 1;
    const rawId = raw && typeof raw === 'object' && typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
    const rawName = raw && typeof raw === 'object' && typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null;
    const { system, problems } = checkSystem(raw);

    // The same id twice would make two different assessments claim one system.
    // The first record keeps the id; every later one is reported, not assessed.
    if (rawId !== null && seen.has(rawId)) {
      incomplete.push({ position, systemId: rawId, name: rawName, problems: [...(problems ?? []), { field: 'id', problem: 'is used by an earlier system in the list' }] });
      return;
    }
    if (rawId !== null) seen.add(rawId);

    if (system) systems.push(system);
    else incomplete.push({ position, systemId: rawId, name: rawName, problems });
  });

  return { ok: incomplete.length === 0, systems, incomplete, problems: [] };
}

// A plain-language notice for the user: one line per system that could not be
// assessed, naming each field that needs fixing. null when there is nothing to say.
export function incompleteSystemsNotice(validation) {
  if (validation.problems.length === 0 && validation.incomplete.length === 0) return null;
  const lines = [];
  for (const p of validation.problems) lines.push(`- ${p}.`);
  for (const s of validation.incomplete) {
    const label = s.systemId ? `"${s.name ?? s.systemId}" (${s.systemId})` : `System #${s.position} (no id)`;
    const what = s.problems.map((p) => (p.field ? `"${p.field}" ${p.problem}` : p.problem)).join('; ');
    lines.push(`- ${label} was not assessed: ${what}.`);
  }
  const head = validation.systems.length === 0
    ? 'No risk assessment was produced because no AI system has complete data. Fix the following and try again:'
    : `${validation.incomplete.length} AI system(s) were not assessed because their data is incomplete or invalid. They are marked unassessed until this is fixed:`;
  return [head, ...lines].join('\n');
}
