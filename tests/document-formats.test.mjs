// Reading uploaded documents: formats, refusals, PDFs (STORY-007). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readDocument, pdfOpenError, UnsupportedFormatError, DocumentReadError } from '../src/documents/formats.js';
import { makeTextPdf, makeImageOnlyPdf } from '../src/demo/makePdf.js';

const bytesOf = (s) => new TextEncoder().encode(s);
const unsupported = (pattern) => (err) => err instanceof UnsupportedFormatError && pattern.test(err.message);
const readErr = (code) => (err) => err instanceof DocumentReadError && err.code === code;

test('plain text, CSV and JSON are read, with a content fingerprint', async () => {
  const txt = await readDocument({ fileName: 'invoice.txt', bytes: bytesOf('﻿Invoice number: INV-1\nTotal: 10.00') });
  assert.deepEqual([txt.format, txt.text.startsWith('Invoice'), txt.needsOcr], ['text', true, false]);
  assert.match(txt.sha256, /^[0-9a-f]{64}$/);

  const csv = await readDocument({ fileName: 'Lines.CSV', bytes: bytesOf('item,amount\nA,1') });
  assert.equal(csv.format, 'csv');

  const json = await readDocument({ fileName: 'contract.json', bytes: bytesOf('{"parties":["A","B"]}') });
  assert.deepEqual(json.data, { parties: ['A', 'B'] });
});

test('the same bytes always give the same fingerprint; different bytes a different one', async () => {
  const a = await readDocument({ fileName: 'a.txt', bytes: bytesOf('same') });
  const b = await readDocument({ fileName: 'b.txt', bytes: bytesOf('same') });
  const c = await readDocument({ fileName: 'a.txt', bytes: bytesOf('different') });
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.sha256, c.sha256);
});

test('a PDF with a text layer is read page by page', async () => {
  const pdf = await readDocument({ fileName: 'inv.pdf', bytes: makeTextPdf(['INVOICE', 'Invoice number: INV-2041', 'Total due: 1,250.00 GBP']) });
  assert.equal(pdf.format, 'pdf');
  assert.equal(pdf.pages, 1);
  assert.equal(pdf.needsOcr, false);
  assert.match(pdf.text, /Invoice number: INV-2041/);
  assert.match(pdf.text, /Total due: 1,250.00 GBP/);
});

test('a PDF with no text layer (a scan) is flagged as needing OCR; nothing is guessed', async () => {
  const scan = await readDocument({ fileName: 'scan.pdf', bytes: makeImageOnlyPdf() });
  assert.deepEqual([scan.format, scan.needsOcr, scan.text], ['pdf', true, '']);
});

// ---- Failure path: unsupported document format ----

test('images, Office files, archives and programs are refused, saying what they are', async () => {
  const cases = [
    ['photo.png', [0x89, 0x50, 0x4e, 0x47, 0, 0], /is a PNG image/],
    ['photo.jpg', [0xff, 0xd8, 0xff, 0xe0], /is a JPEG image/],
    ['contract.docx', [0x50, 0x4b, 0x03, 0x04, 1], /zip archive \(or a Word\/Excel\/PowerPoint file\)/],
    ['old.doc', [0xd0, 0xcf, 0x11, 0xe0, 1], /older Word\/Excel file/],
    ['setup.exe', [0x4d, 0x5a, 0x90, 0], /Windows program/],
  ];
  for (const [fileName, bytes, msg] of cases) {
    await assert.rejects(readDocument({ fileName, bytes: new Uint8Array(bytes) }), unsupported(msg), fileName);
  }
});

test('an unsupported extension is refused, even for plain text', async () => {
  await assert.rejects(readDocument({ fileName: 'notes.md', bytes: bytesOf('# hi') }), unsupported(/"\.md" is not a supported format/));
  await assert.rejects(readDocument({ fileName: 'README', bytes: bytesOf('hi') }), unsupported(/"no extension"/));
});

test('a name that disagrees with the content is refused', async () => {
  await assert.rejects(readDocument({ fileName: 'invoice.pdf', bytes: bytesOf('just text') }), unsupported(/named \.pdf but is not a PDF/));
  await assert.rejects(readDocument({ fileName: 'invoice.txt', bytes: makeTextPdf(['x']) }), unsupported(/is a PDF but is named \.txt/));
  await assert.rejects(readDocument({ fileName: 'data.txt', bytes: new Uint8Array([0x41, 0x00, 0x42]) }), unsupported(/binary data/));
});

// ---- Failure path: extraction errors (the file is a supported kind but cannot be read) ----

test('broken JSON, non-UTF-8 text and a corrupt PDF are refused with the reason', async () => {
  await assert.rejects(readDocument({ fileName: 'c.json', bytes: bytesOf('{"parties": [') }), readErr('malformed'));
  await assert.rejects(readDocument({ fileName: 'i.txt', bytes: new Uint8Array([0x49, 0x6e, 0x76, 0xe9, 0x20]) }), readErr('bad_encoding'));
  await assert.rejects(readDocument({ fileName: 'i.pdf', bytes: bytesOf('%PDF-1.4\nthis is not really a pdf') }), readErr('malformed'));
});

test('pdfjs errors are turned into clear messages: password-protected, or unreadable', () => {
  // pdfjs raises PasswordException for an encrypted PDF. Building a real encrypted PDF
  // in a test is impractical, so this checks the mapping the real reader uses.
  const locked = pdfOpenError(Object.assign(new Error('No password given'), { name: 'PasswordException' }));
  assert.ok(readErr('encrypted')(locked));
  assert.match(locked.message, /password-protected; upload an unprotected copy/);
  const broken = pdfOpenError(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }));
  assert.ok(readErr('malformed')(broken));
});

test('a PDF that takes too long to read is stopped', async () => {
  const started = Date.now();
  await assert.rejects(
    readDocument({ fileName: 'slow.pdf', bytes: makeTextPdf(['x']), pdfTimeoutMs: 30, readPdfText: () => new Promise(() => {}) }),
    (err) => readErr('timeout')(err) && /took longer than 30 ms/.test(err.message),
  );
  assert.ok(Date.now() - started < 2000);
});

test('empty, too large, nameless and content-less uploads are refused', async () => {
  await assert.rejects(readDocument({ fileName: 'e.txt', bytes: new Uint8Array() }), readErr('empty'));
  await assert.rejects(readDocument({ fileName: 'big.txt', bytes: bytesOf('12345'), maxBytes: 4 }), readErr('too_large'));
  await assert.rejects(readDocument({ fileName: '', bytes: bytesOf('x') }), readErr('no_name'));
  await assert.rejects(readDocument({ fileName: 'x.txt', bytes: 'not bytes' }), readErr('no_content'));
});
