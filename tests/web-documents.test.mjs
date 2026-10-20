// Web access, step 4b: the documents endpoints, over real HTTP. Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDocumentService, migrateDocuments } from '../src/documents/service.js';
import { createFileBlobStore } from '../src/documents/blobStore.js';
import { makeTextPdf } from '../src/demo/makePdf.js';
import { openPGlite } from '../src/inventory/db.js';
import { migrateAccounts } from '../src/web/accounts.js';
import { migrateSessions } from '../src/web/sessions.js';
import { documentRoutes } from '../src/web/documentRoutes.js';
import { startHarness } from './helpers/webHarness.mjs';

const PEOPLE = {
  'pm.uploader': 'process manager',
  'ops.other': 'operations manager',
  'fa.reviewer': 'financial analyst',
  'co.reviewer': 'compliance officer',
};
const bytesOf = (s) => new TextEncoder().encode(s);
// Ambiguous issue date and no due date: flagged for review.
const FLAGGED = bytesOf('Invoice number: INV-9\nSupplier: Contoso\nInvoice date: 03/04/2026\nTotal: 120.00 GBP\n');
const INVOICE_PDF = makeTextPdf(['Invoice number: INV-10', 'Supplier: Contoso', 'Invoice date: 2026-04-03', 'Due date: 2026-05-03', 'Total: 120.00 GBP']);

let pg;
before(async () => { pg = await openPGlite(); await migrateDocuments(pg); await migrateAccounts(pg); await migrateSessions(pg); });
after(async () => { await pg.close(); });

async function setup({ maxBytes } = {}) {
  await pg.exec('TRUNCATE documents');
  const h = await startHarness({
    db: pg, people: PEOPLE,
    routes: (audit) => documentRoutes({
      documents: createDocumentService({ db: pg, audit, blobs: createFileBlobStore({ dir: join(mkdtempSync(join(tmpdir(), 'webdocs-')), 'blobs') }) }),
      ...(maxBytes && { maxBytes }),
    }),
  });
  const people = {};
  for (const name of Object.keys(PEOPLE)) people[name] = await h.signIn(name);
  const upload = (as, raw, { fileName = 'invoice.txt', kind, type = 'application/octet-stream' } = {}) => h.call('POST',
    `/api/v1/documents?fileName=${encodeURIComponent(fileName)}${kind ? `&kind=${kind}` : ''}`, { as, raw, type });
  return { ...h, people, upload };
}
const withApi = (name, opts, fn) => test(name, async () => {
  const ctx = await setup(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
});

withApi('a PDF uploaded as the raw request body is read and its fields extracted', {}, async ({ upload, people, audit }) => {
  const r = await upload(people['pm.uploader'], INVOICE_PDF, { fileName: 'inv-10.pdf', type: 'application/pdf' });
  assert.equal(r.status, 200, r.text);
  const doc = r.json.document;
  assert.deepEqual([doc.status, doc.kind, doc.format, doc.uploadedBy, doc.size], ['extracted', 'invoice', 'pdf', 'pm.uploader', INVOICE_PDF.length]);
  assert.equal(doc.fields.total.value, 120);
  assert.ok(!('storageRef' in doc), 'where the file is kept stays internal');
  assert.ok(audit.readAll().some((e) => e.action === 'document.extracted' && e.actor.id === 'pm.uploader'));
});

withApi('uploading the same file again returns the same document; nothing is processed twice', {}, async ({ upload, people, audit }) => {
  const first = await upload(people['pm.uploader'], INVOICE_PDF, { fileName: 'inv-10.pdf', type: 'application/pdf' });
  const again = await upload(people['pm.uploader'], INVOICE_PDF, { fileName: 'inv-10.pdf', type: 'application/pdf' });
  assert.equal(again.status, 200);
  assert.equal(again.json.document.id, first.json.document.id);
  assert.equal(audit.readAll().filter((e) => e.action === 'document.uploaded').length, 1);
  assert.equal(audit.readAll().filter((e) => e.action === 'document.duplicate').length, 1);
});

withApi('an upload must use a file content type, never one an HTML form can send', {}, async ({ upload, people }) => {
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'image/png']) {
    const r = await upload(people['pm.uploader'], FLAGGED, { type });
    assert.equal(r.status, 415, type);
    assert.match(r.json.error, /application\/pdf, application\/json, application\/octet-stream/);
  }
});

withApi('an upload over the size limit is refused with 413 before the service sees it', { maxBytes: 1000 }, async ({ upload, people, audit }) => {
  const r = await upload(people['pm.uploader'], new Uint8Array(1001).fill(65));
  assert.equal(r.status, 413);
  assert.ok(!audit.readAll().some((e) => e.action === 'document.uploaded'));
  assert.equal((await upload(people['pm.uploader'], new Uint8Array(1000).fill(65))).status === 413, false, 'exactly the limit is taken');
});

withApi('the service\'s refusals come back as 400 or 415 with its reason', {}, async ({ upload, people }) => {
  const unsupported = await upload(people['pm.uploader'], FLAGGED, { fileName: 'notes.docx' });
  assert.equal(unsupported.status, 415);
  const badKind = await upload(people['pm.uploader'], FLAGGED, { kind: 'recipe' });
  assert.equal(badKind.status, 400);
  assert.match(badKind.json.error, /"recipe" is not a document type/);
  const empty = await upload(people['pm.uploader'], new Uint8Array(0));
  assert.equal(empty.status, 400);
});

withApi('an upload needs a session and the CSRF token', {}, async ({ url }) => {
  const res = await fetch(`${url}/api/v1/documents?fileName=a.txt`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: FLAGGED, signal: AbortSignal.timeout(10000),
  });
  assert.equal(res.status, 401);
});

withApi('people see their own uploads; reviewers see all; a stranger\'s document looks missing', {}, async ({ upload, call, people }) => {
  const mine = (await upload(people['pm.uploader'], FLAGGED)).json.document;
  await upload(people['ops.other'], INVOICE_PDF, { fileName: 'other.pdf', type: 'application/pdf' });

  const own = await call('GET', '/api/v1/documents', { as: people['pm.uploader'] });
  assert.deepEqual(own.json.documents.map((d) => d.uploadedBy), ['pm.uploader']);
  const all = await call('GET', '/api/v1/documents', { as: people['fa.reviewer'] });
  assert.equal(all.json.documents.length, 2);
  assert.ok(all.json.documents.every((d) => !('storageRef' in d)));
  const flagged = await call('GET', '/api/v1/documents?status=flagged_for_review', { as: people['fa.reviewer'] });
  assert.deepEqual(flagged.json.documents.map((d) => d.id), [mine.id]);
  assert.equal((await call('GET', '/api/v1/documents?status=lost', { as: people['fa.reviewer'] })).status, 400);

  assert.equal((await call('GET', `/api/v1/documents/${mine.id}`, { as: people['pm.uploader'] })).status, 200);
  const stranger = await call('GET', `/api/v1/documents/${mine.id}`, { as: people['ops.other'] });
  const missing = await call('GET', '/api/v1/documents/doc_000000000000000000000000', { as: people['ops.other'] });
  assert.equal(stranger.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(stranger.json.error.replace(mine.id, 'X'), missing.json.error.replace('doc_000000000000000000000000', 'X'), 'not yours and not there read the same');
});

withApi('a reviewer accepts a flagged document with corrections; the version guards against stale views', {}, async ({ upload, call, people, audit }) => {
  const doc = (await upload(people['pm.uploader'], FLAGGED)).json.document;
  const review = (as, over = {}) => call('POST', `/api/v1/documents/${doc.id}/review`, {
    as, body: { decision: 'accept', expectedVersion: 1, note: 'Supplier confirmed the dates', corrections: { issue_date: '2026-04-03', due_date: '2026-05-03' }, ...over },
  });

  const own = await call('POST', `/api/v1/documents/${doc.id}/review`, { as: people['pm.uploader'], body: { decision: 'accept', expectedVersion: 1, note: 'x' } });
  assert.equal(own.status, 403, 'a process manager is not a reviewer');
  const stillBad = await review(people['fa.reviewer'], { corrections: { issue_date: '2026-04-03' } });
  assert.equal(stillBad.status, 400);
  assert.match(stillBad.json.error, /due_date is missing/);
  assert.match((await review(people['fa.reviewer'], { note: '' })).json.error, /a note is required/);

  const ok = await review(people['fa.reviewer']);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.document.status, ok.json.document.version, ok.json.document.reviewedBy], ['reviewed', 2, 'fa.reviewer']);
  assert.equal(audit.readAll().find((e) => e.action === 'document.review_accepted').rationale, 'Supplier confirmed the dates');

  assert.equal((await review(people['fa.reviewer'])).status, 200, 'the same review again changes nothing');
  const stale = await review(people['co.reviewer'], { decision: 'reject', note: 'Fraud' });
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /only a document flagged for review can be reviewed/);
});

withApi('the retention list is for reviewers only', {}, async ({ call, people }) => {
  const r = await call('GET', '/api/v1/documents/due-for-deletion', { as: people['co.reviewer'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.documents, [], 'no policy in force, so nothing is due');
  assert.equal((await call('GET', '/api/v1/documents/due-for-deletion', { as: people['pm.uploader'] })).status, 403);
});
