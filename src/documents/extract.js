// Pulling structured fields out of a document's text (STORY-007, REQ-010).
//
//   extractFields(read, { kind }) → { kind, fields, flags, status }
//
// `read` is what readDocument() returned. `kind` ('invoice' | 'contract') is what
// the uploader said it is; without it, the kind is worked out from the fields found.
//
// Each kind has a fixed list of fields it MUST yield (REQUIRED below). Values are
// read from:
//   - text and PDF lines of the form "Label: value"      e.g. "Total due: 1,250.00 GBP"
//     and invoice line items written "- Description  2 x 150.00 = 300.00"
//   - CSV with a "field,value" header, or a line-items table
//     (header: description, quantity, unit_price, amount)
//   - JSON objects whose keys are the labels
// Labels are matched against a fixed list of names for each field (LABELS below).
//
// Nothing is guessed. Every problem becomes a FLAG naming the field and the reason,
// and a document with any flag has status 'flagged_for_review':
//   - a required field missing; two different values for one field;
//   - a date that is not real, or AMBIGUOUS (03/04/2026 could be 3 April or 4 March);
//   - an amount that is not a plain number, or a currency that is unclear ("$");
//   - figures that do not add up: subtotal + tax ≠ total, line items ≠ subtotal,
//     quantity × unit price ≠ line amount; a due date before the issue date.
// Every field records where it came from ("line 3, label 'Total due'").

export const KINDS = Object.freeze(['invoice', 'contract']);

export const REQUIRED = Object.freeze({
  invoice: ['invoice_number', 'supplier', 'issue_date', 'due_date', 'currency', 'total'],
  contract: ['parties', 'effective_date', 'end_or_term', 'contract_value', 'currency', 'renewal'],
});

// The names each field may appear under (compared lower-case, spaces and punctuation squeezed).
const LABELS = {
  invoice_number: ['invoice number', 'invoice no', 'invoice #', 'invoice id', 'invoice ref', 'invoice reference'],
  supplier: ['supplier', 'vendor', 'seller', 'from', 'billed by'],
  issue_date: ['invoice date', 'issue date', 'date issued', 'date of issue'],
  due_date: ['due date', 'payment due', 'due by', 'pay by'],
  currency: ['currency'],
  total: ['total', 'total due', 'amount due', 'grand total', 'invoice total', 'balance due'],
  subtotal: ['subtotal', 'sub total', 'net amount', 'net total'],
  tax: ['tax', 'vat', 'sales tax', 'gst'],
  party: ['party', 'party a', 'party b', 'party 1', 'party 2', 'first party', 'second party'],
  parties: ['parties', 'between'],
  effective_date: ['effective date', 'start date', 'commencement date'],
  end_date: ['end date', 'expiry date', 'expiration date', 'termination date'],
  term: ['term', 'duration', 'contract term'],
  contract_value: ['contract value', 'total contract value', 'total value', 'fees', 'value'],
  renewal: ['renewal', 'renewal terms', 'auto renewal', 'automatic renewal'],
};
const squeeze = (s) => String(s).toLowerCase().replace(/[_\-]+/g, ' ').replace(/[^a-z0-9# ]+/g, '').replace(/\s+/g, ' ').trim();
const FIELD_BY_LABEL = new Map(Object.entries(LABELS).flatMap(([field, names]) => names.map((n) => [squeeze(n), field])));

const INVOICE_SIGNALS = ['invoice_number', 'due_date', 'total', 'subtotal', 'tax', 'issue_date'];
const CONTRACT_SIGNALS = ['party', 'parties', 'effective_date', 'end_date', 'term', 'contract_value', 'renewal'];

// ---------------------------------------------------------------------------
// Reading values. Each returns { value } or { problem }.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const realDate = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function parseDate(raw) {
  const s = String(raw).trim();
  let m;
  let y; let mo; let d;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s))) [d, mo, y] = [+m[1], MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3))) + 1, +m[3]];
  else if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) [mo, d, y] = [MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) + 1, +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s))) {
    const [a, b] = [+m[1], +m[2]];
    if (a <= 12 && b <= 12 && a !== b) return { problem: `"${s}" is ambiguous: it could be day/month or month/day; write it as YYYY-MM-DD or "3 April 2026"` };
    [d, mo, y] = a > 12 ? [a, b, +m[3]] : b > 12 ? [b, a, +m[3]] : [a, b, +m[3]];
  } else return { problem: `"${s}" is not a date this system can read` };
  if (mo < 1 || !realDate(y, mo, d)) return { problem: `"${s}" is not a real date` };
  return { value: iso(y, mo, d) };
}

const SYMBOLS = { '£': 'GBP', '€': 'EUR' };
// "1,250.00 GBP", "£1,250.00", "GBP 1250", "1250". A bare "$" is unclear (USD, CAD, AUD…).
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? { value: raw, currency: null } : { problem: `${raw} is not a valid amount` };
  let s = String(raw).trim();
  let currency = null;
  const code = /^([A-Z]{3})\s*(.+)$|^(.+?)\s*([A-Z]{3})$/.exec(s);
  if (code) { currency = code[1] ?? code[4]; s = (code[2] ?? code[3]).trim(); }
  if (s.startsWith('$')) return { problem: `"${String(raw).trim()}" uses "$", which could be several currencies; state the currency code (e.g. USD)` };
  if (SYMBOLS[s[0]]) {
    if (currency && currency !== SYMBOLS[s[0]]) return { problem: `"${String(raw).trim()}" names two different currencies` };
    currency = SYMBOLS[s[0]]; s = s.slice(1).trim();
  }
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return { problem: `"${String(raw).trim()}" is not an amount this system can read (use e.g. 1,250.00)` };
  return { value: Number(s.replace(/,/g, '')), currency };
}

// "24 months", "2 years", "36" (months).
function parseTerm(raw) {
  const m = /^(\d{1,3})\s*(months?|years?)?$/i.exec(String(raw).trim());
  if (!m || +m[1] === 0) return { problem: `"${String(raw).trim()}" is not a term this system can read (use e.g. "24 months")` };
  return { value: { months: /year/i.test(m[2] ?? '') ? +m[1] * 12 : +m[1] } };
}

// ---------------------------------------------------------------------------
// Collecting candidate values from each format: [{ field, raw, source }].

const LINE_ITEM = /^\s*[-*•]\s*(.+?)\s+(\d+(?:\.\d+)?)\s*[x×]\s*([£€]?[\d,]+(?:\.\d{1,2})?)\s*=\s*([£€]?[\d,]+(?:\.\d{1,2})?)\s*$/;

function fromText(text) {
  const candidates = [];
  const items = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const item = LINE_ITEM.exec(line);
    if (item) { items.push({ description: item[1].trim(), quantity: item[2], unitPrice: item[3], amount: item[4], source: `line ${i + 1}` }); return; }
    const m = /^\s*([A-Za-z][A-Za-z0-9 #./&()_-]{0,40}?)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) return;
    const field = FIELD_BY_LABEL.get(squeeze(m[1]));
    if (field) candidates.push({ field, raw: m[2], source: `line ${i + 1}, label "${m[1].trim()}"` });
  });
  return { candidates, items };
}

function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

function fromCsv(text) {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map(squeeze);
  const candidates = [];
  const items = [];
  if (header[0] === 'field' && header[1] === 'value') {
    rows.slice(1).forEach((r, i) => {
      const field = FIELD_BY_LABEL.get(squeeze(r[0] ?? ''));
      if (field) candidates.push({ field, raw: (r[1] ?? '').trim(), source: `row ${i + 2}, "${(r[0] ?? '').trim()}"` });
    });
  } else if (['description', 'quantity', 'unit price', 'amount'].every((h) => header.includes(h))) {
    const at = (h) => header.indexOf(h);
    rows.slice(1).forEach((r, i) => items.push({
      description: (r[at('description')] ?? '').trim(), quantity: (r[at('quantity')] ?? '').trim(),
      unitPrice: (r[at('unit price')] ?? '').trim(), amount: (r[at('amount')] ?? '').trim(), source: `row ${i + 2}`,
    }));
  }
  return { candidates, items, csvShapeUnknown: !candidates.length && !items.length };
}

function fromJson(data) {
  const candidates = [];
  const items = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { candidates, items, jsonShapeUnknown: true };
  for (const [key, value] of Object.entries(data)) {
    const k = squeeze(key);
    if (k === 'line items' && Array.isArray(value)) {
      value.forEach((it, i) => items.push({
        description: it?.description, quantity: it?.quantity, unitPrice: it?.unit_price ?? it?.unitPrice, amount: it?.amount, source: `line_items[${i}]`,
      }));
      continue;
    }
    const field = FIELD_BY_LABEL.get(k);
    if (!field) continue;
    if (field === 'parties' && Array.isArray(value)) value.forEach((p, i) => candidates.push({ field: 'party', raw: p, source: `key "${key}"[${i}]` }));
    else candidates.push({ field, raw: value, source: `key "${key}"` });
  }
  return { candidates, items };
}

// ---------------------------------------------------------------------------

export function extractFields(read, { kind: declaredKind } = {}) {
  const flags = [];
  const flag = (field, problem) => flags.push({ field, problem });

  if (read?.needsOcr) {
    flag(null, 'The PDF has no text layer (it looks like a scan); its contents were not read. Upload a text PDF, or enter the fields by hand.');
    return { kind: declaredKind ?? null, fields: {}, flags, status: 'flagged_for_review' };
  }
  const found = read.format === 'json' ? fromJson(read.data) : read.format === 'csv' ? fromCsv(read.text) : fromText(read.text ?? '');
  if (found.csvShapeUnknown) flag(null, 'The CSV has neither a "field,value" header nor a line-items header (description, quantity, unit_price, amount).');
  if (found.jsonShapeUnknown) flag(null, 'The JSON is not an object of labelled fields.');

  // ---- Which kind of document is it? ----
  const present = new Set(found.candidates.map((c) => c.field));
  if (found.items.length) present.add('subtotal');
  let kind = declaredKind ?? null;
  if (kind && !KINDS.includes(kind)) { flag(null, `"${kind}" is not a document type this system extracts (${KINDS.join(', ')})`); kind = null; }
  if (!kind) {
    const inv = INVOICE_SIGNALS.filter((f) => present.has(f)).length;
    const con = CONTRACT_SIGNALS.filter((f) => present.has(f)).length;
    if (inv > con) kind = 'invoice';
    else if (con > inv) kind = 'contract';
    else {
      flag(null, 'Could not tell whether this is an invoice or a contract; say which when uploading.');
      return { kind: null, fields: {}, flags, status: 'flagged_for_review' };
    }
  }

  // ---- One value per field; two different values is a conflict, not a choice. ----
  const fields = {};
  const set = (name, value, source, raw) => { fields[name] = { value, source, ...(raw !== undefined && String(raw) !== String(value) ? { raw: String(raw) } : {}) }; };
  const byField = new Map();
  for (const c of found.candidates) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
  const single = (field) => {
    const cs = byField.get(field) ?? [];
    const distinct = [...new Set(cs.map((c) => squeeze(c.raw)))];
    if (distinct.length > 1) { flag(field, `found ${cs.length} different values (${cs.map((c) => `"${c.raw}" at ${c.source}`).join('; ')})`); return null; }
    return cs[0] ?? null;
  };

  const currencies = [];
  const text = (field, name = field) => { const c = single(field); if (c) set(name, String(c.raw).trim(), c.source); };
  const date = (field, name = field) => {
    const c = single(field);
    if (!c) return;
    const r = parseDate(c.raw);
    if (r.problem) flag(name, `${r.problem} (${c.source})`); else set(name, r.value, c.source, c.raw);
  };
  const amount = (field, name = field) => {
    const c = single(field);
    if (!c) return;
    const r = parseAmount(c.raw);
    if (r.problem) { flag(name, `${r.problem} (${c.source})`); return; }
    set(name, r.value, c.source, c.raw);
    if (r.currency) currencies.push({ currency: r.currency, source: c.source });
  };

  if (kind === 'invoice') {
    text('invoice_number'); text('supplier'); date('issue_date'); date('due_date');
    amount('total'); amount('subtotal'); amount('tax');
  } else {
    // Parties: "Party A: …" lines, a JSON list, or "Between: X and Y".
    const parties = (byField.get('party') ?? []).map((c) => ({ name: String(c.raw).trim(), source: c.source }));
    const between = single('parties');
    if (between) String(between.raw).split(/\s+and\s+|;|,(?=\s*[A-Z])/).map((p) => p.trim()).filter(Boolean).forEach((name) => parties.push({ name, source: between.source }));
    const names = [...new Set(parties.map((p) => p.name))];
    if (names.length) set('parties', names, [...new Set(parties.map((p) => p.source))].join('; '));
    if (names.length === 1) flag('parties', `only one party was found (${names[0]}); a contract needs at least two`);
    date('effective_date'); date('end_date'); amount('contract_value'); text('renewal');
    const term = single('term');
    if (term) { const r = parseTerm(term.raw); if (r.problem) flag('term', `${r.problem} (${term.source})`); else set('term', r.value, term.source, term.raw); }
    if (fields.end_date || fields.term) fields.end_or_term = { value: fields.end_date?.value ?? fields.term.value, source: (fields.end_date ?? fields.term).source };
  }

  // ---- Currency: stated once, or carried by the amounts — never two. ----
  const stated = single('currency');
  if (stated) {
    const code = String(stated.raw).trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) currencies.push({ currency: code, source: stated.source });
    else flag('currency', `"${stated.raw}" is not a 3-letter currency code (${stated.source})`);
  }
  const distinctCurrencies = [...new Set(currencies.map((c) => c.currency))];
  if (distinctCurrencies.length > 1) flag('currency', `more than one currency appears (${currencies.map((c) => `${c.currency} at ${c.source}`).join('; ')})`);
  else if (distinctCurrencies.length === 1) set('currency', distinctCurrencies[0], currencies.map((c) => c.source).join('; '));

  // ---- Line items (invoices): each line, then the lines against the subtotal/total. ----
  if (kind === 'invoice' && found.items.length) {
    const lines = [];
    for (const it of found.items) {
      const qty = Number(it.quantity);
      const unit = parseAmount(it.unitPrice ?? '');
      const amt = parseAmount(it.amount ?? '');
      if (!String(it.description ?? '').trim() || !Number.isFinite(qty) || qty <= 0 || unit.problem || amt.problem) {
        flag('line_items', `line item at ${it.source} is incomplete or unreadable`);
        continue;
      }
      if (Math.abs(qty * unit.value - amt.value) > 0.005) flag('line_items', `at ${it.source}: ${qty} × ${unit.value} = ${(qty * unit.value).toFixed(2)}, but the line says ${amt.value.toFixed(2)}`);
      lines.push({ description: String(it.description).trim(), quantity: qty, unitPrice: unit.value, amount: amt.value, source: it.source });
    }
    if (lines.length) set('line_items', lines, 'line items');
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    const against = fields.subtotal ?? (fields.tax ? null : fields.total);
    if (against && lines.length === found.items.length && Math.abs(sum - against.value) > 0.005) {
      flag('line_items', `the line items add up to ${sum.toFixed(2)}, but the ${fields.subtotal ? 'subtotal' : 'total'} is ${against.value.toFixed(2)}`);
    }
  }

  // ---- Cross-checks ----
  if (kind === 'invoice') {
    if (fields.subtotal && fields.tax && fields.total && Math.abs(fields.subtotal.value + fields.tax.value - fields.total.value) > 0.005) {
      flag('total', `subtotal ${fields.subtotal.value.toFixed(2)} + tax ${fields.tax.value.toFixed(2)} = ${(fields.subtotal.value + fields.tax.value).toFixed(2)}, but the total is ${fields.total.value.toFixed(2)}`);
    }
    if (fields.total && fields.total.value <= 0) flag('total', 'the total is zero');
    if (fields.issue_date && fields.due_date && fields.due_date.value < fields.issue_date.value) {
      flag('due_date', `the due date ${fields.due_date.value} is before the issue date ${fields.issue_date.value}`);
    }
  } else if (fields.effective_date && fields.end_date && fields.end_date.value <= fields.effective_date.value) {
    flag('end_date', `the end date ${fields.end_date.value} is not after the effective date ${fields.effective_date.value}`);
  }

  // ---- Every required field present (unless it was already flagged for another reason) ----
  for (const name of REQUIRED[kind]) {
    if (!fields[name] && !flags.some((f) => f.field === name || (name === 'end_or_term' && ['end_date', 'term'].includes(f.field)))) {
      flag(name, name === 'end_or_term' ? 'neither an end date nor a term was found' : 'is missing');
    }
  }

  return { kind, fields, flags, status: flags.length ? 'flagged_for_review' : 'extracted' };
}
