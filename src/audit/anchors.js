// Anchors for the audit log (STORY-006): catching entries removed from the END.
//
// The hash chain catches any entry edited or removed in the middle, but if the
// last entries are cut off, what remains is still a valid chain. So from time to
// time the log's current end — its last entry number and hash — is copied into
// PostgreSQL, a separate store from the log file. Later, if the file holds fewer
// entries than an anchor says it reached, or an anchored entry's hash differs,
// the log was cut or rewritten.
//
// Anchors are protected twice:
//   - each is signed with the audit log's key (HMAC), so someone who can write to
//     the database but does not have the key cannot forge one;
//   - the database refuses to change or delete them (a trigger rejects UPDATE,
//     DELETE and TRUNCATE on the table).
//
// Limit: entries written after the most recent anchor can still be removed
// without trace; anchoring more often shrinks that window. A database superuser
// can disable the trigger — the signatures still expose a forged anchor, but a
// deleted one is only caught if a later anchor remains.

import { readFileSync, existsSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { verifyAuditFile, MIN_KEY_LENGTH, GENESIS_HASH } from './auditLog.js';

export const ANCHOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_anchors (
  log_id      text NOT NULL CHECK (btrim(log_id) <> ''),
  seq         integer NOT NULL CHECK (seq >= 0),
  hash        text NOT NULL,
  signature   text NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (log_id, seq)
);
CREATE OR REPLACE FUNCTION audit_anchors_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_anchors is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER audit_anchors_no_change BEFORE UPDATE OR DELETE ON audit_anchors
  FOR EACH ROW EXECUTE FUNCTION audit_anchors_append_only();
CREATE OR REPLACE TRIGGER audit_anchors_no_truncate BEFORE TRUNCATE ON audit_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION audit_anchors_append_only();
`;

export async function migrateAnchors(db) {
  await db.exec(ANCHOR_SCHEMA_SQL);
}

const readEntries = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

const sign = (key, logId, seq, hash) => createHmac('sha256', key).update(`${logId}|${seq}|${hash}`).digest('hex');
const sameSignature = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const errorText = (err) => `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;

export function createAuditAnchors({ db, file, key, logId = 'main' }) {
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) {
    throw new Error(`Audit anchors need the audit log key (at least ${MIN_KEY_LENGTH} characters); without it an anchor could be forged.`);
  }

  // The full check: the chain itself, then every anchor against the file.
  //   { ok: true, count, anchors, lastAnchoredSeq, unanchored }
  //   { ok: false, reason, brokenAt? }
  async function verify() {
    const chain = verifyAuditFile({ file, key });
    if (!chain.ok) return { ok: false, brokenAt: chain.brokenAt, reason: `the chain is broken: ${chain.reason}` };

    const entries = readEntries(file);
    const { rows } = await db.query('SELECT seq, hash, signature FROM audit_anchors WHERE log_id = $1 ORDER BY seq', [logId]);
    for (const a of rows) {
      if (!sameSignature(a.signature, sign(key, logId, a.seq, a.hash))) {
        return { ok: false, brokenAt: a.seq, reason: `the anchor at #${a.seq} has an invalid signature (forged, or a different key)` };
      }
      if (a.seq > entries.length) {
        return { ok: false, brokenAt: entries.length + 1, reason: `entries after #${entries.length} were removed: an anchor shows the log had reached #${a.seq}` };
      }
      const actual = a.seq === 0 ? GENESIS_HASH : entries[a.seq - 1].hash;
      if (actual !== a.hash) {
        return { ok: false, brokenAt: a.seq, reason: `entry #${a.seq} does not match its anchor: the log was rewritten from there` };
      }
    }
    const lastAnchoredSeq = rows.length ? rows.at(-1).seq : null;
    return { ok: true, count: entries.length, anchors: rows.length, lastAnchoredSeq, unanchored: entries.length - (lastAnchoredSeq ?? 0) };
  }

  // Records the log's current end. Checks everything first: anchoring a log that
  // was already tampered with would vouch for the tampering. Nothing new since the
  // last anchor → nothing written.
  //   { anchored: true, seq } | { anchored: false, seq, reason }
  async function anchor() {
    const check = await verify();
    if (!check.ok) return { anchored: false, seq: null, reason: check.reason, tampered: true };
    if (check.lastAnchoredSeq === check.count) return { anchored: false, seq: check.count, reason: 'nothing new since the last anchor' };

    const entries = readEntries(file);
    const seq = entries.length;
    const hash = seq === 0 ? GENESIS_HASH : entries[seq - 1].hash;
    // ON CONFLICT DO NOTHING: two anchorers racing to the same entry both succeed, once.
    await db.query('INSERT INTO audit_anchors (log_id, seq, hash, signature) VALUES ($1, $2, $3, $4) ON CONFLICT (log_id, seq) DO NOTHING',
      [logId, seq, hash, sign(key, logId, seq, hash)]);
    return { anchored: true, seq };
  }

  // Anchors every `everyMs` (default 5 minutes). Never two at once. A failure —
  // including tampering found while checking — goes to onError and, when the log
  // can still be written, into the log itself; the timer carries on either way.
  function startTimer({
    everyMs = 5 * 60 * 1000, audit, timers = { setInterval, clearInterval },
    onError = (msg) => { console.error(`audit anchors: ${msg}`); },
  } = {}) {
    let running = null;
    let stopped = false;
    const stats = { anchored: 0, unchanged: 0, failed: 0 };
    const report = (action, rationale) => {
      onError(rationale);
      try {
        audit?.append({ correlationId: `audit-anchors:${logId}`, actor: { type: 'agent', id: 'audit-agent' }, action, rationale });
      } catch (err) {
        onError(`could not record ${action} in the audit log: ${errorText(err)}`);
      }
    };

    function tick() {
      if (stopped) return Promise.resolve(null);
      if (running) return running;
      running = (async () => {
        try {
          const r = await anchor();
          if (r.anchored) stats.anchored += 1;
          else if (r.tampered) { stats.failed += 1; report('audit.tampering_detected', `Anchoring refused: ${r.reason}`); } else stats.unchanged += 1;
          return r;
        } catch (err) {
          stats.failed += 1;
          report('audit.anchor_failed', `Could not anchor the audit log; will try again in ${Math.round(everyMs / 1000)} s: ${errorText(err)}`);
          return null;
        } finally {
          running = null;
        }
      })();
      return running;
    }

    const handle = timers.setInterval(tick, everyMs);
    handle?.unref?.();
    return { tick, stats, async stop() { stopped = true; timers.clearInterval(handle); await running; } };
  }

  return { anchor, verify, startTimer };
}
