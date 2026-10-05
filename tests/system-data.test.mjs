// AI system data checks for risk assessment (STORY-003). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSystems, incompleteSystemsNotice } from '../src/risk/systemData.js';

const system = (over = {}) => ({
  id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications',
  owner: 'hr-lead-1', status: 'active', dataCategories: ['personal'], decisionImpact: 'significant',
  humanOversight: 'review', userFacing: false, ...over,
});

test('complete systems pass and are normalised', () => {
  const v = validateSystems([
    system({ name: '  CV screener ', dataCategories: ['personal', 'internal', 'personal'] }),
    system({ id: 'ai-chat', name: 'Help chatbot', userFacing: true, dataCategories: ['public'] }),
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.systems.length, 2);
  assert.deepEqual(v.incomplete, []);
  assert.equal(v.systems[0].name, 'CV screener');
  assert.deepEqual(v.systems[0].dataCategories, ['internal', 'personal']);
  assert.equal(incompleteSystemsNotice(v), null);
});

test('an incomplete system is held back with each missing field named; the rest can still be assessed', () => {
  const { decisionImpact, userFacing, ...partial } = system({ id: 'ai-fraud', name: 'Fraud scorer' });
  const v = validateSystems([system(), partial]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.systems.map((s) => s.id), ['ai-cv-screen']);
  assert.equal(v.incomplete.length, 1);
  assert.equal(v.incomplete[0].systemId, 'ai-fraud');
  assert.equal(v.incomplete[0].position, 2);
  assert.deepEqual(v.incomplete[0].problems.map((p) => p.field).sort(), ['decisionImpact', 'userFacing']);

  const notice = incompleteSystemsNotice(v);
  assert.match(notice, /1 AI system\(s\) were not assessed/);
  assert.match(notice, /"Fraud scorer" \(ai-fraud\) was not assessed: .*"decisionImpact" is missing/);
  assert.match(notice, /"userFacing" is missing/);
});

test('invalid values are refused, never guessed', () => {
  const v = validateSystems([system({
    status: 'live', decisionImpact: 'huge', humanOversight: 'sometimes', userFacing: 'yes',
    dataCategories: ['personal', 'health'], owner: '   ', purpose: 42,
  })]);
  const byField = Object.fromEntries(v.incomplete[0].problems.map((p) => [p.field, p.problem]));
  assert.match(byField.status, /must be one of/);
  assert.match(byField.decisionImpact, /must be one of/);
  assert.match(byField.humanOversight, /must be one of/);
  assert.match(byField.userFacing, /true or false/);
  assert.match(byField.dataCategories, /"health"/);
  assert.equal(byField.owner, 'is missing');
  assert.equal(byField.purpose, 'must be text');
  assert.deepEqual(v.systems, []);
  assert.match(incompleteSystemsNotice(v), /^No risk assessment was produced/);
});

test('an empty category list and a non-record are each reported', () => {
  const v = validateSystems([system({ dataCategories: [] }), 'not a record', null]);
  assert.equal(v.systems.length, 0);
  assert.equal(v.incomplete.length, 3);
  assert.match(v.incomplete[0].problems[0].problem, /non-empty list/);
  assert.equal(v.incomplete[1].systemId, null);
  assert.match(incompleteSystemsNotice(v), /System #2 \(no id\) was not assessed: is not an AI system record/);
});

test('a reused id is not assessed twice', () => {
  const v = validateSystems([system(), system({ name: 'Another' })]);
  assert.equal(v.systems.length, 1);
  assert.equal(v.incomplete[0].position, 2);
  assert.match(v.incomplete[0].problems.at(-1).problem, /earlier system/);
});

test('no systems, or not a list, is reported at list level', () => {
  for (const input of [[], undefined, { id: 'x' }]) {
    const v = validateSystems(input);
    assert.equal(v.ok, false);
    assert.equal(v.problems.length, 1);
    assert.match(incompleteSystemsNotice(v), /^No risk assessment was produced/);
  }
});
