// STORY-005 demo: workflow automation with human oversight, on SYNTHETIC data.
//
//   node src/demo/automation.js
//
// Runs on PGlite (PostgreSQL inside Node, in memory) with the STORY-004 inventory
// and the STORY-003 risk assessment, and a clock the demo moves forward so hours
// of waiting take no time. Notify, create-ticket and payment actions are
// STAND-INS (no Microsoft 365, ticketing or finance connection exists); the
// inventory status change is real.
//
// Shows: a low-risk workflow running unattended; a high-risk action waiting for
// approval (the starter may not approve it, a second process manager does); a
// mislabelled payment overruled; an approval escalated and then expired; a failed
// step resumed; and every action in the audit trail with its risk level.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { createMemoryResultStore } from '../orchestration/resultStore.js';
import { createRiskAssessmentService } from '../risk/service.js';
import { openPGlite, migrate } from '../inventory/db.js';
import { createInventoryService } from '../inventory/service.js';
import { createWorkflowEngine, migrateWorkflows } from '../automation/workflows.js';
import { createStandInExecutor, createInventoryStatusExecutor } from '../automation/executors.js';
import { sampleAiSystems, SAMPLE_LABEL } from './sampleAiSystems.js';

const HOUR = 60 * 60 * 1000;
const IT = { id: 'it-manager-1', role: 'IT manager' };
const OFFICER = { id: 'compliance-officer-1', role: 'compliance officer' };
const STARTER = { id: 'process-manager-1', role: 'process manager' };
const APPROVER = { id: 'process-manager-2', role: 'process manager' };
const OPS = { id: 'ops-manager-1', role: 'operations manager' };

// One line per step: what it is, its risk, where it got to.
const steps = (wf) => wf.actions.map((a) => {
  const why = (a.riskReasons ?? []).filter((r) => r.effect !== 'base').map((r) => r.rule).join(', ');
  const who = a.decidedBy ? ` (decided by ${a.decidedBy})` : '';
  return `   ${a.step}. ${a.type.padEnd(24)} risk ${String(a.riskLevel ?? '-').padEnd(5)} ${a.status.padEnd(17)}${who}${why ? `  ← ${why}` : ''}`;
}).join('\n');

export async function runAutomationDemo({ print = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-automation-'));
  // The demo's clock is real time plus however far the demo has skipped ahead.
  // It must keep ticking: the database stamps changes with its own real now(), and
  // the inventory refuses a risk rating for a system changed after it was assessed.
  let skipped = 0;
  const clock = { now: () => new Date(Date.now() + skipped), advance: (ms) => { skipped += ms; } };
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl'), now: clock.now });
  const db = await openPGlite();
  const out = {};
  try {
    await migrate(db);
    await migrateWorkflows(db);
    const inventory = createInventoryService({ db, audit });
    const executors = {
      notify: createStandInExecutor('notify'),
      create_ticket: createStandInExecutor('create_ticket'),
      payment: createStandInExecutor('payment'),
      'inventory.update_status': createInventoryStatusExecutor({ inventory }),
    };
    const engine = createWorkflowEngine({ db, audit, executors, now: clock.now, runOptions: { retryDelayMs: 20 } });
    out.executors = executors;

    const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
    print(`OpsPilot AI — workflow automation with human oversight. Data: ${SAMPLE_LABEL}.`);
    print('Notify, create-ticket and payment are STAND-INS; the inventory change is real.');

    rule('0. The AI system inventory (STORY-004), risk-assessed (STORY-003)');
    for (const system of sampleAiSystems()) {
      await inventory.registerSystem({ user: IT, system }).catch((err) => { if (err.name !== 'InventoryRequestError') throw err; });
    }
    const risk = createRiskAssessmentService({ audit, store: createMemoryResultStore(), now: clock.now });
    const assessed = await risk.runAssessment({ assessmentId: 'demo-automation-risk', user: OFFICER, systems: await inventory.systemsForAssessment({ user: OFFICER }) });
    await inventory.recordRiskAssessment({ user: OFFICER, result: assessed });
    for (const s of (await inventory.listSystems({ user: IT })).systems) print(`   ${s.name.padEnd(20)} risk ${s.riskLevel.padEnd(6)} ${s.status}`);

    rule('1. LOW risk runs automatically — "Weekly chatbot review"');
    out.low = await engine.startWorkflow({ user: STARTER, workflowId: 'WF-chatbot-review', name: 'Weekly chatbot review', actions: [
      { type: 'create_ticket', params: { title: 'Review last week\'s chatbot answers', systemId: 'ai-help-chat' } },
      { type: 'notify', params: { to: 'it-support-1', systemId: 'ai-help-chat' } },
    ] });
    print(`Workflow: ${out.low.run.status} — nobody had to approve anything.\n${steps(out.low)}`);

    rule('2. HIGH risk waits for a person — "Bias review: pause CV screener, pay auditor"');
    let wf = await engine.startWorkflow({ user: STARTER, workflowId: 'WF-bias-review', name: 'Bias review: pause CV screener, pay auditor', actions: [
      { type: 'inventory.update_status', params: { systemId: 'ai-cv-screen', status: 'paused', reason: 'Bias review' } },
      { type: 'notify', params: { to: 'hr-lead-1', message: 'The CV screener is paused for a bias review.' } },
      { type: 'payment', params: { amount: 2500, to: 'external-auditor' } },
      { type: 'notify', params: { to: 'finance' } },
    ] });
    print(`Workflow: ${wf.run.status}\n${steps(wf)}`);
    try {
      await engine.decide({ user: STARTER, workflowId: 'WF-bias-review', step: 1, decision: 'approve', note: 'My own request; approving it' });
    } catch (err) {
      out.selfApproval = `${err.name}: ${err.message}`;
      print(`\n${STARTER.id} (who started it) tries to approve step 1 → ${out.selfApproval}`);
    }
    wf = await engine.decide({ user: APPROVER, workflowId: 'WF-bias-review', step: 1, decision: 'approve', note: 'Agreed with HR; pause for the review' });
    out.cvAfterApproval = (await inventory.listSystems({ user: IT })).systems.find((s) => s.id === 'ai-cv-screen');
    print(`\n${APPROVER.id} approves step 1. The CV screener is now "${out.cvAfterApproval.status}" in the inventory (real change).`);
    print(`Workflow: ${wf.run.status}\n${steps(wf)}`);

    rule('3. Approval delays — nobody decides on the payment');
    clock.advance(5 * HOUR);
    const escalated = await engine.checkApprovalDelays();
    print(`+5 h: ${escalated.escalated.join(', ')} escalated — operations managers and compliance officers may now decide; a reminder was sent.`);
    clock.advance(20 * HOUR);
    const expired = await engine.checkApprovalDelays();
    out.expiredWorkflow = await engine.getWorkflow('WF-bias-review');
    print(`+25 h: ${expired.expired.join(', ')} expired — treated as rejected. The payment was never made.`);
    print(`Workflow: ${out.expiredWorkflow.run.status}\n${steps(out.expiredWorkflow)}`);
    try {
      await engine.decide({ user: OPS, workflowId: 'WF-bias-review', step: 3, decision: 'approve', note: 'Auditor invoice checked' });
    } catch (err) { out.lateApproval = `${err.name}: ${err.message}`; }
    print(`\nA late approval by ${OPS.id} → ${out.lateApproval}`);

    rule('4. Incorrect risk categorisation — a payment labelled "low"');
    out.mislabelled = await engine.startWorkflow({ user: STARTER, workflowId: 'WF-small-refund', name: 'Small refund', actions: [
      { type: 'payment', params: { amount: 300, to: 'customer-41' }, declaredRisk: 'low' },
    ] });
    const ignored = out.mislabelled.actions[0].riskReasons.find((r) => r.rule === 'declared.low_ignored');
    print(`Workflow: ${out.mislabelled.run.status}\n${steps(out.mislabelled)}\n   → ${ignored.why}`);

    rule('5. Automation failure — the ticketing service is down, then recovers');
    const flaky = createStandInExecutor('create_ticket', { failTimes: 3 });
    const flakyEngine = createWorkflowEngine({ db, audit, executors: { ...executors, create_ticket: flaky }, now: clock.now, runOptions: { retryDelayMs: 20 } });
    out.failed = await flakyEngine.startWorkflow({ user: STARTER, workflowId: 'WF-forecast-check', name: 'Forecast accuracy check', actions: [
      { type: 'create_ticket', params: { title: 'Check forecast accuracy', systemId: 'ai-demand-forecast' } },
      { type: 'notify', params: { to: 'ops-planner-1' } },
    ] });
    print(`Workflow: ${out.failed.run.status} — step 2 was not run on top of the failure.\n${steps(out.failed)}\n   error: ${out.failed.actions[0].error}`);
    out.resumed = await flakyEngine.resumeWorkflow({ user: STARTER, workflowId: 'WF-forecast-check' });
    print(`\nResumed: ${out.resumed.run.status} — the ticket was created once.\n${steps(out.resumed)}`);

    rule('6. Audit trail: every automated action with its risk level');
    out.entries = audit.readAll();
    for (const e of out.entries.filter((x) => x.action.startsWith('workflow.') || x.action === 'inventory.status_changed')) {
      const d = e.detail ?? {};
      const how = d.automatic === true ? 'automatic' : d.approvedBy ? `approved by ${d.approvedBy}` : '';
      const risk = d.riskLevel ? `risk ${d.riskLevel}` : '';
      print(`  ${e.at.slice(5, 16)}  ${e.actor.id.padEnd(18)} ${e.action.padEnd(28)} ${e.correlationId.padEnd(20)} ${e.subject ?? ''} ${risk} ${how}`.trimEnd());
    }
    out.audit = audit.verify();
    print(`\nAudit chain: ${out.audit.ok ? `verified — ${out.audit.count} entries, none edited or removed` : `BROKEN at #${out.audit.brokenAt}`}`);
    print(`Files: ${dir}`);
    return out;
  } finally {
    await db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runAutomationDemo().then(
    (r) => { process.exitCode = r.audit.ok && r.low.run.status === 'completed' ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
