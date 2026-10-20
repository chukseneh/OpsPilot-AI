// The web API (extra to the plan: web access, step 3): JSON over HTTP, in front of
// the existing services. A thin layer: the services keep every permission check
// and every rule; the API only supplies an identity proven by a session.
//
// A route is { method, path, auth, rateLimit?, handle }:
//   path      '/api/v1/accounts/:username' — ":name" parts become ctx.params
//   auth      'public' or 'session'. A session route gets ctx.user from the session
//             cookie — never from the request body — and, if it changes
//             something (anything but GET), also needs the X-CSRF-Token header.
//   rateLimit 'sign-in': at most signInLimit.max requests per window per address.
//   handle    async (ctx) → { status?, body, headers? }
//             ctx = { user, body, params, query, requestId, sessionToken, ip }
//
// Every request gets an audit entry, written BEFORE the reply is sent (if it cannot
// be written, the reply is a 500): api.request when it worked, api.refused (with
// the reason) when the caller was refused, api.error (with the details) when the
// server failed. Request bodies are never logged.
//
// Statuses: 400 bad request, 401 not signed in, 403 not allowed or CSRF, 404, 405,
// 409 conflict, 413 body over 1 MB, 415 not JSON, 429 too many sign-ins,
// 500/503/504 server-side (a fixed message and a reference id; details only in the log).
// Listens on 127.0.0.1 by default. The rate limit keys on the connecting address:
// behind a reverse proxy, that is the proxy, so put the limit there too.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { statusFor, ApiRequestError } from './errors.js';
import { tokenFromCookieHeader } from './sessions.js';

export const MAX_BODY_BYTES = 1024 * 1024;
const SAFE_METHODS = new Set(['GET']);
const ANONYMOUS = { type: 'anonymous', id: 'anonymous' };
const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});
const MAX_LOGGED_CHARS = 200;
const clip = (text) => (text.length > MAX_LOGGED_CHARS ? `${text.slice(0, MAX_LOGGED_CHARS)}… (${text.length} characters)` : text);

function compile(path) {
  const keys = [];
  const pattern = path.split('/').map((part) => {
    if (part.startsWith(':')) { keys.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${pattern}$`), keys };
}

// A sliding window per key, with a cap on how many keys it remembers.
export function createRateLimiter({ max, windowMs, now = () => Date.now(), maxKeys = 10000 }) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => at > t - windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return { allowed: false, retryAfterS: Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.delete(key); // re-insert so the Map's order is least recently used first
      hits.set(key, recent);
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return { allowed: true };
    },
  };
}

async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  // Also a CSRF defence: a plain HTML form cannot send application/json.
  if (type !== 'application/json') throw new ApiRequestError(415, 'Send the request body as JSON, with Content-Type: application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ApiRequestError(413, `The request body is over ${MAX_BODY_BYTES} bytes.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiRequestError(413, `The request body is over ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiRequestError(400, 'The request body is not valid JSON.'); // the body itself is not echoed: it may hold a password
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiRequestError(400, 'The request body must be a JSON object.');
  return body;
}

class HandlerTimeout extends Error {}

export function createApiServer({
  audit, sessions, routes, requestTimeoutMs = 15000, handlerTimeoutMs = 30000,
  signInLimit = { max: 10, windowMs: 60000 }, now = () => Date.now(),
}) {
  if (!audit?.append || !sessions?.authenticate || !Array.isArray(routes)) throw new TypeError('createApiServer needs audit, sessions and routes');
  const compiled = routes.map((r) => ({ ...r, ...compile(r.path) }));
  const limiter = createRateLimiter({ ...signInLimit, now });

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...HEADERS, ...headers });
    res.end(JSON.stringify(body));
  }

  async function route(req, res) {
    const requestId = randomUUID();
    const url = new URL(`http://api.local${req.url}`); // read as sent; see dashboard/server.js
    const subject = `${req.method} ${clip(url.pathname)}`;
    const ip = req.socket.remoteAddress ?? 'unknown';
    let actor = ANONYMOUS;
    const log = (action, fields = {}) => audit.append({ correlationId: `api-${requestId}`, actor, action, subject, ...fields });
    const refuse = (status, message, headers = {}, action = 'api.refused') => {
      log(action, { rationale: message, detail: { status } });
      send(res, status, { error: message, requestId }, headers);
    };

    const onPath = compiled.filter((r) => r.regex.test(url.pathname));
    if (!onPath.length) return refuse(404, `There is no API endpoint at ${clip(url.pathname)}.`);
    const match = onPath.find((r) => r.method === req.method);
    if (!match) {
      const allow = [...new Set(onPath.map((r) => r.method))].join(', ');
      return refuse(405, `${req.method} is not allowed here; use ${allow}.`, { Allow: allow });
    }
    const params = {};
    try {
      match.regex.exec(url.pathname).slice(1).forEach((v, i) => { params[match.keys[i]] = decodeURIComponent(v); });
    } catch {
      return refuse(400, 'The address is not valid.');
    }

    if (match.rateLimit === 'sign-in') {
      const { allowed, retryAfterS } = limiter.take(ip);
      if (!allowed) return refuse(429, `Too many sign-in attempts from this address; try again in ${retryAfterS} s.`, { 'Retry-After': String(retryAfterS) }, 'api.rate_limited');
    }

    const changesSomething = !SAFE_METHODS.has(req.method);
    let body = {};
    let user = null;
    let sessionToken = null;
    try {
      if (changesSomething) body = await readJson(req);
      if (match.auth !== 'public') {
        sessionToken = tokenFromCookieHeader(req.headers.cookie);
        const who = await sessions.authenticate({ token: sessionToken, csrfToken: req.headers['x-csrf-token'], changesSomething });
        if (!who.ok && who.reason === 'csrf') return refuse(403, 'This request needs the X-CSRF-Token header from sign-in.');
        if (!who.ok) return refuse(401, 'Please sign in.');
        user = who.user;
        actor = { type: 'person', id: user.id };
      }
    } catch (err) {
      if (err instanceof ApiRequestError) return refuse(err.status, err.message);
      throw err;
    }

    let timer;
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new HandlerTimeout()), handlerTimeoutMs); });
      const result = await Promise.race([match.handle({ user, body, params, query: url.searchParams, requestId, sessionToken, ip }), deadline]);
      const status = result?.status ?? 200;
      log('api.request', { detail: { status } });
      return send(res, status, result?.body ?? {}, result?.headers);
    } catch (err) {
      if (err instanceof HandlerTimeout) {
        log('api.error', { rationale: `No answer within ${handlerTimeoutMs} ms; the work may still finish.`, detail: { status: 504 } });
        return send(res, 504, { error: 'The request took too long. It may still complete: check before trying again.', requestId });
      }
      const { status, message } = statusFor(err);
      if (status < 500) return refuse(status, message);
      log('api.error', { rationale: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`, detail: { status } });
      return send(res, status, {
        error: status === 503 ? 'A service is unavailable just now. Try again shortly.' : 'Something went wrong. The problem has been recorded.',
        requestId,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      // Includes a failed audit write: the reply says nothing about the request.
      console.error('API: request failed', err);
      if (res.headersSent) res.destroy(err);
      else send(res, 500, { error: 'The request could not be completed or recorded.' });
    }
  }

  const server = http.createServer(handler);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 10000);

  return {
    server,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve({ url: `http://${host}:${server.address().port}` });
      });
    }),
    // Stops taking requests, lets the ones in progress finish, and drops idle keep-alive connections.
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeIdleConnections();
    }),
  };
}
