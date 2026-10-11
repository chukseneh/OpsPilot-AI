// Reading an uploaded document (STORY-007): what is it, and what text does it hold?
//
//   readDocument({ fileName, bytes }) → { format, text, data?, pages?, needsOcr, sha256, size }
//
// Accepted: plain text (.txt), CSV (.csv), JSON (.json) and PDF (.pdf).
// The format is decided from the file's CONTENT, and the name must agree with it:
// a ".pdf" that is not a PDF, or a PDF named ".txt", is refused. Anything else —
// images, Word/Excel files, zips, programs — is refused as unsupported.
//
// Never guessed:
//   - a PDF with no text layer (a scan or photo) comes back with needsOcr: true and
//     no text; reading it would need OCR, which this build does not do;
//   - text that is not valid UTF-8 is refused rather than turned into garbled text;
//   - broken JSON, a corrupt or password-protected PDF are refused with the reason.
//
// PDFs are read with pdfjs-dist (6.4.299 or later: earlier versions let a
// malicious PDF run code). Script evaluation is switched off, and reading has a
// time limit so a hostile or broken PDF cannot hang the system.

import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const SUPPORTED_EXTENSIONS = Object.freeze(['.txt', '.csv', '.json', '.pdf']);
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PDF_TIMEOUT_MS = 10000;
const MIN_PDF_TEXT_CHARS = 20; // fewer readable characters than this: treat as having no text layer

export class UnsupportedFormatError extends Error {
  constructor(message, options) { super(message, options); this.name = 'UnsupportedFormatError'; }
}
// A supported kind of file that could not be read: empty, too large, malformed, encrypted, timed out.
export class DocumentReadError extends Error {
  constructor(message, { code, ...options } = {}) { super(message, options); this.name = 'DocumentReadError'; this.code = code; }
}

// What the first bytes say a file is. Only the kinds people commonly upload by mistake are named.
const SIGNATURES = [
  ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  ['a PNG image', [0x89, 0x50, 0x4e, 0x47]],
  ['a JPEG image', [0xff, 0xd8, 0xff]],
  ['a GIF image', [0x47, 0x49, 0x46, 0x38]],
  ['a TIFF image', [0x49, 0x49, 0x2a, 0x00]],
  ['a TIFF image', [0x4d, 0x4d, 0x00, 0x2a]],
  ['a zip archive (or a Word/Excel/PowerPoint file)', [0x50, 0x4b, 0x03, 0x04]],
  ['an older Word/Excel file', [0xd0, 0xcf, 0x11, 0xe0]],
  ['a Windows program', [0x4d, 0x5a]],
  ['a Linux program', [0x7f, 0x45, 0x4c, 0x46]],
];
const sniff = (bytes) => SIGNATURES.find(([, sig]) => sig.every((b, i) => bytes[i] === b))?.[0] ?? null;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export async function readDocument({
  fileName, bytes, maxBytes = DEFAULT_MAX_BYTES, pdfTimeoutMs = DEFAULT_PDF_TIMEOUT_MS, readPdfText = readPdfWithPdfjs,
} = {}) {
  // ---- 1. Something to read, within the size limit ----
  if (typeof fileName !== 'string' || fileName.trim() === '') throw new DocumentReadError('The document has no file name.', { code: 'no_name' });
  if (!(bytes instanceof Uint8Array)) throw new DocumentReadError('The document has no content.', { code: 'no_content' });
  if (bytes.length === 0) throw new DocumentReadError(`${fileName} is empty.`, { code: 'empty' });
  if (bytes.length > maxBytes) throw new DocumentReadError(`${fileName} is ${bytes.length} bytes; the limit is ${maxBytes}.`, { code: 'too_large' });

  const ext = extname(fileName).toLowerCase();
  const base = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };

  // ---- 2. What is it really, and does the name agree? ----
  const looksLike = sniff(bytes);
  if (looksLike && looksLike !== 'pdf') {
    throw new UnsupportedFormatError(`${fileName} is ${looksLike}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')} (PDFs must contain text).`);
  }
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new UnsupportedFormatError(`${fileName}: "${ext || 'no extension'}" is not a supported format. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`);
  }
  if ((looksLike === 'pdf') !== (ext === '.pdf')) {
    throw new UnsupportedFormatError(looksLike === 'pdf'
      ? `${fileName} is a PDF but is named ${ext}; rename it to .pdf.`
      : `${fileName} is named .pdf but is not a PDF.`);
  }

  // ---- 3. Read it ----
  if (ext === '.pdf') {
    const { text, pages } = await withTimeout(readPdfText(bytes), pdfTimeoutMs, fileName);
    const readable = text.replace(/\s+/g, '').length;
    return readable < MIN_PDF_TEXT_CHARS
      ? { ...base, format: 'pdf', pages, text: '', needsOcr: true }
      : { ...base, format: 'pdf', pages, text, needsOcr: false };
  }

  if (bytes.includes(0)) throw new UnsupportedFormatError(`${fileName} contains binary data; it is not a text file.`);
  let text;
  try {
    text = utf8.decode(bytes).replace(/^﻿/, ''); // drop a byte-order mark
  } catch (err) {
    throw new DocumentReadError(`${fileName} is not valid UTF-8 text; save it as UTF-8 and upload it again.`, { code: 'bad_encoding', cause: err });
  }
  if (ext === '.json') {
    try {
      return { ...base, format: 'json', text, data: JSON.parse(text), needsOcr: false };
    } catch (err) {
      throw new DocumentReadError(`${fileName} is not valid JSON: ${err.message}`, { code: 'malformed', cause: err });
    }
  }
  return { ...base, format: ext === '.csv' ? 'csv' : 'text', text, needsOcr: false };
}

async function withTimeout(promise, ms, fileName) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DocumentReadError(`Reading ${fileName} took longer than ${ms} ms; it was stopped.`, { code: 'timeout' })), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

// The text of every page, in reading order, one line per text line.
export async function readPdfWithPdfjs(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), // pdfjs takes ownership of the buffer it is given
    isEvalSupported: false, // never evaluate code found in a PDF
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      throw pdfOpenError(err);
    }
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(content.items.map((item) => `${item.str}${item.hasEOL ? '\n' : ''}`).join(''));
    }
    return { text: pages.join('\n'), pages: doc.numPages };
  } finally {
    await task.destroy(); // frees the document and its worker, whether reading worked or not
  }
}

// What the user is told when pdfjs cannot open a PDF.
export function pdfOpenError(err) {
  if (err?.name === 'PasswordException') {
    return new DocumentReadError('The PDF is password-protected; upload an unprotected copy.', { code: 'encrypted', cause: err });
  }
  return new DocumentReadError(`The PDF could not be read (${err?.name ?? 'Error'}: ${err?.message ?? err}).`, { code: 'malformed', cause: err });
}
