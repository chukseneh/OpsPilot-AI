import { esc, card, back, table, emptyState, notFound, stateBadge, storyLink, fmtTimestamp, plural } from '../ui.js';
import { storyOwners, joinStories } from '../data.js';

const BASE = '#/agents';

// No run history exists until an agent is built and runs. Never show a 0% success
// rate — that reads as "ran and failed".
function runsLine(runs) {
  if (!runs) return 'No runs recorded';
  return `${plural(runs.runs, 'run', 'runs')} · ${runs.succeeded} succeeded · last ${fmtTimestamp(new Date(runs.last_run_at))}`;
}

const skillsLine = (skills) => (skills?.length ? skills.join(', ') : 'No skills registered yet');

// One roster shape for both sources: scoped agents from plan.agents, or — while
// the plan has none — the story owners.
function roster(plan) {
  const agents = plan.agents ?? [];
  if (agents.length) return { scoped: true, list: agents.map((a) => ({ ...a, name: a.name ?? a.id, owns: a.owns ?? [] })) };
  return { scoped: false, list: storyOwners(plan) };
}

export function renderAgents(data, sub, ctx) {
  const { scoped, list } = roster(data.plan);
  if (sub[0]) {
    const agent = list.find((a) => a.name === sub[0]);
    return agent ? detail(agent, scoped, data) : notFound(`No agent or owner called “${sub[0]}”.`, BASE, 'AI agents');
  }

  const head = `<h1>AI agents</h1>
    <p class="lede">The agents in the design, what they own, and how they have run.</p>`;
  if (!list.length) return `${head}${emptyState('The plan has no agents and no story owners yet.')}`;

  const byAutonomy = data.plan.derived?.counts?.agents_by_autonomy ?? {};
  const intro = scoped
    ? `<p class="muted">Roster by autonomy: ${Object.entries(byAutonomy).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || 'not broken down in the plan'}</p>`
    : `<div class="banner banner-warn">Your plan does not carry a scoped agent roster yet. These are the <strong>story owners</strong>
        named in the plan — owners, not AI agents. Each becomes an agent only once it is designed with a purpose, trigger and autonomy level.</div>`;

  return `${head}${intro}<div class="cards">${list.map((a) => card(ctx, {
    href: `${BASE}/${encodeURIComponent(a.name)}`, label: scoped ? 'Agent' : 'Story owner', value: a.name,
    sub: `Owns ${a.owns.map(esc).join(', ') || 'no stories'}<br>Skills: ${esc(skillsLine(a.skills))}<br>${esc(runsLine(data.agentRuns?.[a.name]))}`,
  })).join('')}</div>`;
}

function detail(agent, scoped, data) {
  const owns = new Set(agent.owns);
  const stories = joinStories(data.plan, data.progress).filter((s) => owns.has(s.id));
  const field = (v) => (Array.isArray(v) ? (v.length ? esc(v.join(', ')) : 'none') : esc(v ?? 'Not defined in the plan'));
  return `<h1>${esc(agent.name)}</h1>
    <p class="lede">${scoped ? esc(agent.purpose ?? '') : 'A story owner from the plan, not yet a designed AI agent.'}</p>
    <dl class="facts">
      <dt>Purpose</dt><dd>${field(agent.purpose)}</dd>
      <dt>Trigger</dt><dd>${agent.trigger_type || agent.trigger ? `${field(agent.trigger_type)} — ${field(agent.trigger)}` : 'Not defined in the plan'}</dd>
      <dt>Autonomy</dt><dd>${field(agent.autonomy_level)}</dd>
      <dt>Approval gates</dt><dd>${scoped ? field(agent.approval_gates) : 'Not defined in the plan'}</dd>
      <dt>Escalation</dt><dd>${scoped ? field(agent.escalation_rules) : 'Not defined in the plan'}</dd>
      <dt>Skills</dt><dd>${esc(skillsLine(agent.skills))}</dd>
      <dt>Runs</dt><dd>${esc(runsLine(data.agentRuns?.[agent.name]))}</dd>
    </dl>
    <h2>Stories it owns</h2>
    ${stories.length ? table(['Story', 'Title', 'Release', 'State'], stories.map((s) => [storyLink(s.id), esc(s.title), esc(s.release ?? '—'), stateBadge(s.state)]))
      : emptyState('No stories in the plan.')}
    ${back(BASE, 'AI agents')}`;
}
