// Web access, step 5: the API started by startOpsPilot (WEB_PORT), the first-admin
// command, the session clean-up timer, and the demo. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { startOpsPilot, StartupRefusedError } from '../src/system.js';
import { createFirstAdmin } from '../src/web/createFirstAdmin.js';
import { AccountError } from '../src/web/accounts.js';
import { createSessionService } from '../src/web/sessions.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { runWebDemo } from '../src/demo/web.js';

const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
const timers = { approvals: idle, anchors: idle, governance: idle, sessions: idle };
const envFor = (over = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-web-'));
  return { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl'), ...over };
};
const ADMIN_PW = 'correct-horse-battery-staple';
const signIn = (url, username, password) => fetch(`${url}/api/v1/auth/sign-in`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(10000),
});

test('with WEB_PORT set, the API listens on this machine, serves every group, logs to the keyed log, and closes on stop', async () => {
  const sys = await startOpsPilot({ env: envFor({ WEB_PORT: '0' }), timers });
  let url;
  try {
    url = sys.webUrl;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(sys.services.accounts && sys.services.sessions);
    await sys.services.accounts.bootstrapFirstAdmin({ username: 'sec.admin', password: ADMIN_PW, displayName: 'Admin' });
    const res = await signIn(url, 'sec.admin', ADMIN_PW);
    assert.equal(res.status, 200);
    assert.ok(!/;\s*Secure/.test(res.headers.get('set-cookie')), 'not Secure unless asked for');
    const cookie = res.headers.get('set-cookie').split(';')[0];
    // One read from each route group, as a security officer: allowed or refused by the service, never 404.
    for (const path of ['/api/v1/auth/me', '/api/v1/accounts', '/api/v1/workflows/WF-NONE', '/api/v1/documents', '/api/v1/inventory', '/api/v1/roi/scenarios', '/api/v1/audit', '/api/v1/simulations', '/api/v1/governance/UK/versions']) {
      const r = await fetch(`${url}${path}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) });
      await r.text();
      assert.ok(r.status !== 404 || path === '/api/v1/workflows/WF-NONE', `${path} → ${r.status}`);
      assert.ok(r.status < 500, `${path} → ${r.status}`);
    }
    const entries = sys.audit.readAll();
    assert.ok(entries.some((e) => e.action === 'system.web_started'));
    assert.ok(entries.filter((e) => e.action.startsWith('api.')).every((e) => e.alg === 'hmac-sha256'), 'API entries are in the keyed main log');
  } finally {
    await sys.stop();
  }
  await assert.rejects(fetch(`${url}/api/v1/auth/me`), 'after stop, nothing is listening');
});

test('WEB_SECURE_COOKIES=true marks the session cookie Secure', async () => {
  const sys = await startOpsPilot({ env: envFor({ WEB_PORT: '0', WEB_SECURE_COOKIES: 'true' }), timers });
  try {
    await sys.services.accounts.bootstrapFirstAdmin({ username: 'sec.admin', password: ADMIN_PW, displayName: 'Admin' });
    const res = await signIn(sys.webUrl, 'sec.admin', ADMIN_PW);
    assert.match(res.headers.get('set-cookie'), /; Secure$/);
  } finally {
    await sys.stop();
  }
});

test('bad web settings refuse to start; without WEB_PORT nothing listens', async () => {
  await assert.rejects(startOpsPilot({ env: envFor({ WEB_PORT: 'http' }), timers }), (err) => err instanceof StartupRefusedError && /WEB_PORT/.test(err.message));
  await assert.rejects(startOpsPilot({ env: envFor({ WEB_PORT: '99999' }), timers }), StartupRefusedError);
  await assert.rejects(startOpsPilot({ env: envFor({ WEB_SECURE_COOKIES: 'yes' }), timers }), /WEB_SECURE_COOKIES/);
  const sys = await startOpsPilot({ env: envFor(), timers });
  assert.equal(sys.webUrl, null);
  await sys.stop();
});

const listenOn = (port) => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => resolve(s));
});
const closeServer = (s) => new Promise((r) => { s.close(r); });

test('a port already in use refuses startup, and leaves nothing running', async () => {
  const blocker = await listenOn(0);
  // A free port for the dashboard, so we can check afterwards that it was let go.
  const probe = await listenOn(0);
  const dashboardPort = probe.address().port;
  await closeServer(probe);
  const env = envFor({ WEB_PORT: String(blocker.address().port), DASHBOARD_PORT: String(dashboardPort) });
  try {
    await assert.rejects(startOpsPilot({ env, timers }), (err) => err instanceof StartupRefusedError && /web API could not listen/.test(err.message));
  } finally {
    await closeServer(blocker);
  }
  // The dashboard that had started was closed again: its port is free.
  await closeServer(await listenOn(dashboardPort).catch((err) => assert.fail(`the dashboard was left listening on ${dashboardPort}: ${err.code}`)));
  // And the database was closed: the same folder starts cleanly.
  const sys = await startOpsPilot({ env: { ...env, WEB_PORT: '0', DASHBOARD_PORT: '0' }, timers });
  assert.ok(sys.webUrl && sys.dashboardUrl);
  await sys.stop();
});

// ---- The first-admin command ----

test('createFirstAdmin makes the first security officer on the keyed log, once', async () => {
  const env = envFor();
  const printed = [];
  const account = await createFirstAdmin({ env, username: 'sec.admin', displayName: 'Security Admin', readPassword: async () => ADMIN_PW, print: (s) => printed.push(s) });
  assert.deepEqual([account.id, account.role], ['sec.admin', 'security officer']);
  assert.match(printed[0], /Created the first security officer account "sec.admin"/);
  await assert.rejects(createFirstAdmin({ env, username: 'other', readPassword: async () => 'silver-kettle-river-12', print: () => {} }),
    (err) => err instanceof AccountError && /only be created once/.test(err.message));

  const raw = readFileSync(env.AUDIT_LOG_FILE, 'utf8');
  assert.ok(!raw.includes(ADMIN_PW), 'the password is not in the audit log');
  const boot = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.action === 'account.bootstrapped');
  assert.equal(boot.alg, 'hmac-sha256');

  // And the account works through the API.
  const sys = await startOpsPilot({ env: { ...env, WEB_PORT: '0' }, timers });
  try {
    assert.equal((await signIn(sys.webUrl, 'sec.admin', ADMIN_PW)).status, 200);
  } finally {
    await sys.stop();
  }
});

test('createFirstAdmin refuses a weak password and creates nothing', async () => {
  const env = envFor();
  await assert.rejects(createFirstAdmin({ env, username: 'sec.admin', readPassword: async () => 'password', print: () => {} }), /at least 12/);
  const account = await createFirstAdmin({ env, username: 'sec.admin', readPassword: async () => ADMIN_PW, print: () => {} });
  assert.equal(account.id, 'sec.admin', 'the refused attempt did not use up the one-time setup');
});

function runCli(args, { env, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/web/createFirstAdmin.js', ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // Each run starts the whole system in a new process: ~2 s alone, but over 60 s
    // while every other test file is also starting databases. The limit only has to
    // catch a hang, not measure speed.
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the command did not finish: ${out}`)); }, 240000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.end(stdin);
  });
}

test('the command, run for real with --password-stdin: works once, then refuses; the password is never printed', async () => {
  const env = envFor();
  const first = await runCli(['--username', 'sec.admin', '--password-stdin'], { env, stdin: `${ADMIN_PW}\n` });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Created the first security officer account "sec.admin"/);
  const second = await runCli(['--username', 'sec.two', '--password-stdin'], { env, stdin: 'silver-kettle-river-12\n' });
  assert.equal(second.code, 1);
  assert.match(second.out, /Not created: accounts already exist/);
  const noName = await runCli(['--password-stdin'], { env, stdin: `${ADMIN_PW}\n` });
  assert.equal(noName.code, 1);
  assert.match(noName.out, /--username/);
  for (const r of [first, second, noName]) assert.ok(!r.out.includes(ADMIN_PW) && !r.out.includes('silver-kettle-river-12'));
});

test('without a terminal or --password-stdin, the command refuses rather than read a visible password', async () => {
  const r = await runCli(['--username', 'sec.admin'], { env: envFor(), stdin: `${ADMIN_PW}\n` });
  assert.equal(r.code, 1);
  assert.match(r.out, /Run this in a terminal/);
});

// ---- The session clean-up timer ----

test('the clean-up timer removes expired sessions; a failed run is logged and tried again next time', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'purge-')), 'audit.jsonl');
  const audit = createAuditLog({ file });
  let fail = true;
  const db = { query: async (sql) => { if (fail) throw new Error('database unavailable'); return { rows: sql.startsWith('DELETE') ? [] : [] }; } };
  const sessions = createSessionService({ db, audit, accounts: {} });
  let scheduled = null;
  const errors = [];
  const timer = sessions.startPurgeTimer({ everyMs: 1000, timers: { setInterval: (fn) => { scheduled = fn; return 1; }, clearInterval: () => { scheduled = null; } }, onError: (m) => errors.push(m) });
  assert.equal(typeof scheduled, 'function');
  assert.equal(await timer.tick(), null);
  assert.match(errors[0], /could not remove expired sessions: Error: database unavailable/);
  assert.equal(audit.readAll().at(-1).action, 'session.purge_failed');
  fail = false;
  assert.deepEqual(await timer.tick(), { removed: 0 });
  await timer.stop();
  assert.equal(scheduled, null);
  assert.equal(await timer.tick(), null, 'nothing runs after stop');
});

// ---- The demo ----

test('the web demo runs every step as expected, over HTTP, on the real system', async () => {
  const lines = [];
  const r = await runWebDemo({ print: (s) => lines.push(s) });
  assert.equal(r.ok, true, lines.join('\n'));
  assert.ok(r.steps.length >= 12);
  assert.ok(!lines.join('\n').match(/demo-[A-Za-z0-9_-]{16}/), 'no generated password is printed');
});
