// Reading the audit log (STORY-006): who may, what they get, and the record of it.
//
//   readAuditLog({ user, filter, page }) → { entries, nextAfter, integrity }
//
// Only a security officer or compliance officer may read the log (the student's
// choice). Anyone else — or a request with no user — is refused, and the refusal
// is itself logged (audit.read_denied, with the reason). Every successful read is
// logged too (audit.read: who, which filter, how many entries), so reading the
// log leaves a trace like any other action.
//
// Before returning anything, the log's integrity is checked: the keyed hash chain
// and, when anchors are configured, every anchor in PostgreSQL. A tampered log is
// still shown — an auditor needs to see it — but with integrity.ok false and the
// reason, and the finding is logged as audit.tampering_detected.
//
// Entries are returned page by page (at most MAX_PAGE_SIZE per call) and as
// copies, so a reader cannot change the log through what it was given.

import { readFileSync, existsSync } from 'node:fs';

import { roleAllowed } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';
import { verifyAuditFile } from './auditLog.js';

export { PermissionDeniedError };
export const AUDIT_READER_ROLES = Object.freeze(['security officer', 'compliance officer']);
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;

export class AuditReadRequestError extends Error {
  constructor(message, options) { super(message, options); this.name = 'AuditReadRequestError'; }
}

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const FILTER_FIELDS = ['correlationId', 'actorId', 'action', 'from', 'to'];

// Entries that cannot be parsed are left out of results; the integrity check reports them.
const readEntries = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  .split('\n').filter((l) => l.trim() !== '')
  .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

export function createAuditReader({ audit, file, key, anchors, roles = AUDIT_READER_ROLES }) {
  async function readAuditLog({ user, filter = {}, page = {} } = {}) {
    const correlationId = 'audit-read';

    // ---- 1. Who is asking, and may they? ----
    if (!isNonEmpty(user?.id)) {
      const why = 'No user was given; the audit log is only shown to a known reader.';
      audit.append({ correlationId, actor: { type: 'system', id: 'unknown-requester' }, action: 'audit.read_denied', rationale: why });
      throw new PermissionDeniedError(why);
    }
    const actor = { type: 'person', id: user.id };
    const log = (action, fields = {}) => audit.append({ correlationId, actor, action, ...fields });
    if (!roleAllowed(user.role, roles)) {
      const why = `Role "${user.role ?? 'none'}" may not read the audit log; allowed roles: ${roles.join(', ')}.`;
      log('audit.read_denied', { rationale: why, detail: { filter } });
      throw new PermissionDeniedError(why);
    }

    // ---- 2. Is the request well formed? ----
    const unknown = Object.keys(filter ?? {}).filter((k) => !FILTER_FIELDS.includes(k));
    const limit = page.limit ?? DEFAULT_PAGE_SIZE;
    const after = page.after ?? 0;
    const bad = unknown.length ? `unknown filter field(s): ${unknown.join(', ')}; allowed: ${FILTER_FIELDS.join(', ')}`
      : !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE ? `page.limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`
        : !Number.isInteger(after) || after < 0 ? 'page.after must be a whole number of 0 or more'
          : ['from', 'to'].find((k) => filter[k] !== undefined && Number.isNaN(Date.parse(filter[k])))
            ? 'from and to must be ISO 8601 timestamps' : null;
    if (bad) throw new AuditReadRequestError(`Audit log read refused: ${bad}`);

    // ---- 3. Check integrity first, so the reader knows whether to trust what follows. ----
    const check = anchors ? await anchors.verify() : verifyAuditFile({ file, key });
    const integrity = {
      ok: check.ok,
      keyed: Boolean(key),
      anchored: Boolean(anchors),
      ...(check.ok ? {} : { brokenAt: check.brokenAt, warning: `The audit log has been tampered with or damaged: ${check.reason}` }),
    };

    // ---- 4. Select, page, and copy. ----
    const from = filter.from ? Date.parse(filter.from) : -Infinity;
    const to = filter.to ? Date.parse(filter.to) : Infinity;
    const matching = readEntries(file).filter((e) => e.seq > after
      && (!filter.correlationId || e.correlationId === filter.correlationId)
      && (!filter.actorId || e.actor?.id === filter.actorId)
      && (!filter.action || e.action === filter.action || (filter.action.endsWith('.') && e.action?.startsWith(filter.action)))
      && Date.parse(e.at) >= from && Date.parse(e.at) <= to);
    const entries = structuredClone(matching.slice(0, limit));
    const nextAfter = matching.length > limit ? entries.at(-1).seq : null;

    // ---- 5. Record the read (and any tampering found) before returning anything. ----
    if (!check.ok) log('audit.tampering_detected', { rationale: integrity.warning, detail: { brokenAt: check.brokenAt } });
    log('audit.read', { detail: { filter, page: { after, limit }, returned: entries.length, integrityOk: check.ok } });

    return { entries, nextAfter, integrity };
  }

  return { readAuditLog };
}
