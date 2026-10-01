import { esc, card, back, emptyState, notFound, plural, stateBadge, storyLink } from '../ui.js';
import { storiesForRole, joinStories } from '../data.js';

const BASE = '#/users';

export function renderUsers(data, sub, ctx) {
  const roles = data.plan.derived?.roles ?? [];
  if (sub[0]) {
    const role = roles.find((r) => r === sub[0]);
    return role ? detail(role, data) : notFound(`No role called “${sub[0]}” in the plan.`, BASE, 'Users');
  }
  const head = `<h1>Users and use case</h1>
    <p class="lede">Who this is for and what they are trying to get done — the roles your stories are written for.</p>`;
  if (!roles.length) return `${head}${emptyState('The plan lists no roles yet.')}`;

  return `${head}<div class="cards">${roles.map((role) => {
    const stories = storiesForRole(data.plan, role);
    return card(ctx, {
      href: `${BASE}/${encodeURIComponent(role)}`, label: 'Role', value: role,
      sub: stories.length ? `${plural(stories.length, 'story', 'stories')}: ${stories.map((s) => esc(s.id)).join(', ')}`
        : 'Named in the plan; no story narrative matches it yet.',
    });
  }).join('')}</div>`;
}

function detail(role, data) {
  const ids = new Set(storiesForRole(data.plan, role).map((s) => s.id));
  const stories = joinStories(data.plan, data.progress).filter((s) => ids.has(s.id));
  const body = stories.length
    ? stories.map((s) => `<h2>${storyLink(s.id)} — ${esc(s.title)}</h2>
        <p>${esc(s.narrative)}</p>
        <p class="muted">Release ${esc(s.release ?? '—')} · ${stateBadge(s.state)}</p>`).join('')
    : emptyState('No story in the plan is written for this role yet.');
  return `<h1>${esc(role)}</h1>
    <p class="lede">What this role wants, in the words of the stories written for it.</p>
    ${body}
    ${back(BASE, 'Users')}`;
}
