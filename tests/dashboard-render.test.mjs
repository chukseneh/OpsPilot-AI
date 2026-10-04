// Dashboard pages (STORY-011). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderDashboard, renderNoData, renderAnalysis, renderSignIn, renderError, esc } from '../src/dashboard/render.js';
import { createDashboardData } from '../src/dashboard/data.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';
import { createAnalysisService } from '../src/analysis/service.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { sampleInvoiceProcess } from '../src/demo/sampleProcessData.js';

const viewer = { id: 'da-1', role: 'data analyst' };
// What a reader sees: tags removed and entities decoded, as a browser would show it.
const DECODE = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const text = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ')
  .replace(/&(quot|#39|lt|gt|amp);/g, (m) => DECODE[m]).replace(/\s+/g, ' ');

async function realData(process = 'Invoice approval') {
  const store = createMemoryResultStore();
  const service = createAnalysisService({ audit: createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'r-')), 'a.jsonl') }), store });
  await service.runAnalysis({ analysisId: 'AN-1', user: { id: 'analyst-7', role: 'process analyst' }, dataset: { ...sampleInvoiceProcess(), process } });
  const data = createDashboardData({ store });
  const { analyses, skipped } = await data.listAnalyses();
  return { analyses, skipped, latest: await data.getAnalysis(analyses[0].analysisId) };
}

test('the dashboard shows the latest results and its automation opportunities, and lists every analysis', async () => {
  const d = await realData();
  const html = renderDashboard({ user: viewer, ...d });
  const t = text(html);
  assert.match(t, /Process analysis results/);
  assert.match(t, /Biggest issue: cases wait a long time before "Manager approval"/);
  assert.match(t, /Automation opportunities \(3\)/);
  assert.match(t, /"Enter invoice into system" may be a candidate for automation/);
  assert.match(t, /Bottlenecks \(3\)/);
  assert.match(t, /Duplicated work \(2\)/);
  assert.match(html, /href="\/analyses\/AN-1"/);
  assert.match(t, /Signed in as da-1 \(data analyst\)/);
  assert.match(t, /stand-in for real authentication/);
});

test('with no data, the page says so and explains how data arrives', () => {
  const t = text(renderNoData({ user: viewer }));
  assert.match(t, /No process analysis data is available yet\./);
  assert.match(t, /once a process analyst or operations manager runs an analysis/);
});

test('damaged records are mentioned, not silently hidden', async () => {
  const d = await realData();
  assert.match(text(renderDashboard({ user: viewer, ...d, skipped: 2 })), /2 saved analyses could not be read and are not shown/);
  assert.match(text(renderNoData({ user: viewer, skipped: 1 })), /1 saved analysis could not be read and is not shown/);
});

test('the analysis page shows the full report: findings, method and limits', async () => {
  const { latest } = await realData();
  const t = text(renderAnalysis({ user: viewer, report: latest }));
  assert.match(t, /F1\. Cases wait a long time before "Manager approval"/);
  assert.match(t, /Example cases: INV-\d+/);
  assert.match(t, /How this was found/);
  assert.match(t, /What this report does not tell you/);
  assert.match(t, /does not estimate savings/);
});

test('report content is shown as text, never run as markup or script', async () => {
  const d = await realData('<script>alert("x")</script> & co');
  const html = renderDashboard({ user: { id: '<img src=x onerror=alert(1)>', role: 'data analyst' }, ...d });
  assert.ok(!html.includes('<script>alert'), 'no live script tag');
  assert.ok(!html.includes('<img src=x'), 'no live img tag');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co'));
  assert.equal(esc(`<a href='x'>`), '&lt;a href=&#39;x&#39;&gt;');
});

test('sign-in and error pages say what happened in plain words', () => {
  const signIn = text(renderSignIn({ error: 'Enter a user id and a role.', roles: ['data analyst'] }));
  assert.match(signIn, /Allowed roles: data analyst/);
  assert.match(signIn, /Enter a user id and a role\./);
  const forbidden = renderError({ user: viewer, status: 403, title: 'Not allowed', message: 'Role "intern" may not view the dashboard.' });
  assert.match(text(forbidden), /Not allowed Role "intern" may not view the dashboard\. Back to the dashboard HTTP 403/);
  assert.match(renderError({ status: 401, title: 'Please sign in', message: 'x' }), /href="\/sign-in"/);
});

test('every page is a complete document that works on phones and in dark mode', async () => {
  const d = await realData();
  for (const html of [renderDashboard({ user: viewer, ...d }), renderNoData({ user: viewer }), renderSignIn({ roles: [] }),
    renderError({ status: 500, title: 'x', message: 'y' })]) {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /<\/html>$/);
  }
});
