// Uploading documents: storage, extraction outcome, access, audit (STORY-007). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDocumentService, migrateDocuments, PermissionDeniedError, DocumentUploadError, DocumentNotFoundError, DocumentRequestError,
} from '../src/documents/service.js';
import { createFileBlobStore } from '../src/documents/blobStore.js';
import { UnsupportedFormatError, DocumentReadError } from '../src/documents/formats.js';
import { openPGlite } from '../src/inventory/db.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { isDecision } from '../src/audit/decisions.js';
import { makeTextPdf, makeImageOnlyPdf } from '../src/demo/makePdf.js';

const ANALYST = { id: 'fa-1', role: 'financial analyst' };
const PM = { id: 'pm-1', role: 'process manager' };
const OPS = { id: 'ops-1', role: 'operations manager' };
const bytesOf = (s) => new TextEncoder().encode(s);

const INVOICE = 'Invoice number: INV-7\nSupplier: Contoso\nInvoice date: 2026-09-01\nDue date: 2026-09-30\nTotal: 120.00 GBP\n';

let pg;
before(async () => { pg = await openPGlite(); await migrateDocuments(pg); });
after(async () => { await pg.close(); });

async function setup({ blobs } = {}) {
  await pg.exec('TRUNCATE documents');
  const dir = mkdtempSync(join(tmpdir(), 'docs-'));
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const blobDir = join(dir, 'blobs');
  const service = createDocumentService({ db: pg, audit, blobs: blobs ?? createFileBlobStore({ dir: blobDir }) });
  const actions = () => audit.readAll().map((e) => e.action);
  return { service, audit, actions, blobDir };
}

// ---- Acceptance 1: uploaded → processed → structured information ----

test('an uploaded invoice is stored by fingerprint, extracted, and the upload and outcome are logged', async () => {
  const { service, audit, blobDir } = await setup();
  const doc = await service.uploadDocument({ user: PM, fileName: 'inv-7.txt', bytes: bytesOf(INVOICE) });
  assert.equal(doc.status, 'extracted');
  assert.equal(doc.kind, 'invoice');
  assert.equal(doc.fields.total.value, 120);
  assert.deepEqual(doc.flags, []);
  assert.deepEqual(readdirSync(blobDir), [doc.sha256], 'the file is stored once, under its fingerprint');
  assert.equal(doc.storageRef, `file:${doc.sha256}`);

  const [uploaded, extracted] = audit.readAll();
  assert.deepEqual([uploaded.action, uploaded.actor.id, uploaded.detail.fileName], ['document.uploaded', 'pm-1', 'inv-7.txt']);
  assert.equal(extracted.action, 'document.extracted');
  assert.match(extracted.rationale, /^Extracted 6 field\(s\) from an invoice; every required field present/);
});

test('a text PDF contract is extracted the same way', async () => {
  const { service } = await setup();
  const doc = await service.uploadDocument({ user: OPS, fileName: 'msa.pdf', kind: 'contract', bytes: makeTextPdf([
    'Party A: OpsPilot Demo Org', 'Party B: Contoso', 'Effective date: 2026-10-01', 'Term: 12 months', 'Contract value: 9,600.00 EUR', 'Renewal: none',
  ]) });
  assert.equal(doc.status, 'extracted');
  assert.deepEqual(doc.fields.parties.value, ['OpsPilot Demo Org', 'Contoso']);
  assert.equal(doc.format, 'pdf');
});

// ---- Acceptance 2: errors flag the document for review ----

test('a document with errors is stored and flagged for review, with each reason logged as the decision rationale', async () => {
  const { service, audit } = await setup();
  const doc = await service.uploadDocument({ user: PM, fileName: 'bad.txt', bytes: bytesOf(INVOICE.replace('Due date: 2026-09-30\n', '').replace('2026-09-01', '03/04/2026')) });
  assert.equal(doc.status, 'flagged_for_review');
  assert.deepEqual(doc.flags.map((f) => f.field).sort(), ['due_date', 'issue_date']);
  const flagged = audit.readAll().find((e) => e.action === 'document.flagged');
  assert.match(flagged.rationale, /^Flagged for review: .*issue_date "03\/04\/2026" is ambiguous.*due_date is missing/);
});

test('a scanned PDF, broken JSON and a corrupt PDF are stored and flagged, not refused and not guessed', async () => {
  const { service } = await setup();
  const scan = await service.uploadDocument({ user: PM, fileName: 'scan.pdf', kind: 'invoice', bytes: makeImageOnlyPdf() });
  const json = await service.uploadDocument({ user: PM, fileName: 'c.json', bytes: bytesOf('{"parties": [') });
  const pdf = await service.uploadDocument({ user: PM, fileName: 'x.pdf', bytes: bytesOf('%PDF-1.4 not really') });
  for (const [doc, reason] of [[scan, /no text layer/], [json, /not valid JSON/], [pdf, /could not be read/]]) {
    assert.equal(doc.status, 'flagged_for_review');
    assert.deepEqual(doc.fields, {});
    assert.match(doc.flags[0].problem, reason);
  }
});

// ---- Failure path: unsupported document format (refused; nothing stored) ----

test('an unsupported format is refused, nothing is stored, and the refusal is a logged decision', async () => {
  const { service, audit, blobDir } = await setup();
  await assert.rejects(service.uploadDocument({ user: PM, fileName: 'photo.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]) }), UnsupportedFormatError);
  await assert.rejects(service.uploadDocument({ user: PM, fileName: 'empty.txt', bytes: new Uint8Array() }), DocumentReadError);
  assert.deepEqual(await service.listDocuments({ user: ANALYST }), []);
  assert.throws(() => readdirSync(blobDir), /ENOENT/, 'nothing was written');
  const rejected = audit.readAll().filter((e) => e.action === 'document.rejected');
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].rationale, /is a PNG image/);
});

// ---- Failure path: document upload failure ----

test('if the file cannot be stored, nothing is recorded as uploaded and the failure is logged', async () => {
  const blobs = createFileBlobStore({ dir: join(mkdtempSync(join(tmpdir(), 'docs-')), 'blobs'), rename: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  const { service, actions } = await setup({ blobs });
  await assert.rejects(service.uploadDocument({ user: PM, fileName: 'inv.txt', bytes: bytesOf(INVOICE) }),
    (err) => err instanceof DocumentUploadError && /could not be stored \(ENOSPC\); nothing was uploaded/.test(err.message));
  assert.deepEqual(await service.listDocuments({ user: ANALYST }), []);
  assert.deepEqual(actions().slice(0, 1), ['document.upload_failed']);
});

test('the temporary file is cleaned up when storing fails half-way', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'docs-')), 'blobs');
  const blobs = createFileBlobStore({ dir, rename: () => { throw new Error('rename failed'); } });
  assert.throws(() => blobs.put('a'.repeat(64), bytesOf('x')), DocumentUploadError);
  assert.deepEqual(readdirSync(dir), []);
});

test('if the audit log fails, the upload is not recorded', async () => {
  await pg.exec('TRUNCATE documents');
  const audit = { append: (e) => { if (e.action === 'document.uploaded') throw new AuditWriteError('disk full'); return { seq: 1, ...e }; } };
  const service = createDocumentService({ db: pg, audit, blobs: createFileBlobStore({ dir: join(mkdtempSync(join(tmpdir(), 'docs-')), 'b') }) });
  await assert.rejects(service.uploadDocument({ user: PM, fileName: 'inv.txt', bytes: bytesOf(INVOICE) }), AuditWriteError);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0);
});

// ---- Idempotency ----

test('the same person uploading the same content again gets the same document; it is not processed twice', async () => {
  const { service, actions } = await setup();
  const [a, b] = await Promise.all([
    service.uploadDocument({ user: PM, fileName: 'inv.txt', bytes: bytesOf(INVOICE) }),
    service.uploadDocument({ user: PM, fileName: 'inv.txt', bytes: bytesOf(INVOICE) }),
  ]);
  const c = await service.uploadDocument({ user: PM, fileName: 'renamed.txt', bytes: bytesOf(INVOICE) });
  assert.equal(a.id, b.id);
  assert.equal(c.id, a.id);
  assert.equal((await service.listDocuments({ user: ANALYST })).length, 1);
  assert.equal(actions().filter((x) => x === 'document.extracted').length, 1);
  assert.ok(actions().includes('document.duplicate'));
});

test('a different person uploading the same content gets their own record (stored once)', async () => {
  const { service, blobDir } = await setup();
  const mine = await service.uploadDocument({ user: PM, fileName: 'inv.txt', bytes: bytesOf(INVOICE) });
  const theirs = await service.uploadDocument({ user: OPS, fileName: 'inv.txt', bytes: bytesOf(INVOICE) });
  assert.notEqual(mine.id, theirs.id);
  assert.equal(readdirSync(blobDir).length, 1);
});

// ---- Access ----

test('uploaders see only their own documents; reviewers see all; others are refused and logged', async () => {
  const { service, audit } = await setup();
  const mine = await service.uploadDocument({ user: PM, fileName: 'a.txt', bytes: bytesOf(INVOICE) });
  await service.uploadDocument({ user: OPS, fileName: 'b.txt', bytes: bytesOf(`${INVOICE}\n`) });
  assert.equal((await service.listDocuments({ user: PM })).length, 1);
  assert.equal((await service.listDocuments({ user: ANALYST })).length, 2);
  assert.equal((await service.listDocuments({ user: ANALYST, status: 'extracted' })).length, 2);

  assert.equal((await service.getDocument({ user: ANALYST, documentId: mine.id })).id, mine.id);
  await assert.rejects(service.getDocument({ user: OPS, documentId: mine.id }), DocumentNotFoundError, 'not yours looks like not found');
  await assert.rejects(service.getDocument({ user: PM, documentId: 'doc_nope' }), DocumentNotFoundError);
  await assert.rejects(service.uploadDocument({ user: { id: 'x', role: 'intern' }, fileName: 'a.txt', bytes: bytesOf(INVOICE) }), PermissionDeniedError);
  await assert.rejects(service.uploadDocument({ fileName: 'a.txt', bytes: bytesOf(INVOICE) }), PermissionDeniedError);
  assert.ok(audit.readAll().filter((e) => e.action === 'document.denied').length >= 4);
  assert.ok(audit.readAll().some((e) => e.action === 'document.viewed' && e.actor.id === 'fa-1'));
});

test('an unknown document type is refused before anything happens', async () => {
  const { service } = await setup();
  await assert.rejects(service.uploadDocument({ user: PM, fileName: 'r.txt', kind: 'receipt', bytes: bytesOf(INVOICE) }), DocumentRequestError);
});

// ---- Trust: document processing actions are logged ----

test('every processing step is logged with who and when; every decision with its rationale', async () => {
  const { service, audit } = await setup();
  await service.uploadDocument({ user: PM, fileName: 'ok.txt', bytes: bytesOf(INVOICE) });
  await service.uploadDocument({ user: PM, fileName: 'bad.txt', bytes: bytesOf('Total: 5.00 GBP') , kind: 'invoice' });
  await service.uploadDocument({ user: PM, fileName: 'p.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }).catch(() => {});
  await service.listDocuments({ user: ANALYST });
  const entries = audit.readAll();
  assert.deepEqual(entries.map((e) => e.action), [
    'document.uploaded', 'document.extracted', 'document.uploaded', 'document.flagged', 'document.rejected', 'document.listed',
  ]);
  for (const e of entries) {
    assert.ok(e.at && e.actor.id);
    if (isDecision(e.action)) assert.ok(e.rationale);
  }
  assert.equal(audit.verify().ok, true);
});
