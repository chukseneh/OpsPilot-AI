// STORY-008 demo: estimating ROI from user assumptions, checked against evidence,
// on SYNTHETIC data (the STORY-002 sample invoice process and a generated contract).
//
//   node src/demo/roi.js
//
// Runs on PGlite. Shows: an estimate with savings per item and their formulas, a
// low/expected/high range, ROI and payback; an over-optimistic estimate flagged
// for review against the process analysis and the contract; a data input error;
// a calculation error; a repeat request; a refused role; and the audit trail with
// every calculation's assumptions.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { openPGlite } from '../inventory/db.js';
import { createMemoryResultStore } from '../orchestration/resultStore.js';
import { createAnalysisService } from '../analysis/service.js';
import { createDocumentService, migrateDocuments } from '../documents/service.js';
import { createFileBlobStore } from '../documents/blobStore.js';
import { createRoiService, migrateRoi, analysisLookupFrom, documentLookupFrom } from '../roi/service.js';
import { formatMoney } from '../roi/calculate.js';
import { sampleInvoiceProcess } from './sampleProcessData.js';

export const SAMPLE_LABEL = 'SYNTHETIC: the STORY-002 sample invoice process and a generated contract (invented for demonstration)';
const ANALYST = { id: 'financial-analyst-1', role: 'financial analyst' };
const OPS = { id: 'ops-manager-1', role: 'operations manager' };
const PM = { id: 'process-manager-1', role: 'process manager' };

const CONTRACT = [
  'SOFTWARE LICENCE AGREEMENT   (SYNTHETIC SAMPLE)',
  'Party A: OpsPilot Demo Org',
  'Party B: Ledgerly Automation Ltd',
  'Effective date: 2026-10-01',
  'Term: 36 months',
  'Contract value: 14,400.00 GBP',
  'Renewal: renews for 12 months unless 60 days\' notice is given',
].join('\n');

export async function runRoiDemo({ print = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-roi-'));
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const db = await openPGlite();
  const out = {};
  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  try {
    await migrateDocuments(db);
    await migrateRoi(db);
    print(`OpsPilot AI — ROI estimation. Data: ${SAMPLE_LABEL}.`);

    rule('0. The evidence: a process analysis (STORY-002) and an uploaded contract (STORY-007)');
    const analyses = createMemoryResultStore();
    const analysis = await createAnalysisService({ audit, store: analyses }).runAnalysis({ analysisId: 'AN-invoices', user: OPS, dataset: sampleInvoiceProcess() });
    const enter = analysis.report.activities.find((a) => a.activity === 'Enter invoice into system');
    print(`Analysis AN-invoices: "${enter.activity}" happened ${enter.occurrences} times between ${analysis.report.scope.period.from.slice(0, 10)} and ${analysis.report.scope.period.to.slice(0, 10)}, median ${enter.medianDuration}.`);
    const documents = createDocumentService({ db, audit, blobs: createFileBlobStore({ dir: join(dir, 'files') }) });
    const contract = await documents.uploadDocument({ user: PM, fileName: 'ledgerly-licence.txt', bytes: new TextEncoder().encode(CONTRACT) });
    print(`Contract ${contract.id}: ${contract.status}; value ${contract.fields.contract_value.value} ${contract.fields.currency.value} over ${contract.fields.term.value.months} months.`);

    const roi = createRoiService({ db, audit, lookupAnalysis: analysisLookupFrom(analyses), lookupDocument: documentLookupFrom(documents) });
    const licence = { label: 'Ledgerly licence', amount: 4800, evidence: { documentId: contract.id, field: 'contract_value' } };
    const base = {
      name: 'Automate invoice entry', currency: 'GBP', horizonYears: 3,
      timeSavings: [
        { label: 'Enter invoice into system', casesPerYear: 6000, minutesPerCase: 7, automationRate: 0.8, costPerHour: 32 },
        { label: 'Check purchase order', casesPerYear: 6000, minutesPerCase: 16, automationRate: 0.3, costPerHour: 38 },
      ],
      otherSavings: [{ label: 'Fewer late-payment fees', amountPerYear: 1500 }],
      costs: { oneOff: [{ label: 'Implementation and training', amount: 18000 }], perYear: [licence] },
      uncertainty: { savings: 0.25, costs: 0.15 },
    };

    rule('1. Estimated savings from the analyst\'s assumptions');
    out.base = await roi.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-invoice-entry', assumptions: base });
    const r = out.base.result;
    const m = (x) => formatMoney(x, r.currency);
    for (const s of r.savings) print(`   ${s.label.padEnd(26)} ${s.formula}`);
    print(`\n   ${''.padEnd(16)}${'low'.padStart(18)}${'expected'.padStart(18)}${'high'.padStart(18)}`);
    const row = (label, f) => print(`   ${label.padEnd(16)}${['low', 'expected', 'high'].map((k) => f(r[k]).padStart(18)).join('')}`);
    row('Savings / year', (x) => m(x.annualSavings));
    row(`Costs, ${r.horizonYears} years`, (x) => m(x.totalCosts));
    row('Net benefit', (x) => m(x.netBenefit));
    row('ROI', (x) => (x.roiPercent === null ? 'n/a' : `${x.roiPercent}%`));
    row('Payback', (x) => (x.paybackMonths === null ? 'never' : `${x.paybackMonths} months`));
    print(`\n   (${r.range}.)  Status: ${out.base.status}; the licence matches the contract.`);

    rule('2. Optimistic assumptions are flagged for review — against the evidence');
    out.optimistic = await roi.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-invoice-entry-optimistic', assumptions: {
      ...base,
      name: 'Automate invoice entry (optimistic)',
      timeSavings: [{ label: 'Enter invoice into system', casesPerYear: 20000, minutesPerCase: 25, automationRate: 0.98, costPerHour: 32, evidence: { analysisId: 'AN-invoices', activity: 'Enter invoice into system' } }],
      costs: { oneOff: base.costs.oneOff, perYear: [{ ...licence, amount: 1200 }] },
    } });
    print(`Status: ${out.optimistic.status}; expected net benefit ${formatMoney(out.optimistic.result.expected.netBenefit, 'GBP')} — shown, but with ${out.optimistic.warnings.length} warnings:`);
    for (const w of out.optimistic.warnings) print(`   ⚑ [${w.kind}] ${w.message}`);

    rule('3. Failure paths');
    try {
      await roi.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-typo', assumptions: { ...base, horizonYear: 3, timeSavings: [{ ...base.timeSavings[0], automationRate: 80 }], costs: { oneOff: [{ label: 'Implementation', amount: '18k' }] } } });
    } catch (err) { out.inputError = err; }
    print(`Data input error → ${out.inputError.name}:`);
    for (const p of out.inputError.problems) print(`   ✗ ${p.path} ${p.problem}`);
    try {
      await roi.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-huge', assumptions: { ...base, timeSavings: [{ label: 'Everything', casesPerYear: 1e8, minutesPerCase: 10080, automationRate: 1, costPerHour: 1e12 }] } });
    } catch (err) { out.calculationError = `${err.name}: ${err.message}`; }
    print(`Calculation error → ${out.calculationError}`);
    out.repeat = await roi.calculateRoiScenario({ user: ANALYST, scenarioId: 'ROI-invoice-entry', assumptions: base });
    print(`The same request again → the saved scenario (calculated at ${out.repeat.calculatedAt}; not recalculated).`);
    try { await roi.calculateRoiScenario({ user: PM, scenarioId: 'ROI-pm', assumptions: base }); } catch (err) { out.refused = `${err.name}: ${err.message}`; }
    print(`process-manager-1 asks for an estimate → ${out.refused}`);

    rule('4. Audit trail: every calculation with its assumptions');
    out.entries = audit.readAll().filter((e) => e.action.startsWith('roi.'));
    for (const e of out.entries) {
      print(`  #${String(e.seq).padStart(2)} ${e.at.slice(11, 19)} ${e.actor.id.padEnd(20)} ${e.action.padEnd(22)} ${e.subject ?? ''}`);
      if (e.rationale) print(`        why: ${e.rationale.length > 150 ? `${e.rationale.slice(0, 147)}...` : e.rationale}`);
      if (e.detail?.assumptions) print(`        assumptions logged: ${Object.keys(e.detail.assumptions).join(', ')}`);
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
  runRoiDemo().then(
    (r) => { process.exitCode = r.audit.ok && r.base.status === 'ok' ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
