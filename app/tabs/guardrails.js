import { esc, card, back, table, emptyState, notFound, stateBadge, storyLink, coverageBadge } from '../ui.js';
import { coverage, joinStories } from '../data.js';

const BASE = '#/guardrails';

const verdict = (c) => ({
  verified: 'Enforced — every story behind it is verified.',
  open: 'A promise you have made and not yet kept.',
  gap: 'A promise you have made and not yet kept — and no story is planned to keep it.',
}[c.key]);

export function renderGuardrails(data, sub, ctx) {
  const { plan, progress } = data;
  const guardrails = plan.derived?.guardrails ?? [];
  const reqById = new Map((plan.requirements ?? []).map((r) => [r.id, r]));
  if (sub[0] === 'about') return about();
  if (sub[0]) {
    const g = guardrails.find((x) => x.id === sub[0]);
    return g ? detail(g, reqById.get(g.id), data) : notFound(`No guardrail called “${sub[0]}” in the plan.`, BASE, 'Guardrails');
  }

  const head = `<h1>Guardrails — what must never happen</h1>
    <p class="lede">The promises this system makes, and whether anything in the build enforces each one yet.</p>`;
  if (!guardrails.length) {
    return `${head}<div class="banner banner-warn">Your plan has no SAFE requirement, so this system makes no promises yet. That is worth fixing in the portal before building further.</div>
      <div class="cards">${card(ctx, { href: `${BASE}/about`, label: 'No guardrails', value: 'None defined', sub: 'What belongs here.' })}</div>`;
  }

  return `${head}<div class="cards">${guardrails.map((g) => {
    const c = coverage(reqById.get(g.id) ?? { fulfilled_by: [] }, progress);
    return card(ctx, {
      href: `${BASE}/${encodeURIComponent(g.id)}`, label: g.id,
      value: c.key === 'verified' ? 'Enforced' : 'Not yet enforced',
      sub: `${esc(g.statement)}<br><br>${esc(verdict(c))}`,
    });
  }).join('')}</div>`;
}

function about() {
  return `<h1>Guardrails</h1>
    <p class="lede">A guardrail is a SAFE requirement: something the system must never do, or must always do. Add one in the portal and it arrives here on the next sync.</p>
    ${back(BASE, 'Guardrails')}`;
}

function detail(g, req, { plan, progress }) {
  const c = coverage(req ?? { fulfilled_by: [] }, progress);
  const ids = new Set(req?.fulfilled_by ?? []);
  const stories = joinStories(plan, progress).filter((s) => ids.has(s.id));
  return `<h1>${esc(g.id)}</h1>
    <p class="lede">${esc(g.statement)}</p>
    <p>${coverageBadge(c)} ${esc(verdict(c))}</p>
    <h2>Stories that enforce it</h2>
    ${stories.length
      ? table(['Story', 'Title', 'Release', 'State'], stories.map((s) => [storyLink(s.id), esc(s.title), esc(s.release ?? '—'), stateBadge(s.state)]))
      : emptyState('No story in the plan fulfils this guardrail.')}
    ${back(BASE, 'Guardrails')}`;
}
