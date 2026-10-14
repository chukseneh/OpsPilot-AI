// STORY-009 demo: configurable governance controls per jurisdiction.
//
//   node src/demo/governance.js
//
// Starts OpsPilot (on PGlite, with a throwaway signing key) with
// GOVERNANCE_JURISDICTION=EU and a clock the demo moves forward. Uses the
// ILLUSTRATIVE EU policy pack — real sources, example values, NOT legal advice —
// and a synthetic AI system.
//
// Shows: the same system before and after the EU policy is approved (risk rating,
// approvals, audit readers, document retention); a misconfigured proposal refused
// with every alert; a self-approval and an unauthorised change refused; a dated
// regulatory update taking effect on its date; a review date passing; and the
// audit trail of every configuration change.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { startOpsPilot } from '../system.js';
import { examplePack } from '../governance/packs/index.js';

const CO1 = { id: 'compliance-officer-1', role: 'compliance officer' };
const SEC = { id: 'security-officer-1', role: 'security officer' };
const IT = { id: 'it-manager-1', role: 'IT manager' };
const PM = { id: 'process-manager-1', role: 'process manager' };
const FA = { id: 'financial-analyst-1', role: 'financial analyst' };
const DAY = 24 * 60 * 60 * 1000;

const CLAIMS = {
  id: 'ai-claims-triage', name: 'Claims triage', department: 'Finance', purpose: 'Routes expense claims for payment (SYNTHETIC)',
  owner: 'fin-ops-2', status: 'active', dataCategories: ['personal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false,
};

export async function runGovernanceDemo({ print = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-governance-'));
  let t = Date.parse('2026-10-14T09:00:00Z');
  const clock = { now: () => new Date(t), advance: (days) => { t += days * DAY; } };
  // The governance timer is driven by hand, so the demo decides when it "runs".
  const governanceTick = { fn: null };
  const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
  const sys = await startOpsPilot({
    env: { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl'), GOVERNANCE_JURISDICTION: 'EU' },
    now: clock.now,
    timers: { approvals: idle, anchors: idle, governance: { timers: { setInterval: (fn) => { governanceTick.fn = fn; return {}; }, clearInterval: () => {} } } },
  });
  const s = sys.services;
  const out = {};
  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  const day = () => clock.now().toISOString().slice(0, 10);
  try {
    print('OpsPilot AI — configurable governance controls. GOVERNANCE_JURISDICTION=EU.');
    print('The EU pack is ILLUSTRATIVE: real sources, example values, NOT legal advice. The AI system is SYNTHETIC.');
    await s.inventory.registerSystem({ user: IT, system: CLAIMS, reason: 'Initial inventory load' });

    // What the system does for this AI system, under whatever is in force.
    let n = 0;
    const behaviour = async () => {
      n += 1;
      const ra = await s.risk.runAssessment({ assessmentId: `RA-${n}`, user: CO1, systems: await s.inventory.systemsForAssessment({ user: CO1 }) });
      await s.inventory.recordRiskAssessment({ user: CO1, result: ra }); // the rating the workflow will see
      const wf = await s.workflows.startWorkflow({ user: PM, workflowId: `WF-${n}`, name: 'Notify the claims owner', actions: [{ type: 'notify', params: { systemId: CLAIMS.id, to: 'fin-ops-2' } }] });
      const a = wf.actions[0];
      const doc = await s.documents.uploadDocument({ user: PM, fileName: `claims-policy-${n}.txt`, bytes: new TextEncoder().encode(`Total: ${n}.00 EUR`) });
      const seen = await s.documents.getDocument({ user: FA, documentId: doc.id });
      let readerIT;
      try { await s.auditReader.readAuditLog({ user: IT }); readerIT = 'allowed'; } catch { readerIT = 'refused'; }
      return {
        riskLevel: ra.report.systems[0].riskLevel,
        riskModel: ra.report.model.version,
        approval: a.status === 'awaiting_approval' ? `needs approval (deadline ${Math.round((Date.parse(a.deadlineAt) - Date.parse(a.approvalRequestedAt)) / 3600000)} h)` : 'runs automatically',
        policyReason: a.riskReasons?.find((r) => r.rule === 'policy.personal_data')?.why ?? null,
        keepUntil: seen.keepUntil ? seen.keepUntil.slice(0, 10) : 'not set',
        itReadsAudit: readerIT,
      };
    };
    const show = (b) => {
      print(`   Risk rating of "${CLAIMS.name}" (personal data): ${b.riskLevel}   [risk model ${b.riskModel}]`);
      print(`   A workflow notifying its owner:                   ${b.approval}`);
      if (b.policyReason) print(`      ← ${b.policyReason}`);
      print(`   Uploaded document kept until:                     ${b.keepUntil}`);
      print(`   IT manager reading the audit log:                 ${b.itReadsAudit}`);
    };

    rule(`1. ${day()} — EU selected, but no policy approved yet: built-in rules apply`);
    out.before = await behaviour();
    show(out.before);

    rule('2. A misconfigured proposal is refused, with every alert');
    const bad = examplePack('EU');
    bad.controls.approvals.highRiskActionsNeedApproval = false;
    bad.controls.approvals.escalateAfterHours = 72;
    bad.controls.recordKeeping.documentRetentionDays = 4000;
    try { await s.governance.proposePolicy({ user: CO1, policy: bad, reason: 'Speed things up' }); } catch (err) { out.misconfigured = err; }
    print(`${out.misconfigured.name}:`);
    for (const a of out.misconfigured.alerts) print(`   ${a.severity === 'error' ? '✗' : '⚠'} ${a.control}: ${a.message}`);

    rule('3. Propose the EU pack; the two-person rule; approve');
    const v1 = await s.governance.proposePolicy({ user: CO1, policy: examplePack('EU'), reason: 'Adopt EU governance controls (illustrative pack, pending counsel review)' });
    print(`compliance-officer-1 proposes EU version ${v1.version} (${v1.diff.length} settings introduced).`);
    try { await s.governance.approveProposal({ user: CO1, jurisdiction: 'EU', version: v1.version, note: 'Looks fine' }); } catch (err) { out.selfApproval = `${err.name}: ${err.message}`; }
    print(`compliance-officer-1 tries to approve it → ${out.selfApproval}`);
    try { await s.governance.proposePolicy({ user: IT, policy: examplePack('EU'), reason: 'x' }); } catch (err) { out.unauthorised = `${err.name}: ${err.message}`; }
    print(`it-manager-1 tries to propose a policy → ${out.unauthorised}`);
    await s.governance.approveProposal({ user: SEC, jurisdiction: 'EU', version: v1.version, note: 'Two-person check done; adopt pending counsel review' });
    print(`security-officer-1 approves → in force: EU version ${s.governance.inForce().version}.`);

    rule(`4. ${day()} — the same system under the EU policy`);
    out.after = await behaviour();
    show(out.after);

    rule('5. A regulatory update: version 2, dated to take effect on 1 December');
    const updated = examplePack('EU');
    updated.controls.approvals.approvalDeadlineHours = 24;
    updated.reviewBy = '2027-06-30';
    const v2 = await s.governance.proposePolicy({ user: CO1, policy: updated, effectiveFrom: '2026-12-01', reason: 'Regulator guidance: faster human review of automated decisions (illustrative)' });
    for (const d of v2.diff) print(`   ${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`);
    await s.governance.approveProposal({ user: SEC, jurisdiction: 'EU', version: v2.version, note: 'Matches the new guidance' });
    print(`Approved. On ${day()} the policy in force is still version ${s.governance.inForce().version}.`);
    clock.advance(48);
    await governanceTick.fn();
    out.afterUpdate = s.governance.inForce();
    print(`${day()}: the hourly refresh runs → in force: version ${out.afterUpdate.version}, approval deadline ${out.afterUpdate.controls.approvals.approvalDeadlineHours} h.`);

    rule('6. The review date passes: the rules may be out of date');
    clock.advance(220);
    out.overdue = await governanceTick.fn();
    print(`${day()}: ${out.overdue.length ? `review overdue for ${out.overdue.map((o) => `${o.jurisdiction} v${o.version} (review by ${o.reviewBy})`).join(', ')} — alerted once; propose a reviewed update` : 'nothing overdue'}`);

    rule('7. Audit trail: every configuration change, with who, why and what changed');
    out.entries = sys.audit.readAll().filter((e) => e.action.startsWith('governance.'));
    for (const e of out.entries) {
      print(`  #${String(e.seq).padStart(3)} ${e.at.slice(0, 10)} ${e.actor.id.padEnd(20)} ${e.action.padEnd(27)} ${e.subject ?? ''}`);
      if (e.rationale) print(`        why: ${e.rationale.length > 140 ? `${e.rationale.slice(0, 137)}...` : e.rationale}`);
      if (e.detail?.diff && e.action !== 'governance.proposed') print(`        changed: ${e.detail.diff.length > 3 ? `${e.detail.diff.length} settings` : e.detail.diff.map((d) => `${d.path} ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`).join('; ')}`);
    }
    out.audit = sys.audit.verify();
    print(`\nAudit chain: ${out.audit.ok ? `verified — ${out.audit.count} entries, keyed, none edited or removed` : `BROKEN at #${out.audit.brokenAt}`}`);
    print(`Files: ${dir}`);
    return out;
  } finally {
    await sys.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runGovernanceDemo().then(
    (r) => { process.exitCode = r.audit.ok ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
