// Builds small, valid PDFs in code for tests and demos (STORY-007), so no binary
// sample files are kept in the repo.
//
//   makeTextPdf(lines)  — one page with each line as real text (a "digital" PDF)
//   makeImageOnlyPdf()  — one page with only a drawn shape and no text, standing in
//                         for a scanned page (which holds a picture, not characters)
//   makeEncryptedPdf(lines, { userPassword }) — a real password-protected PDF
//
// Text uses the standard Helvetica font with WinAnsi encoding, where every
// character is ONE byte (e.g. "£" is 0xA3). Writing UTF-8 instead would turn "£"
// into two characters when the PDF is read back.

import { createHash } from 'node:crypto';

// WinAnsi differs from Latin-1 for a few characters; only the euro sign matters here.
const WIN_ANSI = { '€': 0x80 };

function toWinAnsi(str) {
  return Uint8Array.from(str, (ch) => {
    const code = WIN_ANSI[ch] ?? ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`makePdf: "${ch}" cannot be written in a standard PDF font`);
    return code;
  });
}

// Assembles objects into a PDF with a correct cross-reference table. Every
// character is one byte, so string lengths are byte offsets.
function assemble(objects) {
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return toWinAnsi(out);
}

const pdfString = (s) => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

export function makeTextPdf(lines) {
  const ops = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td', ...lines.map((l) => `${pdfString(l)} Tj T*`), 'ET'].join('\n');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ]);
}

// A real password-protected PDF, using the PDF standard security handler
// (revision 2: RC4 with a 40-bit key, keys derived with MD5 — PDF 1.7 spec,
// section 7.6.3, algorithms 2, 3 and 4). Opening it needs `userPassword`.
// Weak by today's standards; it exists only to test how encrypted uploads are handled.
const PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const padPassword = (pw) => { const b = new Uint8Array(32); const p = new TextEncoder().encode(pw).slice(0, 32); b.set(p); b.set(PASSWORD_PAD.slice(0, 32 - p.length), p.length); return b; };
const md5 = (...parts) => new Uint8Array(createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest());
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i += 1) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const hex = (b) => Buffer.from(b).toString('hex');
const latin1 = (b) => String.fromCharCode(...b);

export function makeEncryptedPdf(lines, { userPassword = 'demo-user', ownerPassword = 'demo-owner' } = {}) {
  const id = md5(new TextEncoder().encode(`opspilot-test-${lines.join('|')}`));
  const permissions = -44; // print and copy not allowed; any value works for this test
  const P = new Uint8Array(new Int32Array([permissions]).buffer); // 4 bytes, little-endian
  const O = rc4(md5(padPassword(ownerPassword)).slice(0, 5), padPassword(userPassword)); // algorithm 3
  const fileKey = md5(padPassword(userPassword), O, P, id).slice(0, 5); // algorithm 2
  const U = rc4(fileKey, PASSWORD_PAD); // algorithm 4

  // Every string and stream is encrypted with a key derived for its own object.
  const objectKey = (num) => md5(fileKey, Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).slice(0, 10);
  const ops = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td', ...lines.map((l) => `${pdfString(l)} Tj T*`), 'ET'].join('\n');
  const stream = latin1(rc4(objectKey(5), toWinAnsi(ops)));

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(O)}> /U <${hex(U)}> /P ${permissions} >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0));
}

export function makeImageOnlyPdf() {
  const ops = '0.8 g\n50 400 495 380 re f'; // a grey rectangle: marks on the page, no characters
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ]);
}
