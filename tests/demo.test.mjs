// The STORY-001 demo runs end to end. Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDemo } from '../src/demo/run.js';

test('demo: unavailable agent replaced, rate limit retried, replay calls nobody, audit chain verifies', async () => {
  const r = await runDemo({ outDir: mkdtempSync(join(tmpdir(), 'demo-')), print: () => {} });
  const task = (id) => r.first.tasks.find((t) => t.id === id);

  assert.equal(r.first.status, 'completed');
  assert.equal(task('map-process').agentId, 'process-2');
  assert.deepEqual(task('map-process').triedAgents, ['process-1']);
  assert.equal(task('estimate-cost').agentId, 'finance-1');
  assert.equal(task('estimate-cost').attempts, 2);
  assert.equal(r.callsBy['finance-2'], undefined, 'the spare finance agent was not needed');
  assert.equal(r.second.replayed, true);
  assert.equal(r.replayCalls, 0);
  assert.equal(r.audit.ok, true);
});
