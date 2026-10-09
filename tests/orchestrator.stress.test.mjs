// Randomised stress test for the orchestrator. Hundreds of operations run at once
// against agents that fail at random; afterwards every invariant below must hold
// for every operation. The generator is seeded, so a failure can be replayed by
// re-running with the seed printed in the assertion message.
//
// Invariants checked:
//   - an operation is "completed" exactly when all its tasks are completed
//   - a completed task was done by an agent with the right capability, which is
//     not also in its list of failed agents; no agent is tried twice for one task
//   - a failed task failed with NoAgentAvailableError and has no agent
//   - the agent calls actually made match the attempts reported, and no agent is
//     called more than 1 + maxRetries times for one task
//   - the audit log has, per task, one assignment entry per agent used, one entry
//     per failed attempt, one completion or failure; per operation, it starts with
//     operation.started and ends with operation.completed/failed
//   - no work is assigned to an agent after it is marked unhealthy
//   - every rationale is readable (no "undefined"), the audit chain verifies,
//     no promise rejection goes unhandled, and replaying calls no agent

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOrchestrator } from '../src/orchestration/orchestrator.js';
import { defineAgent, createRegistry } from '../src/orchestration/agents.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';
import { AgentUnavailableError, NetworkError, RateLimitedError } from '../src/orchestration/errors.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const MAX_RETRIES = 2;
const TIMEOUT_MS = 15;

// Small seeded PRNG (mulberry32) so runs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each call picks a behaviour at random, weighted towards success.
const BEHAVIOURS = [
  [50, 'ok'], [8, 'slow-ok'], [8, 'unavailable'], [8, 'network'], [6, 'rate-limited'],
  [5, 'crash'], [4, 'sync-throw'], [4, 'hang'], [3, 'throw-non-error'], [2, 'throw-nothing'],
];
const TOTAL_WEIGHT = BEHAVIOURS.reduce((a, [w]) => a + w, 0);

function pick(random) {
  let r = random() * TOTAL_WEIGHT;
  for (const [w, name] of BEHAVIOURS) { r -= w; if (r < 0) return name; }
  return 'ok';
}

const later = (ms, signal, value) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(value), ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

function makeAgents(random, calls, prefix = '') {
  const spec = [
    ['process-1', ['process']], ['process-2', ['process']], ['process-3', ['process', 'risk']],
    ['risk-1', ['risk']], ['risk-2', ['risk', 'finance']],
    ['finance-1', ['finance']], ['finance-2', ['finance']],
  ];
  return spec.map(([id, capabilities]) => {
    const fullId = `${prefix}${id}`;
    // Deliberately NOT async: some behaviours throw synchronously, as careless agent code can.
    const run = (task, { signal }) => {
      const key = `${task.operationId}|${task.id}|${fullId}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      switch (pick(random)) {
        case 'ok': return Promise.resolve({ by: fullId });
        case 'slow-ok': return later(2, signal, { by: fullId });
        case 'unavailable': return Promise.reject(new AgentUnavailableError(`${fullId} down`));
        case 'network': return Promise.reject(new NetworkError('ECONNRESET'));
        case 'rate-limited': return Promise.reject(new RateLimitedError('429', { retryAfterMs: 50 }));
        case 'crash': return Promise.reject(new TypeError('agent bug'));
        case 'sync-throw': throw new RangeError('agent threw synchronously');
        case 'hang': return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        case 'throw-non-error': return Promise.reject('plain string thrown'); // eslint-disable-line prefer-promise-reject-errors
        case 'throw-nothing': return Promise.reject(undefined); // eslint-disable-line prefer-promise-reject-errors
        default: throw new Error('unreachable');
      }
    };
    return defineAgent({ id: fullId, capabilities, run });
  });
}

function randomOperation(random, i) {
  const caps = ['process', 'risk', 'finance'];
  const n = 1 + Math.floor(random() * 4);
  return {
    operationId: `op-${i}`,
    requestedBy: { type: 'person', id: 'operations_manager' },
    tasks: Array.from({ length: n }, (_, j) => ({ id: `t${j}`, capability: caps[Math.floor(random() * caps.length)] })),
  };
}

function checkOperation({ op, result, entries, calls, agentsById, seed }) {
  const where = (msg) => `seed ${seed}, ${op.operationId}: ${msg}`;
  const mine = entries.filter((e) => e.correlationId === op.operationId);

  assert.equal(result.status, result.tasks.every((t) => t.status === 'completed') ? 'completed' : 'failed', where('status'));
  assert.equal(mine[0].action, 'operation.started', where('first entry'));
  assert.equal(mine.at(-1).action, `operation.${result.status}`, where('last entry'));

  for (const t of result.tasks) {
    const tw = (msg) => where(`${t.id}: ${msg}`);
    const forTask = mine.filter((e) => e.subject === t.id);
    const count = (action) => forTask.filter((e) => e.action === action).length;

    assert.equal(new Set(t.triedAgents).size, t.triedAgents.length, tw('an agent was tried twice'));
    if (t.status === 'completed') {
      assert.ok(agentsById.get(t.agentId).capabilities.includes(t.capability), tw(`${t.agentId} lacks ${t.capability}`));
      assert.ok(!t.triedAgents.includes(t.agentId), tw('completing agent is also listed as failed'));
      assert.equal(count('task.completed'), 1, tw('task.completed entries'));
      assert.equal(count('task.failed'), 0, tw('unexpected task.failed'));
    } else {
      assert.equal(t.status, 'failed', tw('status'));
      assert.equal(t.agentId, null, tw('failed task has an agent'));
      assert.equal(t.error.name, 'NoAgentAvailableError', tw('failure reason'));
      assert.equal(count('task.failed'), 1, tw('task.failed entries'));
    }

    const agentsUsed = t.triedAgents.length + (t.status === 'completed' ? 1 : 0);
    assert.equal(count('task.assigned') + count('task.reassigned'), agentsUsed, tw('assignment entries'));
    assert.equal(count('task.reassigned'), Math.max(0, agentsUsed - 1), tw('reassignment entries'));
    assert.equal(count('task.attempt_failed') + (t.status === 'completed' ? 1 : 0), t.attempts, tw('attempt entries'));

    let actualCalls = 0;
    for (const a of agentsById.keys()) {
      const n = calls.get(`${op.operationId}|${t.id}|${a}`) ?? 0;
      assert.ok(n <= 1 + MAX_RETRIES, tw(`${a} called ${n} times`));
      actualCalls += n;
    }
    assert.equal(actualCalls, t.attempts, tw('calls made vs attempts reported'));
  }
}

// Returns how many trial tasks (probes) the log shows, so callers can check some happened.
function checkLog(entries, seed) {
  for (const e of entries) {
    assert.ok(!/undefined/.test(e.rationale ?? ''), `seed ${seed}: unreadable rationale in #${e.seq} ${e.action}: ${e.rationale}`);
  }
  // An agent that is out of rotation only receives work as a trial task, at most
  // one trial runs per agent at a time, and every trial ends in a verdict.
  const out = new Map(); // agent → seq it went out
  const probing = new Map(); // agent → seq of its running trial
  let probes = 0;
  for (const e of entries) {
    const fail = (msg) => assert.fail(`seed ${seed}: #${e.seq} ${e.action} ${e.subject ?? ''}: ${msg}`);
    if (e.action === 'agent.marked_unhealthy') {
      if (out.has(e.subject)) fail('marked unhealthy twice without recovering');
      out.set(e.subject, e.seq);
    }
    if (e.action === 'agent.recovered' || e.action === 'agent.probe_failed') {
      if (!probing.has(e.subject)) fail('verdict without a running trial');
      probing.delete(e.subject);
      if (e.action === 'agent.recovered') out.delete(e.subject);
    }
    const to = e.action === 'task.assigned' ? e.detail.agentId : e.action === 'task.reassigned' ? e.detail.to : null;
    if (!to) continue;
    if (out.has(to)) {
      if (e.detail.probe !== true) fail(`work sent to ${to}, out of rotation since #${out.get(to)}, without a trial`);
      if (probing.has(to)) fail(`second trial on ${to} while trial #${probing.get(to)} is still running`);
      probing.set(to, e.seq);
      probes += 1;
    } else if (e.detail.probe === true) {
      fail(`trial task sent to ${to}, which is not out of rotation`);
    }
  }
  assert.equal(probing.size, 0, `seed ${seed}: trials never finished: ${[...probing.keys()].join(', ')}`);
  return probes;
}

async function withRejectionWatch(fn) {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 50)); // let stragglers settle
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], 'no promise rejection may go unhandled');
}

for (const seed of [1, 7, 42]) {
  test(`stress A (seed ${seed}): 300 independent operations at once, one shared audit log`, { timeout: 60000 }, async () => {
    await withRejectionWatch(async () => {
      const random = rng(seed);
      const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'stress-')), 'audit.jsonl') });
      const calls = new Map();
      const runs = Array.from({ length: 300 }, (_, i) => {
        const agents = makeAgents(random, calls, `o${i}-`);
        const orchestrator = createOrchestrator({
          registry: createRegistry(agents), audit, store: createMemoryResultStore(),
          timeoutMs: TIMEOUT_MS, maxRetries: MAX_RETRIES, sleep: async () => {},
        });
        return { op: randomOperation(random, i), orchestrator, agentsById: new Map(agents.map((a) => [a.id, a])) };
      });

      const results = await Promise.all(runs.map((r) => r.orchestrator.runOperation(r.op)));
      const entries = audit.readAll();
      runs.forEach((r, i) => checkOperation({ ...r, result: results[i], entries, calls, seed }));
      checkLog(entries, seed);
      assert.deepEqual(audit.verify(), { ok: true, count: entries.length, keyed: false });

      // Replaying completed operations calls no agent.
      const before = [...calls.values()].reduce((a, b) => a + b, 0);
      const completed = runs.filter((_, i) => results[i].status === 'completed');
      const replays = await Promise.all(completed.map((r) => r.orchestrator.runOperation(r.op)));
      assert.ok(replays.every((x) => x.replayed));
      assert.equal([...calls.values()].reduce((a, b) => a + b, 0), before, `seed ${seed}: replay called an agent`);
      assert.ok(completed.length > 100 && completed.length < 300, `seed ${seed}: expected a mix of outcomes, got ${completed.length} completed`);
    });
  });

  test(`stress B (seed ${seed}): 60 operations at once sharing one set of agents`, { timeout: 60000 }, async () => {
    await withRejectionWatch(async () => {
      const random = rng(seed * 1000);
      const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'stress-')), 'audit.jsonl') });
      const calls = new Map();
      const agents = makeAgents(random, calls);
      const agentsById = new Map(agents.map((a) => [a.id, a]));
      const orchestrator = createOrchestrator({
        registry: createRegistry(agents), audit, store: createMemoryResultStore(),
        timeoutMs: TIMEOUT_MS, maxRetries: MAX_RETRIES, sleep: async () => {},
      });
      const ops = Array.from({ length: 60 }, (_, i) => randomOperation(random, i));

      const results = await Promise.all(ops.map((op) => orchestrator.runOperation(op)));
      const entries = audit.readAll();
      ops.forEach((op, i) => checkOperation({ op, result: results[i], entries, calls, agentsById, seed }));
      checkLog(entries, seed);
      assert.equal(audit.verify().ok, true);
    });
  });

  test(`stress C (seed ${seed}): shared agents with a 5 ms cooldown, so failed agents recover under load`, { timeout: 60000 }, async () => {
    await withRejectionWatch(async () => {
      const random = rng(seed * 7919);
      const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'stress-')), 'audit.jsonl') });
      const calls = new Map();
      const agents = makeAgents(random, calls);
      const agentsById = new Map(agents.map((a) => [a.id, a]));
      const orchestrator = createOrchestrator({
        registry: createRegistry(agents, { cooldownMs: 5 }), audit, store: createMemoryResultStore(),
        timeoutMs: TIMEOUT_MS, maxRetries: MAX_RETRIES, sleep: async () => {},
      });
      // Three waves, so agents knocked out early come due for trials later.
      const results = [];
      const ops = [];
      for (let wave = 0; wave < 3; wave += 1) {
        const batch = Array.from({ length: 40 }, (_, i) => randomOperation(random, wave * 100 + i));
        ops.push(...batch);
        results.push(...await Promise.all(batch.map((op) => orchestrator.runOperation(op))));
        await new Promise((r) => setTimeout(r, 10)); // let cooldowns expire between waves
      }
      const entries = audit.readAll();
      ops.forEach((op, i) => checkOperation({ op, result: results[i], entries, calls, agentsById, seed }));
      const probes = checkLog(entries, seed);
      assert.ok(probes > 0, `seed ${seed}: no trial task happened, so recovery was not exercised`);
      assert.ok(entries.some((e) => e.action === 'agent.recovered'), `seed ${seed}: no agent recovered`);
      assert.equal(audit.verify().ok, true);
    });
  });
}
