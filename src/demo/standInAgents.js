// STAND-IN AGENTS FOR THE DEMO — not real AI, and not connected to Microsoft 365,
// Google Workspace or anything else. They return made-up results (marked standIn: true)
// and fail on a fixed script, so the orchestrator's behaviour can be seen end to end:
//
//   process-1  always unavailable       → its task must move to process-2
//   process-2  works (the spare)
//   risk-1     works
//   finance-1  rate-limited on its first call, then works → retried, not moved
//   finance-2  works (spare, should not be needed)

import { defineAgent } from '../orchestration/agents.js';
import { AgentUnavailableError, RateLimitedError } from '../orchestration/errors.js';

// Pretend to work for a moment, but stop at once if told to.
const think = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export function createStandInAgents() {
  const calls = new Map();
  const counted = (id, run) => async (task, ctx) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return run(task, ctx, calls.get(id));
  };

  const agents = [
    defineAgent({
      id: 'process-1', capabilities: ['process'],
      run: counted('process-1', async () => { throw new AgentUnavailableError('stand-in process-1 is not responding'); }),
    }),
    defineAgent({
      id: 'process-2', capabilities: ['process'],
      run: counted('process-2', async (task, { signal }) => {
        await think(40, signal);
        return {
          standIn: true,
          steps: ['receive invoice', 'match to purchase order', 'manager approval', 'finance approval', 'payment'],
          observations: ['two approval steps in sequence', 'manual matching'],
        };
      }),
    }),
    defineAgent({
      id: 'risk-1', capabilities: ['risk'],
      run: counted('risk-1', async (task, { signal }) => {
        await think(30, signal);
        return { standIn: true, rating: 'medium', reasons: ['payments above threshold need two approvers'] };
      }),
    }),
    defineAgent({
      id: 'finance-1', capabilities: ['finance'],
      run: counted('finance-1', async (task, { signal }, n) => {
        if (n === 1) throw new RateLimitedError('stand-in finance-1: too many requests', { retryAfterMs: 300 });
        await think(30, signal);
        return { standIn: true, monthlyHandlingHours: 42 };
      }),
    }),
    defineAgent({
      id: 'finance-2', capabilities: ['finance'],
      run: counted('finance-2', async (task, { signal }) => {
        await think(30, signal);
        return { standIn: true, monthlyHandlingHours: 42 };
      }),
    }),
  ];

  return {
    agents,
    callCount: () => [...calls.values()].reduce((a, b) => a + b, 0),
    callsBy: () => Object.fromEntries(calls),
  };
}
