// The STORY-004 demo runs end to end. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runInventoryDemo } from '../src/demo/inventory.js';

test('demo: systems listed with details, risk filled, status change reflected, failures refused, audit verifies', async () => {
  const printed = [];
  const r = await runInventoryDemo({ print: (l) => printed.push(l), databaseUrl: '' });

  assert.deepEqual(r.registered, ['ai-cv-screen', 'ai-claims-triage', 'ai-help-chat', 'ai-demand-forecast']);
  assert.match(r.refusedRegistration, /"humanOversight" is missing/);

  const cv = r.afterChange.find((s) => s.id === 'ai-cv-screen');
  assert.deepEqual([cv.status, cv.riskLevel, cv.department, cv.owner], ['paused', 'high', 'HR', 'hr-lead-1']);
  assert.equal(r.statusChange.changed, true);

  assert.match(r.stale, /InventoryConflictError: .*it is now version 3, status paused/);
  assert.match(r.unauthorised, /PermissionDeniedError: Role "compliance officer" may not change AI system status/);
  assert.match(r.unreachable, /DatabaseUnavailableError: .*gave up after 2 attempts/);
  assert.ok(!printed.join('\n').includes('FAKE-demo-password'), 'the connection string is never printed');

  const actions = r.entries.map((e) => e.action);
  for (const a of ['inventory.registered', 'inventory.register_rejected', 'inventory.viewed', 'inventory.risk_recorded',
    'inventory.status_changed', 'inventory.update_conflict', 'inventory.denied']) assert.ok(actions.includes(a), a);
  assert.ok(r.entries.every((e) => e.actor.id && e.at));
  assert.equal(r.audit.ok, true);
});
