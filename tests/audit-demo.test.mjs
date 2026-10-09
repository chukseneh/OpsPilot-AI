// The STORY-006 demo runs end to end. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAuditDemo } from '../src/demo/audit.js';
import { isDecision } from '../src/audit/decisions.js';

test('demo: who/when on every entry, why on every decision, tampering caught, access controlled, storage repaired', async () => {
  const printed = [];
  const r = await runAuditDemo({ print: (l) => printed.push(l) });

  // Acceptance 1: timestamp and user id.
  assert.ok(r.entries.every((e) => !Number.isNaN(Date.parse(e.at)) && e.actor.id));
  // Acceptance 2: decisions carry their rationale; one without is refused.
  assert.ok(r.decisions.length >= 6);
  assert.ok(r.decisions.every((e) => isDecision(e.action) && e.rationale.trim() !== ''));
  assert.ok(r.decisions.some((e) => e.action === 'workflow.action_rejected' && e.rationale === 'No purchase order on file for this amount'));
  assert.match(r.refusedDecision, /must include its rationale/);

  // Acceptance 3 / log tampering.
  assert.equal(r.intact.ok, true);
  assert.match(r.tampering.edited.reason, /entry was changed after it was written/);
  assert.match(r.tampering.truncated.reason, /entries after #\d+ were removed/);
  assert.match(r.tampering.insider.reason, /does not match its anchor/);
  assert.match(r.anchorChange, /append-only: UPDATE is not allowed/);
  assert.ok(r.entries.every((e) => e.alg === 'hmac-sha256'), 'every entry is keyed');

  // Unauthorised log access.
  assert.match(r.itRefused, /may not read the audit log/);
  assert.equal(r.read.integrity.ok, true);

  // Log storage failure.
  assert.match(r.diskFull, /AuditWriteError/);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.health.ok, false);
  assert.equal(r.repair.repaired, true);
  assert.equal(r.afterRepair.ok, true);

  assert.equal(r.final.ok, true, 'the main log is intact at the end');
  assert.ok(!printed.join('\n').match(/[0-9a-f]{64}/), 'no 64-hex string (such as the key) is printed');
});
