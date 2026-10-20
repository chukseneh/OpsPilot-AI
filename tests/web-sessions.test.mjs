// Web access, step 2: sessions and CSRF protection. Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAccountService, migrateAccounts } from '../src/web/accounts.js';
import {
  createSessionService, migrateSessions, sessionCookie, clearedSessionCookie, tokenFromCookieHeader,
  IDLE_MS, MAX_MS, SESSION_COOKIE,
} from '../src/web/sessions.js';
import { openPGlite } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const ADMIN = { id: 'sec.admin', role: 'security officer' };
const ADMIN_PW = 'correct-horse-battery-staple';
const ALICE_PW = 'tangerine-orbit-91-lantern';
const MINUTE = 60 * 1000;

let pg;
before(async () => { pg = await openPGlite(); await migrateAccounts(pg); await migrateSessions(pg); });
after(async () => { await pg.close(); });

async function setup({ db } = {}) {
  await pg.exec('TRUNCATE user_accounts CASCADE');
  const file = join(mkdtempSync(join(tmpdir(), 'sess-')), 'audit.jsonl');
  const audit = createAuditLog({ file });
  let clock = Date.parse('2026-10-20T09:00:00Z');
  const now = () => new Date(clock);
  const advance = (ms) => { clock += ms; };
  const accounts = createAccountService({ db: pg, audit, now });
  const sessions = createSessionService({ db: db ?? pg, audit, accounts, now });
  await accounts.bootstrapFirstAdmin({ username: ADMIN.id, password: ADMIN_PW, displayName: 'Security Admin' });
  await accounts.createAccount({ user: ADMIN, username: 'alice', displayName: 'Alice', role: 'process analyst', password: ALICE_PW, reason: 'New analyst' });
  const entries = () => audit.readAll();
  const actions = () => entries().map((e) => e.action);
  const aliceIn = async () => sessions.signIn({ username: 'alice', password: ALICE_PW });
  return { accounts, sessions, audit, file, entries, actions, advance, aliceIn };
}
const count = async () => (await pg.query('SELECT count(*)::int AS n FROM user_sessions')).rows[0].n;

// ---- Signing in ----

test('signing in issues a random session token and CSRF token; only their hashes are stored', async () => {
  const { aliceIn, sessions, entries } = await setup();
  const a = await aliceIn();
  const b = await aliceIn();
  assert.equal(a.ok, true);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.token, a.csrfToken);
  assert.equal(a.expiresAt, '2026-10-20T17:00:00.000Z', '8 hours after sign-in');
  assert.equal(a.account.role, 'process analyst');

  const { rows } = await pg.query('SELECT * FROM user_sessions');
  assert.equal(rows.length, 2);
  const stored = JSON.stringify(rows);
  for (const t of [a.token, a.csrfToken, b.token, b.csrfToken]) assert.ok(!stored.includes(t), 'no token stored as given');
  assert.ok(rows.some((r) => r.token_hash === createHash('sha256').update(a.token).digest('hex')));

  const who = await sessions.authenticate({ token: a.token });
  assert.deepEqual({ ok: who.ok, user: who.user }, { ok: true, user: { id: 'alice', role: 'process analyst' } });
  const started = entries().filter((e) => e.action === 'session.started');
  assert.equal(started.length, 2);
  assert.deepEqual(started[0].actor, { type: 'person', id: 'alice' });
  assert.equal(started[0].subject, who.sessionId);
});

test('a wrong password creates no session and gives the same answer as an unknown user', async () => {
  const { sessions } = await setup();
  const wrong = await sessions.signIn({ username: 'alice', password: 'not-the-password-123' });
  const unknown = await sessions.signIn({ username: 'nobody', password: 'not-the-password-123' });
  assert.deepEqual(wrong, { ok: false });
  assert.deepEqual(unknown, wrong);
  assert.equal(await count(), 0);
});

// ---- CSRF ----

test('a request that changes something needs the session\'s own CSRF token', async () => {
  const { aliceIn, sessions, entries } = await setup();
  const a = await aliceIn();
  const b = await aliceIn();

  assert.deepEqual(await sessions.authenticate({ token: a.token, changesSomething: true }), { ok: false, reason: 'csrf' });
  assert.match(entries().at(-1).rationale, /without an X-CSRF-Token header/);
  assert.deepEqual(await sessions.authenticate({ token: a.token, csrfToken: b.csrfToken, changesSomething: true }), { ok: false, reason: 'csrf' }, 'another session\'s token');
  assert.match(entries().at(-1).rationale, /does not match this session/);
  assert.deepEqual(await sessions.authenticate({ token: a.token, csrfToken: 'garbage', changesSomething: true }), { ok: false, reason: 'csrf' });
  assert.deepEqual(await sessions.authenticate({ token: a.token, csrfToken: a.token, changesSomething: true }), { ok: false, reason: 'csrf' }, 'the session token is not the CSRF token');

  assert.equal((await sessions.authenticate({ token: a.token, csrfToken: a.csrfToken, changesSomething: true })).ok, true);
  assert.equal((await sessions.authenticate({ token: a.token })).ok, true, 'reading needs no CSRF token');
  assert.equal(entries().filter((e) => e.action === 'session.csrf_rejected').length, 4);
});

test('a CSRF failure does not end the session', async () => {
  const { aliceIn, sessions } = await setup();
  const a = await aliceIn();
  await sessions.authenticate({ token: a.token, changesSomething: true });
  assert.equal((await sessions.authenticate({ token: a.token })).ok, true);
});

// ---- Expiry ----

test(`a session ends after ${IDLE_MS / MINUTE} minutes unused; each use restarts that clock`, async () => {
  const { aliceIn, sessions, advance, entries } = await setup();
  const a = await aliceIn();
  advance(IDLE_MS - 1000);
  assert.equal((await sessions.authenticate({ token: a.token })).ok, true, 'just inside');
  advance(IDLE_MS - 1000);
  assert.equal((await sessions.authenticate({ token: a.token })).ok, true, 'the last use restarted the clock');
  advance(IDLE_MS);
  assert.deepEqual(await sessions.authenticate({ token: a.token }), { ok: false, reason: 'no_session' });
  const expired = entries().find((e) => e.action === 'session.expired');
  assert.match(expired.rationale, /unused for 30 minutes/);
  assert.equal(await count(), 0, 'the ended session is removed');
  assert.deepEqual(await sessions.authenticate({ token: a.token }), { ok: false, reason: 'no_session' });
});

test(`a session ends ${MAX_MS / 3600000} hours after sign-in even if used all along`, async () => {
  const { aliceIn, sessions, advance, entries } = await setup();
  const a = await aliceIn();
  for (let used = 0; used < MAX_MS - 20 * MINUTE; used += 20 * MINUTE) {
    advance(20 * MINUTE);
    assert.equal((await sessions.authenticate({ token: a.token })).ok, true);
  }
  advance(20 * MINUTE);
  assert.deepEqual(await sessions.authenticate({ token: a.token }), { ok: false, reason: 'no_session' });
  assert.match(entries().find((e) => e.action === 'session.expired').rationale, /8-hour limit/);
});

test('the periodic clean-up removes only expired sessions, and logs each', async () => {
  const { aliceIn, sessions, advance, actions } = await setup();
  const old = await aliceIn();
  advance(IDLE_MS + MINUTE);
  const fresh = await aliceIn();
  assert.deepEqual(await sessions.purgeExpired(), { removed: 1 });
  assert.equal(actions().filter((a) => a === 'session.expired').length, 1);
  assert.equal((await sessions.authenticate({ token: fresh.token })).ok, true);
  assert.equal((await sessions.authenticate({ token: old.token })).ok, false);
  assert.deepEqual(await sessions.purgeExpired(), { removed: 0 }, 'safe to repeat');
});

// ---- Account changes end sessions ----

for (const [what, changeIt, rationale] of [
  ['a role change', (accounts) => accounts.changeRole({ user: ADMIN, username: 'alice', role: 'data analyst', reason: 'Moved team' }), /account changed/],
  ['disabling the account', (accounts) => accounts.disableAccount({ user: ADMIN, username: 'alice', reason: 'Left' }), /disabled/],
  ['a password reset', (accounts) => accounts.resetPassword({ user: ADMIN, username: 'alice', newPassword: 'fresh-meadow-copper-43', reason: 'Suspected leak' }), /account changed/],
  ['changing one\'s own password', (accounts) => accounts.changeOwnPassword({ user: { id: 'alice', role: 'process analyst' }, currentPassword: ALICE_PW, newPassword: 'quiet-harbour-violet-08' }), /account changed/],
]) {
  test(`${what} ends the account's existing sessions at once`, async () => {
    const { aliceIn, sessions, accounts, entries } = await setup();
    const a = await aliceIn();
    const b = await aliceIn();
    await changeIt(accounts);
    for (const s of [a, b]) assert.deepEqual(await sessions.authenticate({ token: s.token }), { ok: false, reason: 'no_session' });
    assert.match(entries().filter((e) => e.action === 'session.expired').at(-1).rationale, rationale);
  });
}

test('after a role change, signing in again gives the new role; other accounts\' sessions are untouched', async () => {
  const { aliceIn, sessions, accounts } = await setup();
  const admin = await sessions.signIn({ username: ADMIN.id, password: ADMIN_PW });
  await aliceIn();
  await accounts.changeRole({ user: ADMIN, username: 'alice', role: 'data analyst', reason: 'Moved team' });
  const again = await aliceIn();
  assert.deepEqual((await sessions.authenticate({ token: again.token })).user, { id: 'alice', role: 'data analyst' });
  assert.equal((await sessions.authenticate({ token: admin.token })).ok, true);
});

// ---- Signing out ----

test('signing out ends the session; doing it twice is harmless and logged once', async () => {
  const { aliceIn, sessions, actions } = await setup();
  const a = await aliceIn();
  const b = await aliceIn();
  assert.deepEqual(await sessions.signOut({ token: a.token }), { signedOut: true });
  assert.deepEqual(await sessions.signOut({ token: a.token }), { signedOut: false });
  assert.deepEqual(await sessions.signOut({ token: 'nonsense' }), { signedOut: false });
  assert.deepEqual(await sessions.signOut({}), { signedOut: false });
  assert.deepEqual(await sessions.authenticate({ token: a.token }), { ok: false, reason: 'no_session' });
  assert.equal((await sessions.authenticate({ token: b.token })).ok, true, 'only that session ends');
  assert.equal(actions().filter((x) => x === 'session.ended').length, 1);
});

// ---- Bad tokens ----

test('missing, malformed and unknown tokens are refused; presented ones are logged', async () => {
  const { sessions, entries } = await setup();
  const before = entries().length;
  assert.deepEqual(await sessions.authenticate({}), { ok: false, reason: 'no_session' });
  assert.equal(entries().length, before, 'no token at all is not worth an entry');
  assert.deepEqual(await sessions.authenticate({ token: 'abc' }), { ok: false, reason: 'no_session' });
  assert.deepEqual(await sessions.authenticate({ token: "x' OR '1'='1" }), { ok: false, reason: 'no_session' });
  assert.deepEqual(await sessions.authenticate({ token: 'A'.repeat(43) }), { ok: false, reason: 'no_session' });
  const rejected = entries().filter((e) => e.action === 'session.rejected');
  assert.equal(rejected.length, 3);
  assert.match(rejected[2].rationale, /No such session/);
});

// ---- Audit ----

test('no session token, CSRF token or full token hash ever reaches the audit log', async () => {
  const { aliceIn, sessions, advance, file } = await setup();
  const a = await aliceIn();
  const b = await aliceIn();
  await sessions.authenticate({ token: a.token, csrfToken: b.csrfToken, changesSomething: true });
  await sessions.authenticate({ token: a.token, csrfToken: a.csrfToken, changesSomething: true });
  await sessions.signOut({ token: a.token });
  await sessions.authenticate({ token: a.token });
  advance(MAX_MS);
  await sessions.authenticate({ token: b.token });
  const raw = readFileSync(file, 'utf8');
  for (const s of [a, b]) {
    for (const t of [s.token, s.csrfToken]) {
      assert.ok(!raw.includes(t), 'no token');
      assert.ok(!raw.includes(createHash('sha256').update(t).digest('hex')), 'no full hash');
    }
  }
  assert.ok(raw.includes('session.started') && raw.includes('session.ended') && raw.includes('session.expired'));
});

test('if the session cannot be saved, sign-in fails and a correcting entry follows', async () => {
  const failing = {
    query: (sql, params) => (sql.startsWith('INSERT INTO user_sessions') ? Promise.reject(new Error('disk full')) : pg.query(sql, params)),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction(fn),
  };
  const { sessions, actions, entries } = await setup({ db: failing });
  await assert.rejects(sessions.signIn({ username: 'alice', password: ALICE_PW }), /disk full/);
  assert.equal(await count(), 0);
  assert.deepEqual(actions().slice(-2), ['session.started', 'session.start_failed']);
  assert.match(entries().at(-1).rationale, /was NOT saved: Error: disk full/);
});

// ---- Cookies ----

test('the session cookie is HttpOnly and SameSite=Strict, and Secure over HTTPS', () => {
  const plain = sessionCookie('tok', { secure: false });
  assert.equal(plain, `${SESSION_COOKIE}=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
  assert.ok(sessionCookie('tok', { secure: true }).endsWith('; Secure'));
  assert.match(clearedSessionCookie({ secure: false }), /^opspilot_session=; .*Max-Age=0$/);
});

test('the session token is read from a Cookie header among other cookies', () => {
  assert.equal(tokenFromCookieHeader(`theme=dark; ${SESSION_COOKIE}=abc123; lang=en`), 'abc123');
  assert.equal(tokenFromCookieHeader(`${SESSION_COOKIE}=xyz`), 'xyz');
  assert.equal(tokenFromCookieHeader(`x${SESSION_COOKIE}=nope; theme=dark`), null, 'only the exact name');
  assert.equal(tokenFromCookieHeader(`${SESSION_COOKIE}=`), null);
  assert.equal(tokenFromCookieHeader(undefined), null);
  assert.equal(tokenFromCookieHeader(''), null);
});
