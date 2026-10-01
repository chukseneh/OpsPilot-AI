import { esc, fmtDay, back, table, emptyState, notFound, stateBadge, storyLink, reqLink, plural } from '../ui.js';
import { joinStories, progressById, daysBetween } from '../data.js';

const BASE = '#/project';

export function renderProject(data, sub, ctx) {
  if (sub[0] === 'story') return storyDetail(data, sub[1]);
  if (sub[0] === 'release') return releaseDetail(data, sub[1]);
  if (sub[0] === 'prep') return prepDetail(data);
  if (sub[0]) return notFound(`Project has no page called “${sub[0]}”.`, BASE, 'Project');
  return summary(data, ctx);
}

// ---- Gantt ----

function timelineRange(plan) {
  const s = plan.schedule ?? {};
  const dates = [
    s.build_start, s.build_end, s.demo_day,
    ...(plan.releases ?? []).flatMap((r) => [r.starts_on, r.ends_on]),
    ...(s.prep ?? []).map((p) => p.due_on),
  ].filter(Boolean).sort();
  return dates.length ? { from: dates[0], to: dates.at(-1) } : null;
}

function gantt(plan, ctx) {
  const range = timelineRange(plan);
  if (!range) return emptyState('No release in the plan has dates yet, so there is nothing to draw.');
  const days = daysBetween(range.from, range.to) + 1;
  const pct = (ymd) => (daysBetween(range.from, ymd) / days) * 100;
  const span = (a, b) => ((daysBetween(a, b) + 1) / days) * 100;
  const s = plan.schedule ?? {};
  const marker = (ymd, cls, title) => (ymd && ymd >= range.from && ymd <= range.to
    ? `<span class="gantt-marker ${cls}" style="left:${pct(ymd) + 50 / days}%" title="${esc(title)}"></span>` : '');
  const markers = marker(s.demo_day, 'marker-demo', `Demo day ${fmtDay(s.demo_day)}`)
    + marker(ctx.today, 'marker-today', `Today ${fmtDay(ctx.today)}`);

  const rows = (plan.releases ?? []).map((r) => {
    const roadmap = !r.is_demo_target && (s.roadmap_release_keys ?? []).includes(r.key);
    const bar = r.starts_on && r.ends_on
      ? `<span class="gantt-bar${r.is_demo_target ? ' bar-demo' : ''}${roadmap ? ' bar-roadmap' : ''}" style="left:${pct(r.starts_on)}%;width:${span(r.starts_on, r.ends_on)}%"></span>`
      : '<span class="gantt-nodate">no dates</span>';
    const tag = r.is_demo_target ? '<span class="chip chip-demo">DEMO TARGET</span>' : roadmap ? '<span class="chip chip-roadmap">ROADMAP</span>' : '';
    return `<a class="gantt-row" href="${BASE}/release/${encodeURIComponent(r.key)}">
      <span class="gantt-label"><strong>${esc(r.key)}</strong> ${esc(r.name)} ${tag}<br>
        <small class="muted">${plural((r.story_ids ?? []).length, 'story', 'stories')} · ${esc(fmtDay(r.starts_on))} → ${esc(fmtDay(r.ends_on))}</small></span>
      <span class="gantt-track">${bar}${markers}</span>
    </a>`;
  }).join('');

  return `<div class="gantt">
    <div class="gantt-axis"><span>${esc(fmtDay(range.from))}</span><span>${esc(fmtDay(range.to))}</span></div>
    ${rows}
    <p class="gantt-legend muted"><span class="legend-swatch marker-demo"></span> Demo day
      <span class="legend-swatch marker-today"></span> Today
      <span class="legend-swatch bar-demo"></span> Demo target (this term)
      <span class="legend-swatch bar-roadmap"></span> Roadmap</p>
  </div>`;
}

function slip(story) {
  if (!story.due_on || !story.due_baseline_on) return '—';
  const d = daysBetween(story.due_baseline_on, story.due_on);
  if (d === 0) return 'On original date';
  return `<span class="${d > 0 ? 'slip-late' : ''}">${d > 0 ? '+' : ''}${plural(d, 'day', 'days')}</span>`;
}

function orderedStories(plan, progress) {
  const order = new Map((plan.releases ?? []).map((r, i) => [r.key, i]));
  return joinStories(plan, progress)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (order.get(a.s.release) ?? 99) - (order.get(b.s.release) ?? 99) || a.i - b.i)
    .map(({ s }) => s);
}

function summary({ plan, progress }, ctx) {
  const s = plan.schedule;
  const stories = orderedStories(plan, progress);
  const prepCount = (s?.prep ?? []).length;
  return `<h1>Project management</h1>
    <p class="lede">${s
      ? `Build ${esc(fmtDay(s.build_start))} → ${esc(fmtDay(s.build_end))}. Demo day ${esc(fmtDay(s.demo_day))}${s.demo_release_key ? `, demoing <strong>${esc(s.demo_release_key)}</strong>` : ''}. Releases after it are the roadmap.`
      : 'The plan has no schedule yet.'}</p>
    ${gantt(plan, ctx)}
    <h2>Tasks</h2>
    <p class="muted">Due is the current date; Original is the date first given. The gap between them is slippage.</p>
    ${stories.length ? table(['Story', 'Title', 'Release', 'Due', 'Original', 'Slip', 'State'], stories.map((st) => [
      storyLink(st.id), esc(st.title), esc(st.release ?? '—'), esc(fmtDay(st.due_on)), esc(fmtDay(st.due_baseline_on)), slip(st), stateBadge(st.state),
    ])) : emptyState('The plan has no stories yet.')}
    <h2>Demo prep</h2>
    <p><a href="${BASE}/prep">${prepCount ? `${plural(prepCount, 'prep task', 'prep tasks')} between build end and demo day →` : 'No demo prep tasks in the plan →'}</a></p>`;
}

function releaseDetail({ plan, progress }, key) {
  const r = (plan.releases ?? []).find((x) => x.key === key);
  if (!r) return notFound(`No release called “${key}” in the plan.`, BASE, 'Project');
  const ids = new Set(r.story_ids ?? []);
  const stories = joinStories(plan, progress).filter((s) => ids.has(s.id));
  return `<h1>${esc(r.key)} · ${esc(r.name)}</h1>
    <p class="lede">${esc(r.goal)}</p>
    <dl class="facts">
      <dt>Dates</dt><dd>${esc(fmtDay(r.starts_on))} → ${esc(fmtDay(r.ends_on))} (weeks ${esc(r.week_start)}–${esc(r.week_end)})</dd>
      <dt>Demo</dt><dd>${esc(r.demo)}</dd>
      <dt>Demo target</dt><dd>${r.is_demo_target ? 'Yes — this term’s work' : 'No — roadmap'}</dd>
    </dl>
    <h2>Stories</h2>
    ${stories.length ? table(['Story', 'Title', 'Due', 'State'], stories.map((s) => [storyLink(s.id), esc(s.title), esc(fmtDay(s.due_on)), stateBadge(s.state)]))
      : emptyState('This release has no stories.')}
    ${back(BASE, 'Project')}`;
}

function prepDetail({ plan }) {
  const prep = plan.schedule?.prep ?? [];
  return `<h1>Demo prep</h1>
    <p class="lede">The week between build end and demo day.</p>
    ${prep.length ? table(['Task', 'What', 'Due'], prep.map((p) => [esc(p.key), esc(p.title), esc(fmtDay(p.due_on))]))
      : emptyState('No demo prep tasks in the plan.')}
    ${back(BASE, 'Project')}`;
}

function storyDetail({ plan, progress }, id) {
  const story = joinStories(plan, progress).find((s) => s.id === id);
  if (!story) return notFound(`No story called “${id}” in the plan.`, BASE, 'Project');
  const p = progressById(progress).get(id);
  const ticks = new Map((p?.criteria ?? []).map((c) => [c.text, c.passed]));
  const list = (items, empty) => (items?.length ? `<ul class="plain">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`);
  return `<h1>${esc(story.id)} — ${esc(story.title)}</h1>
    <p class="lede">${esc(story.narrative)}</p>
    <dl class="facts">
      <dt>State</dt><dd>${stateBadge(story.state)}</dd>
      <dt>Release</dt><dd>${story.release ? `<a href="${BASE}/release/${encodeURIComponent(story.release)}">${esc(story.release)}</a>` : '—'}</dd>
      <dt>Due</dt><dd>${esc(fmtDay(story.due_on))} (original ${esc(fmtDay(story.due_baseline_on))}) · ${slip(story)}</dd>
      <dt>Owner</dt><dd>${esc(story.owner_agent ?? '—')}</dd>
      <dt>Fulfils</dt><dd>${(story.fulfills ?? []).map(reqLink).join(', ') || '—'}</dd>
      <dt>Blocked by</dt><dd>${(story.blocked_by ?? []).map(storyLink).join(', ') || 'nothing'}</dd>
      <dt>Commit</dt><dd>${story.commitUrl ? `<a href="${esc(story.commitUrl)}">view commit</a>` : 'none recorded'}</dd>
    </dl>
    <h2>Acceptance criteria</h2>
    <ul class="plain" style="list-style:none;padding-left:0">${(story.acceptance ?? []).map((t) =>
      `<li>${ticks.get(t) ? '☑' : '☐'} ${esc(t)}</li>`).join('')}</ul>
    <p class="muted">☑ = ticked in progress.json. Verified by the platform: ${story.criteriaTotal == null ? 'not checked yet' : `${story.criteriaPassed} of ${story.criteriaTotal}`}.</p>
    <h2>Failure paths to handle</h2>
    ${list(story.failure_paths, 'None listed.')}
    <h2>Guidance</h2>
    <p>${esc(story.task_guidance ?? 'None.')}</p>
    ${back(BASE, 'Project')}`;
}
