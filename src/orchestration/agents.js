// What an agent is, and the registry that tracks which agents can take work.
//
// An agent has an id, the kinds of work it can do, and an async run(task, { signal }).
// run() must stop when signal aborts (that is how timeouts reach it) and should
// throw one of the errors in errors.js so the orchestrator knows whether to retry
// or reassign.

export const CAPABILITIES = Object.freeze(['process', 'risk', 'finance']);

export function defineAgent({ id, capabilities, run }) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('An agent needs a non-empty string id');
  if (!Array.isArray(capabilities) || !capabilities.length) {
    throw new TypeError(`Agent ${id} needs at least one capability`);
  }
  const unknown = capabilities.filter((c) => !CAPABILITIES.includes(c));
  if (unknown.length) {
    throw new TypeError(`Agent ${id} has unknown capabilities: ${unknown.join(', ')} (allowed: ${CAPABILITIES.join(', ')})`);
  }
  if (typeof run !== 'function') throw new TypeError(`Agent ${id} needs a run(task, { signal }) function`);
  return Object.freeze({ id, capabilities: Object.freeze([...new Set(capabilities)]), run });
}

// Recovery (a "circuit breaker" per agent): an agent that fails is out of rotation
// for cooldownMs. After that it may take ONE trial task at a time — a probe. If the
// probe succeeds the caller marks it healthy; if it fails the caller marks it
// unhealthy again, which restarts the cooldown.
export const DEFAULT_COOLDOWN_MS = 30000;

export function createRegistry(agents, { cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
  const byId = new Map();
  for (const agent of agents) {
    if (byId.has(agent.id)) throw new TypeError(`Two agents share the id ${agent.id}`);
    byId.set(agent.id, agent);
  }
  // id → { reason, since, probing }. Absent means healthy.
  const unhealthy = new Map();

  const known = (id) => { if (!byId.has(id)) throw new Error(`No agent with id ${id}`); };

  // Out of rotation, cooldown over, and no trial task already running on it.
  function isProbeCandidate(id) {
    const s = unhealthy.get(id);
    return Boolean(s) && !s.probing && now() - s.since >= cooldownMs;
  }

  return {
    cooldownMs,
    get: (id) => byId.get(id),
    all: () => [...byId.values()],

    // Agents that can take a task needing `capability`, in registration order:
    // healthy ones, plus out-of-rotation ones that are due a trial task.
    available(capability, { exclude = [] } = {}) {
      return [...byId.values()].filter((a) => a.capabilities.includes(capability) && !exclude.includes(a.id)
        && (!unhealthy.has(a.id) || isProbeCandidate(a.id)));
    },

    isProbeCandidate,

    // Claim the single trial slot. Call straight after choosing the agent.
    beginProbe(id) {
      known(id);
      if (!isProbeCandidate(id)) throw new Error(`Agent ${id} is not due a trial task`);
      unhealthy.get(id).probing = true;
    },

    // The trial ended without a verdict (e.g. the operation was cancelled): free the
    // slot so a later task can try, without restarting the cooldown.
    endProbe(id) {
      const s = unhealthy.get(id);
      if (s) s.probing = false;
    },

    markHealthy(id) {
      known(id);
      unhealthy.delete(id);
    },

    // Out of rotation from now; the cooldown (re)starts.
    markUnhealthy(id, reason) {
      known(id);
      unhealthy.set(id, { reason, since: now(), probing: false });
    },

    isHealthy: (id) => byId.has(id) && !unhealthy.has(id),

    health: () => Object.fromEntries([...byId.keys()].map((id) => [id, unhealthy.get(id)?.reason ?? 'healthy'])),
  };
}
