// Randomised stress test for the dashboard server (STORY-011). Seeded: a failure
// can be replayed from the seed and request number in its message.
//
// Fires hundreds of random requests at once at a real running server — odd methods,
// broken or hostile paths, forged and garbled cookies, malformed sign-in forms —
// over saved analyses whose names contain HTML and script. Then checks, for every
// request:
//   - a sane status, and a complete page (or an empty redirect / HEAD reply)
//   - data appears only for a signed-in allowed role on a real dashboard address
//   - nothing from the saved data appears as live markup
//   - exactly one audit entry, under the right user id (or "anonymous")
// and overall: the audit chain verifies and no promise rejection went unhandled.
// A second scenario does the same against a store that randomly fails or stalls.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDashboardServer } from '../src/dashboard/server.js';
import { createDashboardData } from '../src/dashboard/data.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';
import { createAnalysisService } from '../src/analysis/service.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { sampleInvoiceProcess } from '../src/demo/sampleProcessData.js';

const MARK = 'ZZSECRETDATAZZ'; // planted in every saved analysis: if it shows, data was shown
const servers = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickFrom = (random, xs) => xs[Math.floor(random() * xs.length)];

async function hostileStore(count) {
  const store = createMemoryResultStore();
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'dstress-')), 'a.jsonl') });
  const service = createAnalysisService({ audit, store });
  const names = [`<script>alert(1)</script>${MARK}`, `Invoices & "quotes" ${MARK}`, `<img src=x onerror=alert(2)>${MARK}`, `Ünïcödé ✓ ${MARK}`];
  for (let i = 0; i < count; i += 1) {
    await service.runAnalysis({
      analysisId: `AN-${i}<b>`, user: { id: 'analyst-7', role: 'process analyst' },
      dataset: { ...sampleInvoiceProcess({ cases: 6, seed: i + 1 }), process: names[i % names.length] },
    });
  }
  return store;
}

const cookieFor = (obj) => `opspilot_demo_user=${Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url')}`;
const ALLOWED = ['data analyst', 'Process_Analyst', 'OPERATIONS MANAGER'];

// A random request, with what the checker needs to know about it.
function randomRequest(random, i) {
  const userId = `u${i}`;
  const cookies = [
    { cookie: null, who: null },
    { cookie: cookieFor({ id: userId, role: pickFrom(random, ALLOWED) }), who: { id: userId, allowed: true } },
    { cookie: cookieFor({ id: userId, role: pickFrom(random, ['intern', 'guest', '  ', 'data analystx']) }), who: { id: userId, allowed: false } },
    { cookie: 'opspilot_demo_user=%%%garbage', who: null },
    { cookie: cookieFor('null'), who: null },
    { cookie: cookieFor('[1,2]'), who: null },
    { cookie: cookieFor({ id: 'x'.repeat(200), role: 'data analyst' }), who: null },
    { cookie: `other=1; ${cookieFor({ id: userId, role: 'data analyst' })}; more=2`, who: { id: userId, allowed: true } },
  ];
  let { cookie, who } = pickFrom(random, cookies);
  if (who && cookie.includes(`"role":"  "`)) who = null;
  // A role of only spaces is not a valid sign-in at all.
  if (cookie && /"role":"\s+"/.test(Buffer.from((cookie.split('opspilot_demo_user=')[1] ?? '').split(';')[0], 'base64url').toString())) who = null;

  const path = pickFrom(random, [
    '/', '/', '/analyses/AN-0%3Cb%3E', '/analyses/AN-1%3Cb%3E', '/analyses/nope', '/analyses/%ZZ', '/analyses/a/b',
    '/sign-in', '/sign-out', '/nowhere', '/%00', `/${'x'.repeat(5000)}`, `/analyses/${encodeURIComponent('<script>')}`,
    '//double', '/?q=<script>', '/analyses/', '/../etc/passwd', '/favicon.ico',
  ]);
  const method = pickFrom(random, ['GET', 'GET', 'GET', 'GET', 'POST', 'POST', 'PUT', 'DELETE', 'HEAD']);
  let body;
  if (method === 'POST' || method === 'PUT') {
    body = pickFrom(random, [
      'userId=a1&role=data+analyst', 'userId=&role=', 'role=data+analyst', `userId=${'z'.repeat(9000)}&role=x`,
      'userId=%E2%9C%93&role=%3Cscript%3E', 'garbage-without-equals', '', `userId=${i}&role=intern`,
    ]);
  }
  return { i, method, path, cookie, who, body };
}

async function send(base, r) {
  const res = await fetch(`${base}${r.path}`, {
    method: r.method, redirect: 'manual',
    headers: { ...(r.cookie ? { cookie: r.cookie } : {}), ...(r.body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: r.body,
  });
  return { status: res.status, body: await res.text(), setCookie: res.headers.get('set-cookie') };
}

function checkResponse(r, res, seed, { allowedStatuses }) {
  const where = `seed ${seed} req ${r.i} (${r.method} ${r.path.slice(0, 40)})`;
  assert.ok(allowedStatuses.includes(res.status), `${where}: unexpected status ${res.status}`);
  if (res.status !== 303 && r.method !== 'HEAD') {
    assert.match(res.body, /^<!doctype html>[\s\S]*<\/html>$/, `${where}: incomplete page`);
  }
  if (res.body.includes(MARK)) {
    const pathOnly = r.path.split('?')[0]; // "/?q=…" is the dashboard
    const dataPath = pathOnly === '/' || /^\/analyses\/[^/]+$/.test(pathOnly);
    assert.ok(res.status === 200 && r.method === 'GET' && dataPath && r.who?.allowed, `${where}: data shown when it should not be`);
  }
  // Hostile text planted in the saved data (process names, and the "<b>" inside
  // analysis ids) must only ever appear escaped. The pages' own <b> tags are fine.
  for (const live of [/<script>alert/, /<img src=x/, /AN-\d+<b>/]) {
    assert.ok(!live.test(res.body), `${where}: ${live} appeared as live markup`);
  }
}

function checkAudit(requests, entries, seed) {
  assert.equal(entries.length, requests.length, `seed ${seed}: ${entries.length} audit entries for ${requests.length} requests`);
  assert.equal(new Set(entries.map((e) => e.correlationId)).size, requests.length, `seed ${seed}: correlation ids not unique`);
  // Every entry is by "anonymous" or by a user id we sent (or a sign-in form's user).
  const known = new Set(['anonymous', 'a1', '✓', ...requests.map((r) => `u${r.i}`), ...requests.map((r) => String(r.i))]);
  for (const e of entries) assert.ok(known.has(e.actor.id), `seed ${seed}: unexpected actor ${e.actor.id} on ${e.action}`);
}

// Runs fn over items with at most `limit` in flight at once, keeping results in order.
// (Opening hundreds of connections in the same instant overflows the operating
// system's queue of pending connections on some machines — Windows refuses them —
// which would test the OS, not the dashboard.)
async function inParallel(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

async function withRejectionWatch(fn) {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try { await fn(); await new Promise((res) => setTimeout(res, 50)); } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, [], 'no promise rejection may go unhandled');
}

for (const seed of [5, 17, 404]) {
  test(`dashboard stress (seed ${seed}): 300 random requests at once over hostile data`, { timeout: 120000 }, async () => {
    await withRejectionWatch(async () => {
      const random = rng(seed);
      const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'dstress-')), 'audit.jsonl') });
      const dashboard = createDashboardServer({ data: createDashboardData({ store: await hostileStore(4) }), audit });
      const { url } = await dashboard.listen();
      servers.push(dashboard);

      const requests = Array.from({ length: 300 }, (_, i) => randomRequest(random, i));
      const responses = await inParallel(requests, 50, (r) => send(url, r));
      requests.forEach((r, i) => checkResponse(r, responses[i], seed, { allowedStatuses: [200, 303, 400, 401, 403, 404, 405, 413] }));
      checkAudit(requests, audit.readAll(), seed);
      assert.equal(audit.verify().ok, true);

      // Still serving after all that.
      const ok = await send(url, { i: -1, method: 'GET', path: '/', cookie: cookieFor({ id: 'final', role: 'data analyst' }), who: { allowed: true } });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.includes(MARK));
    });
  });

  test(`dashboard stress (seed ${seed}): a store that randomly fails or stalls gives 200 or 503, never a crash`, { timeout: 120000 }, async () => {
    await withRejectionWatch(async () => {
      const random = rng(seed * 13);
      const real = await hostileStore(2);
      const flaky = {
        list: () => { const r = random(); if (r < 0.25) throw new Error('disk hiccup'); if (r < 0.35) return new Promise(() => {}); return real.list(); },
        get: (id) => { const r = random(); if (r < 0.2) throw new Error('disk hiccup'); return real.get(id); },
      };
      const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'dstress-')), 'audit.jsonl') });
      const dashboard = createDashboardServer({ data: createDashboardData({ store: flaky, timeoutMs: 30 }), audit });
      const { url } = await dashboard.listen();
      servers.push(dashboard);

      const requests = Array.from({ length: 150 }, (_, i) => ({
        i, method: 'GET', path: pickFrom(random, ['/', '/analyses/AN-0%3Cb%3E', '/analyses/AN-1%3Cb%3E']),
        cookie: cookieFor({ id: `u${i}`, role: 'data analyst' }), who: { id: `u${i}`, allowed: true },
      }));
      const responses = await Promise.all(requests.map((r) => send(url, r)));
      requests.forEach((r, i) => checkResponse(r, responses[i], seed, { allowedStatuses: [200, 503] }));
      const statuses = new Set(responses.map((x) => x.status));
      assert.ok(statuses.has(200) && statuses.has(503), `seed ${seed}: expected a mix of 200 and 503, got ${[...statuses]}`);

      const entries = audit.readAll();
      checkAudit(requests, entries, seed);
      responses.forEach((res, i) => {
        const mine = entries.filter((e) => e.actor.id === `u${i}`);
        assert.equal(mine.length, 1, `seed ${seed} req ${i}: ${mine.length} entries`);
        assert.equal(mine[0].action, res.status === 200 ? 'dashboard.viewed' : 'dashboard.data_error', `seed ${seed} req ${i}`);
      });
      assert.equal(audit.verify().ok, true);
    });
  });
}
