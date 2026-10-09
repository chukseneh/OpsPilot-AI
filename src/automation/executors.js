// What actually carries out an automated action (STORY-005), and how a failure
// is handled — the "automation failure" path.
//
// An executor is { type, run(params, { idempotencyKey, signal }) → result }.
// The idempotency key is the same on every retry and every re-run of the same
// action, and an executor must use it so that running an action twice never
// sends, creates or pays twice.
//
// runAction() gives every attempt a time limit and allows a capped number of
// attempts. Only failures that can clear on their own are retried (marked
// `retryable`, or the database being briefly unreachable); anything else — a
// refusal, a conflict, a bug — fails at once. Either way the caller gets
// ActionFailedError saying which action, after how many attempts, and why.
//
// Executors here:
//   - inventory.update_status — REAL: changes an AI system's status through the
//     STORY-004 inventory service, acting as the Automation Agent's own identity.
//   - notify, create_ticket, payment — STAND-INS (no Microsoft 365, ticketing or
//     finance connection exists yet). They record what they would have done and
//     say standIn: true in every result. Real connectors replace them later.

import { DatabaseUnavailableError } from '../inventory/db.js';

export const DEFAULTS = Object.freeze({ timeoutMs: 10000, maxAttempts: 3, retryDelayMs: 200 });

// The Automation Agent's service identity. It holds the IT manager role so it may
// change an AI system's status in the inventory; the workflow engine only lets it
// do so for a low-risk action or one a person has approved. Chosen by the student.
export const AUTOMATION_AGENT = Object.freeze({ id: 'automation-agent', role: 'IT manager' });

export class ActionFailedError extends Error {
  constructor(message, { actionType, attempts, cause } = {}) {
    super(message, { cause });
    this.name = 'ActionFailedError';
    this.actionType = actionType;
    this.attempts = attempts;
  }
}

// Throw this (or any error with retryable: true) for a failure worth trying again.
export class TemporaryActionError extends Error {
  constructor(message, options) { super(message, options); this.name = 'TemporaryActionError'; this.retryable = true; }
}

const isRetryable = (err) => err?.retryable === true || err instanceof DatabaseUnavailableError;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const errorText = (err) => `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;

export async function runAction(executor, params, {
  idempotencyKey, timeoutMs = DEFAULTS.timeoutMs, maxAttempts = DEFAULTS.maxAttempts, retryDelayMs = DEFAULTS.retryDelayMs,
} = {}) {
  if (!executor || typeof executor.run !== 'function') {
    throw new ActionFailedError('No executor is registered for this action type.', { attempts: 0 });
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
    throw new ActionFailedError(`${executor.type}: an idempotency key is required, so a retry cannot repeat the action.`, { actionType: executor.type, attempts: 0 });
  }

  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new TemporaryActionError(`timed out after ${timeoutMs} ms`);
        controller.abort(err);
        reject(err);
      }, timeoutMs);
    });
    try {
      // The race means an executor that ignores the signal still cannot hang us.
      const result = await Promise.race([
        Promise.resolve().then(() => executor.run(params, { idempotencyKey, signal: controller.signal })),
        timedOut,
      ]);
      return { result, attempts: attempt };
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxAttempts) {
        const why = isRetryable(err) ? `gave up after ${attempt} attempt${attempt === 1 ? '' : 's'}` : 'not retried: trying again cannot fix it';
        throw new ActionFailedError(`${executor.type} failed (${why}): ${errorText(err)}`, { actionType: executor.type, attempts: attempt, cause: err });
      }
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// REAL: change an AI system's status in the STORY-004 inventory.
// params: { systemId, status, expectedVersion, reason? }
// expectedVersion is the version the workflow saw when the action was classified:
// if the system changed while the action waited for approval, the inventory
// refuses (InventoryConflictError) and the action fails rather than acting on
// stale information. Repeating it after it landed changes nothing.

export function createInventoryStatusExecutor({ inventory, agent = AUTOMATION_AGENT }) {
  return {
    type: 'inventory.update_status',
    async run(params, { idempotencyKey }) {
      const r = await inventory.updateStatus({
        user: agent,
        systemId: params.systemId,
        status: params.status,
        expectedVersion: params.expectedVersion,
        // The inventory requires a reason. Without one from the workflow's author,
        // point at the workflow step, whose audit entries hold the risk decision and any approval.
        reason: params.reason ?? `Requested by workflow step ${idempotencyKey}; see that step's risk classification and approval in the audit log.`,
        requestId: idempotencyKey,
      });
      return { systemId: r.system.id, status: r.system.status, version: r.system.version, changed: r.changed };
    },
  };
}

// ---------------------------------------------------------------------------
// STAND-INS. `behaviour` is for tests and demos:
//   failTimes: fail with a temporary error this many times first
//   fail:      always fail with this (permanent) message
//   hang:      never answer (and ignore the signal)

export function createStandInExecutor(type, behaviour = {}) {
  const done = new Map(); // idempotencyKey → result
  let failuresLeft = behaviour.failTimes ?? 0;
  let calls = 0;
  return {
    type,
    get calls() { return calls; },
    done: () => [...done.values()],
    async run(params, { idempotencyKey }) {
      calls += 1;
      if (done.has(idempotencyKey)) return { ...done.get(idempotencyKey), repeated: true };
      if (behaviour.hang) return new Promise(() => {});
      if (behaviour.fail) throw new Error(behaviour.fail);
      if (failuresLeft > 0) { failuresLeft -= 1; throw new TemporaryActionError(`${type} service briefly unavailable`); }
      const result = { standIn: true, type, idempotencyKey, params: structuredClone(params ?? {}) };
      done.set(idempotencyKey, result);
      return result;
    },
  };
}
