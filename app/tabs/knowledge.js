import { esc, card, back, table, emptyState, notFound, stateBadge, storyLink, reqLink, coverageBadge, fmtDay, plural } from '../ui.js';
import { coverage, joinStories } from '../data.js';
import { answer } from '../ask.js';

const BASE = '#/knowledge';

// Questions asked this session; kept across re-renders, gone on reload.
const askLog = [];

export function renderKnowledge(data, sub, ctx) {
  switch (sub[0]) {
    case undefined: return summary(data, ctx);
    case 'requirements': return requirements(data);
    case 'requirement': return requirement(data, sub[1]);
    case 'traceability': return traceability(data);
    case 'stories': return stories(data);
    case 'decisions': return decisions(data);
    case 'notes': return notes(data);
    default: return notFound(`Knowledge base has no page called “${sub[0]}”.`, BASE, 'Knowledge base');
  }
}

function summary(data, ctx) {
  const { plan, progress, knowledge } = data;
  const reqs = plan.requirements ?? [];
  const mustGaps = reqs.filter((r) => r.priority === 'must' && !(r.fulfilled_by ?? []).length).length;
  const verifiedStories = joinStories(plan, progress).filter((s) => s.state === 'verified').length;
  const dec = knowledge?.decisions ?? [];
  const nts = knowledge?.notes ?? [];
  return `<h1>Knowledge base</h1>
    <p class="lede">Everything the project knows about itself. Requirements and stories come from the plan;
      decisions and notes live in <code>knowledge/notes.json</code> and grow as you go.</p>
    <div class="cards">
      ${card(ctx, { href: `${BASE}/requirements`, label: 'Requirements', value: String(reqs.length), sub: 'Every requirement in the plan, by kind and priority.' })}
      ${card(ctx, { href: `${BASE}/traceability`, label: 'Traceability', value: mustGaps ? plural(mustGaps, 'must-have gap', 'must-have gaps') : 'No must-have gaps', sub: 'Each requirement, the stories that cover it, and whether they are verified.' })}
      ${card(ctx, { href: `${BASE}/stories`, label: 'Stories', value: `${verifiedStories} of ${(plan.stories ?? []).length} verified`, sub: 'Every story in the plan.' })}
      ${card(ctx, { href: `${BASE}/decisions`, label: 'Decisions', value: String(dec.length), sub: 'Choices made while building, with the reason and the evidence.' })}
      ${card(ctx, { href: `${BASE}/notes`, label: 'Notes', value: String(nts.length), sub: 'Anything else worth remembering.' })}
    </div>
    <h2>Ask about this data</h2>
    <p class="muted">Answers come only from the data on these tabs, and each one says which tab. If the data cannot answer, it says so.</p>
    <form class="ask" id="ask-form" autocomplete="off">
      <input name="q" type="text" placeholder="e.g. Which requirements have no story?  What is REQ-008?  When is demo day?" aria-label="Question">
      <button type="submit">Ask</button>
    </form>
    <div class="ask-log" id="ask-log">${askLog.map(renderExchange).join('')}</div>`;
}

function renderExchange({ q, a }) {
  return `<div class="ask-q">${esc(q)}</div>
    <div class="ask-a">${esc(a.text)}${a.source ? `<div class="ask-cite">Source: <a href="${esc(a.href)}">${esc(a.source)}</a> tab</div>` : ''}</div>`;
}

// Called by the shell after the view is in the DOM.
export function mountKnowledge(root, data) {
  const form = root.querySelector('#ask-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return;
    askLog.push({ q, a: answer(q, data) });
    root.querySelector('#ask-log').innerHTML = askLog.map(renderExchange).join('');
    form.q.value = '';
  });
}

function requirements({ plan, progress }) {
  const reqs = plan.requirements ?? [];
  return `<h1>Requirements</h1>
    <p class="lede">${plural(reqs.length, 'requirement', 'requirements')} in the plan.</p>
    ${reqs.length ? table(['ID', 'Kind', 'Priority', 'Cluster', 'Statement', 'Coverage'], reqs.map((r) => [
      reqLink(r.id), esc(r.kind), esc(r.priority), esc(r.cluster), esc(r.statement), coverageBadge(coverage(r, progress)),
    ])) : emptyState('The plan has no requirements yet.')}
    ${back(BASE, 'Knowledge base')}`;
}

function requirement({ plan, progress }, id) {
  const r = (plan.requirements ?? []).find((x) => x.id === id);
  if (!r) return notFound(`No requirement called “${id}” in the plan.`, BASE, 'Knowledge base');
  const ids = new Set(r.fulfilled_by ?? []);
  const covering = joinStories(plan, progress).filter((s) => ids.has(s.id));
  return `<h1>${esc(r.id)}</h1>
    <p class="lede">${esc(r.statement)}</p>
    <dl class="facts">
      <dt>Kind</dt><dd>${esc(r.kind)}</dd>
      <dt>Priority</dt><dd>${esc(r.priority)}</dd>
      <dt>Cluster</dt><dd>${esc(r.cluster)}</dd>
      <dt>Coverage</dt><dd>${coverageBadge(coverage(r, progress))}</dd>
    </dl>
    <h2>Stories that fulfil it</h2>
    ${covering.length ? table(['Story', 'Title', 'State'], covering.map((s) => [storyLink(s.id), esc(s.title), stateBadge(s.state)]))
      : emptyState(r.priority === 'must' ? 'No story covers this must-have requirement. That is a real gap in the plan.' : 'No story covers this requirement yet.')}
    ${back(`${BASE}/requirements`, 'Requirements')}`;
}

function traceability({ plan, progress }) {
  const reqs = plan.requirements ?? [];
  return `<h1>Traceability</h1>
    <p class="lede">Every requirement, the stories that cover it, and whether those stories are verified.
      A must-have with no story is a gap, and it is shown, not hidden.</p>
    ${reqs.length ? table(['Requirement', 'Priority', 'Statement', 'Stories', 'Status'], reqs.map((r) => {
      const c = coverage(r, progress);
      const gap = c.key === 'gap' && r.priority === 'must';
      return [
        reqLink(r.id), esc(r.priority), esc(r.statement),
        (r.fulfilled_by ?? []).map(storyLink).join(', ') || (gap ? '<strong class="gap">GAP — none</strong>' : 'none'),
        coverageBadge(c),
      ];
    })) : emptyState('The plan has no requirements yet.')}
    ${back(BASE, 'Knowledge base')}`;
}

function stories({ plan, progress }) {
  const rows = joinStories(plan, progress);
  return `<h1>Stories</h1>
    ${rows.length ? table(['Story', 'Title', 'Release', 'Fulfils', 'State'], rows.map((s) => [
      storyLink(s.id), esc(s.title), esc(s.release ?? '—'), (s.fulfills ?? []).map(reqLink).join(', ') || '—', stateBadge(s.state),
    ])) : emptyState('The plan has no stories yet.')}
    ${back(BASE, 'Knowledge base')}`;
}

function decisions({ knowledge }) {
  const list = knowledge?.decisions ?? [];
  return `<h1>Decisions</h1>
    <p class="lede">Add one to <code>knowledge/notes.json</code> whenever you make a choice someone will later ask about.</p>
    ${list.length ? table(['ID', 'Date', 'Decision', 'Why', 'Evidence'], list.map((d) => [
      esc(d.id), esc(fmtDay(d.date)), esc(d.statement), esc(d.rationale), `<code>${esc(d.evidence ?? '—')}</code>`,
    ])) : emptyState(knowledge ? 'No decisions recorded yet.' : 'knowledge/notes.json is not in the repo yet.')}
    ${back(BASE, 'Knowledge base')}`;
}

function notes({ knowledge }) {
  const list = knowledge?.notes ?? [];
  return `<h1>Notes</h1>
    <p class="lede">Free-form notes. Add them to the <code>notes</code> list in <code>knowledge/notes.json</code>.</p>
    ${list.length ? list.map((n) => `<div class="notice" style="margin-bottom:8px"><strong>${esc(fmtDay(n.date))}</strong> — ${esc(n.text)}</div>`).join('')
      : emptyState('No notes yet.')}
    ${back(BASE, 'Knowledge base')}`;
}
