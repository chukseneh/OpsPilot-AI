// The Knowledge base question panel. It answers ONLY from the data on this page,
// by fixed rules, and every answer names the tab it came from. When no rule
// matches it says it cannot answer — it never guesses. (A public static page
// cannot hold an API key, so there is deliberately no AI model behind this.)

import { coverage, storiesForRole, requirementsForSystem, storyOwners, progressById, termPhase, todayISO } from './data.js';

const TAB = {
  overview: ['Overview', '#/overview'],
  outcomes: ['Outcomes', '#/outcomes'],
  users: ['Users', '#/users'],
  guardrails: ['Guardrails', '#/guardrails'],
  systems: ['Systems', '#/systems'],
  project: ['Project', '#/project'],
  agents: ['AI agents', '#/agents'],
  knowledge: ['Knowledge base', '#/knowledge'],
  model: ['Data model', '#/data-model'],
};

const reply = (text, tab) => ({ text, source: TAB[tab][0], href: TAB[tab][1] });
const NO_ANSWER = {
  text: 'I can’t answer that from the data on this page. Try asking about a requirement (REQ-008), a story (STORY-002), a release (r0), progress, guardrails, systems, roles, agents, measures or the schedule.',
  source: null,
  href: null,
};

// Words too common in questions (or in every requirement) to be a useful match.
const STOPWORDS = new Set(['what', 'does', 'have', 'with', 'this', 'that', 'which', 'about', 'there', 'their',
  'where', 'when', 'will', 'should', 'would', 'could', 'must', 'system', 'tell', 'show', 'many', 'much', 'from', 'into']);

const STATE = { verified: 'verified', submitted: 'submitted', in_progress: 'in progress', not_started: 'not started' };
const stateText = (v) => (v ? STATE[v.state] ?? v.state : 'not checked yet');

export function answer(question, data) {
  const q = question.trim();
  if (!q) return NO_ANSWER;
  const lower = q.toLowerCase();
  const { plan, progress } = data;
  const byId = progressById(progress);
  const prefix = data.sample ? '(Sample data) ' : '';
  const say = (text, tab) => reply(prefix + text, tab);

  const reqMatch = q.match(/\bREQ-\d{3}\b/i);
  if (reqMatch) {
    const req = (plan.requirements ?? []).find((r) => r.id === reqMatch[0].toUpperCase());
    if (!req) return say(`There is no ${reqMatch[0].toUpperCase()} in the plan.`, 'knowledge');
    const c = coverage(req, progress);
    return say(`${req.id} (${req.kind}, ${req.priority}): ${req.statement} Covered by: ${(req.fulfilled_by ?? []).join(', ') || 'no story'} — ${c.label.toLowerCase()}.`, 'knowledge');
  }

  const storyMatch = q.match(/\bSTORY-\d{3}\b/i);
  if (storyMatch) {
    const id = storyMatch[0].toUpperCase();
    const story = (plan.stories ?? []).find((s) => s.id === id);
    if (!story) return say(`There is no ${id} in the plan.`, 'project');
    return say(`${id} — ${story.title}. Release ${story.release}, due ${story.due_on ?? 'no date'}, owned by ${story.owner_agent ?? 'no one'}. State: ${stateText(byId.get(id)?.verification)}.`, 'project');
  }

  const relMatch = lower.match(/\b(r\d+)\b/);
  if (relMatch && /release|\br\d+\b/.test(lower)) {
    const r = (plan.releases ?? []).find((x) => x.key === relMatch[1]);
    if (r) return say(`${r.key} — ${r.name}: ${r.goal} Stories: ${(r.story_ids ?? []).join(', ')}. ${r.is_demo_target ? 'This is the demo target.' : 'This is roadmap work.'}`, 'project');
  }

  if (/\b(gap|gaps|uncovered|not covered|missing coverage)\b/.test(lower)) {
    const gaps = (plan.requirements ?? []).filter((r) => !(r.fulfilled_by ?? []).length);
    return say(gaps.length
      ? `${gaps.length} requirement(s) have no covering story: ${gaps.map((r) => `${r.id} (${r.priority})`).join(', ')}.`
      : 'Every requirement has at least one covering story.', 'knowledge');
  }

  if (/guardrail|never happen|safe requirement/.test(lower)) {
    const g = plan.derived?.guardrails ?? [];
    if (!g.length) return say('The plan has no guardrails (no SAFE requirement).', 'guardrails');
    const reqs = new Map((plan.requirements ?? []).map((r) => [r.id, r]));
    return say(g.map((x) => `${x.id}: ${x.statement} — ${coverage(reqs.get(x.id) ?? { fulfilled_by: [] }, progress).label.toLowerCase()}.`).join(' '), 'guardrails');
  }

  const system = (plan.derived?.systems ?? []).find((s) => lower.includes(s.toLowerCase()));
  if (system || /\b(system|systems|integration|integrations|connected|connect)\b/.test(lower)) {
    if (system) {
      const report = data.systemStatus?.[system];
      const reqs = requirementsForSystem(plan, system).map((r) => r.id);
      return say(`${system} is named in ${reqs.join(', ') || 'no requirement'}. Status: ${report ? report.status.replace('_', ' ') : 'not checked from here — nothing in the repo can tell whether it is connected'}.`, 'systems');
    }
    const names = plan.derived?.systems ?? [];
    return say(names.length ? `The plan names ${names.length} systems: ${names.join(', ')}. ${data.systemStatus ? '' : 'None has been checked from here.'}` : 'The plan names no systems.', 'systems');
  }

  if (/\b(measure|measures|outcome|outcomes|kpi|kpis|target|targets)\b/.test(lower)) {
    const m = plan.derived?.measures ?? [];
    return say(m.length ? `${m.length} measure(s): ${m.map((x) => `${x.id} — ${x.statement}`).join('; ')}.` : 'The plan has no measures yet — no numeric target is defined.', 'outcomes');
  }

  if (/\b(agent|agents|owner|owners)\b/.test(lower)) {
    const agents = plan.agents ?? [];
    if (agents.length) return say(`${agents.length} agent(s): ${agents.map((a) => a.name ?? a.id).join(', ')}.`, 'agents');
    const owners = storyOwners(plan);
    return say(`The plan has no scoped agent roster yet. Story owners: ${owners.map((o) => `${o.name} (${o.owns.join(', ')})`).join('; ')}. No runs recorded.`, 'agents');
  }

  const role = (plan.derived?.roles ?? []).find((r) => lower.includes(r.toLowerCase()));
  if (role) {
    const stories = storiesForRole(plan, role);
    return say(`${role}: ${stories.map((s) => `${s.id} — ${s.narrative}`).join(' ') || 'no story is written for this role.'}`, 'users');
  }
  if (/\b(role|roles|user|users|who is it for|who for)\b/.test(lower)) {
    return say(`Roles: ${(plan.derived?.roles ?? []).join(', ') || 'none in the plan'}.`, 'users');
  }

  if (/\b(demo|deadline|schedule|when|build end|build start)\b/.test(lower)) {
    const s = plan.schedule;
    if (!s) return say('The plan has no schedule yet.', 'project');
    return say(`Build ${s.build_start} → ${s.build_end}, demo day ${s.demo_day} (demoing ${s.demo_release_key}). Today: ${termPhase(s, todayISO()).label.toLowerCase()}.`, 'project');
  }

  if (/\b(progress|verified|done|how far|points|criteria|status)\b/.test(lower)) {
    const t = progress.totals ?? {};
    return say(`${t.stories_verified ?? '?'} of ${t.stories_total ?? '?'} stories verified, ${t.criteria_passed ?? '?'} of ${t.criteria_total ?? '?'} criteria passed, ${t.points_awarded ?? '?'} points as reported in progress.json.`, 'overview');
  }

  if (/\b(table|tables|entity|entities|data model|schema)\b/.test(lower)) {
    const e = data.dataModel?.entities ?? [];
    return say(e.length ? `${e.length} proposed tables: ${e.map((x) => x.name).join(', ')}. Not created yet.` : 'No data model has been proposed yet.', 'model');
  }

  // Last resort: words that appear in requirement statements or story titles.
  const words = lower.split(/\W+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
  if (words.length) {
    const hits = (plan.requirements ?? []).filter((r) => words.some((w) => r.statement.toLowerCase().includes(w)));
    if (hits.length) {
      return say(`Requirements mentioning that: ${hits.slice(0, 5).map((r) => `${r.id} — ${r.statement}`).join(' ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}`, 'knowledge');
    }
  }
  return NO_ANSWER;
}
