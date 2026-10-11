// Extracting fields from invoices and contracts, and flagging what is wrong (STORY-007). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractFields, parseDate, parseAmount } from '../src/documents/extract.js';
import { readDocument } from '../src/documents/formats.js';
import { makeTextPdf } from '../src/demo/makePdf.js';

const textDoc = (text) => ({ format: 'text', text, needsOcr: false });
const flagged = (r) => r.flags.map((f) => `${f.field}: ${f.problem}`);
const values = (r) => Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v.value]));

const INVOICE = [
  'INVOICE',
  'Invoice number: INV-2041',
  'Supplier: Northwind Analytics Ltd',
  'Invoice date: 2026-09-01',
  'Due date: 30 September 2026',
  '- Model monitoring licence  2 x 400.00 = 800.00',
  '- Bias audit (fixed fee)  1 x 200.00 = 200.00',
  'Subtotal: 1,000.00 GBP',
  'VAT: 200.00 GBP',
  'Total due: £1,200.00',
].join('\n');

const CONTRACT = [
  'SERVICES AGREEMENT',
  'Party A: OpsPilot Demo Org',
  'Party B: Northwind Analytics Ltd',
  'Effective date: 1 October 2026',
  'Term: 24 months',
  'Contract value: 48,000.00 EUR',
  'Renewal: renews automatically for 12 months unless 90 days\' notice is given',
].join('\n');

// ---- Acceptance 1: structured information is extracted ----

test('an invoice yields every required field, with where each came from', () => {
  const r = extractFields(textDoc(INVOICE));
  assert.deepEqual(flagged(r), []);
  assert.equal(r.status, 'extracted');
  assert.equal(r.kind, 'invoice');
  const v = values(r);
  assert.deepEqual(
    [v.invoice_number, v.supplier, v.issue_date, v.due_date, v.currency, v.subtotal, v.tax, v.total],
    ['INV-2041', 'Northwind Analytics Ltd', '2026-09-01', '2026-09-30', 'GBP', 1000, 200, 1200],
  );
  assert.equal(v.line_items.length, 2);
  assert.deepEqual(v.line_items[0], { description: 'Model monitoring licence', quantity: 2, unitPrice: 400, amount: 800, source: 'line 6' });
  assert.equal(r.fields.total.source, 'line 10, label "Total due"');
  assert.equal(r.fields.due_date.raw, '30 September 2026');
});

test('a contract yields parties, dates, term, value and renewal', () => {
  const r = extractFields(textDoc(CONTRACT));
  assert.deepEqual(flagged(r), []);
  assert.equal(r.kind, 'contract');
  const v = values(r);
  assert.deepEqual(v.parties, ['OpsPilot Demo Org', 'Northwind Analytics Ltd']);
  assert.deepEqual([v.effective_date, v.term, v.contract_value, v.currency], ['2026-10-01', { months: 24 }, 48000, 'EUR']);
  assert.match(v.renewal, /renews automatically/);
  assert.deepEqual(v.end_or_term, { months: 24 });
});

test('the same invoice as JSON, as a "field,value" CSV, and as a text PDF gives the same fields', async () => {
  const json = extractFields({ format: 'json', needsOcr: false, data: {
    invoice_number: 'INV-2041', supplier: 'Northwind Analytics Ltd', invoice_date: '2026-09-01', due_date: '2026-09-30',
    currency: 'GBP', subtotal: 1000, vat: 200, total: 1200,
    line_items: [{ description: 'Licence', quantity: 2, unit_price: 400, amount: 800 }, { description: 'Audit', quantity: 1, unit_price: 200, amount: 200 }],
  } });
  assert.deepEqual(flagged(json), []);

  const csv = extractFields({ format: 'csv', needsOcr: false, text: 'field,value\nInvoice number,INV-2041\nSupplier,"Northwind Analytics, Ltd"\nInvoice date,2026-09-01\nDue date,2026-09-30\nTotal,"1,200.00 GBP"\n' });
  assert.deepEqual(flagged(csv), []);
  assert.equal(csv.fields.supplier.value, 'Northwind Analytics, Ltd');

  const pdf = extractFields(await readDocument({ fileName: 'inv.pdf', bytes: makeTextPdf(INVOICE.split('\n')) }));
  assert.deepEqual(flagged(pdf), []);
  for (const r of [json, csv, pdf]) {
    assert.deepEqual([r.fields.invoice_number.value, r.fields.total.value, r.fields.currency.value], ['INV-2041', 1200, 'GBP']);
  }
});

test('the uploader can say what kind it is; otherwise it is worked out, or flagged', () => {
  assert.equal(extractFields(textDoc('Total: 5.00 GBP'), { kind: 'invoice' }).kind, 'invoice');
  const unknown = extractFields(textDoc('Hello\nNothing labelled here'));
  assert.equal(unknown.kind, null);
  assert.match(flagged(unknown)[0], /Could not tell whether this is an invoice or a contract/);
  assert.match(flagged(extractFields(textDoc(INVOICE), { kind: 'receipt' })).join(), /"receipt" is not a document type/);
});

// ---- Acceptance 2: errors are flagged for review, never guessed ----

test('a missing required field is flagged, and the rest is still extracted', () => {
  const r = extractFields(textDoc(INVOICE.replace('Due date: 30 September 2026\n', '')));
  assert.equal(r.status, 'flagged_for_review');
  assert.deepEqual(flagged(r), ['due_date: is missing']);
  assert.equal(r.fields.total.value, 1200);
});

test('figures that do not add up are flagged, not corrected', () => {
  const wrongTotal = extractFields(textDoc(INVOICE.replace('Total due: £1,200.00', 'Total due: £1,250.00')));
  assert.deepEqual(flagged(wrongTotal), ['total: subtotal 1000.00 + tax 200.00 = 1200.00, but the total is 1250.00']);
  assert.equal(wrongTotal.fields.total.value, 1250, 'the document\'s own figure is kept, not "fixed"');

  const wrongLine = extractFields(textDoc(INVOICE.replace('2 x 400.00 = 800.00', '2 x 400.00 = 900.00')));
  assert.ok(flagged(wrongLine).some((f) => /line 6: 2 × 400 = 800.00, but the line says 900.00/.test(f)));
  assert.ok(flagged(wrongLine).some((f) => /line items add up to 1100.00, but the subtotal is 1000.00/.test(f)));
});

test('ambiguous or impossible dates are flagged, never guessed', () => {
  const amb = extractFields(textDoc(INVOICE.replace('Invoice date: 2026-09-01', 'Invoice date: 03/04/2026')));
  assert.match(flagged(amb)[0], /issue_date: "03\/04\/2026" is ambiguous/);
  assert.equal(amb.fields.issue_date, undefined);
  assert.match(flagged(extractFields(textDoc(INVOICE.replace('2026-09-01', '2026-02-30'))))[0], /not a real date/);
  assert.match(flagged(extractFields(textDoc(INVOICE.replace('Due date: 30 September 2026', 'Due date: 2026-08-01'))))[0], /due date 2026-08-01 is before the issue date 2026-09-01/);
});

test('unclear or conflicting currencies and amounts are flagged', () => {
  assert.match(flagged(extractFields(textDoc(INVOICE.replace('Total due: £1,200.00', 'Total due: $1,200.00')))).join(), /uses "\$", which could be several currencies/);
  assert.match(flagged(extractFields(textDoc(INVOICE.replace('VAT: 200.00 GBP', 'VAT: 200.00 EUR')))).join(), /more than one currency appears/);
  assert.match(flagged(extractFields(textDoc(INVOICE.replace('Total due: £1,200.00', 'Total due: 1.200,00 GBP')))).join(), /not an amount this system can read/);
});

test('two different values for one field are a conflict, not a choice', () => {
  const r = extractFields(textDoc(`${INVOICE}\nInvoice total: 1,300.00 GBP`));
  assert.match(flagged(r).join(), /total: found 2 different values \("£1,200.00" at line 10, label "Total due"; "1,300.00 GBP" at line 11, label "Invoice total"\)/);
  assert.equal(r.fields.total, undefined);
});

test('contract problems: one party, end before start, no end or term', () => {
  const oneParty = extractFields(textDoc(CONTRACT.replace('Party B: Northwind Analytics Ltd\n', '')));
  assert.match(flagged(oneParty).join(), /only one party was found/);
  const backwards = extractFields(textDoc(CONTRACT.replace('Term: 24 months', 'End date: 2026-09-01')));
  assert.match(flagged(backwards).join(), /end date 2026-09-01 is not after the effective date 2026-10-01/);
  const noEnd = extractFields(textDoc(CONTRACT.replace('Term: 24 months\n', '')));
  assert.deepEqual(flagged(noEnd), ['end_or_term: neither an end date nor a term was found']);
});

test('a scanned PDF and a CSV of unknown shape are flagged with nothing extracted', () => {
  const scan = extractFields({ format: 'pdf', needsOcr: true, text: '' }, { kind: 'invoice' });
  assert.deepEqual([scan.status, scan.fields], ['flagged_for_review', {}]);
  assert.match(flagged(scan)[0], /no text layer/);
  assert.match(flagged(extractFields({ format: 'csv', needsOcr: false, text: 'a,b\n1,2' }, { kind: 'invoice' })).join(), /neither a "field,value" header nor a line-items header/);
});

test('date and amount readers', () => {
  assert.equal(parseDate('2026-03-04').value, '2026-03-04');
  assert.equal(parseDate('4 March 2026').value, '2026-03-04');
  assert.equal(parseDate('March 4, 2026').value, '2026-03-04');
  assert.equal(parseDate('25/03/2026').value, '2026-03-25', 'unambiguous: 25 cannot be a month');
  assert.equal(parseDate('04/04/2026').value, '2026-04-04', 'unambiguous: both readings agree');
  assert.ok(parseDate('next Tuesday').problem);
  assert.deepEqual(parseAmount('£1,250.00'), { value: 1250, currency: 'GBP' });
  assert.deepEqual(parseAmount('EUR 99.5'), { value: 99.5, currency: 'EUR' });
  assert.deepEqual(parseAmount(42), { value: 42, currency: null });
  assert.ok(parseAmount('£10 USD').problem, 'two currencies');
  assert.ok(parseAmount(-5).problem);
});
