// STORY-003 demo: a risk assessment of the registered AI systems, on SYNTHETIC data.
//
//   node src/demo/riskAssessment.js                 writes to a fresh temp folder
//   node src/demo/riskAssessment.js --out ./demo    writes to ./demo
//
// Shows: risks identified and categorised per system with suggested mitigations,
// a system with incomplete data reported as unassessed, a refused user, the same
// request replayed rather than redone, and the audit trail of every step.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { createFileResultStore } from '../orchestration/resultStore.js';
import { createRiskAssessmentService } from '../risk/service.js';
import { renderRiskReportText } from '../risk/report.js';
import { sampleAiSystems, SAMPLE_LABEL } from './sampleAiSystems.js';

const OFFICER = { id: 'compliance-officer-1', role: 'compliance officer' };
const ANALYST = { id: 'analyst-7', role: 'process analyst' };

export async function runRiskDemo({ outDir, print = console.log } = {}) {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'opspilot-risk-'));
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const service = createRiskAssessmentService({ audit, store: createFileResultStore({ file: join(dir, 'risk-assessments.json') }) });
  const firstSeq = audit.readAll().length; // entries before this run (a reused --out folder has some)

  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  print(`OpsPilot AI — AI system risk assessment demo. Data: ${SAMPLE_LABEL}.`);

  rule('1. compliance-officer-1 assesses the 5 registered AI systems');
  const first = await service.runAssessment({ assessmentId: 'demo-risk-1', user: OFFICER, systems: sampleAiSystems() });
  print(`Status: ${first.status}${first.replayed ? ' (replayed from an earlier run in this folder)' : ''}\n`);
  print(first.report ? renderRiskReportText(first.report) : first.notice ?? first.message);

  rule('2. The same request again (e.g. a retry after a network blip)');
  const again = await service.runAssessment({ assessmentId: 'demo-risk-1', user: OFFICER, systems: sampleAiSystems() });
  print(`Status: ${again.status}, replayed: ${again.replayed} — the saved assessment is returned; nothing is assessed or saved twice.`);

  rule('3. analyst-7 (process analyst) asks for a risk assessment');
  let refused;
  try {
    await service.runAssessment({ assessmentId: 'demo-risk-analyst', user: ANALYST, systems: sampleAiSystems() });
    refused = { status: 'unexpectedly allowed' };
  } catch (err) {
    if (err?.name !== 'PermissionDeniedError') throw err;
    refused = { status: 'permission_denied', message: err.message };
  }
  print(`Status: ${refused.status}\n${refused.message ?? ''}`);

  rule('4. Audit trail for this run (every entry: timestamp + user id)');
  const entries = audit.readAll().slice(firstSeq);
  for (const e of entries) {
    const what = e.subject ? `${e.subject}${e.detail?.riskLevel ? ` → ${e.detail.riskLevel}, ${e.detail.risks.length} risk(s)` : ''}` : e.rationale ?? '';
    print(`  ${e.at}  ${e.actor.id.padEnd(21)} ${e.action.padEnd(22)} ${e.correlationId.padEnd(18)} ${what}`);
  }
  const check = audit.verify();
  print(`\nAudit chain: ${check.ok ? `verified — ${check.count} entries, none edited or removed` : `BROKEN at #${check.brokenAt}`}`);
  print(`Files: ${dir}`);

  return { first, again, refused, entries, audit: check, dir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--out');
  const outDir = i > -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : undefined;
  runRiskDemo({ outDir }).then(
    (r) => { process.exitCode = r.first.status === 'completed' && r.audit.ok ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
