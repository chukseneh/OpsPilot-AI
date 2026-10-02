// The slot outside workspaces plug into (REQ-001: Microsoft 365 and Google Workspace
// email and documents). Agents read through a connector, never through a vendor SDK
// directly, so swapping or adding a provider does not touch the orchestrator.
//
// No real connector exists yet. Building one needs credentials this project does not
// have: a Microsoft Entra app registration, a Google Cloud OAuth client, and a test
// account for each. Until then nothing may report these systems as connected.
//
// Both methods are read-only, take { signal } so the caller's timeout reaches the
// network call, and throw NetworkError / RateLimitedError (errors.js) on the matching
// failures so retries stay capped in one place.

export const CONNECTOR_KINDS = Object.freeze(['email_documents']);

export function defineConnector({ id, provider, kind, listMessages, listDocuments }) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('A connector needs a non-empty string id');
  if (typeof provider !== 'string' || !provider.trim()) throw new TypeError(`Connector ${id} needs a provider name`);
  if (!CONNECTOR_KINDS.includes(kind)) {
    throw new TypeError(`Connector ${id} has unknown kind ${kind} (allowed: ${CONNECTOR_KINDS.join(', ')})`);
  }
  for (const [name, fn] of [['listMessages', listMessages], ['listDocuments', listDocuments]]) {
    if (typeof fn !== 'function') throw new TypeError(`Connector ${id} needs ${name}({ since, limit, signal })`);
  }
  return Object.freeze({ id, provider, kind, listMessages, listDocuments });
}
