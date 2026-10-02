// The failures an agent can report, and what the orchestrator does about each.
//
//   retry     — a passing problem with the call, not the agent: NetworkError,
//               RateLimitedError. Try the SAME agent again, within a cap.
//   reassign  — the agent itself cannot do the work: AgentUnavailableError,
//               TimeoutError, or any error we did not expect. Take the agent out
//               of rotation and give the task to ANOTHER agent.

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

export function classify(err) {
  if (err instanceof NetworkError || err instanceof RateLimitedError) return 'retry';
  return 'reassign';
}
