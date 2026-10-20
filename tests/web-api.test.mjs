// Web access, step 3: the API core and /api/v1/auth/* and /api/v1/accounts/*,
// tested over real HTTP. Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAccountService, migrateAccounts, AccountError } from '../src/web/accounts.js';
import { createSessionService, migrateSessions, SESSION_COOKIE } from '../src/web/sessions.js';
import { createApiServer, createRateLimiter, MAX_BODY_BYTES } from '../src/web/server.js';
import { authRoutes } from '../src/web/authRoutes.js';
import { statusFor, ApiRequestError } from '../src/web/errors.js';
import { PermissionDeniedError } from '../src/analysis/service.js';
import { InventoryConflictError, SystemNotFoundError, InventoryRequestError } from '../src/inventory/service.js';
import { openPGlite, DatabaseUnavailableError } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const ADMIN_PW = 'correct-horse-battery-staple';
const ALICE_PW = 'tangerine-orbit-91-lantern';

let pg;
before(async () => { pg = await openPGlite(); await migrateAccounts(pg); await migrateSessions(pg); });
after(async () => { await pg.close(); });

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Routes used only to exercise the server's failure handling.
const testRoutes = [
  { method: 'GET', path: '/api/v1/test/crash', auth: 'public', handle: async () => { throw new Error('boom at /srv/opspilot/internal.js line 12'); } },
  { method: 'GET', path: '/api/v1/test/db-down', auth: 'public', handle: async () => { throw new DatabaseUnavailableError('connect ECONNREFUSED 10.0.0.5:5432'); } },
  { method: 'GET', path: '/api/v1/test/slow', auth: 'public', handle: async () => { await sleep(300); return { body: { late: true } }; } },
  { method: 'GET', path: '/api/v1/test/echo/:name', auth: 'public', handle: async ({ params }) => ({ body: params }) },
];

async function setup({ auditOverride, signInLimit, handlerTimeoutMs } = {}) {
  await pg.exec('TRUNCATE user_accounts CASCADE');
  const file = join(mkdtempSync(join(tmpdir(), 'api-')), 'audit.jsonl');
  const realAudit = createAuditLog({ file });
  const audit = auditOverride ? auditOverride(realAudit) : realAudit;
  let clock = Date.parse('2026-10-20T09:00:00Z');
  const now = () => new Date(clock);
  const accounts = createAccountService({ db: pg, audit: realAudit, now });
  const sessions = createSessionService({ db: pg, audit: realAudit, accounts, now });
  await accounts.bootstrapFirstAdmin({ username: 'sec.admin', password: ADMIN_PW, displayName: 'Security Admin' });
  const api = createApiServer({
    audit, sessions, routes: [...authRoutes({ accounts, sessions }), ...testRoutes],
    now: () => clock, ...(signInLimit && { signInLimit }), ...(handlerTimeoutMs && { handlerTimeoutMs }),
  });
  const { url } = await api.listen();
  const call = async (method, path, { body, cookie, csrf, headers = {}, raw } = {}) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...headers,
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
  };
  const signIn = async (username, password) => {
    const r = await call('POST', '/api/v1/auth/sign-in', { body: { username, password } });
    assert.equal(r.status, 200, r.text);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return { cookie, csrf: r.json.csrfToken, res: r };
  };
  const admin = () => signIn('sec.admin', ADMIN_PW);
  const addAlice = async (a) => call('POST', '/api/v1/accounts', {
    ...a, body: { username: 'alice', displayName: 'Alice', role: 'process analyst', password: ALICE_PW, reason: 'New analyst' },
  });
  const entries = () => realAudit.readAll();
  return { api, url, call, signIn, admin, addAlice, entries, file, advance: (ms) => { clock += ms; } };
}

const withServer = (name, opts, fn) => test(name, async () => {
  const ctx = await setup(opts);
  try { await fn(ctx); } finally { await ctx.api.close(); }
});

// ---- Signing in and out ----

withServer('signing in sets an HttpOnly, SameSite=Strict cookie and returns the CSRF token', {}, async ({ call, admin }) => {
  const { cookie, csrf, res } = await admin();
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800$`));
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(res.json.user, { id: 'sec.admin', displayName: 'Security Admin', role: 'security officer' });
  assert.ok(!('token' in res.json), 'the session token is only in the cookie');
  const me = await call('GET', '/api/v1/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.user, { id: 'sec.admin', displayName: 'Security Admin', role: 'security officer' });
});

withServer('a wrong password and an unknown user both get the same 401, and no cookie', {}, async ({ call }) => {
  const wrong = await call('POST', '/api/v1/auth/sign-in', { body: { username: 'sec.admin', password: 'wrong-password-123' } });
  const unknown = await call('POST', '/api/v1/auth/sign-in', { body: { username: 'nobody', password: 'wrong-password-123' } });
  for (const r of [wrong, unknown]) {
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Wrong username or password.');
    assert.equal(r.headers.get('set-cookie'), null);
  }
});

withServer('signing out clears the cookie and ends the session', {}, async ({ call, admin }) => {
  const { cookie, csrf } = await admin();
  const out = await call('POST', '/api/v1/auth/sign-out', { cookie, csrf, body: {} });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { signedOut: true });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie })).status, 401);
});

withServer('changing your own password ends the session; the new password works', {}, async ({ call, admin, signIn }) => {
  const { cookie, csrf } = await admin();
  const NEW_PW = 'quiet-harbour-violet-08';
  const wrong = await call('POST', '/api/v1/auth/password', { cookie, csrf, body: { currentPassword: 'not-it-at-all-1', newPassword: NEW_PW } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /current password is wrong/);
  const ok = await call('POST', '/api/v1/auth/password', { cookie, csrf, body: { currentPassword: ADMIN_PW, newPassword: NEW_PW } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie })).status, 401);
  await signIn('sec.admin', NEW_PW);
});

// ---- Sessions and CSRF over HTTP ----

withServer('without a session, a protected endpoint answers 401 and the refusal is logged', {}, async ({ call, entries }) => {
  const r = await call('GET', '/api/v1/auth/me');
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'Please sign in.');
  assert.match(r.json.requestId, /^[0-9a-f-]{36}$/);
  const refused = entries().at(-1);
  assert.deepEqual({ action: refused.action, subject: refused.subject, status: refused.detail.status }, { action: 'api.refused', subject: 'GET /api/v1/auth/me', status: 401 });
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: `${SESSION_COOKIE}=forged-value` })).status, 401);
});

withServer('a request that changes something needs the CSRF header; the cookie alone gets 403', {}, async ({ admin, addAlice }) => {
  const a = await admin();
  const noHeader = await addAlice({ cookie: a.cookie });
  assert.equal(noHeader.status, 403);
  assert.match(noHeader.json.error, /X-CSRF-Token/);
  assert.equal((await addAlice({ cookie: a.cookie, csrf: 'A'.repeat(43) })).status, 403);
  const ok = await addAlice({ cookie: a.cookie, csrf: a.csrf });
  assert.equal(ok.status, 201);
});

withServer('an HTML form post is refused (415), even with a valid session', {}, async ({ call, admin }) => {
  const { cookie, csrf } = await admin();
  const r = await call('POST', '/api/v1/accounts', {
    cookie, csrf, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: 'username=bob&role=security+officer',
  });
  assert.equal(r.status, 415);
});

withServer('the identity comes from the session, never from the request body', {}, async ({ call, admin, addAlice, signIn }) => {
  const a = await admin();
  await addAlice({ cookie: a.cookie, csrf: a.csrf });
  const alice = await signIn('alice', ALICE_PW);
  const r = await call('POST', '/api/v1/accounts', {
    cookie: alice.cookie, csrf: alice.csrf,
    body: { user: { id: 'sec.admin', role: 'security officer' }, username: 'bob', displayName: 'Bob', role: 'security officer', password: 'silver-kettle-river-12', reason: 'x' },
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Role "process analyst" may not create accounts/);
});

// ---- Account management ----

withServer('a security officer manages accounts over the API; the changes take effect at once', {}, async ({ call, admin, addAlice, signIn }) => {
  const a = await admin();
  const created = await addAlice({ cookie: a.cookie, csrf: a.csrf });
  assert.equal(created.status, 201);
  assert.deepEqual({ id: created.json.account.id, role: created.json.account.role }, { id: 'alice', role: 'process analyst' });
  assert.ok(!created.text.includes('scrypt'), 'no hash in any reply');

  assert.equal((await addAlice({ cookie: a.cookie, csrf: a.csrf })).status, 409, 'the name is taken');
  const list = await call('GET', '/api/v1/accounts', { cookie: a.cookie });
  assert.deepEqual(list.json.accounts.map((x) => x.id), ['alice', 'sec.admin']);
  assert.equal((await call('GET', '/api/v1/accounts/alice', { cookie: a.cookie })).json.account.displayName, 'Alice');
  assert.equal((await call('GET', '/api/v1/accounts/ghost', { cookie: a.cookie })).status, 404);

  const alice = await signIn('alice', ALICE_PW);
  const promoted = await call('POST', '/api/v1/accounts/alice/role', { cookie: a.cookie, csrf: a.csrf, body: { role: 'data analyst', reason: 'Moved team' } });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.json.account.role, 'data analyst');
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: alice.cookie })).status, 401, 'her old session ended with the role change');

  assert.equal((await call('POST', '/api/v1/accounts/alice/disable', { cookie: a.cookie, csrf: a.csrf, body: { reason: 'Left' } })).json.account.status, 'disabled');
  assert.equal((await call('POST', '/api/v1/auth/sign-in', { body: { username: 'alice', password: ALICE_PW } })).status, 401);
  assert.equal((await call('POST', '/api/v1/accounts/alice/enable', { cookie: a.cookie, csrf: a.csrf, body: { reason: 'Back' } })).json.account.status, 'active');
  const reset = await call('POST', '/api/v1/accounts/alice/password-reset', { cookie: a.cookie, csrf: a.csrf, body: { newPassword: 'fresh-meadow-copper-43', reason: 'Forgot' } });
  assert.equal(reset.status, 200);
  await signIn('alice', 'fresh-meadow-copper-43');
});

withServer('service refusals come back as 400, 403 and 404 with the service\'s reason', {}, async ({ call, admin, addAlice, signIn }) => {
  const a = await admin();
  await addAlice({ cookie: a.cookie, csrf: a.csrf });
  const noReason = await call('POST', '/api/v1/accounts/alice/role', { cookie: a.cookie, csrf: a.csrf, body: { role: 'data analyst' } });
  assert.deepEqual([noReason.status, noReason.json.error], [400, 'a reason is required; it is recorded as the decision rationale']);
  const self = await call('POST', '/api/v1/accounts/sec.admin/disable', { cookie: a.cookie, csrf: a.csrf, body: { reason: 'x' } });
  assert.equal(self.status, 400);
  assert.match(self.json.error, /own account/);
  assert.equal((await call('POST', '/api/v1/accounts/ghost/disable', { cookie: a.cookie, csrf: a.csrf, body: { reason: 'x' } })).status, 404);
  const alice = await signIn('alice', ALICE_PW);
  const denied = await call('GET', '/api/v1/accounts', { cookie: alice.cookie });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /allowed roles: security officer/);
});

// ---- The API core ----

withServer('unknown addresses get 404; the wrong method gets 405 with Allow', {}, async ({ call }) => {
  assert.equal((await call('GET', '/api/v1/nothing-here')).status, 404);
  assert.equal((await call('GET', '/')).status, 404);
  const wrong = await call('DELETE', '/api/v1/auth/me');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET');
  assert.equal((await call('GET', '/api/v1/test/echo/%E0%A4%A')).status, 400, 'a malformed escape');
  assert.deepEqual((await call('GET', '/api/v1/test/echo/a%20b')).json, { name: 'a b' });
});

withServer('bad JSON is refused without echoing the body; so is a non-object', {}, async ({ call, entries, file }) => {
  const bad = await call('POST', '/api/v1/auth/sign-in', { raw: '{"username":"sec.admin","password":"leaky-secret-phrase-1"' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'The request body is not valid JSON.');
  assert.ok(!bad.text.includes('leaky-secret-phrase-1'));
  assert.ok(!readFileSync(file, 'utf8').includes('leaky-secret-phrase-1'));
  assert.equal((await call('POST', '/api/v1/auth/sign-in', { raw: '["a"]' })).status, 400);
  assert.equal((await call('POST', '/api/v1/auth/sign-in', { raw: 'null' })).status, 400);
  assert.equal(entries().at(-1).action, 'api.refused');
});

withServer('a body over 1 MB is refused with 413', {}, async ({ call }) => {
  const r = await call('POST', '/api/v1/auth/sign-in', { raw: JSON.stringify({ username: 'x', password: 'y'.repeat(MAX_BODY_BYTES) }) });
  assert.equal(r.status, 413);
});

withServer('every reply carries the security headers, errors included', {}, async ({ call, admin }) => {
  const { cookie } = await admin();
  for (const r of [await call('GET', '/api/v1/auth/me', { cookie }), await call('GET', '/api/v1/auth/me'), await call('GET', '/nope')]) {
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  }
});

withServer('a server failure gives a 500 with a reference id; the details go only to the audit log', {}, async ({ call, entries }) => {
  const r = await call('GET', '/api/v1/test/crash');
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'Something went wrong. The problem has been recorded.');
  assert.ok(!r.text.includes('/srv/opspilot') && !r.text.includes('boom'));
  const logged = entries().at(-1);
  assert.equal(logged.action, 'api.error');
  assert.match(logged.rationale, /boom at \/srv\/opspilot/);
  assert.equal(logged.correlationId, `api-${r.json.requestId}`, 'the reference id finds the entry');

  const down = await call('GET', '/api/v1/test/db-down');
  assert.equal(down.status, 503);
  assert.ok(!down.text.includes('10.0.0.5'));
  assert.match(entries().at(-1).rationale, /ECONNREFUSED 10\.0\.0\.5/);
});

withServer('a handler that takes too long gets a 504 that warns the work may still finish', { handlerTimeoutMs: 50 }, async ({ call, entries }) => {
  const r = await call('GET', '/api/v1/test/slow');
  assert.equal(r.status, 504);
  assert.match(r.json.error, /may still complete/);
  assert.equal(entries().at(-1).action, 'api.error');
});

withServer('if the success entry cannot be written, the reply is a 500 and the session is not handed out', {
  auditOverride: (real) => ({ append: (e) => { if (e.action === 'api.request') throw new Error('disk full'); return real.append(e); } }),
}, async ({ call, entries }) => {
  const r = await call('POST', '/api/v1/auth/sign-in', { body: { username: 'sec.admin', password: ADMIN_PW } });
  assert.equal(r.status, 500);
  assert.equal(r.headers.get('set-cookie'), null, 'no session handed out');
  assert.ok(!('csrfToken' in r.json));
  assert.deepEqual([entries().at(-1).action, entries().at(-1).rationale], ['api.error', 'Error: disk full']);
});

withServer('if the audit log cannot be written at all, the reply is a bare 500', {
  auditOverride: (real) => ({ append: (e) => { if (e.action.startsWith('api.')) throw new Error('disk full'); return real.append(e); } }),
}, async ({ call }) => {
  for (const r of [await call('POST', '/api/v1/auth/sign-in', { body: { username: 'sec.admin', password: ADMIN_PW } }), await call('GET', '/missing')]) {
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'The request could not be completed or recorded.' });
    assert.equal(r.headers.get('set-cookie'), null);
  }
});

withServer('every request leaves exactly one api.* entry', {}, async ({ call, admin, entries }) => {
  const before = entries().filter((e) => e.action.startsWith('api.')).length;
  const a = await admin();
  await call('GET', '/api/v1/auth/me', { cookie: a.cookie });
  await call('GET', '/api/v1/auth/me');
  await call('GET', '/missing');
  await call('GET', '/api/v1/test/crash');
  const apiEntries = entries().filter((e) => e.action.startsWith('api.')).slice(before);
  assert.deepEqual(apiEntries.map((e) => [e.action, e.subject]), [
    ['api.request', 'POST /api/v1/auth/sign-in'],
    ['api.request', 'GET /api/v1/auth/me'],
    ['api.refused', 'GET /api/v1/auth/me'],
    ['api.refused', 'GET /missing'],
    ['api.error', 'GET /api/v1/test/crash'],
  ]);
  assert.deepEqual(apiEntries[1].actor, { type: 'person', id: 'sec.admin' });
  assert.deepEqual(apiEntries[2].actor, { type: 'anonymous', id: 'anonymous' });
});

// ---- Sign-in rate limit ----

withServer('more than 10 sign-ins a minute from one address get 429 with Retry-After, and it is logged', {}, async ({ call, advance, entries }) => {
  const attempt = () => call('POST', '/api/v1/auth/sign-in', { body: { username: 'sec.admin', password: 'wrong-guess-12345' } });
  for (let i = 0; i < 10; i += 1) assert.equal((await attempt()).status, 401);
  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(entries().at(-1).action, 'api.rate_limited');
  const right = await call('POST', '/api/v1/auth/sign-in', { body: { username: 'sec.admin', password: ADMIN_PW } });
  assert.equal(right.status, 429, 'not even the right password gets through');
  advance(61 * 1000);
  // The 5-wrong-password lockout applies too, so the account itself is now locked.
  assert.equal((await attempt()).status, 401, 'the address may try again after a minute');
});

test('the rate limiter counts per key in a sliding window and forgets the oldest keys', () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t, maxKeys: 2 });
  assert.deepEqual([1, 2, 3].map(() => limiter.take('a').allowed), [true, true, true]);
  assert.deepEqual(limiter.take('a'), { allowed: false, retryAfterS: 1 });
  assert.equal(limiter.take('b').allowed, true, 'another key is separate');
  t = 1001;
  assert.equal(limiter.take('a').allowed, true, 'the window slid');
  limiter.take('c');
  limiter.take('d'); // a third and fourth key: with room for 2, the least recently used ("b", then "a") are dropped
  t = 1002;
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('a').allowed), [true, true, true, false], '"a" was forgotten, so it starts afresh');
});

// ---- Error mapping ----

test('service errors map to statuses by class, and only 4xx messages are shown', () => {
  assert.deepEqual(statusFor(new PermissionDeniedError('no')), { status: 403, message: 'no' });
  assert.deepEqual(statusFor(new InventoryRequestError('bad')), { status: 400, message: 'bad' });
  assert.deepEqual(statusFor(new SystemNotFoundError('gone')), { status: 404, message: 'gone' });
  assert.deepEqual(statusFor(new InventoryConflictError('clash')), { status: 409, message: 'clash' });
  assert.deepEqual(statusFor(new AccountError('taken', { status: 409 })), { status: 409, message: 'taken' });
  assert.deepEqual(statusFor(new ApiRequestError(413, 'big')), { status: 413, message: 'big' });
  assert.deepEqual(statusFor(new DatabaseUnavailableError('host 10.0.0.5')), { status: 503, message: null });
  assert.deepEqual(statusFor(new Error('internal')), { status: 500, message: null });
  const lookalike = new Error('secret detail');
  lookalike.name = 'InventoryRequestError';
  assert.deepEqual(statusFor(lookalike), { status: 500, message: null }, 'a matching name is not enough');
});

withServer('no password, session token or CSRF token reaches the audit log through the API', {}, async ({ call, admin, addAlice, signIn, file }) => {
  const a = await admin();
  await addAlice({ cookie: a.cookie, csrf: a.csrf });
  const alice = await signIn('alice', ALICE_PW);
  await call('POST', '/api/v1/auth/sign-in', { body: { username: 'alice', password: 'a-wrong-password-xyz' } });
  await call('POST', '/api/v1/auth/password', { cookie: alice.cookie, csrf: alice.csrf, body: { currentPassword: ALICE_PW, newPassword: 'quiet-harbour-violet-08' } });
  const raw = readFileSync(file, 'utf8');
  for (const s of [ADMIN_PW, ALICE_PW, 'a-wrong-password-xyz', 'quiet-harbour-violet-08', a.cookie.split('=')[1], a.csrf, alice.cookie.split('=')[1], alice.csrf]) {
    assert.ok(!raw.includes(s), 'a secret leaked into the audit log');
  }
});
