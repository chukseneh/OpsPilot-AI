import { esc, back, table, emptyState, notFound, statusDot, checkedAt, sampleChip, reqLink, storyLink, stateBadge } from '../ui.js';
import { requirementsForSystem, joinStories } from '../data.js';

const BASE = '#/systems';

export function renderSystems(data, sub, ctx) {
  const systems = data.plan.derived?.systems ?? [];
  if (sub[0]) {
    const name = systems.find((s) => s === sub[0]);
    return name ? detail(name, data) : notFound(`No system called “${sub[0]}” in the plan.`, BASE, 'Systems');
  }
  const head = `<h1>Systems — what this connects to</h1>
    <p class="lede">The systems your requirements name. Whether one is connected is a fact about your running
      system, and nothing in this repo can check it — so every indicator stays grey until your system reports.</p>`;
  if (!systems.length) return `${head}${emptyState('The plan names no external systems yet.')}`;

  return `${head}<div class="cards">${systems.map((name) => {
    const report = data.systemStatus?.[name] ?? null;
    return `<a class="card" href="${BASE}/${encodeURIComponent(name)}">
      ${sampleChip(ctx)}
      <div class="label">System</div>
      <div class="value">${esc(name)}</div>
      <div class="sub">${statusDot(report)}<br>${esc(checkedAt(report))}</div>
      <span class="more">Open →</span>
    </a>`;
  }).join('')}</div>`;
}

function detail(name, data) {
  const report = data.systemStatus?.[name] ?? null;
  const reqs = requirementsForSystem(data.plan, name);
  const storyIds = new Set(reqs.flatMap((r) => r.fulfilled_by ?? []));
  const stories = joinStories(data.plan, data.progress).filter((s) => storyIds.has(s.id));
  return `<h1>${esc(name)}</h1>
    <p class="lede">${statusDot(report)} · ${esc(checkedAt(report))}</p>
    ${report ? '' : `<p>No running system has reported on ${esc(name)}. The plan only knows its name, so this page cannot say whether it is connected.</p>`}
    <h2>Requirements that name it</h2>
    ${reqs.length ? table(['Requirement', 'Statement'], reqs.map((r) => [reqLink(r.id), esc(r.statement)]))
      : emptyState('No requirement statement mentions this system by name.')}
    <h2>Stories that would connect it</h2>
    ${stories.length ? table(['Story', 'Title', 'State'], stories.map((s) => [storyLink(s.id), esc(s.title), stateBadge(s.state)]))
      : emptyState('No story fulfils those requirements yet — nothing is planned to connect this system.')}
    ${back(BASE, 'Systems')}`;
}
