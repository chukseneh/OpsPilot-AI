// Action risk classifier (STORY-005). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAction } from '../src/automation/actionRisk.js';

const sys = (over = {}) => ({ id: 'ai-chat', name: 'Help-desk chatbot', status: 'active', riskLevel: 'low', ...over });
const rules = (r) => r.reasons.filter((x) => x.effect === 'high').map((x) => x.rule);

test('low-risk actions stay low, with their reason', () => {
  for (const type of ['notify', 'create_ticket']) {
    const r = classifyAction({ type, params: { to: 'owner' } });
    assert.equal(r.level, 'low', type);
    assert.equal(r.reasons[0].effect, 'base');
  }
  const ok = classifyAction({ type: 'inventory.update_status', params: { systemId: 'ai-chat', status: 'active' } }, { system: sys({ status: 'paused' }) });
  assert.equal(ok.level, 'low');
  assert.equal(classifyAction({ type: 'payment', params: { amount: 50 } }).level, 'high', 'payments are high on their own');
});

test('touching a high-risk or unassessed AI system, or one the inventory does not know, is high', () => {
  const notifyAbout = { type: 'notify', params: { systemId: 'ai-chat' } };
  assert.deepEqual(rules(classifyAction(notifyAbout, { system: sys({ riskLevel: 'high' }) })), ['system.high_risk']);
  assert.deepEqual(rules(classifyAction(notifyAbout, { system: sys({ riskLevel: 'unassessed' }) })), ['system.unassessed']);
  assert.deepEqual(rules(classifyAction(notifyAbout, {})), ['system.not_in_inventory']);
  assert.equal(classifyAction(notifyAbout, { system: sys() }).level, 'low');
});

test('taking an active AI system out of use is high', () => {
  const r = classifyAction({ type: 'inventory.update_status', params: { systemId: 'ai-chat', status: 'retired' } }, { system: sys() });
  assert.deepEqual(rules(r), ['inventory.takes_out_of_use']);
  assert.match(r.reasons.at(-1).why, /set Help-desk chatbot to retired/);
  // Already paused: pausing → retired is not taking an ACTIVE system out of use.
  assert.equal(classifyAction({ type: 'inventory.update_status', params: { systemId: 'ai-chat', status: 'retired' } }, { system: sys({ status: 'paused' }) }).level, 'low');
});

test('payments over the limit, or with no valid amount, say why', () => {
  assert.ok(rules(classifyAction({ type: 'payment', params: { amount: 5000 } })).includes('payment.over_limit'));
  assert.ok(!rules(classifyAction({ type: 'payment', params: { amount: 5000 } }, { paymentLimit: 10000 })).includes('payment.over_limit'));
  for (const amount of [undefined, -5, 0, '100', Number.NaN]) {
    assert.ok(rules(classifyAction({ type: 'payment', params: { amount } })).includes('payment.amount_unknown'), String(amount));
  }
});

test('an irreversible action is high', () => {
  assert.deepEqual(rules(classifyAction({ type: 'notify', irreversible: true })), ['irreversible']);
});

// ---- Failure path: incorrect risk categorisation ----

test('an author can mark an action high, but marking it low never lowers it', () => {
  assert.deepEqual(rules(classifyAction({ type: 'notify', declaredRisk: 'high' })), ['declared.high']);

  const r = classifyAction({ type: 'payment', params: { amount: 5000 }, declaredRisk: 'low' });
  assert.equal(r.level, 'high');
  const ignored = r.reasons.find((x) => x.rule === 'declared.low_ignored');
  assert.equal(ignored.effect, 'ignored');
  assert.match(ignored.why, /cannot lower the risk/);

  assert.equal(classifyAction({ type: 'notify', declaredRisk: 'low' }).level, 'low', 'agreeing with the rules is fine');
  assert.deepEqual(rules(classifyAction({ type: 'notify', declaredRisk: 'medium' })), ['declared.invalid']);
});

test('when in doubt it is high: unknown types, missing details, no action at all', () => {
  assert.deepEqual(rules(classifyAction({ type: 'delete_customer_records' })), ['type.unknown']);
  assert.deepEqual(rules(classifyAction({ type: 'inventory.update_status', params: { systemId: 'ai-chat' } }, { system: sys() })), ['inventory.incomplete']);
  for (const bad of [null, undefined, {}, { type: '  ' }, 'notify']) {
    const r = classifyAction(bad);
    assert.equal(r.level, 'high');
    assert.equal(r.reasons[0].rule, 'action.invalid');
  }
});

test('every result explains itself', () => {
  for (const a of [{ type: 'notify' }, { type: 'payment', params: { amount: 1 } }, { type: 'x' }]) {
    const r = classifyAction(a);
    assert.ok(r.reasons.length > 0);
    for (const reason of r.reasons) assert.ok(reason.rule && reason.why && ['base', 'high', 'ignored'].includes(reason.effect));
  }
});
