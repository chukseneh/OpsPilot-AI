import { esc, fmtDay, num, stateBadge, card, back, table, emptyState } from '../ui.js';
import {
  projectName, projectDescriptor, joinStories, progressById, currentRelease, termPhase,
} from '../data.js';

const BASE = '#/overview';

export function renderOverview(data, sub, ctx) {
  switch (sub[0]) {
    case undefined: return summary(data, ctx);
    case 'term': return termDetail(data, ctx);
    case 'release': return releaseDetail(data, ctx);
    case 'stories': return storiesDetail(data, ctx);
    case 'criteria': return criteriaDetail(data, ctx);
    case 'points': return pointsDetail(data, ctx);
    case 'live': return liveDetail(data, ctx);
    default: return `<h1>Not found</h1><p class="lede">Overview has no page called “${esc(sub[0])}”.</p>${back(BASE, 'Overview')}`;
  }
}

function summary({ plan, progress }, ctx) {
  const t = progress.totals ?? {};
  const phase = termPhase(plan.schedule, ctx.today);
  const { release, allDone } = currentRelease(plan, progress);
  const byId = progressById(progress);
  const relVerified = release
    ? release.story_ids.filter((id) => byId.get(id)?.verification?.state === 'verified').length : 0;
  const s = plan.schedule;

  const cards = [
    card(ctx, {
      href: `${BASE}/term`, label: 'Where we are in the term', value: phase.label,
      sub: s ? `Build ${esc(fmtDay(s.build_start))} → ${esc(fmtDay(s.build_end))} · Demo day ${esc(fmtDay(s.demo_day))}`
        : 'The plan has no schedule yet.',
    }),
    card(ctx, {
      href: `${BASE}/release`, label: allDone ? 'Last release (all verified)' : 'Current release',
      value: release ? `${release.key} · ${release.name}` : 'No releases in plan',
      sub: release
        ? `${relVerified} of ${release.story_ids.length} stories verified${release.is_demo_target ? ' · demo target' : ''}`
        : '',
    }),
    card(ctx, {
      href: `${BASE}/stories`, label: 'Stories verified',
      value: `${num(t.stories_verified)} of ${num(t.stories_total)}`,
      sub: `${num(t.stories_in_progress)} in progress · ${num(t.stories_submitted)} submitted · ${num(t.stories_not_started)} not started`,
    }),
    card(ctx, {
      href: `${BASE}/criteria`, label: 'Acceptance criteria passed',
      value: `${num(t.criteria_passed)} of ${num(t.criteria_total)}`,
      sub: 'Confirmed by the platform’s verification',
    }),
    card(ctx, {
      href: `${BASE}/points`, label: 'Points awarded', value: num(t.points_awarded),
      // The platform writes this figure; if no story is verified it cannot be earned
      // work, so say so rather than let it read as a result.
      sub: t.stories_verified === 0 && t.points_awarded > 0
        ? 'As reported in progress.json. No story is verified yet, so none of this comes from finished work.'
        : 'As reported in progress.json',
    }),
    card(ctx, {
      href: `${BASE}/live`, label: 'What is live',
      value: t.stories_verified > 0 ? `${t.stories_verified} verified ${t.stories_verified === 1 ? 'story' : 'stories'}` : 'Nothing yet',
      sub: t.stories_verified > 0 ? 'Stories the platform has verified' : 'No story has been verified, so nothing is live.',
    }),
  ];

  return `<h1>${esc(projectName(plan))}</h1>
    <p class="lede">${esc(projectDescriptor(plan))}</p>
    <div class="cards">${cards.join('')}</div>`;
}

function termDetail({ plan }, ctx) {
  const s = plan.schedule;
  if (!s) return `<h1>Where we are in the term</h1>${emptyState('The plan has no schedule yet. It will appear here once the platform publishes one.')}${back(BASE, 'Overview')}`;
  const demo = (plan.releases ?? []).find((r) => r.key === s.demo_release_key);
  const roadmap = (s.roadmap_release_keys ?? []).join(', ') || 'none';
  const prep = (s.prep ?? []).map((p) => [esc(p.key), esc(p.title), esc(fmtDay(p.due_on))]);
  return `<h1>Where we are in the term</h1>
    <p class="lede">Today is ${esc(fmtDay(ctx.today))}: <strong>${esc(termPhase(s, ctx.today).label)}</strong>.</p>
    <dl class="facts">
      <dt>Build starts</dt><dd>${esc(fmtDay(s.build_start))}</dd>
      <dt>Build ends</dt><dd>${esc(fmtDay(s.build_end))}</dd>
      <dt>Demo day</dt><dd>${esc(fmtDay(s.demo_day))}</dd>
      <dt>Demo release</dt><dd>${demo ? `${esc(demo.key)} · ${esc(demo.name)}` : esc(s.demo_release_key ?? 'not set')}</dd>
      <dt>Roadmap (after this term)</dt><dd>${esc(roadmap)}</dd>
    </dl>
    <h2>Demo prep</h2>
    ${prep.length ? table(['Task', 'What', 'Due'], prep) : emptyState('No demo prep tasks in the plan.')}
    ${back(BASE, 'Overview')}`;
}

function releaseDetail({ plan, progress }) {
  const { release } = currentRelease(plan, progress);
  if (!release) return `<h1>Current release</h1>${emptyState('The plan has no releases with stories in them yet.')}${back(BASE, 'Overview')}`;
  const stories = joinStories(plan, progress).filter((s) => s.release === release.key);
  return `<h1>${esc(release.key)} · ${esc(release.name)}</h1>
    <p class="lede">${esc(release.goal)}</p>
    <dl class="facts">
      <dt>Dates</dt><dd>${esc(fmtDay(release.starts_on))} → ${esc(fmtDay(release.ends_on))}</dd>
      <dt>Demo</dt><dd>${esc(release.demo)}</dd>
      <dt>Demo target</dt><dd>${release.is_demo_target ? 'Yes — this is the release you demo' : 'No — roadmap'}</dd>
    </dl>
    <h2>Stories</h2>
    ${table(['Story', 'Title', 'Due', 'State'], stories.map((s) => [
      esc(s.id), esc(s.title), esc(fmtDay(s.due_on)), stateBadge(s.state)]))}
    ${back(BASE, 'Overview')}`;
}

function storiesDetail({ plan, progress }) {
  const rows = joinStories(plan, progress).map((s) => [
    esc(s.id), esc(s.title), esc(s.release ?? '—'), stateBadge(s.state),
    s.criteriaTotal == null ? 'not checked yet' : `${s.criteriaPassed} of ${s.criteriaTotal}`,
  ]);
  return `<h1>Stories</h1>
    <p class="lede">Every story in the plan, with its state from progress.json.</p>
    ${rows.length ? table(['Story', 'Title', 'Release', 'State', 'Criteria verified'], rows) : emptyState('The plan has no stories yet.')}
    ${back(BASE, 'Overview')}`;
}

function criteriaDetail({ plan, progress }) {
  const titles = new Map((plan.stories ?? []).map((s) => [s.id, s.title]));
  const blocks = (progress.stories ?? []).map((s) => {
    const items = (s.criteria ?? []).map((c) =>
      `<li>${c.passed ? '☑' : '☐'} ${esc(c.text)}</li>`).join('');
    const title = titles.get(s.id) ?? 'Not in plan.json (platform story)';
    return `<h2>${esc(s.id)} — ${esc(title)}</h2>
      <p class="muted">Verified by the platform: ${s.verification
        ? `${s.verification.criteria_passed} of ${s.verification.criteria_total}` : 'not checked yet'}</p>
      ${items ? `<ul class="plain" style="list-style:none;padding-left:0">${items}</ul>` : emptyState('No criteria listed.')}`;
  });
  return `<h1>Acceptance criteria</h1>
    <p class="lede">☑ means the line is ticked in progress.json (a claim). The platform's count
      above each list is what it has confirmed.</p>
    ${blocks.join('') || emptyState('progress.json lists no stories yet.')}
    ${back(BASE, 'Overview')}`;
}

function pointsDetail({ plan, progress }) {
  const titles = new Map((plan.stories ?? []).map((s) => [s.id, s.title]));
  const rows = (progress.stories ?? []).map((s) => [
    esc(s.id), esc(titles.get(s.id) ?? 'Not in plan.json (platform story)'),
    stateBadge(s.verification?.state ?? null),
    s.verification ? esc(num(s.verification.points_awarded)) : 'not checked yet',
  ]);
  return `<h1>Points</h1>
    <p class="lede">Total in progress.json: <strong>${esc(num(progress.totals?.points_awarded))}</strong>.
      Per-story values are shown exactly as the platform wrote them.</p>
    ${rows.length ? table(['Story', 'Title', 'State', 'points_awarded'], rows) : emptyState('progress.json lists no stories yet.')}
    ${back(BASE, 'Overview')}`;
}

function liveDetail({ plan, progress }) {
  const titles = new Map((plan.stories ?? []).map((s) => [s.id, s.title]));
  const verified = (progress.stories ?? []).filter((s) => s.verification?.state === 'verified');
  const body = verified.length
    ? table(['Story', 'Title', 'Verified', 'Commit'], verified.map((s) => [
      esc(s.id), esc(titles.get(s.id) ?? '—'),
      esc(s.verification.verified_at ? new Date(s.verification.verified_at).toLocaleDateString('en-GB') : '—'),
      s.verification.commit_url ? `<a href="${esc(s.verification.commit_url)}">${esc((s.verification.commit_sha ?? 'commit').slice(0, 7))}</a>` : '—',
    ]))
    : emptyState('Nothing is live yet. A story counts as live here once the platform has verified it — every acceptance criterion ticked and a commit that names it.');
  return `<h1>What is live</h1>
    <p class="lede">Only stories the platform has verified. Anything else is still being built.</p>
    ${body}
    ${back(BASE, 'Overview')}`;
}
