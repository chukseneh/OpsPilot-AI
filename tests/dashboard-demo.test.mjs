// The STORY-011 demo walk-through runs end to end. Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDashboardCheck, walkthroughPassed } from '../src/demo/dashboard.js';

test('demo: anonymous 401, analyst sees results and automation opportunities, intern 403, no-data message, audit verifies', async () => {
  const r = await runDashboardCheck({ print: () => {} });

  assert.equal(r.anonymous.status, 401);
  assert.equal(r.analyst.status, 200);
  assert.ok(r.analyst.lines.some((l) => /^Automation opportunities \(3\)$/.test(l)));
  assert.ok(r.analyst.lines.some((l) => /may be a candidate for automation/.test(l)));
  assert.equal(r.intern.status, 403);
  assert.equal(r.noData.status, 200);
  assert.ok(r.noData.lines.some((l) => /No process analysis data is available yet/.test(l)));

  assert.deepEqual(r.entries.map((e) => [e.action, e.actor.id]), [
    ['dashboard.denied', 'anonymous'],
    ['dashboard.signed_in', 'da-1'],
    ['dashboard.viewed', 'da-1'],
    ['dashboard.signed_in', 'intern-3'],
    ['dashboard.denied', 'intern-3'],
    ['dashboard.viewed', 'da-1'],
  ]);
  assert.equal(r.audit.ok, true);
  assert.equal(walkthroughPassed(r), true);

  // The exit code must catch a broken permission check, not just a working analyst view.
  assert.equal(walkthroughPassed({ ...r, intern: { ...r.intern, status: 200 } }), false);
  assert.equal(walkthroughPassed({ ...r, anonymous: { ...r.anonymous, status: 200 } }), false);
  assert.equal(walkthroughPassed({ ...r, noData: { status: 200, lines: [] } }), false);
});
