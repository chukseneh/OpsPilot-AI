// Web access, step 1: local accounts and passwords. Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAccountService, migrateAccounts, hashPassword, passwordMatches, passwordProblems,
  AccountError, PermissionDeniedError, MAX_FAILED_ATTEMPTS, LOCK_MS,
} from '../src/web/accounts.js';
import { openPGlite } from '../src/inventory/db.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const ADMIN_PW = 'correct-horse-battery-staple';
const ALICE_PW = 'tangerine-orbit-91-lantern';
const ADMIN = { id: 'sec.admin', role: 'security officer' };

let pg;
before(async () => { pg = await openPGlite(); await migrateAccounts(pg); });
after(async () => { await pg.close(); });

async function setup({ db, bootstrap = true } = {}) {
  await pg.exec('TRUNCATE user_accounts');
  const file = join(mkdtempSync(join(tmpdir(), 'acct-')), 'audit.jsonl');
  const audit = createAuditLog({ file });
  let clock = Date.parse('2026-10-20T09:00:00Z');
  const now = () => new Date(clock);
  const advance = (ms) => { clock += ms; };
  const accounts = createAccountService({ db: db ?? pg, audit, now });
  if (bootstrap) await accounts.bootstrapFirstAdmin({ username: ADMIN.id, password: ADMIN_PW, displayName: 'Security Admin' });
  const entries = () => audit.readAll();
  const actions = () => entries().map((e) => e.action);
  const addAlice = () => accounts.createAccount({
    user: ADMIN, username: 'alice', displayName: 'Alice Analyst', role: 'process analyst', password: ALICE_PW, reason: 'New process analyst',
  });
  return { accounts, audit, file, entries, actions, advance, addAlice };
}

// ---- Passwords ----

test('a password is hashed with scrypt and its own salt, and only the right password matches', async () => {
  const a = await hashPassword(ALICE_PW);
  const b = await hashPassword(ALICE_PW);
  assert.match(a, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, 'the cost settings are stored with the hash');
  assert.notEqual(a, b, 'a fresh salt each time');
  assert.ok(!a.includes(ALICE_PW));
  assert.equal(await passwordMatches(ALICE_PW, a), true);
  assert.equal(await passwordMatches(ALICE_PW, b), true);
  assert.equal(await passwordMatches(`${ALICE_PW}x`, a), false);
  assert.equal(await passwordMatches('', a), false);
  assert.equal(await passwordMatches(ALICE_PW, 'not-a-hash'), false);
});

test('the password rule: 12+ characters, not the username, not a common password', () => {
  assert.deepEqual(passwordProblems(ALICE_PW, 'alice'), []);
  assert.ok(passwordProblems('short-pw', 'alice').some((p) => p.includes('at least 12')));
  assert.ok(passwordProblems('alice-is-great-2026', 'alice').some((p) => p.includes('username')));
  assert.ok(passwordProblems('ALICE-is-great-2026', 'alice').some((p) => p.includes('username')), 'case does not hide the username');
  for (const common of ['Password1234!', '123password!!', 'aaaaaaaaaaaaaa', '1234567890abc', 'Changeme2026!!']) {
    assert.ok(passwordProblems(common, 'alice').some((p) => p.includes('common')), `"${common}" is refused`);
  }
  assert.ok(passwordProblems('x'.repeat(257), 'alice').some((p) => p.includes('at most')));
  assert.deepEqual(passwordProblems(undefined), ['must be text']);
});

// ---- The first account ----

test('the first security officer is created once; a second bootstrap is refused and logged', async () => {
  const { accounts, actions } = await setup({ bootstrap: false });
  const admin = await accounts.bootstrapFirstAdmin({ username: ADMIN.id, password: ADMIN_PW, displayName: 'Security Admin' });
  assert.deepEqual({ id: admin.id, role: admin.role, status: admin.status, createdBy: admin.createdBy }, { id: ADMIN.id, role: 'security officer', status: 'active', createdBy: 'bootstrap' });
  assert.ok(!('password_hash' in admin) && !('passwordHash' in admin));

  await assert.rejects(accounts.bootstrapFirstAdmin({ username: 'mallory', password: 'another-long-phrase-77', displayName: 'Mallory' }),
    (e) => e instanceof AccountError && /only be created once/.test(e.message));
  assert.equal(await accounts.getAccount('mallory'), null);
  assert.deepEqual(actions(), ['account.bootstrapped', 'account.refused']);
});

test('the bootstrap checks the password rule too', async () => {
  const { accounts, actions } = await setup({ bootstrap: false });
  await assert.rejects(accounts.bootstrapFirstAdmin({ username: 'sec.admin', password: 'password', displayName: 'Admin' }), AccountError);
  assert.equal(await accounts.getAccount('sec.admin'), null);
  assert.deepEqual(actions(), ['account.refused']);
});

// ---- Signing in ----

test('the right password signs in and returns the account without its hash', async () => {
  const { accounts, addAlice } = await setup();
  await addAlice();
  const result = await accounts.verifyCredentials({ username: ' Alice ', password: ALICE_PW });
  assert.equal(result.ok, true);
  assert.deepEqual({ id: result.account.id, role: result.account.role }, { id: 'alice', role: 'process analyst' });
  assert.ok(!JSON.stringify(result).includes('scrypt$'));
});

test('a wrong password and an unknown username give exactly the same answer; the log keeps the real reason', async () => {
  const { accounts, addAlice, entries } = await setup();
  await addAlice();
  const wrong = await accounts.verifyCredentials({ username: 'alice', password: 'not-alices-password-1' });
  const unknown = await accounts.verifyCredentials({ username: 'nobody', password: 'not-alices-password-1' });
  const empty = await accounts.verifyCredentials({});
  assert.deepEqual(wrong, { ok: false });
  assert.deepEqual(unknown, wrong);
  assert.deepEqual(empty, wrong);
  const failed = entries().filter((e) => e.action === 'account.sign_in_failed');
  assert.deepEqual(failed.map((e) => [e.subject, e.rationale]), [
    ['alice', `Wrong password (1 of ${MAX_FAILED_ATTEMPTS}).`],
    ['nobody', 'No such account.'],
    [null, 'No such account.'],
  ]);
});

test('an unknown username takes about as long as a wrong password (the hash is still computed)', async () => {
  const { accounts, addAlice } = await setup();
  await addAlice();
  await accounts.verifyCredentials({ username: 'nobody', password: 'warm-up-the-dummy-hash' });
  const time = async (username) => {
    const t0 = performance.now();
    for (let i = 0; i < 3; i += 1) await accounts.verifyCredentials({ username, password: `wrong-password-${i}-xyz` });
    return performance.now() - t0;
  };
  const known = await time('alice');
  const unknown = await time('nobody');
  // Loose bound: without the dummy hash an unknown name would answer in well under a tenth of the time.
  assert.ok(unknown > known * 0.3, `unknown ${unknown.toFixed(0)} ms vs known ${known.toFixed(0)} ms`);
});

test(`${MAX_FAILED_ATTEMPTS} wrong passwords lock the account for 15 minutes, even against the right password`, async () => {
  const { accounts, addAlice, actions, entries, advance } = await setup();
  await addAlice();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    assert.deepEqual(await accounts.verifyCredentials({ username: 'alice', password: `guess-number-${i}-abc` }), { ok: false });
  }
  const lock = entries().find((e) => e.action === 'account.locked');
  assert.ok(lock && lock.subject === 'alice' && /locked until 2026-10-20T09:15:00.000Z/.test(lock.rationale));
  assert.equal((await accounts.getAccount('alice')).lockedUntil, '2026-10-20T09:15:00.000Z');

  assert.deepEqual(await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW }), { ok: false }, 'locked, so the right password fails too');
  assert.match(entries().at(-1).rationale, /locked until/);

  advance(LOCK_MS - 1000);
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW })).ok, false, 'still locked a second before');
  advance(1000);
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW })).ok, true, 'unlocked after 15 minutes');
  assert.equal((await accounts.getAccount('alice')).lockedUntil, null);
  assert.equal(actions().filter((a) => a === 'account.locked').length, 1);
});

test('a correct password resets the count of wrong ones', async () => {
  const { accounts, addAlice, actions } = await setup();
  await addAlice();
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) await accounts.verifyCredentials({ username: 'alice', password: `guess-${round}-${i}-abcdef` });
    assert.equal((await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW })).ok, true);
  }
  assert.ok(!actions().includes('account.locked'));
});

test('guesses sent in parallel cannot slip past the lockout', async () => {
  const { accounts, addAlice, actions } = await setup();
  await addAlice();
  const guesses = Array.from({ length: MAX_FAILED_ATTEMPTS * 2 }, (_, i) => accounts.verifyCredentials({ username: 'alice', password: `parallel-guess-${i}-x` }));
  // The right password sent in the same burst, after the wrong ones.
  guesses.push(accounts.verifyCredentials({ username: 'alice', password: ALICE_PW }));
  const results = await Promise.all(guesses);
  assert.ok(results.slice(0, -1).every((r) => r.ok === false));
  assert.ok(actions().includes('account.locked'));
  assert.notEqual((await accounts.getAccount('alice')).lockedUntil, null, 'the account ends up locked');
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW })).ok, false);
});

// ---- Managing accounts ----

test('a security officer creates an account; the reason is the logged rationale', async () => {
  const { accounts, addAlice, entries } = await setup();
  const alice = await addAlice();
  assert.deepEqual({ id: alice.id, role: alice.role, status: alice.status, createdBy: alice.createdBy, version: alice.version },
    { id: 'alice', role: 'process analyst', status: 'active', createdBy: ADMIN.id, version: 1 });
  const created = entries().find((e) => e.action === 'account.created');
  assert.deepEqual({ actor: created.actor, subject: created.subject, rationale: created.rationale, role: created.detail.role },
    { actor: { type: 'person', id: ADMIN.id }, subject: 'alice', rationale: 'New process analyst', role: 'process analyst' });
  assert.deepEqual(await accounts.getAccount('alice'), alice);
});

test('only a security officer may manage accounts; every refusal is logged', async () => {
  const { accounts, addAlice, entries } = await setup();
  await addAlice();
  const analyst = { id: 'alice', role: 'process analyst' };
  const attempts = [
    () => accounts.createAccount({ user: analyst, username: 'bob', displayName: 'Bob', role: 'security officer', password: 'silver-kettle-river-12', reason: 'x' }),
    () => accounts.changeRole({ user: analyst, username: 'alice', role: 'security officer', reason: 'promote myself' }),
    () => accounts.disableAccount({ user: { id: 'it.mgr', role: 'IT manager' }, username: ADMIN.id, reason: 'x' }),
    () => accounts.resetPassword({ user: undefined, username: ADMIN.id, newPassword: 'takeover-password-99', reason: 'x' }),
    () => accounts.enableAccount({ user: { id: 'x', role: 'user' }, username: 'alice', reason: 'x' }),
  ];
  for (const attempt of attempts) await assert.rejects(attempt(), PermissionDeniedError);
  const denied = entries().filter((e) => e.action === 'account.denied');
  assert.equal(denied.length, attempts.length);
  assert.ok(denied.every((e) => /allowed roles: security officer/.test(e.rationale)));
  assert.equal(denied[3].actor.id, 'unknown-requester');
  assert.equal((await accounts.getAccount('alice')).role, 'process analyst');
  assert.equal(await accounts.getAccount('bob'), null);
});

test('a new account needs a valid username, a project role, a good password, a free name and a reason', async () => {
  const { accounts, addAlice, actions } = await setup();
  await addAlice();
  const base = { user: ADMIN, username: 'bob', displayName: 'Bob', role: 'financial analyst', password: 'silver-kettle-river-12', reason: 'New analyst' };
  const cases = [
    [{ username: 'Bob Smith' }, /username must be/],
    [{ username: 'ab' }, /username must be/],
    [{ displayName: '  ' }, /displayName is required/],
    [{ role: 'user' }, /role must be one of/],
    [{ role: 'superuser' }, /role must be one of/],
    [{ password: 'short' }, /at least 12/],
    [{ password: 'bob-bob-bob-bob-12' }, /username/],
    [{ reason: '' }, /reason is required/],
    [{ username: 'alice' }, /is taken/],
  ];
  for (const [over, message] of cases) {
    await assert.rejects(accounts.createAccount({ ...base, ...over }), (e) => e instanceof AccountError && message.test(e.message), JSON.stringify(over));
  }
  assert.equal(await accounts.getAccount('bob'), null);
  assert.equal((await accounts.getAccount('alice')).displayName, 'Alice Analyst', 'the taken name was not overwritten');
  assert.equal(actions().filter((a) => a === 'account.refused').length, cases.length);
  const ok = await accounts.createAccount(base);
  assert.equal(ok.role, 'financial analyst');
});

test('changing a role, disabling, enabling and resetting a password each take effect and are logged with the reason', async () => {
  const { accounts, addAlice, entries } = await setup();
  await addAlice();

  const promoted = await accounts.changeRole({ user: ADMIN, username: 'alice', role: 'operations manager', reason: 'Moved to operations' });
  assert.deepEqual({ role: promoted.role, version: promoted.version }, { role: 'operations manager', version: 2 });
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW })).account.role, 'operations manager');

  await accounts.disableAccount({ user: ADMIN, username: 'alice', reason: 'Left the company' });
  assert.deepEqual(await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW }), { ok: false });
  assert.equal(entries().at(-1).rationale, 'The account is disabled.');

  await accounts.enableAccount({ user: ADMIN, username: 'alice', reason: 'Rejoined' });
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW })).ok, true);

  const NEW_PW = 'fresh-meadow-copper-43';
  await accounts.resetPassword({ user: ADMIN, username: 'alice', newPassword: NEW_PW, reason: 'Forgot password; identity checked in person' });
  assert.deepEqual(await accounts.verifyCredentials({ username: 'alice', password: ALICE_PW }), { ok: false }, 'the old password no longer works');
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: NEW_PW })).ok, true);

  const changes = entries().filter((e) => ['account.role_changed', 'account.disabled', 'account.enabled', 'account.password_reset'].includes(e.action));
  assert.deepEqual(changes.map((e) => [e.action, e.rationale]), [
    ['account.role_changed', 'Moved to operations'],
    ['account.disabled', 'Left the company'],
    ['account.enabled', 'Rejoined'],
    ['account.password_reset', 'Forgot password; identity checked in person'],
  ]);
  assert.deepEqual(changes[0].detail, { from: 'process analyst', to: 'operations manager' });
});

test('a reset unlocks a locked account', async () => {
  const { accounts, addAlice } = await setup();
  await addAlice();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await accounts.verifyCredentials({ username: 'alice', password: `guess-number-${i}-abc` });
  await accounts.resetPassword({ user: ADMIN, username: 'alice', newPassword: 'fresh-meadow-copper-43', reason: 'Locked out' });
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: 'fresh-meadow-copper-43' })).ok, true);
});

test('nobody may change their own role, disable or reset their own account', async () => {
  const { accounts, actions } = await setup();
  await assert.rejects(accounts.changeRole({ user: ADMIN, username: ADMIN.id, role: 'data analyst', reason: 'x' }), /own account/);
  await assert.rejects(accounts.disableAccount({ user: ADMIN, username: ADMIN.id, reason: 'x' }), /own account/);
  await assert.rejects(accounts.resetPassword({ user: ADMIN, username: ADMIN.id, newPassword: 'new-long-password-55', reason: 'x' }), /own account/);
  assert.equal((await accounts.getAccount(ADMIN.id)).role, 'security officer');
  assert.deepEqual(actions().slice(1), ['account.refused', 'account.refused', 'account.refused']);
});

test('changes to a missing account, or to an invalid role, are refused', async () => {
  const { accounts, addAlice } = await setup();
  await addAlice();
  await assert.rejects(accounts.disableAccount({ user: ADMIN, username: 'ghost', reason: 'x' }), /no account "ghost"/);
  await assert.rejects(accounts.changeRole({ user: ADMIN, username: 'alice', role: 'admin', reason: 'x' }), /role must be one of/);
  await assert.rejects(accounts.changeRole({ user: ADMIN, username: 'alice', role: 'security officer' }), /reason is required/);
  await assert.rejects(accounts.resetPassword({ user: ADMIN, username: 'alice', newPassword: 'qwerty', reason: 'x' }), /at least 12/);
  const alice = await accounts.getAccount('alice');
  assert.deepEqual({ role: alice.role, version: alice.version }, { role: 'process analyst', version: 1 });
});

test('a person changes their own password with the current one; a wrong current one counts toward the lockout', async () => {
  const { accounts, addAlice, actions } = await setup();
  await addAlice();
  const alice = { id: 'alice', role: 'process analyst' };
  const NEW_PW = 'quiet-harbour-violet-08';

  await assert.rejects(accounts.changeOwnPassword({ user: alice, currentPassword: ALICE_PW, newPassword: ALICE_PW }), /must differ/);
  await assert.rejects(accounts.changeOwnPassword({ user: alice, currentPassword: ALICE_PW, newPassword: 'alice-new-password-1' }), /username/);
  assert.deepEqual(await accounts.changeOwnPassword({ user: alice, currentPassword: ALICE_PW, newPassword: NEW_PW }), { changed: true });
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: NEW_PW })).ok, true);
  assert.ok(actions().includes('account.password_changed'));

  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    await assert.rejects(accounts.changeOwnPassword({ user: alice, currentPassword: `wrong-${i}-current-pw`, newPassword: 'another-good-password-3' }), /current password is wrong|not active/);
  }
  assert.ok(actions().includes('account.locked'));
  assert.equal((await accounts.verifyCredentials({ username: 'alice', password: NEW_PW })).ok, false, 'locked');
});

// ---- Audit ----

test('no password or password hash ever reaches the audit log', async () => {
  const { accounts, addAlice, file } = await setup();
  await addAlice();
  const NEW_PW = 'fresh-meadow-copper-43';
  await accounts.verifyCredentials({ username: 'alice', password: 'a-wrong-password-xyz' });
  await accounts.verifyCredentials({ username: 'nobody', password: 'a-different-wrong-one' });
  await accounts.resetPassword({ user: ADMIN, username: 'alice', newPassword: NEW_PW, reason: 'Reset' });
  await accounts.changeOwnPassword({ user: { id: 'alice', role: 'process analyst' }, currentPassword: NEW_PW, newPassword: 'quiet-harbour-violet-08' });
  await accounts.createAccount({ user: ADMIN, username: 'bob', displayName: 'Bob', role: 'data analyst', password: 'short', reason: 'x' }).catch((e) => assert.ok(e instanceof AccountError));
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await accounts.verifyCredentials({ username: 'alice', password: `lockout-guess-${i}-q` });

  const raw = readFileSync(file, 'utf8');
  for (const pw of [ADMIN_PW, ALICE_PW, NEW_PW, 'quiet-harbour-violet-08', 'a-wrong-password-xyz', 'a-different-wrong-one', 'lockout-guess-0-q']) {
    assert.ok(!raw.includes(pw), `"${pw}" is not in the log`);
  }
  assert.ok(!raw.includes('scrypt$'), 'no hash in the log');
  const { rows } = await pg.query('SELECT password_hash FROM user_accounts');
  for (const { password_hash: h } of rows) assert.ok(!raw.includes(h.split('$').at(-1)), 'no hash digest in the log');
});

test('a change whose commit fails is followed by a correcting entry, and nothing is saved', async () => {
  const failingCommit = {
    query: (...a) => pg.query(...a),
    exec: (...a) => pg.exec(...a),
    transaction: (fn) => pg.transaction(async (tx) => {
      await fn({ query: (...a) => tx.query(...a), exec: (...a) => tx.exec(...a) });
      throw new Error('connection lost at commit');
    }),
  };
  const { accounts, audit, actions } = await setup({ bootstrap: false });
  const failing = createAccountService({ db: failingCommit, audit });
  await assert.rejects(failing.bootstrapFirstAdmin({ username: 'carol', displayName: 'Carol', password: 'amber-window-falcon-7' }), /connection lost/);
  assert.equal(await accounts.getAccount('carol'), null, 'rolled back');
  assert.deepEqual(actions(), ['account.bootstrapped', 'account.change_failed']);
  assert.match(audit.readAll()[1].rationale, /#1 \(account\.bootstrapped\) were NOT saved: Error: connection lost at commit/);
});
