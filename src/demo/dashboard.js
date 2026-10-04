// STORY-011 demo: the process analysis dashboard, on real saved analyses made by
// the STORY-002 demo from SYNTHETIC invoice data.
//
//   node src/demo/dashboard.js            start it; open the printed address in a browser
//   node src/demo/dashboard.js --check    scripted walk-through, then exit
//   options: --port 4310   --out ./demo
//
// In the browser, sign in as  da-1 / data analyst  to see the results, and as
// intern-3 / intern  to see the refusal. Sign-in is a demo stand-in (no password).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { createFileResultStore, createMemoryResultStore } from '../orchestration/resultStore.js';
import { createDashboardData } from '../dashboard/data.js';
import { createDashboardServer } from '../dashboard/server.js';
import { runAnalysisDemo } from './analyse.js';

export async function startDashboardDemo({ outDir, port = 0 } = {}) {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'opspilot-dashboard-'));
  await runAnalysisDemo({ outDir: dir, print: () => {} }); // saves analyses.json and audit.jsonl in dir
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const dashboard = createDashboardServer({
    data: createDashboardData({ store: createFileResultStore({ file: join(dir, 'analyses.json') }) }),
    audit,
  });
  const { url } = await dashboard.listen(port);
  return { url, dashboard, audit, dir };
}

async function signIn(url, userId, role) {
  const res = await fetch(`${url}/sign-in`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ userId, role }),
  });
  return res.headers.get('set-cookie')?.split(';')[0];
}

const DECODE = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, '\n')
  .replace(/&(quot|#39|lt|gt|amp);/g, (m) => DECODE[m]).split('\n').map((l) => l.trim()).filter(Boolean);

// Did every step of the walk-through behave as it should? (Used for the exit code.)
export const walkthroughPassed = (r) => r.anonymous?.status === 401 && r.analyst?.status === 200 && r.intern?.status === 403
  && r.noData?.status === 200 && r.noData.lines.some((l) => /No process analysis data/.test(l)) && r.audit?.ok === true;

export async function runDashboardCheck({ print = console.log } = {}) {
  const started = [];
  // Every server that started is closed, even if a later step fails.
  const closeAll = () => Promise.all(started.map((s) => s.close()));
  try {
    return await walkthrough(print, started);
  } finally {
    await closeAll();
  }
}

async function walkthrough(print, started) {
  const { url, dashboard, audit, dir } = await startDashboardDemo();
  started.push(dashboard);
  const firstSeq = audit.readAll().length;
  const empty = createDashboardServer({ data: createDashboardData({ store: createMemoryResultStore() }), audit });
  const { url: emptyUrl } = await empty.listen();
  started.push(empty);
  const get = async (base, path, cookie) => {
    const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    return { status: res.status, lines: visible(await res.text()) };
  };
  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  const results = {};

  print(`OpsPilot AI — process analysis dashboard demo (SYNTHETIC data). Dashboard at ${url}`);

  rule('1. Someone opens the dashboard without signing in');
  results.anonymous = await get(url, '/');
  print(`HTTP ${results.anonymous.status}: ${results.anonymous.lines.find((l) => /Sign in to see/.test(l))}`);

  rule('2. da-1 (data analyst) signs in and opens the dashboard');
  const analyst = await signIn(url, 'da-1', 'data analyst');
  results.analyst = await get(url, '/', analyst);
  const l = results.analyst.lines;
  print(`HTTP ${results.analyst.status}`);
  for (const line of [l.find((x) => x.startsWith('Biggest issue')), ...l.filter((x) => /^(Automation opportunities|Bottlenecks|Duplicated work) \(\d+\)$/.test(x) || /^F\d+\. /.test(x))]) {
    print(`  ${line}`);
  }

  rule('3. intern-3 (intern) signs in and tries');
  const intern = await signIn(url, 'intern-3', 'intern');
  results.intern = await get(url, '/', intern);
  print(`HTTP ${results.intern.status}: ${results.intern.lines.find((x) => /may not view/.test(x))}`);

  rule('4. da-1 opens a dashboard with no analyses saved yet');
  results.noData = await get(emptyUrl, '/', analyst);
  print(`HTTP ${results.noData.status}: ${results.noData.lines.find((x) => /No process analysis data/.test(x))}`);

  rule('5. Audit trail for these dashboard requests (timestamp, user id, what happened)');
  results.entries = audit.readAll().slice(firstSeq);
  for (const e of results.entries) {
    const what = e.action === 'dashboard.viewed'
      ? (e.detail.noData ? 'saw: no data' : e.detail.page === 'analysis' ? `saw: ${e.detail.analysisId}` : `saw: ${e.detail.analysesListed.join(', ')}`)
      : (e.rationale ?? e.subject ?? '');
    print(`  ${e.at}  ${e.actor.id.padEnd(10)} ${e.action.padEnd(26)} ${what}`);
  }
  results.audit = audit.verify();
  print(`\nAudit chain: ${results.audit.ok ? `verified — ${results.audit.count} entries in ${join(dir, 'audit.jsonl')}` : `BROKEN at #${results.audit.brokenAt}`}`);
  print(walkthroughPassed(results) ? 'Walk-through: every step behaved as expected.' : 'Walk-through: SOMETHING DID NOT BEHAVE AS EXPECTED (see above).');
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
  if (process.argv.includes('--check')) {
    runDashboardCheck().then(
      (r) => { process.exitCode = walkthroughPassed(r) ? 0 : 1; },
      (err) => { console.error(err); process.exitCode = 1; },
    );
  } else {
    const out = arg('--out');
    const port = Number(arg('--port') ?? 4310);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('--port needs a number from 0 to 65535, e.g. --port 4311');
      process.exit(1);
    }
    startDashboardDemo({ outDir: out ? resolve(out) : undefined, port }).then(
      ({ url, dashboard, dir }) => {
        console.log(`OpsPilot dashboard running at ${url}   (SYNTHETIC demo data in ${dir})`);
        console.log('Sign in as  da-1 / data analyst  to see results, or  intern-3 / intern  to see a refusal. Ctrl+C to stop.');
        process.once('SIGINT', () => { dashboard.close().then(() => process.exit(0)); });
      },
      (err) => {
        console.error(err.code === 'EADDRINUSE' ? `Port in use; try --port 4311 (${err.message})` : err);
        process.exitCode = 1;
      },
    );
  }
}
