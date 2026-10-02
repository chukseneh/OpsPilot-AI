// Runs one operation across several agents (REQ-012), and logs every step (REQ-008).
//
// An operation is an id plus tasks; each task names the capability it needs.
// For each task the orchestrator:
//   1. picks the healthy agent with that capability that has had the fewest tasks;
//   2. calls it with a timeout, retrying network failures and rate limits a capped
//      number of times on the SAME agent (errors.js decides which errors retry);
//   3. if the agent still fails, takes it out of rotation and gives the task to
//      ANOTHER healthy agent with the same capability — and says why in the log;
//   4. if no such agent is left, fails that task cleanly. It never loops forever:
//      each agent is tried at most once per task, and agents are finite.
//
// Running the same operation twice is safe: finished task results are saved by
// operation id, a completed operation is returned from the store without calling
// any agent, a part-finished one only redoes the unfinished tasks, and a call for
// an operation that is still running joins that run instead of starting another.
// Reusing an id with different tasks is refused (OperationConflictError). Agents
// also get an idempotencyKey (operationId:taskId) to guard their own side effects.
// Limit: "already running" is known only inside one process; two processes
// sharing a store would need a lock, which nothing here provides yet.
//
// If the audit log (or the result store) cannot be written, every in-flight task
// is cancelled and runOperation rejects: nothing carries on unrecorded.

import { createHash } from 'node:crypto';

import { classify, NoAgentAvailableError, TimeoutError, RateLimitedError, OperationConflictError } from './errors.js';
import { CAPABILITIES } from './agents.js';

const ORCHESTRATOR = { type: 'system', id: 'orchestrator' };
const UNKNOWN_REQUESTER = { type: 'system', id: 'unknown-requester' };

// JSON with object keys sorted, so {a,b} and {b,a} fingerprint the same.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// What an operation asks for. Same id + same fingerprint = the same operation.
const fingerprintOf = (tasks) => createHash('sha256')
  .update(stableJson(tasks.map((t) => ({ id: t.id, capability: t.capability, input: t.input ?? null }))))
  .digest('hex');

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); reject(signal.reason); }
  signal.addEventListener('abort', onAbort, { once: true });
});

// A plain, always-readable description of whatever an agent failed with. Agents
// should reject with an Error, but JavaScript allows any value (even undefined),
// so never read .name or .message off the raw value anywhere else.
function errorInfo(err) {
  if (err instanceof Error) return { name: err.name, message: err.message };
  const got = typeof err === 'string' ? JSON.stringify(err) : String(err);
  return { name: 'NonErrorRejection', message: `agent failed without an Error (got ${got})` };
}

export function createOrchestrator({
  registry,
  audit,
  store,
  timeoutMs = 5000,
  maxRetries = 2,
  backoffBaseMs = 100,
  backoffMaxMs = 2000,
  maxRetryAfterMs = 10000,
  sleep = defaultSleep,
}) {
  // Tasks assigned to each agent over this orchestrator's life — used to spread work.
  const assignedCount = new Map();
  // Operations running right now in this process: operationId → { promise, fingerprint }.
  const inFlight = new Map();

  function retryDelay(err, attempt) {
    // instanceof, not a name check: a connector's own subclass (e.g. a throttling
    // error extending RateLimitedError) must still get the wait the service asked for.
    if (err instanceof RateLimitedError && err.retryAfterMs != null) return Math.min(err.retryAfterMs, maxRetryAfterMs);
    return Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffMaxMs);
  }

  const validActor = (a) => typeof a?.type === 'string' && a.type.trim() !== '' && typeof a?.id === 'string' && a.id.trim() !== '';

  function validate(operationId, tasks, requestedBy) {
    if (requestedBy !== undefined && !validActor(requestedBy)) return 'requestedBy must have a non-empty string type and id';
    if (typeof operationId !== 'string' || !operationId.trim()) return 'operationId must be a non-empty string';
    if (!Array.isArray(tasks) || !tasks.length) return 'an operation needs at least one task';
    const ids = new Set();
    for (const t of tasks) {
      if (typeof t?.id !== 'string' || !t.id) return 'every task needs a string id';
      if (ids.has(t.id)) return `task id ${t.id} is used twice`;
      ids.add(t.id);
      if (!CAPABILITIES.includes(t.capability)) return `task ${t.id} has unknown capability ${t.capability}`;
    }
    return null;
  }

  // The public entry point: checks the request, then either joins a run already in
  // progress, returns a saved result, or starts a new (or resumed) run.
  async function runOperation({ operationId, tasks, requestedBy } = {}) {
    const problem = validate(operationId, tasks, requestedBy);
    if (problem) {
      audit.append({
        correlationId: typeof operationId === 'string' && operationId.trim() ? operationId : 'invalid-request',
        actor: validActor(requestedBy) ? requestedBy : UNKNOWN_REQUESTER,
        action: 'operation.rejected', rationale: problem,
      });
      throw new TypeError(`Operation rejected: ${problem}`);
    }
    const actor = requestedBy ?? UNKNOWN_REQUESTER;
    const fingerprint = fingerprintOf(tasks);

    const conflict = (rationale) => {
      audit.append({ correlationId: operationId, actor, action: 'operation.rejected', rationale });
      return new OperationConflictError(`Operation ${operationId} rejected: ${rationale}`);
    };

    // Already running in this process: hand back the same in-progress result, so
    // a retry from the caller can never run the tasks a second time.
    const running = inFlight.get(operationId);
    if (running) {
      if (running.fingerprint !== fingerprint) throw conflict('This id is already running with a different set of tasks.');
      audit.append({
        correlationId: operationId, actor, action: 'operation.joined',
        rationale: 'Already running; waiting for the same run instead of starting a second one.',
      });
      return running.promise;
    }

    const saved = store.get(operationId);
    if (saved?.fingerprint && saved.fingerprint !== fingerprint) {
      throw conflict('This id was used before with a different set of tasks; use a new operation id.');
    }
    if (saved?.status === 'completed') {
      audit.append({
        correlationId: operationId, actor, action: 'operation.replayed',
        rationale: 'Already completed; returning the saved result without calling any agent again.',
      });
      return { ...saved.result, replayed: true };
    }

    const promise = execute({ operationId, tasks, actor, fingerprint, saved });
    inFlight.set(operationId, { promise, fingerprint });
    // then(cleanup, cleanup), not finally(): finally() would return a second promise
    // that rejects unhandled whenever the run fails.
    const cleanup = () => { inFlight.delete(operationId); };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async function execute({ operationId, tasks, actor, fingerprint, saved }) {
    const log = (action, fields = {}) => audit.append({ correlationId: operationId, actor: ORCHESTRATOR, action, ...fields });

    audit.append({
      correlationId: operationId, actor, action: 'operation.started',
      detail: { tasks: tasks.map((t) => ({ id: t.id, capability: t.capability })), resumed: Boolean(saved) },
    });

    const record = { status: 'running', fingerprint, tasks: { ...(saved?.tasks ?? {}) } };
    store.put(operationId, record);

    // Cancels every in-flight task if something we cannot work without fails.
    const operation = new AbortController();

    async function callWithTimeout(agent, task) {
      const call = new AbortController();
      const onOperationAbort = () => call.abort(operation.signal.reason);
      operation.signal.addEventListener('abort', onOperationAbort, { once: true });
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new TimeoutError(`Agent ${agent.id} did not finish task ${task.id} within ${timeoutMs} ms`, { timeoutMs });
          call.abort(err);
          reject(err);
        }, timeoutMs);
      });
      const cancelled = new Promise((_, reject) => {
        call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
      });
      try {
        const work = Promise.resolve().then(() => agent.run(
          { id: task.id, capability: task.capability, input: task.input, operationId, idempotencyKey: `${operationId}:${task.id}` },
          { signal: call.signal },
        ));
        return await Promise.race([work, timedOut, cancelled]);
      } finally {
        clearTimeout(timer);
        operation.signal.removeEventListener('abort', onOperationAbort);
      }
    }

    // Up to 1 + maxRetries attempts on one agent. Returns { ok, output | error, attempts }.
    async function attemptOnAgent(agent, task) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return { ok: true, output: await callWithTimeout(agent, task), attempts: attempt };
        } catch (err) {
          if (operation.signal.aborted) throw operation.signal.reason;
          const willRetry = classify(err) === 'retry' && attempt <= maxRetries;
          log('task.attempt_failed', {
            subject: task.id,
            detail: { agentId: agent.id, attempt, error: errorInfo(err), next: willRetry ? 'retry same agent' : 'reassign' },
          });
          if (!willRetry) return { ok: false, error: err, attempts: attempt };
          const waitMs = retryDelay(err, attempt);
          log('task.retry_scheduled', { subject: task.id, detail: { agentId: agent.id, nextAttempt: attempt + 1, waitMs } });
          await sleep(waitMs, operation.signal);
        }
      }
    }

    async function runTask(task) {
      const triedAgents = [];
      let previousFailure = null;
      let totalAttempts = 0;

      for (;;) {
        if (operation.signal.aborted) throw operation.signal.reason;
        const candidates = registry.available(task.capability, { exclude: triedAgents });
        if (!candidates.length) {
          const err = new NoAgentAvailableError(`No healthy ${task.capability} agent is left for task ${task.id}`);
          log('task.failed', {
            subject: task.id,
            rationale: triedAgents.length
              ? `Every ${task.capability} agent has failed or is out of rotation (tried: ${triedAgents.join(', ')}).`
              : `No ${task.capability} agent is registered or healthy.`,
            detail: { error: errorInfo(err), triedAgents },
          });
          return { id: task.id, capability: task.capability, status: 'failed', agentId: null, attempts: totalAttempts, triedAgents, error: errorInfo(err) };
        }

        const agent = candidates.reduce((best, a) => ((assignedCount.get(a.id) ?? 0) < (assignedCount.get(best.id) ?? 0) ? a : best));
        assignedCount.set(agent.id, (assignedCount.get(agent.id) ?? 0) + 1);

        if (previousFailure) {
          log('task.reassigned', {
            subject: task.id,
            rationale: `${previousFailure.agentId} failed (${previousFailure.error.name}); moved to ${agent.id}, the least-loaded healthy ${task.capability} agent.`,
            detail: { from: previousFailure.agentId, to: agent.id, triedAgents: [...triedAgents] },
          });
        } else {
          log('task.assigned', {
            subject: task.id,
            rationale: `${agent.id} is the least-loaded healthy ${task.capability} agent.`,
            detail: { agentId: agent.id },
          });
        }

        const result = await attemptOnAgent(agent, task);
        totalAttempts += result.attempts;

        if (result.ok) {
          log('task.completed', { subject: task.id, detail: { agentId: agent.id, attempts: result.attempts } });
          const done = {
            id: task.id, capability: task.capability, status: 'completed', agentId: agent.id,
            attempts: totalAttempts, triedAgents, output: result.output,
          };
          record.tasks[task.id] = done;
          store.put(operationId, record);
          return done;
        }

        triedAgents.push(agent.id);
        const failure = errorInfo(result.error);
        previousFailure = { agentId: agent.id, error: failure };
        // Concurrent tasks can see the same agent fail; take it out (and log it) once.
        if (registry.isHealthy(agent.id)) {
          registry.markUnhealthy(agent.id, `${failure.name}: ${failure.message}`);
          log('agent.marked_unhealthy', {
            subject: agent.id,
            rationale: `Failed task ${task.id} with ${failure.name}; kept out of rotation for the rest of this orchestrator's life.`,
            detail: { error: failure },
          });
        }
      }
    }

    const settled = await Promise.allSettled(tasks.map(async (task) => {
      const already = record.tasks[task.id];
      if (already?.status === 'completed') {
        log('task.skipped', { subject: task.id, rationale: 'Completed in an earlier run of this operation.', detail: { agentId: already.agentId } });
        return already;
      }
      try {
        return await runTask(task);
      } catch (err) {
        operation.abort(err); // stop the other tasks too, then let the error surface
        throw err;
      }
    }));

    const crash = settled.find((s) => s.status === 'rejected');
    if (crash) throw crash.reason;

    const taskResults = settled.map((s) => s.value);
    const status = taskResults.every((t) => t.status === 'completed') ? 'completed' : 'failed';
    const result = { operationId, status, tasks: taskResults, replayed: false };

    audit.append({
      correlationId: operationId, actor, action: `operation.${status}`,
      detail: {
        completed: taskResults.filter((t) => t.status === 'completed').map((t) => t.id),
        failed: taskResults.filter((t) => t.status === 'failed').map((t) => t.id),
      },
    });
    store.put(operationId, { status, fingerprint, tasks: record.tasks, result });
    return result;
  }

  return { runOperation };
}
