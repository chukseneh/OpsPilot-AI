// Builds small, valid PDFs in code for tests and demos (STORY-007), so no binary
// sample files are kept in the repo.
//
//   makeTextPdf(lines)  — one page with each line as real text (a "digital" PDF)
//   makeImageOnlyPdf()  — one page with only a drawn shape and no text, standing in
//                         for a scanned page (which holds a picture, not characters)
//
// Text uses the standard Helvetica font with WinAnsi encoding, where every
// character is ONE byte (e.g. "£" is 0xA3). Writing UTF-8 instead would turn "£"
// into two characters when the PDF is read back.

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

export function makeImageOnlyPdf() {
  const ops = '0.8 g\n50 400 495 380 re f'; // a grey rectangle: marks on the page, no characters
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ]);
}
