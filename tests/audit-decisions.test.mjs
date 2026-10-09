// Every action logged with a timestamp and user id; every decision with its
// rationale (STORY-006 acceptance 1 and 2). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { DECISION_ACTIONS, isDecision } from '../src/audit/decisions.js';
import { runDemo } from '../src/demo/run.js';
import { runAnalysisDemo } from '../src/demo/analyse.js';
import { runRiskDemo } from '../src/demo/riskAssessment.js';
import { runInventoryDemo } from '../src/demo/inventory.js';
import { runAutomationDemo } from '../src/demo/automation.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'audit-decisions-'));
const actor = { type: 'person', id: 'u-1' };

test('every decision action is refused without a rationale, and nothing is written', () => {
  const log = createAuditLog({ file: join(tmp(), 'audit.jsonl') });
  for (const action of DECISION_ACTIONS) {
    for (const rationale of [undefined, null, '', '   ']) {
      assert.throws(() => log.append({ correlationId: 'c', actor, action, rationale }),
        (err) => err instanceof AuditWriteError && /records a decision, so it must include its rationale/.test(err.message), `${action} / ${JSON.stringify(rationale)}`);
    }
  }
  assert.equal(log.readAll().length, 0);
  // A refused decision does not lock the log the way a failed write does.
  log.append({ correlationId: 'c', actor, action: 'workflow.action_approved', rationale: 'Invoice checked against the contract' });
  assert.equal(log.verify().ok, true);
});

test('plain actions may still be logged without a rationale', () => {
  const log = createAuditLog({ file: join(tmp(), 'audit.jsonl') });
  for (const action of ['workflow.started', 'inventory.viewed', 'risk.requested']) {
    assert.equal(isDecision(action), false);
    log.append({ correlationId: 'c', actor, action });
  }
  assert.equal(log.readAll().length, 3);
});

// The strongest evidence: run every demo end to end and inspect every entry it wrote.
test('across every demo: each entry has a timestamp and a user id, and each decision has its rationale', async () => {
  const quiet = () => {};
  const logs = [];
  const dir = (name) => { const d = tmp(); logs.push({ name, read: () => createAuditLog({ file: join(d, 'audit.jsonl') }).readAll() }); return d; };

  await runDemo({ outDir: dir('orchestration (STORY-001)'), print: quiet });
  await runAnalysisDemo({ outDir: dir('process analysis (STORY-002)'), print: quiet });
  await runRiskDemo({ outDir: dir('risk assessment (STORY-003)'), print: quiet });
  const inventory = await runInventoryDemo({ print: quiet, databaseUrl: '' });
  const automation = await runAutomationDemo({ print: quiet });
  logs.push({ name: 'inventory (STORY-004)', read: () => inventory.entries });
  logs.push({ name: 'automation (STORY-005)', read: () => automation.entries });

  for (const { name, read } of logs) {
    const all = read();
    // Each demo must actually have logged decisions, or this test would prove nothing for it.
    assert.ok(all.filter((e) => isDecision(e.action)).length > 0, `${name}: logged no decisions`);
    for (const e of all) {
      assert.ok(!Number.isNaN(Date.parse(e.at)) && e.at.endsWith('Z'), `${name} #${e.seq} ${e.action}: timestamp`);
      assert.ok(typeof e.actor?.id === 'string' && e.actor.id.trim() !== '', `${name} #${e.seq} ${e.action}: user id`);
      if (isDecision(e.action)) {
        assert.ok(typeof e.rationale === 'string' && e.rationale.trim() !== '', `${name} #${e.seq} ${e.action}: rationale`);
      }
    }
  }
});

test('the rationale says why, in words: approvals carry the note, risk decisions the rules', async () => {
  const { entries } = await runAutomationDemo({ print: () => {} });
  const approved = entries.find((e) => e.action === 'workflow.action_approved');
  assert.equal(approved.rationale, 'Agreed with HR; pause for the review');
  const classified = entries.find((e) => e.action === 'workflow.action_classified' && e.detail.riskLevel === 'high');
  assert.match(classified.rationale, /^High risk: .*rates high risk/);
  const changed = entries.find((e) => e.action === 'inventory.status_changed');
  assert.match(changed.rationale, /^Bias review|Requested by workflow step/);
});
