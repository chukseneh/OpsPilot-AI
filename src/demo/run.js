// STORY-001 demo: one process operation orchestrated across stand-in agents.
//
//   node src/demo/run.js                 writes to a fresh temp folder
//   node src/demo/run.js --out ./demo    writes to ./demo (re-running there replays)
//
// The agents are stand-ins (see standInAgents.js). Nothing here touches Microsoft 365,
// Google Workspace or any network.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { createRegistry } from '../orchestration/agents.js';
import { createOrchestrator } from '../orchestration/orchestrator.js';
import { createFileResultStore } from '../orchestration/resultStore.js';
import { createStandInAgents } from './standInAgents.js';

export const DEMO_OPERATION = {
  operationId: 'demo-monthly-invoice-review',
  requestedBy: { type: 'person', id: 'operations_manager' },
  tasks: [
    { id: 'map-process', capability: 'process', input: { process: 'invoice approval' } },
    { id: 'assess-risk', capability: 'risk', input: { process: 'invoice approval' } },
    { id: 'estimate-cost', capability: 'finance', input: { process: 'invoice approval' } },
  ],
};

const pad = (s, n) => String(s).padEnd(n);

export async function runDemo({ outDir, print = console.log } = {}) {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'opspilot-demo-'));
  const auditFile = join(dir, 'audit.jsonl');
  const resultsFile = join(dir, 'results.json');

  const standIns = createStandInAgents();
  const orchestrator = createOrchestrator({
    registry: createRegistry(standIns.agents),
    audit: createAuditLog({ file: auditFile }),
    store: createFileResultStore({ file: resultsFile }),
    timeoutMs: 2000,
  });

  print('OpsPilot AI — orchestration demo (STAND-IN agents: made-up results, not real AI, no live systems)');
  print(`Operation ${DEMO_OPERATION.operationId}, requested by ${DEMO_OPERATION.requestedBy.id}\n`);

  print('Run 1');
  const first = await orchestrator.runOperation(DEMO_OPERATION);
  for (const t of first.tasks) {
    const route = t.triedAgents.length ? `${t.triedAgents.join(' ✗ → ')} ✗ → ${t.agentId ?? 'nobody'}` : t.agentId;
    print(`  ${pad(t.id, 14)} ${pad(t.capability, 8)} ${pad(t.status, 10)} via ${route}  (${t.attempts} attempt${t.attempts === 1 ? '' : 's'})`);
  }
  print(`  Operation: ${first.status}${first.replayed ? ' (replayed from an earlier run in this folder)' : ''}\n`);

  const callsBefore = standIns.callCount();
  print('Run 2 — same operation id');
  const second = await orchestrator.runOperation(DEMO_OPERATION);
  const replayCalls = standIns.callCount() - callsBefore;
  print(`  Operation: ${second.status}, replayed: ${second.replayed}, agent calls: ${replayCalls}\n`);

  const audit = createAuditLog({ file: auditFile });
  const entries = audit.readAll();
  print(`Audit trail (${entries.length} entries, times in UTC)`);
  for (const e of entries) {
    const time = e.at.slice(11, 23);
    const d = e.detail ?? {};
    const why = e.rationale ? ` — ${e.rationale}`
      : e.action === 'task.attempt_failed' ? ` — ${d.agentId} attempt ${d.attempt}: ${d.error?.name}; next: ${d.next}`
        : e.action === 'task.retry_scheduled' ? ` — retry ${d.agentId} in ${d.waitMs} ms`
          : e.action === 'task.completed' ? ` — by ${d.agentId}`
            : '';
    print(`  #${pad(e.seq, 3)} ${time} ${pad(e.actor.id, 18)} ${pad(e.action, 22)} ${e.subject ?? ''}${why}`);
  }
  const check = audit.verify();
  print(`\nAudit chain: ${check.ok ? `verified — ${check.count} entries, none edited or removed` : `BROKEN at #${check.brokenAt}: ${check.reason}`}`);
  print(`Files: ${auditFile}\n       ${resultsFile}`);

  return { first, second, replayCalls, callsBy: standIns.callsBy(), audit: check, auditFile, resultsFile };
}

// Run when called as a script, not when imported by a test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--out');
  const outDir = i > -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : undefined;
  runDemo({ outDir }).then(
    (r) => { process.exitCode = r.first.status === 'completed' && r.audit.ok ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
