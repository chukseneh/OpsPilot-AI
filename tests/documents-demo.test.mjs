// The STORY-007 demo runs end to end. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDocumentsDemo } from '../src/demo/documents.js';
import { isDecision } from '../src/audit/decisions.js';

test('demo: extracted, flagged, reviewed, refused, failed safely, deduplicated — and all of it logged', async () => {
  const r = await runDocumentsDemo({ print: () => {} });

  // Acceptance 1: structured information extracted.
  assert.equal(r.invoice.status, 'extracted');
  assert.deepEqual([r.invoice.fields.invoice_number.value, r.invoice.fields.total.value, r.invoice.fields.currency.value], ['INV-2041', 1200, 'GBP']);
  assert.equal(r.contract.status, 'extracted');
  assert.deepEqual(r.contract.fields.parties.value, ['OpsPilot Demo Org', 'Northwind Analytics Ltd']);

  // Acceptance 2: errors flagged for review.
  assert.match(r.badTotal.flags[0].problem, /but the total is 1250.00/);
  assert.match(r.ambiguous.flags[0].problem, /ambiguous/);
  assert.match(r.scan.flags[0].problem, /no text layer/);
  assert.equal(r.accepted.status, 'reviewed');
  assert.equal(r.rejected.status, 'rejected');
  assert.match(r.selfReview, /may not review their own upload/);

  // Failure paths.
  assert.match(r.unsupported, /UnsupportedFormatError: receipt.png is a PNG image/);
  assert.match(r.uploadFailure, /DocumentUploadError: .*nothing was uploaded/);
  assert.equal(r.repeat.id, r.invoice.id);
  assert.ok(!r.documents.some((d) => d.fileName === 'INV-2044.txt'), 'the failed upload was not recorded');

  // Trust: every processing action logged, decisions with rationale, chain intact.
  const actions = r.entries.map((e) => e.action);
  for (const a of ['document.uploaded', 'document.extracted', 'document.flagged', 'document.review_accepted',
    'document.review_rejected', 'document.rejected', 'document.upload_failed', 'document.duplicate']) assert.ok(actions.includes(a), a);
  assert.ok(r.entries.every((e) => e.at && e.actor.id && (!isDecision(e.action) || e.rationale)));
  assert.equal(r.audit.ok, true);
});
