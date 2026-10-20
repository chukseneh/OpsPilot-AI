// A running web API over real HTTP, with accounts for the given people, for the
// endpoint tests (web access, step 4). Every person's password is PASSWORD.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAccountService } from '../../src/web/accounts.js';
import { createSessionService } from '../../src/web/sessions.js';
import { createApiServer } from '../../src/web/server.js';
import { authRoutes } from '../../src/web/authRoutes.js';
import { createAuditLog } from '../../src/audit/auditLog.js';

export const PASSWORD = 'tangerine-orbit-91-lantern';
const ADMIN = { id: 'sec.admin', role: 'security officer' };

// db must already have the accounts and sessions tables (migrateAccounts, migrateSessions).
// routes: (audit) → the routes under test. people: { username: role }.
export async function startHarness({ db, routes, people = {}, audit: givenAudit }) {
  await db.exec('TRUNCATE user_accounts CASCADE');
  const audit = givenAudit ?? createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'web-')), 'audit.jsonl') });
  const accounts = createAccountService({ db, audit });
  const sessions = createSessionService({ db, audit, accounts });
  await accounts.bootstrapFirstAdmin({ username: ADMIN.id, password: 'grapefruit-orbit-91-lantern', displayName: 'Admin' });
  for (const [username, role] of Object.entries(people)) {
    await accounts.createAccount({ user: ADMIN, username, displayName: username, role, password: PASSWORD, reason: 'Test account' });
  }
  const api = createApiServer({
    audit, sessions, routes: [...authRoutes({ accounts, sessions }), ...routes(audit)],
    signInLimit: { max: 1000, windowMs: 60000 }, // the limit itself is tested in web-api.test.mjs
  });
  const { url } = await api.listen();

  const request = (method, path, { body, as } = {}) => fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(as ? { Cookie: as.cookie, 'X-CSRF-Token': as.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const call = async (method, path, options) => {
    const res = await request(method, path, options);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  // → { username, cookie, csrf }, passed as `as` to call().
  const signIn = async (username) => {
    const res = await request('POST', '/api/v1/auth/sign-in', { body: { username, password: PASSWORD } });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    return { username, cookie: res.headers.get('set-cookie').split(';')[0], csrf: json.csrfToken };
  };
  return { api, url, audit, accounts, call, signIn, close: () => api.close() };
}
