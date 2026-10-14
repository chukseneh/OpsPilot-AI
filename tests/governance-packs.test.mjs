// The illustrative UK and EU policy packs (STORY-009). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { examplePack, EXAMPLE_JURISDICTIONS } from '../src/governance/packs/index.js';
import { validatePolicy } from '../src/governance/policy.js';

const TODAY = new Date('2026-10-12T00:00:00Z');

for (const code of EXAMPLE_JURISDICTIONS) {
  test(`${code} pack: valid, no alerts at all`, () => {
    const r = validatePolicy(examplePack(code), { today: TODAY });
    assert.deepEqual(r.alerts, []);
    assert.equal(r.ok, true);
    assert.equal(r.policy.jurisdiction.code, code);
  });

  test(`${code} pack: clearly marked as an illustrative example, not legal advice`, () => {
    const p = examplePack(code);
    assert.equal(p.illustrative, true);
    assert.match(p.notes, /^ILLUSTRATIVE EXAMPLE - not legal advice/);
    assert.match(p.notes, /reviewed by qualified counsel/);
  });

  test(`${code} pack: every control cites a listed source and says what is sourced and what is an example choice`, () => {
    const p = examplePack(code);
    const ids = new Set(p.sources.map((s) => s.id));
    for (const [name, ctl] of Object.entries(p.controls)) {
      assert.ok(ids.has(ctl.source), `${name} cites a listed source`);
      assert.match(ctl.note, /Supported by the source/, `${name} says what the source supports`);
      assert.match(ctl.note, /Example choice/, `${name} says what is an example choice`);
    }
    for (const s of p.sources) if (s.url) assert.match(s.url, /^https:\/\/(www\.legislation\.gov\.uk|eur-lex\.europa\.eu)\//, `${s.id}: an official legislation site`);
  });
}

test('the two jurisdictions differ, so the system behaves differently by jurisdiction', () => {
  const uk = examplePack('UK').controls;
  const eu = examplePack('EU').controls;
  assert.notDeepEqual(uk.riskRules.highRiskDataCategories, eu.riskRules.highRiskDataCategories);
  assert.notEqual(uk.approvals.approvalDeadlineHours, eu.approvals.approvalDeadlineHours);
  assert.notEqual(uk.recordKeeping.auditRetentionDays, eu.recordKeeping.auditRetentionDays);
});

test('each call returns a fresh copy; the shipped examples cannot be changed by accident', () => {
  const a = examplePack('UK');
  a.controls.approvals.approvalDeadlineHours = 1;
  assert.equal(examplePack('UK').controls.approvals.approvalDeadlineHours, 24);
  assert.throws(() => examplePack('FR'), /no example pack for "FR" \(available: UK, EU\)/);
});

test('a note must be text when given', () => {
  const p = examplePack('UK');
  p.controls.approvals.note = '';
  assert.match(validatePolicy(p, { today: TODAY }).alerts.map((x) => x.message).join(), /must be text when given/);
});
