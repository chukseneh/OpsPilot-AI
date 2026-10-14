// Configuring governance per jurisdiction: two-person rule, versions, review dates, audit (STORY-009). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGovernanceService, migrateGovernance, diffPolicies, PermissionDeniedError, PolicyMisconfiguredError, GovernanceRequestError,
} from '../src/governance/service.js';
import { examplePack } from '../src/governance/packs/index.js';
import { openPGlite } from '../src/inventory/db.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { isDecision } from '../src/audit/decisions.js';

const CO1 = { id: 'co-1', role: 'compliance officer' };
const CO2 = { id: 'co-2', role: 'compliance officer' };
const SEC = { id: 'sec-1', role: 'security officer' };

let pg;
before(async () => { pg = await openPGlite(); await migrateGovernance(pg); });
after(async () => { await pg.close(); });

async function setup(start = '2026-10-12T09:00:00Z') {
  await pg.exec('TRUNCATE policy_versions');
  let t = Date.parse(start);
  const clock = { now: () => new Date(t), set: (iso) => { t = Date.parse(iso); } };
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'gov-')), 'audit.jsonl'), now: clock.now });
  const gov = createGovernanceService({ db: pg, audit, now: clock.now });
  const entries = () => audit.readAll();
  const approveUk = async () => {
    const p = await gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt the UK policy pack' });
    return gov.approveProposal({ user: SEC, jurisdiction: 'UK', version: p.version, note: 'Reviewed with counsel' });
  };
  return { gov, audit, entries, clock, approveUk };
}

// ---- Acceptance 1: a selected jurisdiction's controls reflect its policy ----

test('propose → approve: the UK policy is in force, with its controls', async () => {
  const { gov, approveUk } = await setup();
  assert.equal(await gov.getActivePolicy({ jurisdiction: 'UK' }), null, 'nothing in force before approval');
  const approved = await approveUk();
  assert.deepEqual([approved.status, approved.version, approved.decidedBy], ['approved', 1, 'sec-1']);
  const active = await gov.getActivePolicy({ jurisdiction: 'UK' });
  assert.equal(active.version, 1);
  assert.equal(active.policy.controls.approvals.approvalDeadlineHours, 24);
  assert.equal(active.reviewOverdue, false);
  assert.equal(await gov.getActivePolicy({ jurisdiction: 'EU' }), null, 'jurisdictions are independent');
});

test('a proposal does not take effect until a second person approves it', async () => {
  const { gov } = await setup();
  await gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt the UK pack' });
  assert.equal(await gov.getActivePolicy({ jurisdiction: 'UK' }), null);
});

// ---- Acceptance 2: misconfiguration alerts the user ----

test('a misconfigured proposal is refused with every alert returned to the user and logged', async () => {
  const { gov, entries } = await setup();
  const bad = examplePack('UK');
  bad.controls.approvals.highRiskActionsNeedApproval = false;
  bad.controls.approvals.escalateAfterHours = 30;
  await assert.rejects(gov.proposePolicy({ user: CO1, policy: bad, reason: 'Relax approvals' }), (err) => {
    assert.ok(err instanceof PolicyMisconfiguredError);
    assert.equal(err.alerts.filter((a) => a.severity === 'error').length, 2);
    assert.match(err.message, /cannot be switched off/);
    assert.match(err.message, /escalation \(30 h\) must come before the deadline \(24 h\)/);
    return true;
  });
  const refused = entries().find((e) => e.action === 'governance.proposal_refused');
  assert.match(refused.rationale, /^Misconfigured: /);
  assert.equal(refused.detail.alerts.length, 2);
  assert.equal(await gov.getActivePolicy({ jurisdiction: 'UK' }), null, 'nothing was stored or activated');
});

test('warnings are kept with the version and shown where it is used', async () => {
  const { gov } = await setup();
  const p = examplePack('UK');
  delete p.controls.riskRules.source;
  const v = await gov.proposePolicy({ user: CO1, policy: p, reason: 'x' });
  assert.match(v.alerts.map((a) => a.message).join(), /cites no source/);
});

// ---- Failure path: unauthorized configuration changes ----

test('two-person rule: nobody approves their own proposal; other roles cannot propose or decide', async () => {
  const { gov, entries } = await setup();
  const p = await gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt' });
  await assert.rejects(gov.approveProposal({ user: CO1, jurisdiction: 'UK', version: p.version, note: 'ok' }), /may not decide on it \(two-person rule\)/);
  await assert.rejects(gov.proposePolicy({ user: SEC, policy: examplePack('EU'), reason: 'x' }), PermissionDeniedError);
  await assert.rejects(gov.approveProposal({ user: { id: 'it-1', role: 'IT manager' }, jurisdiction: 'UK', version: 1, note: 'ok' }), PermissionDeniedError);
  await assert.rejects(gov.proposePolicy({ policy: examplePack('UK'), reason: 'x' }), PermissionDeniedError);
  assert.equal(await gov.getActivePolicy({ jurisdiction: 'UK' }), null);
  assert.equal(entries().filter((e) => e.action === 'governance.denied').length, 3);
  assert.equal(entries().filter((e) => e.action === 'governance.decision_refused').length, 1);
});

test('the database itself refuses a self-approval, even if the code were bypassed', async () => {
  const { gov } = await setup();
  await gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt' });
  await assert.rejects(pg.query("UPDATE policy_versions SET status = 'approved', decided_by = 'co-1' WHERE jurisdiction = 'UK'"), /two_person_rule/);
});

test('only a pending proposal can be decided; a note is required; deciding twice changes nothing', async () => {
  const { gov } = await setup();
  const p = await gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt' });
  await assert.rejects(gov.approveProposal({ user: CO2, jurisdiction: 'UK', version: p.version, note: ' ' }), /a note is required/);
  await gov.rejectProposal({ user: CO2, jurisdiction: 'UK', version: p.version, note: 'Retention needs legal sign-off' });
  const again = await gov.rejectProposal({ user: CO2, jurisdiction: 'UK', version: p.version, note: 'Retention needs legal sign-off' });
  assert.equal(again.status, 'rejected');
  await assert.rejects(gov.approveProposal({ user: SEC, jurisdiction: 'UK', version: p.version, note: 'ok' }), /not waiting for a decision \(it is rejected, by co-2\)/);
  await assert.rejects(gov.approveProposal({ user: SEC, jurisdiction: 'UK', version: 9, note: 'ok' }), /no version 9 for UK/);
});

test('a proposal needs a reason, and cannot take effect in the past', async () => {
  const { gov } = await setup();
  await assert.rejects(gov.proposePolicy({ user: CO1, policy: examplePack('UK') }), /a reason is required/);
  await assert.rejects(gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'x', effectiveFrom: '2026-01-01' }), /cannot take effect retroactively/);
  await assert.rejects(gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'x', effectiveFrom: '1 Jan' }), GovernanceRequestError);
});

// ---- Failure path: regulatory updates ----

test('an update is a new version with a diff; it takes over on its effective date; old versions are kept', async () => {
  const { gov, clock, approveUk, entries } = await setup();
  await approveUk();
  const updated = examplePack('UK');
  updated.controls.approvals.approvalDeadlineHours = 12;
  updated.reviewBy = '2027-09-30';
  const v2 = await gov.proposePolicy({ user: CO1, policy: updated, effectiveFrom: '2026-11-01', reason: 'Regulator guidance update: faster human review' });
  assert.deepEqual(v2.diff, [
    { path: 'controls.approvals.approvalDeadlineHours', from: 24, to: 12 },
    { path: 'reviewBy', from: '2027-03-31', to: '2027-09-30' },
  ]);
  await gov.approveProposal({ user: CO2, jurisdiction: 'UK', version: 2, note: 'Checked against the new guidance' });

  assert.equal((await gov.getActivePolicy({ jurisdiction: 'UK' })).version, 1, 'still version 1 before 1 November');
  clock.set('2026-11-01T00:00:01Z');
  const active = await gov.getActivePolicy({ jurisdiction: 'UK' });
  assert.deepEqual([active.version, active.policy.controls.approvals.approvalDeadlineHours], [2, 12]);
  assert.equal((await gov.listVersions({ user: SEC, jurisdiction: 'UK' })).length, 2, 'version 1 is kept');

  const approvedEntry = entries().filter((e) => e.action === 'governance.approved').at(-1);
  assert.deepEqual(approvedEntry.detail.diff[0], { path: 'controls.approvals.approvalDeadlineHours', from: 24, to: 12 });
});

test('when the policy in force passes its review date, the system alerts once that it may be out of date', async () => {
  const { gov, clock, approveUk, entries } = await setup();
  await approveUk();
  assert.deepEqual(await gov.checkReviewDates(), []);
  clock.set('2027-04-01T09:00:00Z');
  assert.equal((await gov.getActivePolicy({ jurisdiction: 'UK' })).reviewOverdue, true);
  assert.deepEqual(await gov.checkReviewDates(), [{ jurisdiction: 'UK', version: 1, reviewBy: '2027-03-31' }]);
  assert.deepEqual(await gov.checkReviewDates(), [], 'only once');
  assert.match(entries().find((e) => e.action === 'governance.review_overdue').rationale, /passed its review date 2027-03-31; its rules may no longer match the law/);
});

test('approval re-checks the policy: its alerts are refreshed (a review date that passed while it waited shows up)', async () => {
  const { gov, clock } = await setup();
  const p = examplePack('UK');
  const v = await gov.proposePolicy({ user: CO1, policy: p, reason: 'Adopt' });
  clock.set('2027-06-01T09:00:00Z'); // past its review date: a warning, still approvable
  const ok = await gov.approveProposal({ user: CO2, jurisdiction: 'UK', version: v.version, note: 'ok' });
  assert.match(ok.alerts.map((a) => a.message).join(), /has passed/);
});

// ---- Idempotency ----

test('the same proposal twice gives the same version', async () => {
  const { gov, entries } = await setup();
  const a = await gov.proposePolicy({ user: CO1, policy: examplePack('EU'), reason: 'Adopt EU' });
  const b = await gov.proposePolicy({ user: CO1, policy: examplePack('EU'), reason: 'Adopt EU' });
  assert.equal(a.version, b.version);
  assert.equal(entries().filter((e) => e.action === 'governance.proposed').length, 1);
});

// ---- Trust: configuration changes are logged ----

test('every change is logged with who, why and the diff; decisions carry their rationale', async () => {
  const { approveUk, entries, audit } = await setup();
  await approveUk();
  const [proposed, approved] = entries();
  assert.deepEqual([proposed.action, proposed.actor.id, proposed.rationale], ['governance.proposed', 'co-1', 'Adopt the UK policy pack']);
  assert.ok(proposed.detail.diff.length > 10, 'the first version lists every setting it introduces');
  assert.deepEqual([approved.action, approved.actor.id, approved.rationale, approved.detail.proposedBy], ['governance.approved', 'sec-1', 'Reviewed with counsel', 'co-1']);
  assert.ok(entries().every((e) => e.at && e.actor.id && (!isDecision(e.action) || e.rationale)));
  assert.equal(audit.verify().ok, true);
});

test('if the audit log fails, the proposal is not stored', async () => {
  await pg.exec('TRUNCATE policy_versions');
  const audit = { append: (e) => { if (e.action === 'governance.proposed') throw new AuditWriteError('disk full'); return { seq: 1, ...e }; } };
  const gov = createGovernanceService({ db: pg, audit });
  await assert.rejects(gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt' }), AuditWriteError);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM policy_versions')).rows[0].n, 0);
});

test('diffPolicies lists each changed setting, from → to', () => {
  assert.deepEqual(diffPolicies({ a: { b: 1, c: [1] } }, { a: { b: 2, c: [1], d: 'x' } }), [
    { path: 'a.b', from: 1, to: 2 }, { path: 'a.d', from: null, to: 'x' },
  ]);
});

test('key order is not a change (jsonb reorders keys when a policy is read back)', () => {
  const before = { sources: [{ id: 'a', title: 'T', url: 'https://x' }] };
  const after = { sources: [{ url: 'https://x', id: 'a', title: 'T' }] };
  assert.deepEqual(diffPolicies(before, after), []);
});
