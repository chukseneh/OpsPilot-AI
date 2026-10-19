// Did the simulated workflows do what was expected? (STORY-010, acceptance 1, and
// the "unexpected workflow behaviour" failure path.)
//
//   compareResults(scenario, run) → { verdict, workflows, summary, error? }
//
// Every step's risk level and outcome, and every workflow's final status, is
// compared with what the scenario declared. The verdict:
//   passed     — everything matched: the workflows executed as expected
//   failed     — at least one mismatch, each described: expected, actual, and the
//                engine's reasons
//   timed_out  — the run hit its time limit; workflows that did not finish are
//                listed as UNCHECKED, never counted as passing
//   error      — the run itself failed; nothing could be checked
//
// A mismatch is CRITICAL when a step expected to be high risk was treated as low:
// it ran without a person, which is exactly what REQ-007 forbids. Others are normal.

const DESCRIBE = {
  succeeded: 'succeeded', awaiting_approval: 'waiting for approval', approved: 'approved', pending: 'not reached',
  failed: 'failed', rejected: 'rejected', expired: 'expired', skipped: 'skipped', running: 'still running',
};
const describe = (riskLevel, outcome) => [riskLevel ? `${riskLevel} risk` : null, DESCRIBE[outcome] ?? outcome ?? 'missing'].filter(Boolean).join(', ');

export function compareResults(scenario, run) {
  const reported = new Map((run.workflows ?? []).map((w) => [w.id, w]));
  const workflows = scenario.workflows.map((w) => {
    const actual = reported.get(w.id);
    if (!actual || run.status === 'error') {
      return { id: w.id, verdict: 'unchecked', mismatches: [], reason: run.status === 'timed_out' ? 'did not finish before the time limit' : 'the run failed before it was checked' };
    }
    const mismatches = [];
    const mismatch = (step, field, expected, got, message, severity = 'normal') => mismatches.push({ step, field, expected, actual: got, severity, message: `${w.id}${step ? ` step ${step}` : ''}: ${message}` });

    w.expect.steps.forEach((e, j) => {
      const a = actual.actions[j];
      const step = j + 1;
      if (!a) { mismatch(step, 'step', describe(e.riskLevel, e.outcome), 'missing', `expected ${describe(e.riskLevel, e.outcome)}; the step does not exist in the run`); return; }
      const sameRisk = e.riskLevel === undefined || e.riskLevel === a.riskLevel;
      if (!sameRisk || e.outcome !== a.outcome) {
        const unattended = e.riskLevel === 'high' && a.riskLevel === 'low';
        mismatch(step, sameRisk ? 'outcome' : 'riskLevel', describe(e.riskLevel, e.outcome), describe(a.riskLevel, a.outcome),
          `expected ${describe(e.riskLevel, e.outcome)}; got ${describe(a.riskLevel, a.outcome)}${unattended ? ' (it ran without a person)' : ''}${a.reasons?.length ? ` [engine reasons: ${a.reasons.join(', ')}]` : ''}${a.error ? ` [error: ${a.error}]` : ''}`,
          unattended ? 'critical' : 'normal');
      }
    });
    if (actual.actions.length > w.expect.steps.length) {
      mismatch(null, 'steps', `${w.expect.steps.length} step(s)`, `${actual.actions.length} step(s)`, `the run has ${actual.actions.length - w.expect.steps.length} more step(s) than expected`);
    }
    if (actual.status !== w.expect.final) {
      mismatch(null, 'final', w.expect.final, actual.status, `expected the workflow to end ${w.expect.final}; it ended ${actual.status}`);
    }
    for (const d of actual.decisionErrors ?? []) {
      mismatch(d.step, 'decision', `${d.decision} accepted`, 'refused', `the scripted ${d.decision} of step ${d.step} was refused: ${d.error}`);
    }
    const stepsMismatched = new Set(mismatches.filter((m) => m.step).map((m) => m.step)).size;
    return { id: w.id, verdict: mismatches.length ? 'failed' : 'passed', mismatches, stepsMismatched };
  });

  const count = (v) => workflows.filter((w) => w.verdict === v).length;
  const all = workflows.flatMap((w) => w.mismatches);
  const checked = workflows.filter((w) => w.verdict !== 'unchecked');
  const stepsChecked = checked.reduce((n, w) => n + scenario.workflows.find((x) => x.id === w.id).expect.steps.length, 0);
  const stepsMismatched = checked.reduce((n, w) => n + w.stepsMismatched, 0);
  const summary = {
    workflows: { total: workflows.length, passed: count('passed'), failed: count('failed'), unchecked: count('unchecked') },
    steps: { checked: stepsChecked, matched: stepsChecked - stepsMismatched, mismatched: stepsMismatched },
    critical: all.filter((m) => m.severity === 'critical').length,
  };
  const verdict = run.status === 'error' ? 'error' : run.status === 'timed_out' ? 'timed_out' : summary.workflows.failed ? 'failed' : 'passed';
  return { verdict, workflows, summary, ...(run.error ? { error: run.error } : {}) };
}
