// Sample mode: believable made-up progress laid over the REAL plan, so the
// shape of every tab is visible on day one. Built from the plan at runtime —
// delete a story from plan.json and it disappears here too. The returned
// object carries sample: true, which the shell turns into a banner on every
// screen and a SAMPLE chip on every card.

const SAMPLE_VERIFIED_AT = '2026-09-28T15:00:00.000Z';
const SAMPLE_POINTS_PER_STORY = 80;

export function makeSample(real) {
  const plan = structuredClone(real.plan);
  const progress = structuredClone(real.progress);

  // Build order: release by release, stories in the order each release lists them.
  const storyById = new Map((plan.stories ?? []).map((s) => [s.id, s]));
  const ordered = [];
  for (const r of plan.releases ?? []) {
    for (const id of r.story_ids ?? []) if (storyById.has(id)) ordered.push(storyById.get(id));
  }
  for (const s of plan.stories ?? []) if (!ordered.includes(s)) ordered.push(s);

  const n = ordered.length;
  const stateAt = (i) => {
    if (i < Math.ceil(n * 0.3)) return 'verified';
    if (i < Math.ceil(n * 0.4)) return 'submitted';
    if (i < Math.ceil(n * 0.6)) return 'in_progress';
    return 'not_started';
  };

  progress.stories = ordered.map((story, i) => {
    const state = stateAt(i);
    const acceptance = story.acceptance ?? [];
    const total = acceptance.length;
    const passed = state === 'verified' || state === 'submitted' ? total
      : state === 'in_progress' ? Math.floor(total / 2) : 0;
    return {
      id: story.id,
      release: story.release ?? null,
      acceptance_total: total,
      criteria: acceptance.map((text, j) => ({ text, passed: j < passed })),
      files_touched: [],
      tests_added: [],
      notes: 'Sample data',
      updated_at: null,
      verification: {
        state,
        criteria_passed: state === 'verified' ? total : 0,
        criteria_total: total,
        verified_at: state === 'verified' ? SAMPLE_VERIFIED_AT : null,
        commit_sha: null,
        commit_url: null,
        commit_at: null,
        points_awarded: state === 'verified' ? SAMPLE_POINTS_PER_STORY : 0,
        outstanding: acceptance.slice(state === 'verified' ? total : 0),
      },
    };
  });

  const count = (st) => progress.stories.filter((s) => s.verification.state === st).length;
  progress.totals = {
    stories_total: n,
    stories_verified: count('verified'),
    stories_submitted: count('submitted'),
    stories_in_progress: count('in_progress'),
    stories_not_started: count('not_started'),
    criteria_total: progress.stories.reduce((a, s) => a + s.verification.criteria_total, 0),
    criteria_passed: progress.stories.reduce((a, s) => a + s.verification.criteria_passed, 0),
    points_awarded: progress.stories.reduce((a, s) => a + s.verification.points_awarded, 0),
  };

  // Measures: the real plan may have none yet, so sample mode supplies some.
  if (!(plan.derived?.measures ?? []).length) {
    plan.derived = {
      ...plan.derived,
      measures: [
        { id: 'SAMPLE-M1', statement: 'Reduce the average turnaround time for approvals.' },
        { id: 'SAMPLE-M2', statement: 'Increase the share of routine requests handled without manual rework.' },
        { id: 'SAMPLE-M3', statement: 'Cut the hours spent on manual document data entry each week.' },
      ],
    };
  }
  const SAMPLE_VALUES = [
    { baseline: '4.2 days', current: '3.1 days', target: '2 days' },
    { baseline: '35%', current: '52%', target: '70%' },
    { baseline: '40 h/week', current: '26 h/week', target: '15 h/week' },
  ];
  const measurements = Object.fromEntries(plan.derived.measures.map((m, i) => [m.id, SAMPLE_VALUES[i % SAMPLE_VALUES.length]]));

  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const STATUSES = ['connected', 'connected', 'error', 'not_connected'];
  const systemStatus = Object.fromEntries((plan.derived?.systems ?? []).map((name, i) => [
    name, { status: STATUSES[i % STATUSES.length], checked_at: hoursAgo(i + 1) },
  ]));

  const owners = [...new Set((plan.stories ?? []).map((s) => s.owner_agent).filter(Boolean))];
  const agentRuns = Object.fromEntries(owners.map((name, i) => [
    name, i % 3 === 2 ? null : { runs: 6 + i * 3, succeeded: 5 + i * 3, last_run_at: hoursAgo(2 + i) },
  ]));

  return { ...real, plan, progress, measurements, systemStatus, agentRuns, sample: true };
}
