// User accounts for the web API (extra to the plan: web access). Until now every
// service trusted the identity its caller stated; on the web that would let anyone
// claim any role. Accounts make the caller prove who they are.
//
//   bootstrapFirstAdmin({ username, password, displayName })  — once, when there are no accounts
//   createAccount / changeRole / disableAccount / enableAccount / resetPassword
//                                         — security officers only, never on themselves
//   changeOwnPassword({ user, currentPassword, newPassword })
//   verifyCredentials({ username, password }) → { ok: true, account } | { ok: false }
//
// Passwords:
//   - hashed with scrypt (Node's crypto), a fresh random salt each, the cost settings
//     stored with the hash so they can be raised later; compared in constant time;
//   - never stored, logged, returned or put in an error;
//   - at least 12 characters, not the username, not a common password.
// Sign-in failures all look the same from outside ("wrong username or password"),
// whether the username exists, the password is wrong, or the account is locked or
// disabled — and take about as long — so nobody can find out which usernames exist.
// Five wrong passwords lock the account for 15 minutes.
//
// Every account change, lock and refusal is an audited decision with its reason.

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { roleAllowed, PROJECT_ROLES } from '../lib/roles.js';
import { PermissionDeniedError } from '../analysis/service.js';

export { PermissionDeniedError };
const scrypt = promisify(scryptCb);

export const ACCOUNT_ADMIN_ROLES = Object.freeze(['security officer']);
export const PASSWORD_MIN_LENGTH = 12;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60 * 1000;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
const COMMON = new Set(['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'administrator', 'iloveyou',
  'monkey', 'dragon', 'football', 'baseball', 'opspilot', 'changeme', 'secret', 'abc', 'abcdef', 'login', 'master', 'sunshine']);

export class AccountError extends Error {
  constructor(message, options) { super(message, options); this.name = 'AccountError'; }
}

export const ACCOUNTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_accounts (
  username            text PRIMARY KEY CHECK (username ~ '^[a-z0-9._-]{3,64}$'),
  display_name        text NOT NULL CHECK (btrim(display_name) <> ''),
  role                text NOT NULL,
  password_hash       text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  status              text NOT NULL CHECK (status IN ('active', 'disabled')),
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1
);
`;
export async function migrateAccounts(db) { await db.exec(ACCOUNTS_SCHEMA_SQL); }

// ---------------------------------------------------------------------------
// Passwords

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function passwordMatches(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compared against when the username does not exist, so a miss takes as long as a hit.
let dummyHash = null;
const getDummyHash = async () => { dummyHash ??= await hashPassword(randomBytes(24).toString('hex')); return dummyHash; };

export function passwordProblems(password, username = '') {
  if (typeof password !== 'string') return ['must be text'];
  const problems = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > 256) problems.push('must be at most 256 characters');
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) problems.push('must not contain the username');
  const core = lower.replace(/[^a-z]+$/, '').replace(/^[^a-z]+/, '');
  if (COMMON.has(core) || /^(.)\1+$/.test(password) || /^(0123456789|1234567890|abcdefghij)/.test(lower)) problems.push('is too common or too easy to guess');
  return problems;
}

// ---------------------------------------------------------------------------

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const iso = (v) => (v == null ? null : new Date(v).toISOString());
// What the rest of the system sees of an account — never the hash.
const publicAccount = (r) => ({
  id: r.username, displayName: r.display_name, role: r.role, status: r.status,
  lockedUntil: iso(r.locked_until), createdBy: r.created_by, createdAt: iso(r.created_at), version: r.version,
});

export function createAccountService({ db, audit, now = () => new Date() }) {
  const SYSTEM = { type: 'system', id: 'opspilot' };
  const log = (actor, action, fields) => audit.append({ correlationId: `account:${fields.subject ?? 'unknown'}`, actor, action, ...fields });

  function asAdmin(user, what, subject) {
    if (!isNonEmpty(user?.id) || !roleAllowed(user.role, ACCOUNT_ADMIN_ROLES)) {
      const why = `${isNonEmpty(user?.id) ? `Role "${user.role ?? 'none'}"` : 'An unknown caller'} may not ${what}; allowed roles: ${ACCOUNT_ADMIN_ROLES.join(', ')}.`;
      log(isNonEmpty(user?.id) ? { type: 'person', id: user.id } : { type: 'system', id: 'unknown-requester' }, 'account.denied', { subject, rationale: why, detail: { attempted: what } });
      throw new PermissionDeniedError(why);
    }
    return { type: 'person', id: user.id };
  }
  const refuse = (actor, subject, why) => {
    log(actor, 'account.refused', { subject, rationale: why });
    return new AccountError(why);
  };
  const checkNewAccount = (actor, { username, displayName, role, password }) => {
    const subject = typeof username === 'string' ? username : null;
    if (typeof username !== 'string' || !/^[a-z0-9._-]{3,64}$/.test(username)) throw refuse(actor, subject, 'username must be 3 to 64 lower-case letters, digits, dots, dashes or underscores');
    if (!isNonEmpty(displayName)) throw refuse(actor, subject, 'displayName is required');
    if (!PROJECT_ROLES.includes(role)) throw refuse(actor, subject, `role must be one of: ${PROJECT_ROLES.join(', ')}`);
    const problems = passwordProblems(password, username);
    if (problems.length) throw refuse(actor, subject, `the password ${problems.join('; ')}`);
  };
  const needReason = (actor, subject, reason) => { if (!isNonEmpty(reason)) throw refuse(actor, subject, 'a reason is required; it is recorded as the decision rationale'); };
  const get = async (username) => (await db.query('SELECT * FROM user_accounts WHERE username = $1', [username])).rows[0] ?? null;

  // A change is logged INSIDE its transaction; if the commit then fails, a
  // correcting entry says the logged change was not saved.
  async function committed(actor, subject, fn) {
    const logged = [];
    const logOk = (action, fields) => { logged.push(log(actor, action, { subject, ...fields })); };
    try {
      return await db.transaction((tx) => fn(tx, logOk));
    } catch (err) {
      if (logged.length) {
        log(actor, 'account.change_failed', {
          subject,
          rationale: `The change(s) logged as ${logged.map((e) => `#${e.seq} (${e.action})`).join(', ')} were NOT saved: ${err?.name ?? 'Error'}: ${err?.message ?? err}`,
        });
      }
      throw err;
    }
  }

  async function bootstrapFirstAdmin({ username, password, displayName } = {}) {
    checkNewAccount(SYSTEM, { username, displayName, role: 'security officer', password });
    const hash = await hashPassword(password);
    return committed(SYSTEM, username, async (tx, logOk) => {
      await tx.query('LOCK TABLE user_accounts IN EXCLUSIVE MODE');
      const { rows: [{ n }] } = await tx.query('SELECT count(*)::int AS n FROM user_accounts');
      if (n > 0) throw refuse(SYSTEM, username, 'accounts already exist; the first security officer can only be created once');
      const { rows: [row] } = await tx.query(
        "INSERT INTO user_accounts (username, display_name, role, password_hash, status, created_by) VALUES ($1, $2, 'security officer', $3, 'active', 'bootstrap') RETURNING *",
        [username, displayName.trim(), hash],
      );
      logOk('account.bootstrapped', { rationale: 'First security officer account, created once at setup.', detail: { role: 'security officer' } });
      return publicAccount(row);
    });
  }

  async function createAccount({ user, username, displayName, role, password, reason } = {}) {
    const actor = asAdmin(user, 'create accounts', username ?? null);
    needReason(actor, username, reason);
    checkNewAccount(actor, { username, displayName, role, password });
    const hash = await hashPassword(password);
    return committed(actor, username, async (tx, logOk) => {
      const { rows: [row] } = await tx.query(
        "INSERT INTO user_accounts (username, display_name, role, password_hash, status, created_by) VALUES ($1, $2, $3, $4, 'active', $5) ON CONFLICT (username) DO NOTHING RETURNING *",
        [username, displayName.trim(), role, hash, user.id],
      );
      if (!row) throw refuse(actor, username, `the username "${username}" is taken`);
      logOk('account.created', { rationale: reason.trim(), detail: { role, displayName: displayName.trim() } });
      return publicAccount(row);
    });
  }

  // One audited change to someone else's account.
  async function change(user, what, username, reason, action, fn) {
    const actor = asAdmin(user, what, username ?? null);
    needReason(actor, username, reason);
    if (username === user.id) throw refuse(actor, username, `you may not ${what} on your own account; ask another security officer`);
    return committed(actor, username, async (tx, logOk) => {
      const { rows: [row] } = await tx.query('SELECT * FROM user_accounts WHERE username = $1 FOR UPDATE', [username]);
      if (!row) throw refuse(actor, username, `there is no account "${username}"`);
      const { set, detail } = await fn(row, actor);
      // Column names come only from the fixed sets above, never from the caller.
      const fields = Object.keys(set);
      const { rows: [updated] } = await tx.query(
        `UPDATE user_accounts SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}, version = version + 1 WHERE username = $1 RETURNING *`,
        [username, ...fields.map((f) => set[f])],
      );
      logOk(action, { rationale: reason.trim(), detail });
      return publicAccount(updated);
    });
  }

  const changeRole = ({ user, username, role, reason } = {}) => change(user, 'change roles', username, reason, 'account.role_changed', (row, actor) => {
    if (!PROJECT_ROLES.includes(role)) throw refuse(actor, username, `role must be one of: ${PROJECT_ROLES.join(', ')}`);
    return { set: { role }, detail: { from: row.role, to: role } };
  });
  const disableAccount = ({ user, username, reason } = {}) => change(user, 'disable accounts', username, reason, 'account.disabled', (row) => ({ set: { status: 'disabled' }, detail: { from: row.status, to: 'disabled' } }));
  const enableAccount = ({ user, username, reason } = {}) => change(user, 'enable accounts', username, reason, 'account.enabled', (row) => ({ set: { status: 'active', failed_attempts: 0, locked_until: null }, detail: { from: row.status, to: 'active' } }));
  const resetPassword = ({ user, username, newPassword, reason } = {}) => change(user, 'reset passwords', username, reason, 'account.password_reset', async (_row, actor) => {
    const problems = passwordProblems(newPassword, username);
    if (problems.length) throw refuse(actor, username, `the password ${problems.join('; ')}`);
    return { set: { password_hash: await hashPassword(newPassword), password_changed_at: now().toISOString(), failed_attempts: 0, locked_until: null }, detail: {} };
  });

  const SIGN_IN = { type: 'system', id: 'sign-in' };
  const isLocked = (row, t) => row.locked_until != null && new Date(row.locked_until).getTime() > t;

  // One wrong password. The count goes up in a single statement, so guesses sent
  // in parallel cannot slip past the limit; the fifth locks the account.
  async function recordWrongPassword(name, t) {
    return committed(SIGN_IN, name, async (tx, logOk) => {
      const { rows: [{ failed_attempts: attempts }] } = await tx.query(
        'UPDATE user_accounts SET failed_attempts = failed_attempts + 1 WHERE username = $1 RETURNING failed_attempts', [name]);
      if (attempts < MAX_FAILED_ATTEMPTS) return { attempts, lockedUntil: null };
      const until = new Date(t + LOCK_MS).toISOString();
      await tx.query('UPDATE user_accounts SET failed_attempts = 0, locked_until = $2 WHERE username = $1', [name, until]);
      logOk('account.locked', { rationale: `${MAX_FAILED_ATTEMPTS} wrong passwords in a row; locked until ${until}.` });
      return { attempts, lockedUntil: until };
    });
  }

  async function changeOwnPassword({ user, currentPassword, newPassword } = {}) {
    const actor = { type: 'person', id: isNonEmpty(user?.id) ? user.id : 'unknown' };
    const row = isNonEmpty(user?.id) ? await get(user.id) : null;
    const t = now().getTime();
    if (!row || row.status !== 'active' || isLocked(row, t)) throw refuse(actor, user?.id ?? null, 'the account is not active');
    if (!(await passwordMatches(currentPassword ?? '', row.password_hash))) {
      // Counts toward the lockout, so a stolen session cannot be used to guess the password.
      await recordWrongPassword(row.username, t);
      throw refuse(actor, user.id, 'the current password is wrong');
    }
    const problems = passwordProblems(newPassword, user.id);
    if (problems.length) throw refuse(actor, user.id, `the new password ${problems.join('; ')}`);
    if (await passwordMatches(newPassword, row.password_hash)) throw refuse(actor, user.id, 'the new password must differ from the current one');
    const hash = await hashPassword(newPassword);
    await committed(actor, user.id, async (tx, logOk) => {
      await tx.query('UPDATE user_accounts SET password_hash = $2, password_changed_at = $3, failed_attempts = 0, version = version + 1 WHERE username = $1',
        [user.id, hash, now().toISOString()]);
      logOk('account.password_changed', {});
    });
    return { changed: true };
  }

  // Sign-in check. The caller only ever learns ok or not ok; the audit log
  // records the real reason.
  async function verifyCredentials({ username, password } = {}) {
    const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const row = name ? await get(name) : null;
    const t = now().getTime();
    const locked = row ? isLocked(row, t) : false;
    // Always do the expensive comparison, even when the answer is already "no".
    const matches = await passwordMatches(String(password ?? ''), row && !locked ? row.password_hash : await getDummyHash());
    const fail = (why) => {
      log(SIGN_IN, 'account.sign_in_failed', { subject: name || null, rationale: why });
      return { ok: false };
    };
    if (!row) return fail('No such account.');
    if (row.status !== 'active') return fail('The account is disabled.');
    if (locked) return fail(`The account is locked until ${new Date(row.locked_until).toISOString()}.`);
    if (!matches) {
      const { attempts, lockedUntil } = await recordWrongPassword(name, t);
      return fail(lockedUntil ? 'Wrong password; the account is now locked.' : `Wrong password (${attempts} of ${MAX_FAILED_ATTEMPTS}).`);
    }
    // Re-checked as it is written: a guess that locked the account a moment ago wins.
    const { rows: [current] } = await db.query(
      "UPDATE user_accounts SET failed_attempts = 0, locked_until = NULL WHERE username = $1 AND status = 'active' AND (locked_until IS NULL OR locked_until <= $2) RETURNING *",
      [name, new Date(t).toISOString()]);
    if (!current) return fail('The account was locked or disabled while signing in.');
    return { ok: true, account: publicAccount(current) };
  }

  async function getAccount(username) {
    const row = await get(username);
    return row ? publicAccount(row) : null;
  }

  return { bootstrapFirstAdmin, createAccount, changeRole, disableAccount, enableAccount, resetPassword, changeOwnPassword, verifyCredentials, getAccount };
}
