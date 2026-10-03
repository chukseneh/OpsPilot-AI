// The failures an agent can report, and what the orchestrator does about each.
//
//   retry     — a passing problem with the call, not the agent: NetworkError,
//               RateLimitedError. Try the SAME agent again, within a cap.
//   reassign  — the agent itself cannot do the work: AgentUnavailableError,
//               TimeoutError, or any error we did not expect. Take the agent out
//               of rotation and give the task to ANOTHER agent.
//   fail      — the agent is fine, but THIS task could not finish this time
//               (TaskFailedError, e.g. an analysis that hit its own time limit).
//               Fail the task at once: no retry, no other agent, the agent stays
//               in rotation, and the operation is marked failed so it re-runs.

export class OrchestrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class AgentUnavailableError extends OrchestrationError {}

export class TimeoutError extends OrchestrationError {
  constructor(message, { timeoutMs, ...options } = {}) {
    super(message, options);
    this.timeoutMs = timeoutMs;
  }
}

export class NetworkError extends OrchestrationError {}

export class RateLimitedError extends OrchestrationError {
  // retryAfterMs: how long the other side asked us to wait, if it said.
  constructor(message, { retryAfterMs = null, ...options } = {}) {
    super(message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

// No healthy agent is left that can do a task. The operation cannot finish.
export class NoAgentAvailableError extends OrchestrationError {}

// An operation id was reused with a different set of tasks. Refused, because
// returning or resuming the old work would answer a question nobody asked.
export class OperationConflictError extends OrchestrationError {}

// The agent worked but this task did not finish (see "fail" above). Raise it only
// when another agent would do no better and the agent itself is healthy.
export class TaskFailedError extends OrchestrationError {}

export function classify(err) {
  if (err instanceof NetworkError || err instanceof RateLimitedError) return 'retry';
  if (err instanceof TaskFailedError) return 'fail';
  return 'reassign';
}
