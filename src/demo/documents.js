// STORY-007 demo: uploading documents and extracting structured information, on
// SYNTHETIC documents generated in code (invented; no real supplier or contract).
//
//   node src/demo/documents.js
//
// Runs on PGlite (PostgreSQL inside Node). Shows: a text-PDF invoice and a contract
// extracted, with where each value came from; documents with errors flagged for
// review (a total that does not add up, an ambiguous date, a scanned PDF); a
// reviewer correcting one and rejecting another; an unsupported format refused;
// a storage failure; a repeat upload; and the audit trail of it all.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { isDecision } from '../audit/decisions.js';
import { openPGlite } from '../inventory/db.js';
import { createDocumentService, migrateDocuments } from '../documents/service.js';
import { createFileBlobStore } from '../documents/blobStore.js';
import { makeTextPdf, makeImageOnlyPdf } from './makePdf.js';

export const SAMPLE_LABEL = 'SYNTHETIC documents generated in code (invented for demonstration)';
const PM = { id: 'process-manager-1', role: 'process manager' };
const ANALYST = { id: 'financial-analyst-1', role: 'financial analyst' };
const bytesOf = (s) => new TextEncoder().encode(s);

const INVOICE_LINES = [
  'INVOICE   (SYNTHETIC SAMPLE)',
  'Invoice number: INV-2041',
  'Supplier: Northwind Analytics Ltd',
  'Invoice date: 2026-09-01',
  'Due date: 30 September 2026',
  '- Model monitoring licence  2 x 400.00 = 800.00',
  '- Bias audit (fixed fee)  1 x 200.00 = 200.00',
  'Subtotal: 1,000.00 GBP',
  'VAT: 200.00 GBP',
  'Total due: £1,200.00',
];
const CONTRACT = [
  'SERVICES AGREEMENT   (SYNTHETIC SAMPLE)',
  'Party A: OpsPilot Demo Org',
  'Party B: Northwind Analytics Ltd',
  'Effective date: 1 October 2026',
  'Term: 24 months',
  'Contract value: 48,000.00 EUR',
  'Renewal: renews automatically for 12 months unless 90 days\' notice is given',
].join('\n');

const show = (v) => (Array.isArray(v) ? (typeof v[0] === 'object' ? `${v.length} line item(s)` : v.join(' | ')) : typeof v === 'object' ? JSON.stringify(v) : String(v));
function fieldsTable(doc) {
  return Object.entries(doc.fields).filter(([n]) => n !== 'end_or_term')
    .map(([n, f]) => `   ${n.padEnd(15)} ${show(f.value).padEnd(40).slice(0, 40)}  ← ${f.source}`).join('\n');
}
const flagsList = (doc) => doc.flags.map((f) => `   ⚑ ${f.field ? `${f.field}: ` : ''}${f.problem}`).join('\n');

export async function runDocumentsDemo({ print = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-documents-'));
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const db = await openPGlite();
  const out = {};
  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  try {
    await migrateDocuments(db);
    const service = createDocumentService({ db, audit, blobs: createFileBlobStore({ dir: join(dir, 'files') }) });
    print(`OpsPilot AI — document upload and extraction. Data: ${SAMPLE_LABEL}.`);

    rule('1. Uploaded → processed → structured information');
    out.invoice = await service.uploadDocument({ user: PM, fileName: 'INV-2041.pdf', bytes: makeTextPdf(INVOICE_LINES) });
    print(`INV-2041.pdf (a text PDF) → ${out.invoice.status}, ${out.invoice.kind}\n${fieldsTable(out.invoice)}`);
    out.contract = await service.uploadDocument({ user: PM, fileName: 'northwind-msa.txt', bytes: bytesOf(CONTRACT) });
    print(`\nnorthwind-msa.txt → ${out.contract.status}, ${out.contract.kind}\n${fieldsTable(out.contract)}`);

    rule('2. Documents with errors are flagged for review — nothing is guessed');
    out.badTotal = await service.uploadDocument({ user: PM, fileName: 'INV-2042.txt', bytes: bytesOf(INVOICE_LINES.join('\n').replace('INV-2041', 'INV-2042').replace('£1,200.00', '£1,250.00')) });
    out.ambiguous = await service.uploadDocument({ user: PM, fileName: 'INV-2043.txt', bytes: bytesOf(INVOICE_LINES.join('\n').replace('INV-2041', 'INV-2043').replace('Invoice date: 2026-09-01', 'Invoice date: 03/09/2026')) });
    out.scan = await service.uploadDocument({ user: PM, fileName: 'paper-invoice-scan.pdf', kind: 'invoice', bytes: makeImageOnlyPdf() });
    for (const [name, d] of [['INV-2042.txt', out.badTotal], ['INV-2043.txt', out.ambiguous], ['paper-invoice-scan.pdf', out.scan]]) {
      print(`${name} → ${d.status}\n${flagsList(d)}`);
    }

    rule('3. A reviewer resolves them');
    try {
      await service.uploadDocument({ user: ANALYST, fileName: 'own.txt', bytes: bytesOf(INVOICE_LINES.join('\n').replace('£1,200.00', '£9.00')) })
        .then((own) => service.reviewDocument({ user: ANALYST, documentId: own.id, decision: 'accept', expectedVersion: own.version, note: 'fine' }));
    } catch (err) { out.selfReview = `${err.name}: ${err.message}`; }
    print(`financial-analyst-1 tries to review their own upload → ${out.selfReview}`);

    out.accepted = await service.reviewDocument({
      user: ANALYST, documentId: out.ambiguous.id, decision: 'accept', expectedVersion: out.ambiguous.version,
      corrections: { issue_date: '2026-09-03' }, note: 'Supplier confirmed: issued 3 September 2026 (UK date format)',
    });
    print(`\nINV-2043 accepted with a correction → ${out.accepted.status}; issue_date ${out.accepted.fields.issue_date.value} ← ${out.accepted.fields.issue_date.source}`);
    out.rejected = await service.reviewDocument({
      user: ANALYST, documentId: out.badTotal.id, decision: 'reject', expectedVersion: out.badTotal.version,
      note: 'Total overstated by 50.00; returned to supplier for a corrected invoice',
    });
    print(`INV-2042 rejected → ${out.rejected.status}: "${out.rejected.reviewNote}"`);

    rule('4. Failure paths: unsupported format, storage failure, repeat upload');
    try { await service.uploadDocument({ user: PM, fileName: 'receipt.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) }); } catch (err) { out.unsupported = `${err.name}: ${err.message}`; }
    print(`receipt.png → ${out.unsupported}`);
    const brokenDisk = createDocumentService({ db, audit, blobs: createFileBlobStore({ dir: join(dir, 'files'), rename: () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); } }) });
    try { await brokenDisk.uploadDocument({ user: PM, fileName: 'INV-2044.txt', bytes: bytesOf('Invoice number: INV-2044\nTotal: 10.00 GBP') }); } catch (err) { out.uploadFailure = `${err.name}: ${err.message}`; }
    print(`INV-2044.txt with the disk full → ${out.uploadFailure}`);
    out.repeat = await service.uploadDocument({ user: PM, fileName: 'INV-2041 (copy).pdf', bytes: makeTextPdf(INVOICE_LINES) });
    print(`INV-2041 uploaded again → the same document (${out.repeat.id === out.invoice.id ? 'same id' : 'DIFFERENT id'}); not processed twice`);
    out.documents = await service.listDocuments({ user: ANALYST });
    print(`\nThe reviewer's list: ${out.documents.map((d) => `${d.fileName} (${d.status})`).join(', ')}`);

    rule('5. Audit trail: every document action, with who, when, and each decision\'s rationale');
    out.entries = audit.readAll();
    for (const e of out.entries) {
      const why = isDecision(e.action) ? ` — ${e.rationale.length > 90 ? `${e.rationale.slice(0, 87)}...` : e.rationale}` : '';
      print(`  #${String(e.seq).padStart(2)} ${e.at.slice(11, 19)} ${e.actor.id.padEnd(20)} ${e.action.padEnd(24)}${why}`);
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
  runDocumentsDemo().then(
    (r) => { process.exitCode = r.audit.ok && r.invoice.status === 'extracted' ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
