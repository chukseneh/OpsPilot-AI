// Dashboard server over real HTTP (STORY-011). Run with: node --test "tests/*.test.mjs"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDashboardServer } from '../src/dashboard/server.js';
import { createDashboardData } from '../src/dashboard/data.js';
import * as pages from '../src/dashboard/render.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';
import { createAnalysisService } from '../src/analysis/service.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { sampleInvoiceProcess } from '../src/demo/sampleProcessData.js';

const servers = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

const newAudit = () => createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'dsrv-')), 'audit.jsonl') });

async function storeWith(ids) {
  const store = createMemoryResultStore();
  const service = createAnalysisService({ audit: newAudit(), store });
  for (const id of ids) await service.runAnalysis({ analysisId: id, user: { id: 'analyst-7', role: 'process analyst' }, dataset: sampleInvoiceProcess() });
  return store;
}

async function start({ store, audit = newAudit(), render, data } = {}) {
  const dashboard = createDashboardServer({ data: data ?? createDashboardData({ store: store ?? createMemoryResultStore() }), audit, render });
  const { url } = await dashboard.listen();
  servers.push(dashboard);
  return { url, audit };
}

// Signs in through the real form and returns the cookie the browser would keep.
async function signIn(url, userId, role) {
  const res = await fetch(`${url}/sign-in`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ userId, role }),
  });
  assert.equal(res.status, 303);
  return res.headers.get('set-cookie').split(';')[0];
}

const get = (url, path, cookie) => fetch(`${url}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const DECODE = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&(quot|#39|lt|gt|amp);/g, (m) => DECODE[m]).replace(/\s+/g, ' ');

// ---- Acceptance 1: data available → results and automation opportunities ----

test('a data analyst sees the analysis results and automation opportunities', async () => {
  const { url, audit } = await start({ store: await storeWith(['AN-1', 'AN-2']) });
  const cookie = await signIn(url, 'da-1', 'data analyst');
  const res = await get(url, '/', cookie);
  const page = visible(await res.text());

  assert.equal(res.status, 200);
  assert.match(page, /Biggest issue: cases wait a long time before "Manager approval"/);
  assert.match(page, /Automation opportunities \(3\)/);
  assert.match(page, /"Enter invoice into system" may be a candidate for automation/);
  assert.match(page, /2 analyses available/);

  const view = audit.readAll().find((e) => e.action === 'dashboard.viewed');
  assert.equal(view.actor.id, 'da-1');
  assert.deepEqual(view.detail.analysesListed, ['AN-2', 'AN-1']);
  assert.equal(view.detail.latestShown, 'AN-2');
  assert.equal(view.detail.noData, false);
});

test('one analysis can be opened in full, and the view is logged with its id', async () => {
  const { url, audit } = await start({ store: await storeWith(['AN-1']) });
  const cookie = await signIn(url, 'pa-2', 'Process_Analyst');
  const res = await get(url, '/analyses/AN-1', cookie);
  assert.equal(res.status, 200);
  assert.match(visible(await res.text()), /What this report does not tell you/);
  const view = audit.readAll().find((e) => e.action === 'dashboard.viewed');
  assert.deepEqual([view.actor.id, view.detail.page, view.detail.analysisId], ['pa-2', 'analysis', 'AN-1']);
});

// ---- Acceptance 2: no data → a message saying so ----

test('with no data, the dashboard says no data is present', async () => {
  const { url, audit } = await start();
  const cookie = await signIn(url, 'da-1', 'data analyst');
  const res = await get(url, '/', cookie);
  assert.equal(res.status, 200);
  assert.match(visible(await res.text()), /No process analysis data is available yet\./);
  const view = audit.readAll().find((e) => e.action === 'dashboard.viewed');
  assert.equal(view.detail.noData, true);
  assert.deepEqual(view.detail.analysesListed, []);
});

// ---- Acceptance 3: every access and data view is logged ----

test('every request is logged with a timestamp and a user id (or "anonymous"), and the chain verifies', async () => {
  const { url, audit } = await start({ store: await storeWith(['AN-1']) });
  await get(url, '/sign-in');
  await get(url, '/'); // not signed in
  const cookie = await signIn(url, 'da-1', 'data analyst');
  await get(url, '/', cookie);
  await get(url, '/analyses/AN-1', cookie);
  await get(url, '/analyses/missing', cookie);
  await get(url, '/nowhere', cookie);
  await fetch(`${url}/sign-out`, { method: 'POST', headers: { cookie }, redirect: 'manual' });

  const entries = audit.readAll();
  assert.deepEqual(entries.map((e) => [e.action, e.actor.id]), [
    ['dashboard.accessed', 'anonymous'],
    ['dashboard.denied', 'anonymous'],
    ['dashboard.signed_in', 'da-1'],
    ['dashboard.viewed', 'da-1'],
    ['dashboard.viewed', 'da-1'],
    ['dashboard.not_found', 'da-1'],
    ['dashboard.not_found', 'da-1'],
    ['dashboard.signed_out', 'da-1'],
  ]);
  for (const e of entries) assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Set(entries.map((e) => e.correlationId)).size, 8, 'each request has its own correlation id');
  assert.equal(audit.verify().ok, true);
});

// ---- Failure path: unauthorized access ----

test('not signed in gets 401, a role that is not allowed gets 403, and no data is shown to either', async () => {
  const { url, audit } = await start({ store: await storeWith(['AN-1']) });
  const anon = await get(url, '/');
  assert.equal(anon.status, 401);
  assert.doesNotMatch(await anon.text(), /Manager approval/);

  const cookie = await signIn(url, 'intern-3', 'intern');
  for (const path of ['/', '/analyses/AN-1']) {
    const res = await get(url, path, cookie);
    assert.equal(res.status, 403);
    const body = visible(await res.text());
    assert.match(body, /Role "intern" may not view the dashboard/);
    assert.doesNotMatch(body, /Manager approval/);
  }
  const denials = audit.readAll().filter((e) => e.action === 'dashboard.denied');
  assert.deepEqual(denials.map((e) => [e.actor.id, e.detail.status]), [['anonymous', 401], ['intern-3', 403], ['intern-3', 403]]);
});

test('a forged or garbled cookie counts as not signed in', async () => {
  const { url } = await start({ store: await storeWith(['AN-1']) });
  assert.equal((await get(url, '/', 'opspilot_demo_user=not-base64-json')).status, 401);
  const tooLong = Buffer.from(JSON.stringify({ id: 'x'.repeat(500), role: 'data analyst' })).toString('base64url');
  assert.equal((await get(url, '/', `opspilot_demo_user=${tooLong}`)).status, 401);
});

test('sign-in with a blank field is refused, and an oversized form is rejected', async () => {
  const { url, audit } = await start();
  const blank = await fetch(`${url}/sign-in`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'userId=&role=data+analyst' });
  assert.equal(blank.status, 400);
  assert.match(visible(await blank.text()), /Enter a user id and a role/);
  const huge = await fetch(`${url}/sign-in`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `userId=${'a'.repeat(10000)}&role=x` });
  assert.equal(huge.status, 413);
  assert.deepEqual(audit.readAll().map((e) => e.action), ['dashboard.sign_in_rejected', 'dashboard.sign_in_rejected']);
});

// ---- Failure path: data retrieval failure ----

test('when the data cannot be read, the user gets a 503 "could not load" page and it is logged', async () => {
  const broken = { list: () => { throw new Error('disk unplugged'); }, get: () => { throw new Error('disk unplugged'); } };
  const { url, audit } = await start({ store: broken });
  const cookie = await signIn(url, 'da-1', 'data analyst');
  const res = await get(url, '/', cookie);
  assert.equal(res.status, 503);
  assert.match(visible(await res.text()), /The analysis data could not be loaded just now \(Could not read the saved analyses: disk unplugged\)/);
  const entry = audit.readAll().find((e) => e.action === 'dashboard.data_error');
  assert.equal(entry.actor.id, 'da-1');
  assert.ok(!audit.readAll().some((e) => e.action === 'dashboard.viewed'));
});

// ---- Failure path: dashboard rendering error ----

test('when a page fails to build, the user gets a clean 500 page (not half a page) and it is logged', async () => {
  const faulty = { ...pages, renderDashboard: () => { throw new TypeError('template bug'); } };
  const { url, audit } = await start({ store: await storeWith(['AN-1']), render: faulty });
  const cookie = await signIn(url, 'da-1', 'data analyst');
  const res = await get(url, '/', cookie);
  const body = await res.text();
  assert.equal(res.status, 500);
  assert.match(visible(body), /Could not show this page/);
  assert.match(body, /<\/html>$/, 'a complete page');
  assert.doesNotMatch(body, /Manager approval/);
  assert.match(audit.readAll().find((e) => e.action === 'dashboard.render_error').rationale, /TypeError: template bug/);
});

test('even if the error page itself fails, a fixed fallback page is sent', async () => {
  const faulty = { ...pages, renderDashboard: () => { throw new Error('a'); }, renderError: () => { throw new Error('b'); } };
  const { url } = await start({ store: await storeWith(['AN-1']), render: faulty });
  const cookie = await signIn(url, 'da-1', 'data analyst');
  const res = await get(url, '/', cookie);
  assert.equal(res.status, 500);
  assert.match(await res.text(), /Something went wrong/);
});

// ---- Guardrail: no unrecorded data view ----

test('if the audit log cannot be written, no data is shown', async () => {
  const real = newAudit();
  const failOnView = { ...real, append: (e) => { if (e.action === 'dashboard.viewed') throw new AuditWriteError('disk full'); return real.append(e); }, readAll: () => real.readAll() };
  const { url } = await start({ store: await storeWith(['AN-1']), audit: failOnView });
  const cookie = await signIn(url, 'da-1', 'data analyst');
  const res = await get(url, '/', cookie);
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.doesNotMatch(body, /Manager approval/);
  assert.match(body, /could not be completed or recorded, so nothing was shown/);
});

test('pages carry headers that block scripts and caching', async () => {
  const { url } = await start();
  const res = await get(url, '/sign-in');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /script-src/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const cookie = (await fetch(`${url}/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'userId=a&role=b' })).headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});
