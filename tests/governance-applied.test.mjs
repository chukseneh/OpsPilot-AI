// The policy in force changes how the system behaves (STORY-009, acceptance 1). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { classifyAction } from '../src/automation/actionRisk.js';
import { createRuleBasedRiskModel, createPolicyAwareRiskModel, policyRules } from '../src/risk/riskModel.js';
import { createGovernanceView } from '../src/governance/view.js';
import { examplePack } from '../src/governance/packs/index.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { startOpsPilot } from '../src/system.js';

// A policy as services see it through the view.
const inForce = (code, over = {}) => {
  const p = examplePack(code);
  return { jurisdiction: p.jurisdiction, version: 1, controls: { ...p.controls, ...over } };
};
const view = (policy) => ({ current: () => policy });
const system = (over = {}) => ({
  id: 'ai-x', name: 'Claims triage', department: 'Finance', purpose: 'p', owner: 'o', status: 'active', riskLevel: 'low',
  dataCategories: ['personal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false, ...over,
});

// ---- Approvals (STORY-005) ----

test('under a policy requiring it, an action on a personal-data system needs approval; without one it does not', () => {
  const action = { type: 'notify', params: { systemId: 'ai-x' } };
  assert.equal(classifyAction(action, { system: system() }).level, 'low', 'built-in rules: low');
  const r = classifyAction(action, { system: system(), policy: inForce('UK') });
  assert.equal(r.level, 'high');
  assert.match(r.reasons.find((x) => x.rule === 'policy.personal_data').why, /Under the UK governance policy \(version 1\), actions on AI systems that process personal data need human approval; Claims triage processes personal data/);
  assert.equal(classifyAction(action, { system: system({ dataCategories: ['internal'] }), policy: inForce('UK') }).level, 'low', 'no personal data: no extra approval');
  const off = inForce('UK', { approvals: { ...examplePack('UK').controls.approvals, personalDataActionsNeedApproval: false } });
  assert.equal(classifyAction(action, { system: system(), policy: off }).level, 'low');
});

// ---- Risk rules (STORY-003) ----

test('the EU example treats personal data as high risk; the UK example and the built-in rules do not', () => {
  const s = system();
  const builtIn = createRuleBasedRiskModel().assess(s).risks.find((r) => r.category === 'privacy');
  assert.equal(builtIn.severity, 'medium');
  const eu = createPolicyAwareRiskModel(view(inForce('EU'))).assess(s).risks.find((r) => r.rule === 'jurisdiction.high_risk_data');
  assert.equal(eu.severity, 'high');
  assert.match(eu.why, /Under the EU governance policy \(version 1\), AI systems processing personal data are high risk/);
  assert.equal(createPolicyAwareRiskModel(view(inForce('UK'))).assess(s).risks.some((r) => r.rule.startsWith('jurisdiction.')), false);
});

test('a policy can extend human-oversight requirements to lower-impact decisions, never narrow them', () => {
  const p = inForce('UK', { riskRules: { highRiskDataCategories: [], humanOversightRequiredFor: ['low', 'significant', 'critical'] } });
  const r = createPolicyAwareRiskModel(view(p)).assess(system({ dataCategories: ['internal'], humanOversight: 'none' })).risks;
  assert.match(r.find((x) => x.rule === 'jurisdiction.oversight_required').why, /decisions with low impact need human oversight/);
  // Narrowing: a policy listing only 'critical' does not remove the built-in rule for 'significant'.
  const narrow = inForce('UK', { riskRules: { highRiskDataCategories: [], humanOversightRequiredFor: ['critical'] } });
  const sig = createPolicyAwareRiskModel(view(narrow)).assess(system({ dataCategories: ['internal'], decisionImpact: 'significant', humanOversight: 'none' })).risks;
  assert.ok(sig.some((x) => x.rule === 'human_oversight.missing' && x.severity === 'high'));
  assert.deepEqual(policyRules(null), []);
});

test('the risk model version names the policy it ran under', () => {
  assert.equal(createPolicyAwareRiskModel(view(null)).version, '1');
  assert.equal(createPolicyAwareRiskModel(view({ ...inForce('UK'), version: 2 })).version, '1+UK.v2');
});

// ---- The view ----

test('the view records each switch of the policy in force, once', async () => {
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'view-')), 'a.jsonl') });
  let active = null;
  const gov = { getActivePolicy: async () => active };
  const v = createGovernanceView({ governance: gov, jurisdiction: 'UK', audit });
  await v.refresh(); await v.refresh();
  active = { version: 1, effectiveFrom: '2026-10-13', policy: examplePack('UK'), reviewOverdue: false };
  await v.refresh(); await v.refresh();
  assert.equal(v.current().version, 1);
  const applied = audit.readAll().map((e) => e.rationale);
  assert.equal(applied.length, 2);
  assert.match(applied[0], /No approved governance policy is in force for UK; the built-in rules apply/);
  assert.match(applied[1], /Now applying the UK governance policy, version 1 .*marked ILLUSTRATIVE/);
  const none = createGovernanceView({ governance: gov, audit });
  assert.equal(await none.refresh(), null, 'no jurisdiction selected: nothing applies');
});

test('if refreshing fails, the last policy keeps applying and the failure is logged', async () => {
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'view-')), 'a.jsonl') });
  let fail = false;
  const gov = { getActivePolicy: async () => { if (fail) throw new Error('database unavailable'); return { version: 1, effectiveFrom: '2026-10-13', policy: examplePack('UK') }; }, checkReviewDates: async () => [] };
  const v = createGovernanceView({ governance: gov, jurisdiction: 'UK', audit });
  await v.refresh();
  fail = true;
  const t = { fn: null };
  const timer = v.startTimer({ timers: { setInterval: (fn) => { t.fn = fn; return {}; }, clearInterval() {} }, onError: () => {} });
  await t.fn();
  assert.equal(v.current().version, 1, 'still applying the last known policy');
  assert.match(audit.readAll().at(-1).rationale, /database unavailable/);
  await timer.stop();
});

// ---- End to end: the same system, different jurisdictions ----

const startWith = async (jurisdiction) => {
  const dir = mkdtempSync(join(tmpdir(), 'gov-e2e-'));
  const env = { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl'), GOVERNANCE_JURISDICTION: jurisdiction };
  const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
  return { env, sys: await startOpsPilot({ env, timers: { approvals: idle, anchors: idle, governance: idle } }) };
};
const CO1 = { id: 'co-1', role: 'compliance officer' };
const SEC = { id: 'sec-1', role: 'security officer' };
const IT = { id: 'it-1', role: 'IT manager' };
const PM = { id: 'pm-1', role: 'process manager' };
const claims = {
  id: 'ai-claims', name: 'Claims triage', department: 'Finance', purpose: 'Routes expense claims', owner: 'fin-1',
  status: 'active', dataCategories: ['personal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false,
};

test('end to end: selecting EU and approving its policy changes approvals, risk ratings, audit readers and retention', async () => {
  const { sys } = await startWith('EU');
  try {
    const s = sys.services;
    assert.equal(s.governance.inForce(), null, 'nothing in force until approved');
    await s.inventory.registerSystem({ user: IT, system: claims, reason: 'Initial load' });

    // Before: built-in rules.
    const before = await s.workflows.startWorkflow({ user: PM, workflowId: 'WF-before', name: 'Notify', actions: [{ type: 'notify', params: { systemId: 'ai-claims' } }] });
    assert.deepEqual(before.actions[0].riskReasons.filter((r) => r.rule === 'policy.personal_data'), []);

    // Approve the EU pack (two people).
    const p = await s.governance.proposePolicy({ user: CO1, policy: examplePack('EU'), reason: 'Adopt EU controls' });
    await s.governance.approveProposal({ user: SEC, jurisdiction: 'EU', version: p.version, note: 'Reviewed' });
    assert.equal(s.governance.inForce().version, 1, 'in force straight after approval');

    // Approvals: a personal-data action now needs approval, with the EU deadline (48 h).
    const wf = await s.workflows.startWorkflow({ user: PM, workflowId: 'WF-after', name: 'Notify', actions: [{ type: 'notify', params: { systemId: 'ai-claims' } }] });
    const a = wf.actions[0];
    assert.equal(a.status, 'awaiting_approval');
    assert.ok(a.riskReasons.some((r) => r.rule === 'policy.personal_data'));
    assert.equal(Date.parse(a.deadlineAt) - Date.parse(a.approvalRequestedAt), 48 * 3600 * 1000);

    // Risk: personal data is rated high under EU, and the assessment records the policy.
    const ra = await s.risk.runAssessment({ assessmentId: 'RA-eu', user: CO1, systems: await s.inventory.systemsForAssessment({ user: CO1 }) });
    assert.equal(ra.report.model.version, '1+EU.v1');
    assert.equal(ra.report.systems[0].riskLevel, 'high');

    // Record keeping: readers come from the policy; documents show their keep-until date.
    await assert.rejects(s.auditReader.readAuditLog({ user: IT }), /may not read the audit log/);
    const doc = await s.documents.uploadDocument({ user: PM, fileName: 'a.txt', bytes: new TextEncoder().encode('Total: 1.00 GBP') });
    const seen = await s.documents.getDocument({ user: { id: 'fa-1', role: 'financial analyst' }, documentId: doc.id });
    assert.equal(Date.parse(seen.keepUntil) - Date.parse(seen.uploadedAt), 2190 * 24 * 3600 * 1000);
    assert.deepEqual(await s.documents.listDueForDeletion({ user: { id: 'fa-1', role: 'financial analyst' } }), []);

    // The switch is in the audit log.
    const applied = sys.audit.readAll().filter((e) => e.action === 'governance.applied').map((e) => e.subject);
    assert.deepEqual(applied, ['none', 'EU v1']);
  } finally {
    await sys.stop();
  }
});

test('end to end: the same assumptions under UK rate personal data differently from EU', async () => {
  const { sys } = await startWith('UK');
  try {
    const s = sys.services;
    await s.inventory.registerSystem({ user: IT, system: claims, reason: 'Initial load' });
    const p = await s.governance.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt UK controls' });
    await s.governance.approveProposal({ user: SEC, jurisdiction: 'UK', version: p.version, note: 'Reviewed' });
    const ra = await s.risk.runAssessment({ assessmentId: 'RA-uk', user: CO1, systems: await s.inventory.systemsForAssessment({ user: CO1 }) });
    assert.equal(ra.report.model.version, '1+UK.v1');
    assert.equal(ra.report.systems[0].riskLevel, 'medium', 'UK example: personal data alone is medium, not high');
  } finally {
    await sys.stop();
  }
});

test('the policy in force survives a restart; a bad jurisdiction setting refuses to start', async () => {
  const { env, sys } = await startWith('UK');
  const p = await sys.services.governance.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt' });
  await sys.services.governance.approveProposal({ user: SEC, jurisdiction: 'UK', version: p.version, note: 'ok' });
  await sys.stop();
  const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
  const again = await startOpsPilot({ env, timers: { approvals: idle, anchors: idle, governance: idle } });
  try {
    assert.equal(again.services.governance.inForce().version, 1);
  } finally {
    await again.stop();
  }
  await assert.rejects(startOpsPilot({ env: { ...env, GOVERNANCE_JURISDICTION: 'uk' } }), /must look like UK, EU or US-CA/);
});
