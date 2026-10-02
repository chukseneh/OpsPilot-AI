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

export function createRegistry(agents) {
  const byId = new Map();
  for (const agent of agents) {
    if (byId.has(agent.id)) throw new TypeError(`Two agents share the id ${agent.id}`);
    byId.set(agent.id, agent);
  }
  // id → why it was taken out of rotation. Absent means healthy.
  const unhealthy = new Map();

  return {
    get: (id) => byId.get(id),
    all: () => [...byId.values()],

    // Healthy agents that can do `capability`, in registration order.
    available(capability, { exclude = [] } = {}) {
      return [...byId.values()].filter((a) =>
        a.capabilities.includes(capability) && !unhealthy.has(a.id) && !exclude.includes(a.id));
    },

    markUnhealthy(id, reason) {
      if (!byId.has(id)) throw new Error(`No agent with id ${id}`);
      unhealthy.set(id, reason);
    },

    isHealthy: (id) => byId.has(id) && !unhealthy.has(id),

    health: () => Object.fromEntries([...byId.keys()].map((id) => [id, unhealthy.get(id) ?? 'healthy'])),
  };
}
