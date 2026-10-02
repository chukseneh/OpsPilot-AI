// Agent contract, registry, errors and connector contract. Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defineAgent, createRegistry } from '../src/orchestration/agents.js';
import {
  classify, AgentUnavailableError, TimeoutError, NetworkError, RateLimitedError,
} from '../src/orchestration/errors.js';
import { defineConnector } from '../src/connectors/connector.js';

const noop = async () => ({});
const agent = (id, capabilities) => defineAgent({ id, capabilities, run: noop });

test('defineAgent refuses an agent with no id, no or unknown capabilities, or no run()', () => {
  assert.throws(() => defineAgent({ id: '', capabilities: ['process'], run: noop }), /id/);
  assert.throws(() => defineAgent({ id: 'a', capabilities: [], run: noop }), /capability/);
  assert.throws(() => defineAgent({ id: 'a', capabilities: ['marketing'], run: noop }), /unknown capabilities: marketing/);
  assert.throws(() => defineAgent({ id: 'a', capabilities: ['risk'] }), /run/);
});

test('registry lists healthy agents for a capability, in registration order', () => {
  const reg = createRegistry([agent('p1', ['process']), agent('r1', ['risk']), agent('p2', ['process', 'finance'])]);
  assert.deepEqual(reg.available('process').map((a) => a.id), ['p1', 'p2']);
  assert.deepEqual(reg.available('finance').map((a) => a.id), ['p2']);
  assert.deepEqual(reg.available('process', { exclude: ['p1'] }).map((a) => a.id), ['p2']);
});

test('an unhealthy agent drops out of rotation and its reason is kept', () => {
  const reg = createRegistry([agent('p1', ['process']), agent('p2', ['process'])]);
  reg.markUnhealthy('p1', 'AgentUnavailableError: not responding');
  assert.deepEqual(reg.available('process').map((a) => a.id), ['p2']);
  assert.equal(reg.isHealthy('p1'), false);
  assert.deepEqual(reg.health(), { p1: 'AgentUnavailableError: not responding', p2: 'healthy' });
});

test('registry: after the cooldown an agent is offered for one trial at a time', () => {
  let t = 0;
  const reg = createRegistry([agent('p1', ['process'])], { cooldownMs: 100, now: () => t });
  reg.markUnhealthy('p1', 'down');
  assert.deepEqual(reg.available('process'), []);
  t = 100;
  assert.equal(reg.isProbeCandidate('p1'), true);
  assert.deepEqual(reg.available('process').map((a) => a.id), ['p1']);

  reg.beginProbe('p1');
  assert.deepEqual(reg.available('process'), [], 'the trial slot is taken');
  assert.throws(() => reg.beginProbe('p1'), /not due a trial/);

  reg.endProbe('p1'); // cancelled without a verdict: slot freed, cooldown not restarted
  assert.equal(reg.isProbeCandidate('p1'), true);

  reg.beginProbe('p1');
  reg.markUnhealthy('p1', 'failed trial'); // failed: cooldown restarts from now
  assert.equal(reg.isProbeCandidate('p1'), false);
  t = 200;
  reg.beginProbe('p1');
  reg.markHealthy('p1');
  assert.equal(reg.isHealthy('p1'), true);
  assert.deepEqual(reg.health(), { p1: 'healthy' });
});

test('registry refuses two agents with the same id', () => {
  assert.throws(() => createRegistry([agent('a', ['risk']), agent('a', ['process'])]), /share the id a/);
});

test('network failures and rate limits are retried; unavailability, timeouts and surprises are reassigned', () => {
  assert.equal(classify(new NetworkError('reset')), 'retry');
  assert.equal(classify(new RateLimitedError('429', { retryAfterMs: 500 })), 'retry');
  assert.equal(classify(new AgentUnavailableError('down')), 'reassign');
  assert.equal(classify(new TimeoutError('slow', { timeoutMs: 100 })), 'reassign');
  assert.equal(classify(new TypeError('bug in agent')), 'reassign');
  assert.equal(new RateLimitedError('429', { retryAfterMs: 500 }).retryAfterMs, 500);
  assert.equal(new TimeoutError('slow').name, 'TimeoutError');
});

test('defineConnector requires a provider, a known kind and both read methods', () => {
  const ok = { id: 'm365', provider: 'Microsoft 365', kind: 'email_documents', listMessages: noop, listDocuments: noop };
  assert.equal(defineConnector(ok).provider, 'Microsoft 365');
  assert.throws(() => defineConnector({ ...ok, provider: '' }), /provider/);
  assert.throws(() => defineConnector({ ...ok, kind: 'crm' }), /unknown kind crm/);
  assert.throws(() => defineConnector({ ...ok, listDocuments: undefined }), /listDocuments/);
});
