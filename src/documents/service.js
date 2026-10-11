// Uploading documents and extracting their fields (STORY-007, REQ-010).
//
//   uploadDocument({ user, fileName, bytes, kind })  → the document (extracted, or flagged for review)
//   getDocument({ user, documentId })                → one document
//   listDocuments({ user })                          → the documents this user may see
//
// Who (the student's choice): any known role may upload, and sees its own
// uploads; a compliance officer or financial analyst (the reviewers) sees all.
// Anyone else — or a request with no user — is refused, and the refusal logged.
//
// What happens to an upload:
//   refused, nothing stored     — unsupported format; empty or too large
//   stored, flagged for review  — a supported file that could not be read (broken
//                                 JSON, corrupt or password-protected PDF, read
//                                 timeout), a scanned PDF, or any extraction flag
//   stored, extracted           — every required field found and every check passed
// Upload failure: if the file cannot be stored, nothing is recorded as uploaded,
// the failure is logged, and the caller is told to try again.
//
// Every upload, outcome, view and refusal is in the audit log. The outcome is a
// DECISION with its rationale (each flag, or what was extracted), written inside
// the database transaction like every other change.
//
// Idempotent: the same person uploading the same content again gets the same
// document back; it is not stored or processed twice.

import { createHash } from 'node:crypto';

import { roleAllowed } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { readDocument, UnsupportedFormatError, DocumentReadError } from './formats.js';
import { extractFields, KINDS, REQUIRED } from './extract.js';
import { DocumentUploadError } from './blobStore.js';

export { PermissionDeniedError, DocumentUploadError };
export const UPLOAD_ROLES = Object.freeze([
  'operations manager', 'process analyst', 'process manager', 'compliance officer', 'IT manager', 'security officer', 'financial analyst',
]);
export const REVIEWER_ROLES = Object.freeze(['compliance officer', 'financial analyst']);
export const DOCUMENT_STATUSES = Object.freeze(['extracted', 'flagged_for_review', 'reviewed', 'rejected']);

// Read problems that mean "this upload is refused" rather than "store it and flag it".
const REFUSED_READ_CODES = new Set(['empty', 'too_large', 'no_name', 'no_content']);

export class DocumentRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'DocumentRequestError'; }
}
export class DocumentNotFoundError extends Error {
  constructor(message, options) { super(message, options); this.name = 'DocumentNotFoundError'; }
}

const list = (values) => values.map((v) => `'${v}'`).join(', ');
export const DOCUMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id            text PRIMARY KEY,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by   text NOT NULL CHECK (btrim(uploaded_by) <> ''),
  file_name     text NOT NULL,
  declared_kind text,
  kind          text CHECK (kind IN (${list(KINDS)})),
  format        text,
  size          integer NOT NULL CHECK (size > 0),
  storage_ref   text NOT NULL,
  status        text NOT NULL CHECK (status IN (${list(DOCUMENT_STATUSES)})),
  fields        jsonb NOT NULL,
  flags         jsonb NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (sha256, uploaded_by),
  -- "Extracted" means nothing is outstanding; a flagged document must say why.
  CONSTRAINT status_matches_flags CHECK (status <> 'extracted' OR jsonb_array_length(flags) = 0),
  CONSTRAINT flagged_has_reason CHECK (status <> 'flagged_for_review' OR jsonb_array_length(flags) > 0)
);
`;
export async function migrateDocuments(db) { await db.exec(DOCUMENT_SCHEMA_SQL); }

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const iso = (v) => (v == null ? null : new Date(v).toISOString());
// One document per (content, uploader): the id is derived from both, so a repeat finds it.
const documentId = (sha256, userId) => `doc_${createHash('sha256').update(`${userId}\n${sha256}`).digest('hex').slice(0, 24)}`;

const fromRow = (r) => ({
  id: r.id, fileName: r.file_name, kind: r.kind, declaredKind: r.declared_kind, format: r.format, size: r.size,
  sha256: r.sha256, storageRef: r.storage_ref, status: r.status, fields: r.fields, flags: r.flags,
  uploadedBy: r.uploaded_by, uploadedAt: iso(r.uploaded_at),
  reviewedBy: r.reviewed_by, reviewedAt: iso(r.reviewed_at), reviewNote: r.review_note, version: r.version,
});

// The audit rationale for an extraction outcome: what was found, or every flag.
const outcomeRationale = (result) => (result.status === 'extracted'
  ? `Extracted ${Object.keys(result.fields).length} field(s) from a${result.kind === 'invoice' ? 'n' : ''} ${result.kind}; every required field present and every check passed.`
  : `Flagged for review: ${result.flags.map((f) => (f.field ? `${f.field} ${f.problem}` : f.problem)).join('; ')}`);

export function createDocumentService({ db, audit, blobs, readOptions = {} }) {
  const UNKNOWN = { type: 'system', id: 'unknown-requester' };

  function authorise(user, allowed, correlationId, what, subject = null) {
    if (!isNonEmpty(user?.id)) {
      const why = 'No user was given; documents are only handled for a known user.';
      audit.append({ correlationId, actor: UNKNOWN, action: 'document.denied', subject, rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    const actor = { type: 'person', id: user.id };
    if (!roleAllowed(user.role, allowed)) {
      const why = `Role "${user.role ?? 'none'}" may not ${what}; allowed roles: ${allowed.join(', ')}.`;
      audit.append({ correlationId, actor, action: 'document.denied', subject, rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    return actor;
  }

  // A change and its audit entries in one transaction; a failed commit after the
  // entries were written is followed by a correcting entry (the STORY-004 pattern).
  async function change(log, fn) {
    const logged = [];
    try {
      return await db.transaction((tx) => fn(tx, (action, fields) => { const e = log(action, fields); logged.push(e); return e; }));
    } catch (err) {
      if (logged.length) {
        log('document.change_failed', { rationale: `The change(s) logged as ${logged.map((e) => `#${e.seq} (${e.action})`).join(', ')} were NOT saved: ${err?.name ?? 'Error'}: ${err?.message ?? err}` });
      }
      throw err;
    }
  }

  const findOwn = async (sha256, userId) => {
    const { rows: [r] } = await db.query('SELECT * FROM documents WHERE sha256 = $1 AND uploaded_by = $2', [sha256, userId]);
    return r ? fromRow(r) : null;
  };

  async function uploadDocument({ user, fileName, bytes, kind } = {}) {
    const correlationId = `upload:${isNonEmpty(fileName) ? fileName : 'unnamed'}`;
    const actor = authorise(user, UPLOAD_ROLES, correlationId, 'upload documents');
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, ...fields });
    const about = { fileName: fileName ?? null, size: bytes?.length ?? null, declaredKind: kind ?? null };

    if (kind !== undefined && !KINDS.includes(kind)) {
      const why = `"${kind}" is not a document type this system extracts (${KINDS.join(', ')}); leave it out to have the type worked out.`;
      log('document.rejected', { rationale: why, detail: about });
      throw new DocumentRequestError(why);
    }

    // ---- 1. Read it. Some problems refuse the upload; others are stored and flagged. ----
    let read = null;
    let readProblem = null;
    try {
      read = await readDocument({ fileName, bytes, ...readOptions });
    } catch (err) {
      const refuse = err instanceof UnsupportedFormatError || (err instanceof DocumentReadError && REFUSED_READ_CODES.has(err.code));
      if (refuse) {
        log('document.rejected', { rationale: err.message, detail: about });
        throw err;
      }
      if (!(err instanceof DocumentReadError)) throw err;
      readProblem = err.message;
    }
    const sha256 = read?.sha256 ?? createHash('sha256').update(bytes).digest('hex');

    // ---- 2. Already uploaded by this person? Return it; process nothing twice. ----
    const existing = await findOwn(sha256, user.id);
    if (existing) {
      log('document.duplicate', { subject: existing.id, rationale: 'The same content was already uploaded by this user; returning that document.', detail: about });
      return existing;
    }

    // ---- 3. Store the file. If that fails, nothing is recorded as uploaded. ----
    let storageRef;
    try {
      storageRef = blobs.put(sha256, bytes);
    } catch (err) {
      log('document.upload_failed', { rationale: err.message, detail: { ...about, sha256 } });
      throw err instanceof DocumentUploadError ? err : new DocumentUploadError(`The file could not be stored: ${err.message}`, { cause: err });
    }

    // ---- 4. Extract, or flag what could not be read. ----
    const result = read
      ? extractFields(read, { kind })
      : { kind: kind ?? null, fields: {}, flags: [{ field: null, problem: readProblem }], status: 'flagged_for_review' };

    // ---- 5. Record it, with the upload and the outcome logged in the same transaction. ----
    const id = documentId(sha256, user.id);
    const saved = await change(log, async (tx, logChange) => {
      const { rows: [row] } = await tx.query(
        `INSERT INTO documents (id, sha256, uploaded_by, file_name, declared_kind, kind, format, size, storage_ref, status, fields, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
         ON CONFLICT (sha256, uploaded_by) DO NOTHING RETURNING *`,
        [id, sha256, user.id, fileName, kind ?? null, result.kind, read?.format ?? null, bytes.length, storageRef, result.status,
          JSON.stringify(result.fields), JSON.stringify(result.flags)],
      );
      if (!row) return null; // the same upload finished first in another request
      logChange('document.uploaded', { subject: id, detail: { ...about, sha256, format: read?.format ?? null, storageRef } });
      logChange(result.status === 'extracted' ? 'document.extracted' : 'document.flagged', {
        subject: id,
        rationale: outcomeRationale(result),
        detail: { kind: result.kind, fields: Object.keys(result.fields), flags: result.flags },
      });
      return fromRow(row);
    });
    return saved ?? findOwn(sha256, user.id);
  }

  // ---------------------------------------------------------------------------

  const canSeeAll = (user) => roleAllowed(user.role, REVIEWER_ROLES);

  async function getDocument({ user, documentId: id } = {}) {
    const actor = authorise(user, UPLOAD_ROLES, `document:${id ?? 'unknown'}`, 'view documents', id ?? null);
    const log = (action, fields = {}) => audit.append({ correlationId: `document:${id}`, actor, action, subject: id, ...fields });
    const { rows: [r] } = await db.query('SELECT * FROM documents WHERE id = $1', [id]);
    // "Not found" and "not yours" look the same to the caller, so ids cannot be probed.
    if (!r || (r.uploaded_by !== user.id && !canSeeAll(user))) {
      log('document.denied', { rationale: r ? `${user.id} did not upload this document and is not a reviewer.` : 'No such document.' });
      throw new DocumentNotFoundError(`No document ${id} that you may see.`);
    }
    log('document.viewed');
    return fromRow(r);
  }

  async function listDocuments({ user, status } = {}) {
    const actor = authorise(user, UPLOAD_ROLES, 'documents', 'view documents');
    if (status !== undefined && !DOCUMENT_STATUSES.includes(status)) throw new DocumentRequestError(`status must be one of: ${DOCUMENT_STATUSES.join(', ')}`);
    const all = canSeeAll(user);
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE ($1::boolean OR uploaded_by = $2) AND ($3::text IS NULL OR status = $3) ORDER BY uploaded_at, id`,
      [all, user.id, status ?? null],
    );
    audit.append({ correlationId: 'documents', actor, action: 'document.listed', detail: { scope: all ? 'all' : 'own', status: status ?? null, returned: rows.length } });
    return rows.map(fromRow);
  }

  // ---------------------------------------------------------------------------
  // Reviewing a flagged document (a compliance officer or financial analyst, never
  // on their own upload; a note is required — it is the decision's rationale).
  //   accept — with corrections; the corrected document must pass the SAME checks
  //            as extraction (dates, amounts, totals adding up, required fields),
  //            or the accept is refused with what is still wrong
  //   reject — the document is marked rejected
  // Only a flagged document can be reviewed; a review from an out-of-date view is
  // refused (expectedVersion); the same review again changes nothing.

  async function reviewDocument({ user, documentId: id, decision, corrections = {}, kind, note, expectedVersion } = {}) {
    const correlationId = `document:${id ?? 'unknown'}`;
    const actor = authorise(user, REVIEWER_ROLES, correlationId, 'review documents', id ?? null);
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, subject: id ?? null, ...fields });
    const refuse = (why, Err = DocumentRequestError) => {
      log('document.review_refused', { rationale: why, detail: { decision: decision ?? null } });
      return new Err(`Review refused: ${why}`);
    };

    if (decision !== 'accept' && decision !== 'reject') throw refuse('decision must be "accept" or "reject"');
    if (!isNonEmpty(note)) throw refuse(`a note is required: say why you ${decision} it (it is recorded as the decision rationale)`);
    if (!Number.isInteger(expectedVersion)) throw refuse('expectedVersion is required: the version of the document you reviewed');
    if (!corrections || typeof corrections !== 'object' || Array.isArray(corrections)) throw refuse('corrections must be an object of field: value');

    const outcome = await change(log, async (tx, logChange) => {
      const { rows: [row] } = await tx.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw refuse('no such document', DocumentNotFoundError);
      const doc = fromRow(row);
      if (doc.uploadedBy === user.id) throw refuse('a reviewer may not review their own upload');

      // The same review again: nothing to do.
      const earlier = doc.status === 'reviewed' ? 'accept' : doc.status === 'rejected' ? 'reject' : null;
      if (earlier && earlier === decision && doc.reviewedBy === user.id) {
        log('document.review_unchanged', { rationale: `Already ${decision}ed by ${user.id}; nothing changed.` });
        return doc;
      }
      if (doc.status !== 'flagged_for_review') throw refuse(`only a document flagged for review can be reviewed (this one is ${doc.status})`);
      if (doc.version !== expectedVersion) throw refuse(`the document changed since you reviewed it (you saw version ${expectedVersion}, it is now version ${doc.version}); look again`);

      const stamp = async (status, fields) => {
        const { rows: [updated] } = await tx.query(
          `UPDATE documents SET status = $2, fields = $3::jsonb, reviewed_by = $4, reviewed_at = now(), review_note = $5, version = version + 1
           WHERE id = $1 RETURNING *`,
          [id, status, JSON.stringify(fields), user.id, note.trim()],
        );
        return fromRow(updated);
      };

      if (decision === 'reject') {
        const after = await stamp('rejected', doc.fields);
        logChange('document.review_rejected', { rationale: note.trim(), detail: { flags: doc.flags } });
        return after;
      }

      // ---- Accept: apply the corrections, then run the extraction checks again. ----
      const finalKind = kind ?? doc.kind;
      if (!KINDS.includes(finalKind)) throw refuse(`say which kind of document this is (${KINDS.join(', ')}) to accept it`);
      const allowed = new Set([...REQUIRED_FIELDS[finalKind], ...OPTIONAL_FIELDS[finalKind]]);
      const unknown = Object.keys(corrections).filter((k) => !allowed.has(k));
      if (unknown.length) throw refuse(`unknown field(s) for ${finalKind === 'invoice' ? 'an' : 'a'} ${finalKind}: ${unknown.join(', ')}; allowed: ${[...allowed].join(', ')}`);

      const data = { ...asLabelled(doc.fields), ...corrections };
      if (data.term && typeof data.term === 'object') data.term = `${data.term.months} months`;
      const recheck = extractFields({ format: 'json', needsOcr: false, data }, { kind: finalKind });
      if (recheck.flags.length) {
        throw refuse(`the corrected document still has problems: ${recheck.flags.map((f) => (f.field ? `${f.field} ${f.problem}` : f.problem)).join('; ')}`);
      }
      // Keep where each value came from: the original source, or this review.
      const fields = Object.fromEntries(Object.entries(recheck.fields).map(([name, f]) => [name, {
        ...f, source: name in corrections ? `corrected by ${user.id} during review` : (doc.fields[name]?.source ?? f.source),
      }]));
      const after = await stamp('reviewed', fields);
      if (finalKind !== doc.kind) await tx.query('UPDATE documents SET kind = $2 WHERE id = $1', [id, finalKind]);
      logChange('document.review_accepted', {
        rationale: note.trim(),
        detail: {
          kind: finalKind,
          resolvedFlags: doc.flags,
          corrections: Object.fromEntries(Object.keys(corrections).map((k) => [k, { before: doc.fields[k]?.value ?? null, after: fields[k]?.value ?? null }])),
        },
      });
      return { ...after, kind: finalKind };
    });
    return outcome;
  }

  return { uploadDocument, getDocument, listDocuments, reviewDocument };
}

// Fields a reviewer may set, per kind: the required ones (from extract.js, so the
// two can never disagree) plus the optional ones. "end_or_term" is set through
// end_date or term.
const REQUIRED_FIELDS = Object.fromEntries(KINDS.map((k) => [k, REQUIRED[k].filter((n) => n !== 'end_or_term')]));
const OPTIONAL_FIELDS = { invoice: ['subtotal', 'tax', 'line_items'], contract: ['end_date', 'term'] };

// Extracted fields back into labelled values, so a corrected document can be
// checked by the same extraction rules (as if it had been uploaded as JSON).
function asLabelled(fields) {
  return Object.fromEntries(Object.entries(fields)
    .filter(([name]) => name !== 'end_or_term') // derived from end_date / term
    .map(([name, f]) => [name, f.value]));
}
