// Reviewing documents flagged for review (STORY-007). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDocumentService, migrateDocuments, PermissionDeniedError, DocumentRequestError, DocumentNotFoundError } from '../src/documents/service.js';
import { createFileBlobStore } from '../src/documents/blobStore.js';
import { openPGlite } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { makeImageOnlyPdf } from '../src/demo/makePdf.js';

const PM = { id: 'pm-1', role: 'process manager' };
const ANALYST = { id: 'fa-1', role: 'financial analyst' };
const COMPLIANCE = { id: 'co-1', role: 'compliance officer' };
const bytesOf = (s) => new TextEncoder().encode(s);

// Ambiguous issue date, and no due date: flagged twice.
const FLAGGED_INVOICE = 'Invoice number: INV-9\nSupplier: Contoso\nInvoice date: 03/04/2026\nTotal: 120.00 GBP\n';

let pg;
before(async () => { pg = await openPGlite(); await migrateDocuments(pg); });
after(async () => { await pg.close(); });

async function setup(text = FLAGGED_INVOICE) {
  await pg.exec('TRUNCATE documents');
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const service = createDocumentService({ db: pg, audit, blobs: createFileBlobStore({ dir: join(dir, 'blobs') }) });
  const doc = await service.uploadDocument({ user: PM, fileName: 'inv.txt', bytes: bytesOf(text) });
  return { service, audit, doc };
}

test('accept with corrections: the corrected document passes the extraction checks and is marked reviewed', async () => {
  const { service, audit, doc } = await setup();
  assert.equal(doc.status, 'flagged_for_review');
  const r = await service.reviewDocument({
    user: ANALYST, documentId: doc.id, decision: 'accept', expectedVersion: doc.version,
    corrections: { issue_date: '2026-04-03', due_date: '2026-05-03' },
    note: 'Supplier confirmed by phone: issued 3 April, 30-day terms',
  });
  assert.equal(r.status, 'reviewed');
  assert.equal(r.version, 2);
  assert.deepEqual([r.fields.issue_date.value, r.fields.due_date.value, r.fields.total.value], ['2026-04-03', '2026-05-03', 120]);
  assert.equal(r.fields.issue_date.source, 'corrected by fa-1 during review');
  assert.equal(r.fields.total.source, 'line 4, label "Total"', 'untouched fields keep where they came from');
  assert.equal(r.flags.length, 2, 'the original flags are kept as history');

  const entry = audit.readAll().find((e) => e.action === 'document.review_accepted');
  assert.equal(entry.rationale, 'Supplier confirmed by phone: issued 3 April, 30-day terms');
  assert.deepEqual(entry.detail.corrections.issue_date, { before: null, after: '2026-04-03' });
  assert.equal(entry.actor.id, 'fa-1');
});

test('an accept whose corrections still fail the checks is refused, listing what is wrong', async () => {
  const { service, doc, audit } = await setup();
  await assert.rejects(service.reviewDocument({
    user: ANALYST, documentId: doc.id, decision: 'accept', expectedVersion: 1, note: 'fixed', corrections: { issue_date: '2026-04-03', due_date: '2026-03-01' },
  }), (err) => err instanceof DocumentRequestError && /still has problems: due_date the due date 2026-03-01 is before the issue date 2026-04-03/.test(err.message));
  await assert.rejects(service.reviewDocument({
    user: ANALYST, documentId: doc.id, decision: 'accept', expectedVersion: 1, note: 'fixed', corrections: { issue_date: '2026-04-03' },
  }), /due_date is missing/);
  assert.equal((await service.getDocument({ user: ANALYST, documentId: doc.id })).status, 'flagged_for_review', 'nothing changed');
  assert.equal(audit.readAll().filter((e) => e.action === 'document.review_refused').length, 2);
});

test('reject: the document is marked rejected with the note', async () => {
  const { service, audit, doc } = await setup();
  const r = await service.reviewDocument({ user: COMPLIANCE, documentId: doc.id, decision: 'reject', expectedVersion: 1, note: 'Not one of our suppliers; possible fraud' });
  assert.deepEqual([r.status, r.reviewedBy, r.reviewNote], ['rejected', 'co-1', 'Not one of our suppliers; possible fraud']);
  assert.equal(audit.readAll().at(-1).action, 'document.review_rejected');
});

test('a scanned invoice can be accepted by entering every field by hand', async () => {
  await pg.exec('TRUNCATE documents');
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  const service = createDocumentService({ db: pg, audit: createAuditLog({ file: join(dir, 'a.jsonl') }), blobs: createFileBlobStore({ dir: join(dir, 'b') }) });
  const scan = await service.uploadDocument({ user: PM, fileName: 'scan.pdf', kind: 'invoice', bytes: makeImageOnlyPdf() });
  const r = await service.reviewDocument({
    user: ANALYST, documentId: scan.id, decision: 'accept', expectedVersion: 1, note: 'Typed in from the paper original',
    corrections: { invoice_number: 'INV-55', supplier: 'Contoso', issue_date: '2026-09-01', due_date: '2026-09-30', currency: 'GBP', total: 75 },
  });
  assert.equal(r.status, 'reviewed');
  assert.ok(Object.values(r.fields).every((f) => f.source === 'corrected by fa-1 during review'));
});

test('a reviewer may not review their own upload; non-reviewers may not review at all', async () => {
  const { service, doc } = await setup();
  const selfUpload = await service.uploadDocument({ user: ANALYST, fileName: 'mine.txt', bytes: bytesOf(`${FLAGGED_INVOICE}\n`) });
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: selfUpload.id, decision: 'reject', expectedVersion: 1, note: 'x' }), /may not review their own upload/);
  await assert.rejects(service.reviewDocument({ user: PM, documentId: doc.id, decision: 'reject', expectedVersion: 1, note: 'x' }), PermissionDeniedError);
  await assert.rejects(service.reviewDocument({ user: { id: 'sec-1', role: 'security officer' }, documentId: doc.id, decision: 'reject', expectedVersion: 1, note: 'x' }), PermissionDeniedError);
});

test('a note is required, and the decision and version must be given', async () => {
  const { service, doc } = await setup();
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: doc.id, decision: 'reject', expectedVersion: 1, note: '  ' }), /a note is required/);
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: doc.id, decision: 'maybe', expectedVersion: 1, note: 'x' }), /"accept" or "reject"/);
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: doc.id, decision: 'reject', note: 'x' }), /expectedVersion is required/);
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: 'doc_nope', decision: 'reject', expectedVersion: 1, note: 'x' }), DocumentNotFoundError);
});

test('an unknown correction field is refused', async () => {
  const { service, doc } = await setup();
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: doc.id, decision: 'accept', expectedVersion: 1, note: 'x', corrections: { iban: 'GB00' } }), /unknown field\(s\) for an invoice: iban/);
});

test('only flagged documents can be reviewed; a stale review is refused; the same review twice changes nothing', async () => {
  const { service, doc } = await setup();
  const first = await service.reviewDocument({ user: COMPLIANCE, documentId: doc.id, decision: 'reject', expectedVersion: 1, note: 'Duplicate of INV-8' });
  const again = await service.reviewDocument({ user: COMPLIANCE, documentId: doc.id, decision: 'reject', expectedVersion: 1, note: 'Duplicate of INV-8' });
  assert.equal(again.version, first.version, 'nothing changed');
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: doc.id, decision: 'accept', expectedVersion: 2, note: 'x', corrections: {} }), /only a document flagged for review can be reviewed \(this one is rejected\)/);
});

test('a cleanly extracted document cannot be overwritten by a review', async () => {
  const { service, doc } = await setup('Invoice number: INV-1\nSupplier: A\nInvoice date: 2026-09-01\nDue date: 2026-09-30\nTotal: 1.00 GBP\n');
  assert.equal(doc.status, 'extracted');
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: doc.id, decision: 'reject', expectedVersion: 1, note: 'x' }), /this one is extracted/);
});

test('a review from an out-of-date view is refused', async () => {
  const { service, doc } = await setup();
  await assert.rejects(service.reviewDocument({ user: ANALYST, documentId: doc.id, decision: 'reject', expectedVersion: 7, note: 'x' }), /you saw version 7, it is now version 1/);
});
