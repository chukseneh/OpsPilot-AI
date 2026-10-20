// Sessions and CSRF protection for the web API (extra to the plan: web access, step 2).
//
//   signIn({ username, password })        → { ok: true, token, csrfToken, account, expiresAt } | { ok: false }
//   authenticate({ token, csrfToken, changesSomething })
//                                         → { ok: true, user, sessionId } | { ok: false, reason }
//   signOut({ token })                    → { signedOut: true | false }   (safe to repeat)
//   purgeExpired()                        → { removed }
//
// Tokens:
//   - 32 random bytes each for the session and its CSRF token. Only their SHA-256
//     hashes are stored, so a copy of the database cannot be used to sign in.
//   - Never logged. The audit log names a session by a short id taken from the
//     hash, which cannot be turned back into the token.
// A session ends after 30 minutes without use, or 8 hours after sign-in at most.
// It also stops working as soon as its account changes (role, disabled, password
// reset or changed): every such change raises the account's version, and the
// session remembers the version it was started with.
// Every request that changes something must carry the session's CSRF token, in
// the X-CSRF-Token header; the cookie alone is not enough.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const IDLE_MS = 30 * 60 * 1000;
export const MAX_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'opspilot_session';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url

export const SESSIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash      text PRIMARY KEY,
  csrf_hash       text NOT NULL,
  username        text NOT NULL REFERENCES user_accounts (username) ON DELETE CASCADE,
  account_version integer NOT NULL,
  created_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_username ON user_sessions (username);
`;
export async function migrateSessions(db) { await db.exec(SESSIONS_SCHEMA_SQL); }

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const sessionIdOf = (tokenHash) => tokenHash.slice(0, 16);
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------------------------------------------------------------------------
// Cookies

export function sessionCookie(token, { secure }) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_MS / 1000}${secure ? '; Secure' : ''}`;
}
export function clearedSessionCookie({ secure }) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
export function tokenFromCookieHeader(header) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) return part.slice(at + 1).trim() || null;
  }
  return null;
}

// ---------------------------------------------------------------------------

export function createSessionService({ db, audit, accounts, now = () => new Date(), idleMs = IDLE_MS, maxMs = MAX_MS }) {
  const SESSIONS = { type: 'system', id: 'sessions' };
  const log = (actor, action, sessionId, fields) => audit.append({ correlationId: `session:${sessionId ?? 'none'}`, actor, action, subject: sessionId, ...fields });
  const person = (id) => ({ type: 'person', id });

  async function signIn({ username, password } = {}) {
    const result = await accounts.verifyCredentials({ username, password });
    if (!result.ok) return { ok: false };
    const { account } = result;
    const token = newToken();
    const csrfToken = newToken();
    const tokenHash = sha256(token);
    const t = now();
    const expiresAt = new Date(t.getTime() + maxMs).toISOString();
    // Logged first: if the log cannot be written, no session exists.
    const started = log(person(account.id), 'session.started', sessionIdOf(tokenHash), { detail: { role: account.role, expiresAt } });
    try {
      await db.query(
        'INSERT INTO user_sessions (token_hash, csrf_hash, username, account_version, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $5, $5, $6)',
        [tokenHash, sha256(csrfToken), account.id, account.version, t.toISOString(), expiresAt],
      );
    } catch (err) {
      log(person(account.id), 'session.start_failed', sessionIdOf(tokenHash), {
        rationale: `The session logged as #${started.seq} was NOT saved: ${err?.name ?? 'Error'}: ${err?.message ?? err}`,
      });
      throw err;
    }
    return { ok: true, token, csrfToken, account, expiresAt };
  }

  // The session's reason for ending, or null if it is still good.
  function whyEnded(row, account, t) {
    if (!account) return 'The account no longer exists.';
    if (account.status !== 'active') return 'The account is disabled.';
    if (account.version !== row.account_version) return 'The account changed since sign-in (role, status or password); please sign in again.';
    if (new Date(row.expires_at).getTime() <= t) return `The session reached its ${maxMs / 3600000}-hour limit.`;
    if (new Date(row.last_seen_at).getTime() + idleMs <= t) return `The session was unused for ${idleMs / 60000} minutes.`;
    return null;
  }

  async function authenticate({ token, csrfToken, changesSomething = false } = {}) {
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
      if (token != null) log(SESSIONS, 'session.rejected', null, { rationale: 'A session token of the wrong shape was presented.' });
      return { ok: false, reason: 'no_session' };
    }
    const tokenHash = sha256(token);
    const sessionId = sessionIdOf(tokenHash);
    const { rows: [row] } = await db.query('SELECT * FROM user_sessions WHERE token_hash = $1', [tokenHash]);
    if (!row) {
      log(SESSIONS, 'session.rejected', sessionId, { rationale: 'No such session (signed out, expired or never issued).' });
      return { ok: false, reason: 'no_session' };
    }
    const t = now().getTime();
    const account = await accounts.getAccount(row.username);
    const why = whyEnded(row, account, t);
    if (why) {
      log(person(row.username), 'session.expired', sessionId, { rationale: why });
      await db.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
      return { ok: false, reason: 'no_session' };
    }
    if (changesSomething) {
      const given = typeof csrfToken === 'string' && TOKEN_SHAPE.test(csrfToken) ? sha256(csrfToken) : null;
      if (!given || !sameHash(given, row.csrf_hash)) {
        log(person(row.username), 'session.csrf_rejected', sessionId, {
          rationale: given ? 'The X-CSRF-Token header does not match this session.' : 'A request that changes something came without an X-CSRF-Token header.',
        });
        return { ok: false, reason: 'csrf' };
      }
    }
    await db.query('UPDATE user_sessions SET last_seen_at = $2 WHERE token_hash = $1', [tokenHash, new Date(t).toISOString()]);
    return { ok: true, user: { id: account.id, role: account.role }, sessionId };
  }

  async function signOut({ token } = {}) {
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { signedOut: false };
    const tokenHash = sha256(token);
    const { rows: [row] } = await db.query('DELETE FROM user_sessions WHERE token_hash = $1 RETURNING username', [tokenHash]);
    if (!row) return { signedOut: false };
    log(person(row.username), 'session.ended', sessionIdOf(tokenHash), { rationale: 'Signed out.' });
    return { signedOut: true };
  }

  // Removes sessions past either limit. Changed accounts' sessions are removed
  // when next used; they cannot be used before that.
  async function purgeExpired() {
    const t = now().getTime();
    const { rows } = await db.query(
      'DELETE FROM user_sessions WHERE expires_at <= $1 OR last_seen_at <= $2 RETURNING token_hash, username',
      [new Date(t).toISOString(), new Date(t - idleMs).toISOString()],
    );
    for (const r of rows) log(person(r.username), 'session.expired', sessionIdOf(r.token_hash), { rationale: 'Removed by the periodic clean-up: past its idle or absolute limit.' });
    return { removed: rows.length };
  }

  return { signIn, authenticate, signOut, purgeExpired };
}
