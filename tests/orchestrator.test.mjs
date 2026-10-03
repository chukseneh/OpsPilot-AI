// Orchestrator checks for STORY-001. Run with: node --test "tests/*.test.mjs"
// Agents here are in-process stand-ins whose behaviour each test scripts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOrchestrator } from '../src/orchestration/orchestrator.js';
import { defineAgent, createRegistry } from '../src/orchestration/agents.js';
import { createMemoryResultStore, createFileResultStore } from '../src/orchestration/resultStore.js';
import { AgentUnavailableError, NetworkError, RateLimitedError, TaskFailedError } from '../src/orchestration/errors.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'orch-'));
const manager = { type: 'person', id: 'operations_manager' };

// An agent that records its calls and behaves as `behaviour(callNumber, task, signal)` says.
function scripted(id, capabilities, behaviour = () => ({ ok: true })) {
  const calls = [];
  const agent = defineAgent({
    id, capabilities,
    run: async (task, { signal }) => {
      calls.push(task);
      return behaviour(calls.length, task, signal);
    },
  });
  // defineAgent returns a frozen agent; the test copy adds a call log beside it.
  return { ...agent, calls };
}

const hangUntilAborted = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

function setup(agents, options = {}) {
  const audit = options.audit ?? createAuditLog({ file: join(tempDir(), 'audit.jsonl') });
  const waits = [];
  const orchestrator = createOrchestrator({
    registry: createRegistry(agents, options.registry),
    audit,
    store: options.store ?? createMemoryResultStore(),
    timeoutMs: options.timeoutMs ?? 200,
    sleep: async (ms) => { waits.push(ms); },
  });
  const actions = () => audit.readAll().map((e) => e.action);
  return { orchestrator, audit, waits, actions };
}

const processOp = (operationId = 'op-1') => ({
  operationId,
  requestedBy: manager,
  tasks: [
    { id: 'map-process', capability: 'process', input: { process: 'invoice approval' } },
    { id: 'assess-risk', capability: 'risk', input: {} },
    { id: 'estimate-cost', capability: 'finance', input: {} },
  ],
});

// ---- Acceptance 1: several agents, one operation, all done ----

test('a process operation is split across the process, risk and finance agents and completes', async () => {
  const p = scripted('process-1', ['process'], () => ({ steps: 4 }));
  const r = scripted('risk-1', ['risk'], () => ({ rating: 'medium' }));
  const f = scripted('finance-1', ['finance'], () => ({ cost: 1200 }));
  const { orchestrator, audit, actions } = setup([p, r, f]);

  const result = await orchestrator.runOperation(processOp());

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.tasks.map((t) => [t.id, t.agentId, t.status]), [
    ['map-process', 'process-1', 'completed'],
    ['assess-risk', 'risk-1', 'completed'],
    ['estimate-cost', 'finance-1', 'completed'],
  ]);
  assert.deepEqual(result.tasks[0].output, { steps: 4 });
  assert.equal(p.calls[0].idempotencyKey, 'op-1:map-process');
  assert.equal(actions()[0], 'operation.started');
  assert.equal(actions().at(-1), 'operation.completed');
  assert.equal(actions().filter((a) => a === 'task.assigned').length, 3);
  assert.equal(actions().filter((a) => a === 'task.completed').length, 3);
  assert.equal(audit.verify().ok, true);
});

test('tasks needing the same capability are spread across the agents that have it', async () => {
  const a = scripted('process-1', ['process']);
  const b = scripted('process-2', ['process']);
  const { orchestrator } = setup([a, b]);
  const result = await orchestrator.runOperation({
    operationId: 'op-spread', requestedBy: manager,
    tasks: [{ id: 't1', capability: 'process' }, { id: 't2', capability: 'process' }],
  });
  assert.deepEqual(result.tasks.map((t) => t.agentId).sort(), ['process-1', 'process-2']);
});

// ---- Acceptance 2: an agent fails, its task moves to another agent ----

test('an unavailable agent is taken out of rotation and its task is reassigned', async () => {
  const down = scripted('process-1', ['process'], () => { throw new AgentUnavailableError('not responding'); });
  const backup = scripted('process-2', ['process']);
  const { orchestrator, audit, actions } = setup([down, backup]);

  const result = await orchestrator.runOperation({
    operationId: 'op-down', requestedBy: manager, tasks: [{ id: 'map-process', capability: 'process' }],
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.tasks[0].agentId, 'process-2');
  assert.deepEqual(result.tasks[0].triedAgents, ['process-1']);
  assert.equal(down.calls.length, 1, 'an unavailable agent is not retried');
  assert.deepEqual(actions(), [
    'operation.started', 'task.assigned', 'task.attempt_failed', 'agent.marked_unhealthy',
    'task.reassigned', 'task.completed', 'operation.completed',
  ]);
  const moved = audit.readAll().find((e) => e.action === 'task.reassigned');
  assert.deepEqual([moved.detail.from, moved.detail.to], ['process-1', 'process-2']);
  assert.match(moved.rationale, /process-1 failed \(AgentUnavailableError\)/);
});

test('an agent that hangs past the timeout is cancelled and its task is reassigned', async () => {
  let sawAbort = false;
  const slow = scripted('risk-1', ['risk'], (_n, _t, signal) => {
    signal.addEventListener('abort', () => { sawAbort = true; });
    return hangUntilAborted(signal);
  });
  const backup = scripted('risk-2', ['risk']);
  const { orchestrator, audit } = setup([slow, backup], { timeoutMs: 30 });

  const result = await orchestrator.runOperation({
    operationId: 'op-slow', requestedBy: manager, tasks: [{ id: 'assess-risk', capability: 'risk' }],
  });

  assert.equal(result.tasks[0].agentId, 'risk-2');
  assert.ok(sawAbort, 'the hung agent was told to stop');
  const failed = audit.readAll().find((e) => e.action === 'task.attempt_failed');
  assert.equal(failed.detail.error.name, 'TimeoutError');
});

test('an agent that crashes with an unexpected error is treated as failed and replaced', async () => {
  const buggy = scripted('finance-1', ['finance'], () => { throw new TypeError('cannot read properties of undefined'); });
  const backup = scripted('finance-2', ['finance']);
  const { orchestrator } = setup([buggy, backup]);
  const result = await orchestrator.runOperation({
    operationId: 'op-bug', requestedBy: manager, tasks: [{ id: 'estimate-cost', capability: 'finance' }],
  });
  assert.equal(result.tasks[0].agentId, 'finance-2');
});

test('an agent that rejects with undefined or a string is replaced, without crashing the operation', async () => {
  // Found by the stress test: reading .name off `undefined` used to crash the whole operation.
  const silent = scripted('process-1', ['process'], () => Promise.reject(undefined));
  const stringy = scripted('risk-1', ['risk'], () => Promise.reject('it broke'));
  const p2 = scripted('process-2', ['process']);
  const r2 = scripted('risk-2', ['risk']);
  const { orchestrator, audit } = setup([silent, stringy, p2, r2]);

  const result = await orchestrator.runOperation({
    operationId: 'op-non-error', requestedBy: manager,
    tasks: [{ id: 'a', capability: 'process' }, { id: 'b', capability: 'risk' }],
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.tasks.map((t) => t.agentId), ['process-2', 'risk-2']);
  const marked = audit.readAll().filter((e) => e.action === 'agent.marked_unhealthy');
  assert.equal(marked.length, 2);
  for (const e of marked) {
    assert.match(e.rationale, /with NonErrorRejection;/);
    assert.ok(!/undefined/.test(e.rationale));
  }
  assert.match(marked.find((e) => e.subject === 'risk-1').detail.error.message, /got "it broke"/);
});

// ---- Failure paths: network failure and rate limits ----

test('a network blip is retried on the same agent with backoff, then succeeds', async () => {
  const flaky = scripted('process-1', ['process'], (n) => {
    if (n === 1) throw new NetworkError('ECONNRESET');
    return { ok: true };
  });
  const other = scripted('process-2', ['process']);
  const { orchestrator, waits, actions } = setup([flaky, other]);

  const result = await orchestrator.runOperation({
    operationId: 'op-blip', requestedBy: manager, tasks: [{ id: 't', capability: 'process' }],
  });

  assert.equal(result.tasks[0].agentId, 'process-1');
  assert.equal(result.tasks[0].attempts, 2);
  assert.equal(other.calls.length, 0);
  assert.deepEqual(waits, [100]);
  assert.ok(actions().includes('task.retry_scheduled'));
});

test('retries are capped: a network failure that persists moves the task after 3 attempts', async () => {
  const offline = scripted('process-1', ['process'], () => { throw new NetworkError('ENOTFOUND'); });
  const backup = scripted('process-2', ['process']);
  const { orchestrator, waits } = setup([offline, backup]);

  const result = await orchestrator.runOperation({
    operationId: 'op-offline', requestedBy: manager, tasks: [{ id: 't', capability: 'process' }],
  });

  assert.equal(offline.calls.length, 3);
  assert.deepEqual(waits, [100, 200]);
  assert.equal(result.tasks[0].agentId, 'process-2');
  assert.equal(result.tasks[0].attempts, 4);
});

test("a rate limit waits as long as the service asks, but never more than the cap", async () => {
  const limited = scripted('risk-1', ['risk'], (n) => {
    if (n === 1) throw new RateLimitedError('429', { retryAfterMs: 750 });
    if (n === 2) throw new RateLimitedError('429', { retryAfterMs: 600000 });
    return { ok: true };
  });
  const { orchestrator, waits } = setup([limited]);
  const result = await orchestrator.runOperation({
    operationId: 'op-429', requestedBy: manager, tasks: [{ id: 't', capability: 'risk' }],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(waits, [750, 10000]);
});

// ---- When no agent can do it ----

test('if every agent with a capability fails, that task fails cleanly and the rest still finish', async () => {
  const p = scripted('process-1', ['process']);
  const f = scripted('finance-1', ['finance'], () => { throw new AgentUnavailableError('offline'); });
  const r = scripted('risk-1', ['risk']);
  const { orchestrator, audit } = setup([p, r, f]);

  const result = await orchestrator.runOperation(processOp('op-no-finance'));

  assert.equal(result.status, 'failed');
  const finance = result.tasks.find((t) => t.id === 'estimate-cost');
  assert.equal(finance.status, 'failed');
  assert.equal(finance.error.name, 'NoAgentAvailableError');
  assert.deepEqual(finance.triedAgents, ['finance-1']);
  assert.equal(result.tasks.filter((t) => t.status === 'completed').length, 2);
  const last = audit.readAll().at(-1);
  assert.equal(last.action, 'operation.failed');
  assert.deepEqual(last.detail.failed, ['estimate-cost']);
});

// ---- "The task failed, but the agent is fine" ----

test('a TaskFailedError fails the task at once, keeps the agent in rotation, and the operation re-runs', async () => {
  const p1 = scripted('process-1', ['process'], (n) => {
    if (n === 1) throw new TaskFailedError('ran out of time on this one');
    return { ok: true };
  });
  const p2 = scripted('process-2', ['process']);
  const store = createMemoryResultStore();
  const { orchestrator, audit, actions } = setup([p1, p2], { store });

  const first = await orchestrator.runOperation(oneTask('op-tf'));
  assert.equal(first.status, 'failed');
  assert.equal(first.tasks[0].agentId, 'process-1');
  assert.equal(first.tasks[0].error.name, 'TaskFailedError');
  assert.equal(p1.calls.length, 1, 'not retried');
  assert.equal(p2.calls.length, 0, 'not reassigned');
  assert.ok(!actions().includes('agent.marked_unhealthy'), 'the agent stays in rotation');
  assert.match(audit.readAll().find((e) => e.action === 'task.failed').rationale, /the agent is fine/);

  const second = await orchestrator.runOperation(oneTask('op-tf'));
  assert.equal(second.replayed, false, 'a failed operation is re-run, not replayed');
  assert.equal(second.status, 'completed');
});

// ---- Running it twice ----

test('running a completed operation again calls no agent and is logged as a replay', async () => {
  const p = scripted('process-1', ['process']);
  const r = scripted('risk-1', ['risk']);
  const f = scripted('finance-1', ['finance']);
  const { orchestrator, actions } = setup([p, r, f]);

  const first = await orchestrator.runOperation(processOp('op-twice'));
  const second = await orchestrator.runOperation(processOp('op-twice'));

  assert.equal(second.replayed, true);
  assert.deepEqual(second.tasks, first.tasks);
  assert.equal(p.calls.length + r.calls.length + f.calls.length, 3);
  assert.equal(actions().at(-1), 'operation.replayed');
});

test('re-running a part-failed operation only redoes the unfinished task (file store survives restarts)', async () => {
  const dir = tempDir();
  const store = createFileResultStore({ file: join(dir, 'results.json') });
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });

  const p1 = scripted('process-1', ['process']);
  const r1 = scripted('risk-1', ['risk']);
  const fDown = scripted('finance-1', ['finance'], () => { throw new AgentUnavailableError('offline'); });
  const first = await setup([p1, r1, fDown], { store, audit }).orchestrator.runOperation(processOp('op-resume'));
  assert.equal(first.status, 'failed');

  // "Restart": new orchestrator and agents, same store and audit file.
  const p2 = scripted('process-1', ['process']);
  const r2 = scripted('risk-1', ['risk']);
  const fUp = scripted('finance-1', ['finance']);
  const second = await setup([p2, r2, fUp], { store, audit: createAuditLog({ file: join(dir, 'audit.jsonl') }) })
    .orchestrator.runOperation(processOp('op-resume'));

  assert.equal(second.status, 'completed');
  assert.equal(p2.calls.length + r2.calls.length, 0, 'finished tasks were not redone');
  assert.equal(fUp.calls.length, 1);
  assert.equal(createAuditLog({ file: join(dir, 'audit.jsonl') }).verify().ok, true);
});

test('two calls for the same operation at once run it only once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = scripted('process-1', ['process'], async () => { await gate; return { ok: true }; });
  const { orchestrator, actions } = setup([p], { timeoutMs: 5000 });
  const op = { operationId: 'op-dup', requestedBy: manager, tasks: [{ id: 't', capability: 'process' }] };

  const first = orchestrator.runOperation(op);
  const second = orchestrator.runOperation(op); // the caller retries while the first is still working
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(p.calls.length, 1, 'the agent ran once');
  assert.equal(a, b, 'both callers get the same result');
  assert.ok(actions().includes('operation.joined'));
  assert.equal(actions().filter((x) => x === 'operation.started').length, 1);
});

test('reusing an operation id with different tasks is refused, and the saved result is untouched', async () => {
  const p = scripted('process-1', ['process']);
  const { orchestrator, audit } = setup([p]);
  const original = { operationId: 'op-reuse', requestedBy: manager, tasks: [{ id: 't', capability: 'process', input: { a: 1, b: 2 } }] };
  await orchestrator.runOperation(original);

  // Same tasks with keys in another order count as the same operation: replayed.
  const same = await orchestrator.runOperation({ ...original, tasks: [{ id: 't', capability: 'process', input: { b: 2, a: 1 } }] });
  assert.equal(same.replayed, true);

  await assert.rejects(
    orchestrator.runOperation({ ...original, tasks: [{ id: 't', capability: 'process', input: { a: 99 } }] }),
    (err) => err.name === 'OperationConflictError',
  );
  await assert.rejects(
    orchestrator.runOperation({ ...original, tasks: [...original.tasks, { id: 'extra', capability: 'process' }] }),
    /different set of tasks/,
  );
  assert.equal(p.calls.length, 1);
  assert.equal(audit.readAll().filter((e) => e.action === 'operation.rejected').length, 2);
  assert.equal((await orchestrator.runOperation(original)).replayed, true, 'the original still replays');
});

test("a connector's own rate-limit subclass still gets the wait the service asked for", async () => {
  class GraphThrottledError extends RateLimitedError {}
  const throttled = scripted('finance-1', ['finance'], (n) => {
    if (n === 1) throw new GraphThrottledError('throttled', { retryAfterMs: 5000 });
    return { ok: true };
  });
  const { orchestrator, waits } = setup([throttled]);
  await orchestrator.runOperation({ operationId: 'op-sub', requestedBy: manager, tasks: [{ id: 't', capability: 'finance' }] });
  assert.deepEqual(waits, [5000]);
});

test('a malformed requester gets a clear bad-request error, not a misleading audit failure', async () => {
  const { orchestrator, audit } = setup([scripted('process-1', ['process'])]);
  await assert.rejects(
    orchestrator.runOperation({ operationId: 'op-who', requestedBy: { id: 'bob' }, tasks: [{ id: 't', capability: 'process' }] }),
    (err) => err instanceof TypeError && /requestedBy/.test(err.message),
  );
  const [entry] = audit.readAll();
  assert.equal(entry.action, 'operation.rejected');
  assert.equal(entry.actor.id, 'unknown-requester');
});

// ---- Recovery: failed agents get a trial task after a cooldown ----

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
const oneTask = (operationId, capability = 'process', input) => ({
  operationId, requestedBy: manager, tasks: [{ id: 't', capability, input }],
});

test('a failed agent stays out during its cooldown, then recovers after one successful trial task', async () => {
  const c = clock();
  const flaky = scripted('process-1', ['process'], (n) => {
    if (n === 1) throw new AgentUnavailableError('restarting');
    return { ok: true };
  });
  const { orchestrator, audit } = setup([flaky], { registry: { cooldownMs: 1000, now: c.now } });

  assert.equal((await orchestrator.runOperation(oneTask('op-r1'))).status, 'failed');
  c.advance(999);
  assert.equal((await orchestrator.runOperation(oneTask('op-r2'))).status, 'failed', 'still cooling down');
  assert.equal(flaky.calls.length, 1, 'not called during the cooldown');

  c.advance(1);
  assert.equal((await orchestrator.runOperation(oneTask('op-r3'))).status, 'completed');
  assert.equal((await orchestrator.runOperation(oneTask('op-r4'))).status, 'completed');

  const entries = audit.readAll();
  const trial = entries.find((e) => e.correlationId === 'op-r3' && e.action === 'task.assigned');
  assert.equal(trial.detail.probe, true);
  assert.match(trial.rationale, /single trial task/);
  assert.ok(entries.some((e) => e.correlationId === 'op-r3' && e.action === 'agent.recovered'));
  const after = entries.find((e) => e.correlationId === 'op-r4' && e.action === 'task.assigned');
  assert.equal(after.detail.probe, false, 'back in normal rotation');
  assert.match(entries.find((e) => e.action === 'agent.marked_unhealthy').rationale, /out of rotation for 1 s, then gets one trial task/);
});

test('a failed trial task restarts the cooldown, and the task itself moves to another agent', async () => {
  const c = clock();
  const sick = scripted('process-1', ['process'], (n) => {
    if (n <= 2) throw new AgentUnavailableError('still down');
    return { ok: true };
  });
  const spare = scripted('process-2', ['process'], (n) => {
    if (n === 1) throw new AgentUnavailableError('spare down at first');
    return { ok: true };
  });
  const { orchestrator, audit } = setup([sick, spare], { registry: { cooldownMs: 1000, now: c.now } });

  await orchestrator.runOperation(oneTask('op-p1')); // both fail; both out at t=0
  c.advance(1000);
  const trial = await orchestrator.runOperation(oneTask('op-p2')); // both on trial; process-1 fails its trial
  assert.equal(trial.status, 'completed', 'the task still finished, on the other agent');
  assert.ok(audit.readAll().some((e) => e.action === 'agent.probe_failed' && e.subject === 'process-1'));

  c.advance(500);
  const busy = await orchestrator.runOperation({ ...oneTask('op-p3'), tasks: [{ id: 'a', capability: 'process' }, { id: 'b', capability: 'process' }] });
  assert.ok(busy.tasks.every((t) => t.agentId !== 'process-1'), 'process-1 is cooling down again');

  c.advance(500);
  await orchestrator.runOperation(oneTask('op-p4'));
  assert.ok(audit.readAll().some((e) => e.action === 'agent.recovered' && e.subject === 'process-1'));
});

test('only one trial task runs on a recovering agent at a time', async () => {
  const c = clock();
  const flaky = scripted('process-1', ['process'], (n) => {
    if (n === 1) throw new AgentUnavailableError('down');
    return { ok: true };
  });
  const { orchestrator, audit } = setup([flaky], { registry: { cooldownMs: 1000, now: c.now } });
  await orchestrator.runOperation(oneTask('op-o1'));
  c.advance(1000);

  const result = await orchestrator.runOperation({
    ...oneTask('op-o2'), tasks: [{ id: 'a', capability: 'process' }, { id: 'b', capability: 'process' }],
  });
  assert.deepEqual(result.tasks.map((t) => t.status), ['completed', 'failed']);
  assert.equal(flaky.calls.length, 2, 'one call in op-o1, one trial in op-o2');
  assert.equal(audit.readAll().filter((e) => e.correlationId === 'op-o2' && e.detail?.probe === true).length, 1);
});

test('one bad task no longer takes a capability offline for good', async () => {
  // The case the code review raised: input that makes every finance agent crash.
  const c = clock();
  const behaviour = (_n, task) => {
    if (task.input?.poison) throw new TypeError('cannot handle this input');
    return { ok: true };
  };
  const f1 = scripted('finance-1', ['finance'], behaviour);
  const f2 = scripted('finance-2', ['finance'], behaviour);
  const { orchestrator } = setup([f1, f2], { registry: { cooldownMs: 1000, now: c.now } });

  assert.equal((await orchestrator.runOperation(oneTask('op-bad', 'finance', { poison: true }))).status, 'failed');
  assert.equal((await orchestrator.runOperation(oneTask('op-next', 'finance'))).status, 'failed', 'both are cooling down');
  c.advance(1000);
  assert.equal((await orchestrator.runOperation(oneTask('op-later', 'finance'))).status, 'completed');
});

// ---- Trust: audit is not optional ----

test('if the audit log cannot be written, in-flight work is cancelled and the operation rejects', async () => {
  const real = createAuditLog({ file: join(tempDir(), 'audit.jsonl') });
  let writes = 0;
  const failingAudit = {
    readAll: () => real.readAll(),
    append(e) {
      writes += 1;
      if (writes > 3) throw new AuditWriteError('disk full');
      return real.append(e);
    },
  };
  let cancelled = false;
  const slow = scripted('process-1', ['process'], (_n, _t, signal) => {
    signal.addEventListener('abort', () => { cancelled = true; });
    return hangUntilAborted(signal);
  });
  const quick = scripted('risk-1', ['risk']);
  const { orchestrator } = setup([slow, quick], { audit: failingAudit, timeoutMs: 5000 });

  await assert.rejects(orchestrator.runOperation({
    operationId: 'op-audit-down', requestedBy: manager,
    tasks: [{ id: 'slow', capability: 'process' }, { id: 'quick', capability: 'risk' }],
  }), AuditWriteError);
  assert.ok(cancelled, 'the in-flight agent was cancelled');
});

test('a malformed operation is refused, and the refusal is logged', async () => {
  const { orchestrator, audit } = setup([scripted('process-1', ['process'])]);
  await assert.rejects(orchestrator.runOperation({
    operationId: 'op-bad', requestedBy: manager, tasks: [{ id: 't', capability: 'process' }, { id: 't', capability: 'process' }],
  }), /used twice/);
  await assert.rejects(orchestrator.runOperation({
    operationId: 'op-bad-2', requestedBy: manager, tasks: [{ id: 't', capability: 'marketing' }],
  }), /unknown capability/);
  assert.deepEqual(audit.readAll().map((e) => [e.correlationId, e.action]), [
    ['op-bad', 'operation.rejected'], ['op-bad-2', 'operation.rejected'],
  ]);
});
