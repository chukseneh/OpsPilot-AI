// STORY-006 demo: a secure, append-only audit log, on SYNTHETIC data.
//
//   node src/demo/audit.js
//
// Runs on PGlite (PostgreSQL inside Node) with a throwaway signing key made for
// this run only (never written down). In production the key comes from the
// AUDIT_LOG_KEY environment variable (openAuditLogFromEnv).
//
// Shows: actions logged with timestamp and user id; decisions with their
// rationale (and one refused without); the chain and anchors verifying; three
// kinds of tampering caught; unauthorised reading refused; a full disk alerted,
// checked and repaired.

import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHmac } from 'node:crypto';

import { createAuditLog, verifyAuditFile } from '../audit/auditLog.js';
import { createAuditAnchors, migrateAnchors } from '../audit/anchors.js';
import { createAuditReader } from '../audit/reader.js';
import { checkAuditStorage, repairAuditLog } from '../audit/storage.js';
import { isDecision } from '../audit/decisions.js';
import { openPGlite, migrate } from '../inventory/db.js';
import { createInventoryService } from '../inventory/service.js';
import { createWorkflowEngine, migrateWorkflows } from '../automation/workflows.js';
import { createStandInExecutor, createInventoryStatusExecutor } from '../automation/executors.js';
import { sampleAiSystems, SAMPLE_LABEL } from './sampleAiSystems.js';

const IT = { id: 'it-manager-1', role: 'IT manager' };
const PM1 = { id: 'process-manager-1', role: 'process manager' };
const PM2 = { id: 'process-manager-2', role: 'process manager' };
const SECURITY = { id: 'security-officer-1', role: 'security officer' };

const lines = (file) => readFileSync(file, 'utf8').trim().split('\n');
const writeLines = (file, ls) => writeFileSync(file, `${ls.join('\n')}\n`);

// What an insider WITH the key would do to rewrite history: change an entry, then
// re-sign it and every entry after it so the chain links up perfectly again.
function insiderRewrite(file, key, seq, change) {
  const all = lines(file).map((l) => JSON.parse(l));
  let prev = all[seq - 2]?.hash;
  for (const e of all.slice(seq - 1)) {
    if (e.seq === seq) change(e);
    e.prevHash = prev;
    const body = { seq: e.seq, at: e.at, correlationId: e.correlationId, actor: e.actor, action: e.action, subject: e.subject, rationale: e.rationale, detail: e.detail, prevHash: e.prevHash, alg: e.alg };
    e.hash = createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');
    prev = e.hash;
  }
  writeLines(file, all.map((e) => JSON.stringify(e)));
}

export async function runAuditDemo({ print = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-audit-'));
  const file = join(dir, 'audit.jsonl');
  const key = randomBytes(32).toString('hex'); // this run only
  const audit = createAuditLog({ file, key });
  const db = await openPGlite();
  const out = {};
  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  try {
    await migrate(db); await migrateWorkflows(db); await migrateAnchors(db);
    const anchors = createAuditAnchors({ db, file, key, logId: 'main' });
    const inventory = createInventoryService({ db, audit });
    const engine = createWorkflowEngine({ db, audit, runOptions: { retryDelayMs: 10 }, executors: {
      notify: createStandInExecutor('notify'), payment: createStandInExecutor('payment'),
      'inventory.update_status': createInventoryStatusExecutor({ inventory }),
    } });

    print(`OpsPilot AI — secure, append-only audit log. Data: ${SAMPLE_LABEL}.`);
    print('Signing key: a throwaway made for this run (production reads AUDIT_LOG_KEY).');

    rule('1. Actions are logged with a timestamp and user id; decisions with their rationale');
    const [cv, , chat] = sampleAiSystems();
    await inventory.registerSystem({ user: IT, system: cv, reason: 'Initial inventory load' });
    await inventory.registerSystem({ user: IT, system: chat, reason: 'Initial inventory load' });
    await engine.startWorkflow({ user: PM1, workflowId: 'WF-pause-chatbot', name: 'Pause chatbot for retraining', actions: [
      { type: 'inventory.update_status', params: { systemId: 'ai-help-chat', status: 'paused', reason: 'Retraining on new IT policies' } },
    ] });
    await engine.decide({ user: PM2, workflowId: 'WF-pause-chatbot', step: 1, decision: 'approve', note: 'Retraining window agreed with IT support' });
    await engine.startWorkflow({ user: PM1, workflowId: 'WF-vendor-payment', name: 'Pay vendor', actions: [{ type: 'payment', params: { amount: 9000, to: 'vendor-3' } }] });
    await engine.decide({ user: PM2, workflowId: 'WF-vendor-payment', step: 1, decision: 'reject', note: 'No purchase order on file for this amount' });
    await inventory.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused', expectedVersion: 1, reason: 'Bias complaint received; paused pending review' });

    out.entries = audit.readAll();
    out.decisions = out.entries.filter((e) => isDecision(e.action));
    print(`${out.entries.length} entries, ${out.decisions.length} of them decisions. A sample:\n`);
    for (const e of out.entries.filter((x) => ['workflow.started', 'workflow.action_classified', 'workflow.action_approved', 'workflow.action_rejected', 'inventory.status_changed'].includes(x.action)).slice(0, 6)) {
      print(`  #${String(e.seq).padStart(2)} ${e.at}  user ${e.actor.id.padEnd(18)} ${e.action}`);
      if (isDecision(e.action)) print(`        rationale: ${e.rationale}`);
    }
    try {
      audit.append({ correlationId: 'demo', actor: { type: 'person', id: PM2.id }, action: 'workflow.action_approved' });
    } catch (err) { out.refusedDecision = `${err.name}: ${err.message}`; }
    print(`\nA decision logged WITHOUT a rationale → ${out.refusedDecision}`);

    rule('2. Immutable: the keyed chain and the anchors verify');
    await anchors.anchor();
    out.intact = await anchors.verify();
    print(`Chain (HMAC-SHA256, keyed): ${verifyAuditFile({ file, key }).ok ? 'verified' : 'BROKEN'}; anchors: ${out.intact.anchors}, last anchored #${out.intact.lastAnchoredSeq} — ${out.intact.ok ? 'all match' : out.intact.reason}`);

    // Each attack is made on a COPY, so the real log stays intact for the rest of the demo.
    const attack = (name, fn) => {
      const copy = join(dir, `tampered-${name}.jsonl`);
      copyFileSync(file, copy);
      fn(copy);
      return createAuditAnchors({ db, file: copy, key, logId: 'main' }).verify();
    };
    out.tampering = {
      edited: await attack('edited', (f) => { const ls = lines(f); const e = JSON.parse(ls[4]); e.actor.id = 'someone-else'; ls[4] = JSON.stringify(e); writeLines(f, ls); }),
      truncated: await attack('truncated', (f) => writeLines(f, lines(f).slice(0, -3))),
      insider: await attack('insider', (f) => insiderRewrite(f, key, 5, (e) => { e.rationale = 'forged by an insider'; })),
    };
    print('\nTampering, each attempted on a copy of the log:');
    print(`  a) an entry edited                         → ${out.tampering.edited.reason}`);
    print(`  b) the last 3 entries cut off              → ${out.tampering.truncated.reason}`);
    print(`  c) insider WITH the key rewrites history   → ${out.tampering.insider.reason}`);
    try { await db.query("UPDATE audit_anchors SET seq = 1 WHERE log_id = 'main'"); } catch (err) { out.anchorChange = err.message; }
    print(`  d) someone edits the anchors in PostgreSQL → refused: ${out.anchorChange}`);

    rule('3. Unauthorised log access');
    const reader = createAuditReader({ audit, file, key, anchors });
    try { await reader.readAuditLog({ user: IT }); } catch (err) { out.itRefused = `${err.name}: ${err.message}`; }
    print(`it-manager-1 asks to read the log → ${out.itRefused}`);
    out.read = await reader.readAuditLog({ user: SECURITY, filter: { action: 'workflow.' } });
    print(`security-officer-1 reads the workflow entries → ${out.read.entries.length} entries; integrity ${out.read.integrity.ok ? 'OK (keyed chain + anchors)' : out.read.integrity.warning}`);
    print(`Both are now in the log: ${audit.readAll().slice(-2).map((e) => `${e.action} by ${e.actor.id}`).join(', ')}`);

    rule('4. Log storage failure: a full disk, then a repair');
    const file2 = join(dir, 'audit-disk.jsonl');
    let diskFull = false;
    const alerts = [];
    const log2 = createAuditLog({
      file: file2, key, onWriteFailure: (err) => alerts.push(`ALERT: audit log write failed (${err.code})`),
      write: (f, data, opts) => {
        if (!diskFull) return appendFileSync(f, data, opts);
        appendFileSync(f, data.slice(0, 20), opts); // the disk fills part-way through the line
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
    });
    log2.append({ correlationId: 'demo', actor: { type: 'person', id: PM1.id }, action: 'workflow.started' });
    diskFull = true;
    try { log2.append({ correlationId: 'demo', actor: { type: 'person', id: PM1.id }, action: 'workflow.completed' }); } catch (err) { out.diskFull = `${err.name}: ${err.message}`; }
    out.alerts = alerts;
    out.health = checkAuditStorage({ file: file2, log: log2 });
    print(`Writing an entry → ${out.diskFull}\n${alerts.join('\n')}\nHealth: ${out.health.ok ? 'OK' : out.health.problems.join('; ')}`);
    out.repair = repairAuditLog({ file: file2, key, user: SECURITY, reason: 'Disk filled; space freed; resuming' });
    print(`\nsecurity-officer-1 repairs it → ${out.repair.removedBytes} damaged byte(s) set aside in ${out.repair.savedTo.split(/[\\/]/).at(-1)}; the repair is entry #${out.repair.entrySeq}`);
    out.afterRepair = verifyAuditFile({ file: file2, key });
    print(`After the repair: chain ${out.afterRepair.ok ? 'verified' : 'BROKEN'}, ${out.afterRepair.count} entries; health ${checkAuditStorage({ file: file2 }).ok ? 'OK' : 'still failing'}`);

    out.final = await anchors.verify();
    print(`\nMain audit log: ${out.final.ok ? `verified — ${out.final.count} entries, keyed chain and anchors intact` : out.final.reason}`);
    print(`Files: ${dir}`);
    return out;
  } finally {
    await db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runAuditDemo().then(
    (r) => { process.exitCode = r.final.ok ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
