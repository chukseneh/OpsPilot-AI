// STORY-002 demo: process analysis run by the process analyst agent, through the
// STORY-001 orchestrator, on SYNTHETIC data.
//
//   node src/demo/analyse.js                 writes to a fresh temp folder
//   node src/demo/analyse.js --out ./demo    writes to ./demo
//
// Shows: a full report for an analyst, the missing-data notice, a refused user,
// and the audit trail with a user id and timestamp on every entry.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { createRegistry } from '../orchestration/agents.js';
import { createOrchestrator } from '../orchestration/orchestrator.js';
import { createFileResultStore } from '../orchestration/resultStore.js';
import { createAnalysisService } from '../analysis/service.js';
import { createProcessAnalystAgent } from '../analysis/processAgent.js';
import { sampleInvoiceProcess, sampleWithGaps, SAMPLE_LABEL } from './sampleProcessData.js';

const ANALYST = { id: 'analyst-7', role: 'process analyst' };
const INTERN = { id: 'intern-3', role: 'intern' };
const MANAGER = { type: 'person', id: 'operations_manager' };

export async function runAnalysisDemo({ outDir, print = console.log } = {}) {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'opspilot-analysis-'));
  const auditFile = join(dir, 'audit.jsonl');
  const audit = createAuditLog({ file: auditFile });
  const service = createAnalysisService({ audit, store: createFileResultStore({ file: join(dir, 'analyses.json') }) });
  const orchestrator = createOrchestrator({
    registry: createRegistry([createProcessAnalystAgent({ service })]),
    audit,
    store: createFileResultStore({ file: join(dir, 'operations.json') }),
    timeoutMs: 60000,
  });
  const run = async (operationId, user, dataset) => (await orchestrator.runOperation({
    operationId, requestedBy: MANAGER,
    tasks: [{ id: 'analyse', capability: 'process', input: { user, dataset } }],
  })).tasks[0].output;

  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  print(`OpsPilot AI — process analysis demo. Data: ${SAMPLE_LABEL}.`);

  rule('1. analyst-7 (process analyst) analyses 30 invoice-approval cases');
  const full = await run('demo-analysis-full', ANALYST, sampleInvoiceProcess());
  print(full.status === 'completed' ? full.text : `Unexpected: ${full.status}`);

  rule('2. The same request with gaps in the data');
  const gaps = await run('demo-analysis-gaps', ANALYST, sampleWithGaps());
  print(`Status: ${gaps.status}\n\n${gaps.notice}`);

  rule('3. intern-3 asks for an analysis');
  const refused = await run('demo-analysis-intern', INTERN, sampleInvoiceProcess());
  print(`Status: ${refused.status}\n${refused.message}`);

  rule('4. Audit trail for the analyses (every entry: timestamp + user id)');
  const entries = createAuditLog({ file: auditFile }).readAll().filter((e) => e.action.startsWith('analysis.'));
  for (const e of entries) {
    print(`  ${e.at}  ${e.actor.id.padEnd(10)} ${e.action.padEnd(22)} ${e.correlationId}${e.rationale ? ` — ${e.rationale}` : ''}`);
  }
  const check = createAuditLog({ file: auditFile }).verify();
  print(`\nAudit chain: ${check.ok ? `verified — ${check.count} entries (orchestrator + analysis), none edited or removed` : `BROKEN at #${check.brokenAt}`}`);
  print(`Files: ${dir}`);

  return { full, gaps, refused, entries, audit: check, dir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--out');
  const outDir = i > -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : undefined;
  runAnalysisDemo({ outDir }).then(
    (r) => { process.exitCode = r.full.status === 'completed' && r.audit.ok ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
