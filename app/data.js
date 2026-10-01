// The one place the Command Center gets its data. Every tab receives what
// loadData() returns (or its sample twin) and nothing else — no tab fetches
// or hard-codes plan content on its own.

const FILES = {
  plan: '.colaberry/plan.json',
  progress: '.colaberry/progress.json',
  manifest: '.colaberry/manifest.json',
  profile: '.colaberry/profile.json',
  // Yours, not the platform's: decisions/notes you add, and the proposed data model.
  knowledge: 'knowledge/notes.json',
  dataModel: 'knowledge/data-model.json',
};

const TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 7 * DAY_MS;

async function fetchJson(path, { optional = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    // no-store: a fresh sync must show up on reload, not a cached copy.
    res = await fetch(path, { cache: 'no-store', signal: controller.signal });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? `${path} timed out after ${TIMEOUT_MS / 1000}s`
      : `${path} could not be fetched (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (optional && res.status === 404) return null;
    throw new Error(`${path} returned HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message})`);
  }
}

// plan and progress are required: without them there is nothing true to show.
// manifest and profile are optional: a missing manifest is surfaced as
// "data age unknown" rather than blanking the page.
export async function loadData() {
  const [plan, progress, manifest, profile, knowledge, dataModel] = await Promise.all([
    fetchJson(FILES.plan),
    fetchJson(FILES.progress),
    fetchJson(FILES.manifest, { optional: true }),
    fetchJson(FILES.profile, { optional: true }),
    fetchJson(FILES.knowledge, { optional: true }),
    fetchJson(FILES.dataModel, { optional: true }),
  ]);
  return {
    plan, progress, manifest, profile, knowledge, dataModel,
    // Runtime facts only your running system can report. Nothing in this repo
    // can tell whether a system is connected, an agent has run or a measure has
    // moved, so in Real mode these stay null and the tabs say so.
    systemStatus: null,
    agentRuns: null,
    measurements: null,
    sample: false,
  };
}

// ---- Plan accessors (schema_version 2; unknown fields are ignored) ----

export const projectName = (plan) => plan.project?.name ?? plan.project_name ?? 'Untitled project';
export const projectDescriptor = (plan) => plan.project?.descriptor ?? plan.descriptor ?? '';

export function progressById(progress) {
  return new Map((progress.stories ?? []).map((s) => [s.id, s]));
}

// Join on story id, per docs/DATA_CONTRACT.md. State comes from progress only.
// A missing verification block means "not measured" and stays null — it is
// never turned into a 0.
export function joinStories(plan, progress) {
  const byId = progressById(progress);
  return (plan.stories ?? []).map((story) => {
    const v = byId.get(story.id)?.verification ?? null;
    return {
      ...story,
      state: v?.state ?? null,
      criteriaPassed: v ? v.criteria_passed : null,
      criteriaTotal: v ? v.criteria_total : null,
      points: v ? v.points_awarded : null,
      commitUrl: v?.commit_url ?? null,
    };
  });
}

const isVerifiedIn = (byId) => (id) => byId.get(id)?.verification?.state === 'verified';

// How well a requirement is covered: no story (a gap), some stories still open,
// or every fulfilling story verified ("built", per the data contract).
export function coverage(req, progress) {
  const ids = req.fulfilled_by ?? [];
  if (!ids.length) return { key: 'gap', label: 'No story covers this', verified: 0, total: 0 };
  const verified = ids.filter(isVerifiedIn(progressById(progress))).length;
  if (verified === ids.length) return { key: 'verified', label: 'All covering stories verified', verified, total: ids.length };
  return { key: 'open', label: `${verified} of ${ids.length} covering stories verified`, verified, total: ids.length };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Stories are written "As a <role>, I want …"; derived.roles came from that.
export function storiesForRole(plan, role) {
  const re = new RegExp(`^As an? ${escapeRegex(role)}\\b`, 'i');
  return (plan.stories ?? []).filter((s) => re.test(s.narrative ?? ''));
}

// Requirements whose text names a system (derived.systems came from CONSTRAINT text).
export function requirementsForSystem(plan, system) {
  const needle = system.toLowerCase();
  return (plan.requirements ?? []).filter((r) => (r.statement ?? '').toLowerCase().includes(needle));
}

// Story owners, in plan order — used as the roster while plan.agents is empty.
export function storyOwners(plan) {
  const owners = new Map();
  for (const s of plan.stories ?? []) {
    if (!s.owner_agent) continue;
    if (!owners.has(s.owner_agent)) owners.set(s.owner_agent, []);
    owners.get(s.owner_agent).push(s.id);
  }
  return [...owners].map(([name, owns]) => ({ name, owns }));
}

// The first release, in plan order, that still has an unverified story.
export function currentRelease(plan, progress) {
  const releases = (plan.releases ?? []).filter((r) => (r.story_ids ?? []).length > 0);
  const isVerified = isVerifiedIn(progressById(progress));
  const open = releases.find((r) => !r.story_ids.every(isVerified));
  if (open) return { release: open, allDone: false };
  return { release: releases.at(-1) ?? null, allDone: releases.length > 0 };
}

// ---- Dates ----

export function todayISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Where today sits in the term. Dates are YYYY-MM-DD, so string order is date order.
export function termPhase(schedule, today) {
  if (!schedule) return { label: 'No schedule in plan', key: 'none' };
  const { build_start: start, build_end: end, demo_day: demo } = schedule;
  if (start && today < start) return { label: 'Before the build starts', key: 'before' };
  if (end && today < end) return { label: 'Building', key: 'build' };
  if (end && today === end) return { label: 'Building — final day', key: 'build' };
  if (demo && today < demo) return { label: 'Demo prep', key: 'prep' };
  if (demo && today === demo) return { label: 'Demo day', key: 'demo' };
  if (demo) return { label: 'After demo day', key: 'after' };
  return { label: 'Schedule incomplete', key: 'none' };
}

// "Data as of" — from manifest.generated_at, which only moves when the data changes.
export function dataAge(manifest, now = new Date()) {
  const iso = manifest?.generated_at;
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return { level: 'unknown', at: null, ageMs: null };
  const ageMs = now.getTime() - at.getTime();
  return { level: ageMs > STALE_AFTER_MS ? 'stale' : 'ok', at, ageMs };
}

// Whole days from a to b (YYYY-MM-DD), ignoring time zones.
export function daysBetween(a, b) {
  const utc = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

export function relativeAge(ms) {
  if (ms < 60 * 1000) return 'just now';
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (ms < 60 * 60 * 1000) return plural(Math.floor(ms / 60000), 'minute');
  if (ms < DAY_MS) return plural(Math.floor(ms / 3600000), 'hour');
  return plural(Math.floor(ms / DAY_MS), 'day');
}
