import { esc, card, back, emptyState, notFound } from '../ui.js';

const BASE = '#/outcomes';

export function renderOutcomes(data, sub, ctx) {
  const measures = data.plan.derived?.measures ?? [];
  if (sub[0] === 'about') return about();
  if (sub[0]) {
    const m = measures.find((x) => x.id === sub[0]);
    return m ? detail(m, data) : notFound(`No measure called “${sub[0]}” in the plan.`, BASE, 'Outcomes');
  }

  const head = `<h1>Outcomes</h1>
    <p class="lede">The numbers this system has to move. One card per measure in <code>plan.derived.measures</code>.</p>`;

  if (!measures.length) {
    return `${head}
      ${emptyState('Your plan carries no measures yet — there is no numeric target to show. Nothing here is invented to fill the gap.')}
      <div class="cards" style="margin-top:12px">${card(ctx, {
        href: `${BASE}/about`, label: 'No measures defined', value: 'Not set yet',
        sub: 'What will appear here, and what has to happen first.',
      })}</div>`;
  }

  return `${head}<div class="cards">${measures.map((m) => {
    const v = data.measurements?.[m.id];
    return card(ctx, {
      href: `${BASE}/${encodeURIComponent(m.id)}`, label: m.id,
      value: v?.current ?? 'Not measured yet',
      sub: esc(m.statement),
    });
  }).join('')}</div>`;
}

function about() {
  return `<h1>Outcome measures</h1>
    <p class="lede">Each measure the plan commits to gets a card here showing its baseline, its current value and its target.</p>
    <h2>What has to happen first</h2>
    <ul class="plain">
      <li>The plan needs measures — numeric targets agreed in the portal. They arrive in <code>plan.derived.measures</code> on the next sync.</li>
      <li>Current values come from your running system once it measures something. The plan only ever holds the target, never the measurement.</li>
    </ul>
    ${back(BASE, 'Outcomes')}`;
}

function detail(m, data) {
  const v = data.measurements?.[m.id];
  return `<h1>${esc(m.id)}</h1>
    <p class="lede">${esc(m.statement)}</p>
    <dl class="facts">
      <dt>Baseline</dt><dd>${esc(v?.baseline ?? 'Not measured yet')}</dd>
      <dt>Current</dt><dd>${esc(v?.current ?? 'Not measured yet — your running system reports this; nothing in the repo can')}</dd>
      <dt>Target</dt><dd>${esc(v?.target ?? 'No numeric target in the plan yet')}</dd>
    </dl>
    ${back(BASE, 'Outcomes')}`;
}
