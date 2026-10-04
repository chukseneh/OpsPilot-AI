// The process analysis dashboard (STORY-011, REQ-013): a small web server that
// shows the reports the STORY-002 analysis service saved.
//
//   GET  /               the dashboard: latest results, automation opportunities, every analysis
//   GET  /analyses/:id   one analysis in full
//   GET  /sign-in        demo sign-in form          POST /sign-in   sign in
//   POST /sign-out       sign out
//
// Every request is written to the audit log (REQ-008) with the user id (or
// "anonymous") and the time: page views record WHICH analyses were shown, and
// refusals and errors record why. The entry is written BEFORE the page is sent;
// if it cannot be written, no data is shown (fail closed).
//
// Failure paths:
//   not signed in → 401        role not allowed → 403
//   data cannot be read → 503  a page cannot be built → 500 (never half a page)
//
// Sign-in is a DEMO stand-in: the user id and role are whatever was typed, kept in
// a cookie. The permission check and the audit trail are real; the identity is not.
// Listens on 127.0.0.1 by default, so it is not reachable from other machines.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import * as pages from './render.js';
import { DashboardDataError } from './data.js';
import { roleAllowed } from '../lib/roles.js';

export const DASHBOARD_ROLES = Object.freeze(['data analyst', 'process analyst', 'operations manager']);
const COOKIE = 'opspilot_demo_user';
const MAX_BODY_BYTES = 4096;
const MAX_FIELD = 64;
const ANONYMOUS = { type: 'anonymous', id: 'anonymous' };

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // No page needs script; inline styles only; forms post back to this server.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

// Last resort when even the error page cannot be built or the audit log failed.
const FALLBACK_500 = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Error</title></head><body>'
  + '<h1>Something went wrong</h1><p>The request could not be completed or recorded, so nothing was shown. Try again later.</p></body></html>';

class RequestProblem extends Error {
  constructor(status, message) { super(message); this.name = 'RequestProblem'; this.status = status; }
}

const validField = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_FIELD;

function readUser(req) {
  const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  try {
    const { id, role } = JSON.parse(Buffer.from(raw.slice(COOKIE.length + 1), 'base64url').toString('utf8'));
    return validField(id) && validField(role) ? { id: id.trim(), role: role.trim() } : null;
  } catch {
    return null; // a cookie we cannot read is the same as no sign-in
  }
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestProblem(413, 'The form was too large.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createDashboardServer({ data, audit, roles = DASHBOARD_ROLES, render = pages, requestTimeoutMs = 10000 }) {
  if (!data?.listAnalyses || !audit?.append) throw new TypeError('createDashboardServer needs data and audit');

  function send(res, status, html, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(html);
  }

  // Build an error page; if even that fails, use the fixed fallback.
  function errorPage(user, status, title, message) {
    try {
      return render.renderError({ user, status, title, message });
    } catch (err) {
      console.error('Dashboard: the error page itself failed to render', err);
      return FALLBACK_500;
    }
  }

  async function route(req, res) {
    const correlationId = `dashboard-${randomUUID()}`;
    const user = readUser(req);
    const actor = user ? { type: 'person', id: user.id } : ANONYMOUS;
    const log = (action, fields = {}, who = actor) => audit.append({ correlationId, actor: who, action, ...fields });
    const url = new URL(req.url, 'http://dashboard.local');
    const path = url.pathname;
    const refuse = (status, title, message, action = 'dashboard.denied') => {
      log(action, { subject: path, rationale: message, detail: { status, role: user?.role ?? null } });
      send(res, status, errorPage(user, status, title, message));
    };

    // ---- Public: sign in and out ----
    if (path === '/sign-in' && req.method === 'GET') {
      log('dashboard.accessed', { subject: path }); // before rendering, so the access is recorded even if that fails
      return send(res, 200, render.renderSignIn({ roles }));
    }
    if (path === '/sign-in' && req.method === 'POST') {
      let form;
      try {
        form = await readForm(req);
      } catch (err) {
        if (err instanceof RequestProblem) return refuse(err.status, 'Sign-in refused', err.message, 'dashboard.sign_in_rejected');
        throw err;
      }
      const id = form.get('userId') ?? '';
      const role = form.get('role') ?? '';
      if (!validField(id) || !validField(role)) {
        const why = `Enter a user id and a role (each up to ${MAX_FIELD} characters).`;
        log('dashboard.sign_in_rejected', { subject: path, rationale: why }, ANONYMOUS);
        return send(res, 400, render.renderSignIn({ error: why, roles }));
      }
      const who = { id: id.trim(), role: role.trim() };
      log('dashboard.signed_in', { subject: path, detail: { role: who.role } }, { type: 'person', id: who.id });
      const value = Buffer.from(JSON.stringify(who)).toString('base64url');
      return send(res, 303, '', { Location: '/', 'Set-Cookie': `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` });
    }
    if (path === '/sign-out' && req.method === 'POST') {
      log('dashboard.signed_out', { subject: path });
      return send(res, 303, '', { Location: '/sign-in', 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }

    // ---- Everything else needs a signed-in user with an allowed role ----
    const isDashboard = path === '/';
    const analysisMatch = /^\/analyses\/([^/]+)$/.exec(path);
    if (!isDashboard && !analysisMatch) return refuse(404, 'Page not found', `There is no page at ${path}.`, 'dashboard.not_found');
    if (req.method !== 'GET') {
      log('dashboard.denied', { subject: path, rationale: `${req.method} is not allowed here.`, detail: { status: 405 } });
      return send(res, 405, errorPage(user, 405, 'Not allowed', `${req.method} is not allowed here.`), { Allow: 'GET' });
    }
    if (!user) return refuse(401, 'Please sign in', 'Sign in to see the process analysis dashboard.');
    if (!roleAllowed(user.role, roles)) {
      return refuse(403, 'Not allowed', `Role "${user.role}" may not view the dashboard; allowed roles: ${roles.join(', ')}.`);
    }

    // ---- Load the data ----
    let view;
    try {
      if (isDashboard) {
        const { analyses, skipped } = await data.listAnalyses();
        const latest = analyses.length ? await data.getAnalysis(analyses[0].analysisId) : null;
        if (analyses.length && !latest) throw new DashboardDataError('The latest analysis could not be loaded');
        view = { kind: 'dashboard', analyses, skipped, latest };
      } else {
        let analysisId;
        try {
          analysisId = decodeURIComponent(analysisMatch[1]);
        } catch {
          return refuse(400, 'Bad address', 'That analysis address is not valid.', 'dashboard.not_found');
        }
        const report = await data.getAnalysis(analysisId);
        if (!report) return refuse(404, 'Analysis not found', `There is no completed analysis called ${analysisId}.`, 'dashboard.not_found');
        view = { kind: 'analysis', report };
      }
    } catch (err) {
      if (!(err instanceof DashboardDataError)) throw err;
      log('dashboard.data_error', { subject: path, rationale: err.message });
      return send(res, 503, errorPage(user, 503, 'Could not load the data', `The analysis data could not be loaded just now (${err.message}). Try again shortly.`));
    }

    // ---- Build the page; a failure here must not send half a page ----
    let html;
    try {
      if (view.kind === 'analysis') html = render.renderAnalysis({ user, report: view.report });
      else if (view.analyses.length) html = render.renderDashboard({ user, analyses: view.analyses, skipped: view.skipped, latest: view.latest });
      else html = render.renderNoData({ user, skipped: view.skipped });
    } catch (err) {
      console.error('Dashboard: page failed to render', err);
      log('dashboard.render_error', { subject: path, rationale: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` });
      return send(res, 500, errorPage(user, 500, 'Could not show this page', 'The page could not be built. The problem has been recorded.'));
    }

    // ---- Record the data view, THEN show it ----
    log('dashboard.viewed', {
      subject: path,
      detail: view.kind === 'analysis'
        ? { page: 'analysis', analysisId: view.report.analysisId, role: user.role }
        : {
          page: 'dashboard', role: user.role, noData: view.analyses.length === 0,
          analysesListed: view.analyses.map((a) => a.analysisId), latestShown: view.latest?.analysisId ?? null, skipped: view.skipped,
        },
    });
    return send(res, 200, html);
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      // Includes a failed audit write: nothing was sent yet, so nothing is shown.
      console.error('Dashboard: request failed', err);
      if (res.headersSent) res.destroy(err);
      else send(res, 500, FALLBACK_500);
    }
  }

  const server = http.createServer(handler);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 10000);

  return {
    server,
    handler,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const { port: actual } = server.address();
        resolve({ url: `http://${host}:${actual}` });
      });
    }),
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
