// The STORY-010 demo runs end to end. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSimulationDemo } from '../src/demo/simulation.js';
import { isDecision } from '../src/audit/decisions.js';

test('demo: expected runs pass, incorrect data is refused, unexpected behaviour is flagged, all logged, live system untouched', async () => {
  const r = await runSimulationDemo({ print: () => {} });

  // Acceptance 1: executes as expected — hand-written (with EU policy) and generated.
  assert.equal(r.passed.verdict, 'passed');
  assert.deepEqual(r.passed.summary.steps, { checked: 5, matched: 5, mismatched: 0 });
  assert.equal(r.generated.verdict, 'passed');
  assert.equal(r.generated.summary.workflows.passed, 10);

  // Acceptance 2: incorrect synthetic data flagged; nothing ran.
  assert.equal(r.incorrect.name, 'ScenarioError');
  assert.ok(r.incorrect.problems.some((p) => /only data marked as synthetic/.test(p.problem)));

  // Unexpected behaviour: both directions, graded honestly.
  assert.equal(r.unexpected.verdict, 'failed');
  assert.equal(r.unexpected.summary.critical, 0, 'the engine being stricter than expected is not critical');
  assert.equal(r.critical.verdict, 'failed');
  assert.equal(r.critical.summary.critical, 1, 'a step that should have needed a person running without one is critical');

  // Data generation error and timeout.
  assert.equal(r.generationError.generated, true);
  assert.equal(r.timedOut.verdict, 'timed_out');
  assert.ok(r.timedOut.summary.workflows.unchecked > 0);

  // Trust: logged for review; nothing reached the live system; chain intact.
  const completed = r.entries.filter((e) => e.action === 'simulation.completed');
  assert.equal(completed.length, 5, 'five runs completed; the two refused runs never started');
  assert.ok(completed.every((e) => e.detail.synthetic === true && /^Simulation on SYNTHETIC data /.test(e.rationale)));
  assert.ok(!completed.some((e) => /\.\.$/.test(e.rationale)), 'no doubled full stops');
  assert.ok(r.entries.every((e) => e.at && e.actor.id && (!isDecision(e.action) || e.rationale)));
  assert.equal(r.liveInventory, 0);
  assert.equal(r.liveWorkflowEntries, 0);
  assert.equal(r.audit.ok, true);
});
