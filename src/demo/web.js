// Web access demo: the real system, started with WEB_PORT, used only over HTTP.
//
//   npm run demo:web            (node src/demo/web.js)
//
// A security officer signs in and creates accounts; an IT manager registers an AI
// system; one process manager asks to pause it (a high-risk action, so it waits);
// they may not approve it themselves; a second process manager approves it and it
// runs; the security officer reads that workflow's audit trail. Everything runs on
// a throwaway local database and audit log in a temp folder, with a random signing
// key and random passwords that are used in memory and never printed. Nothing here
// touches a network beyond 127.0.0.1.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { startOpsPilot } from '../system.js';

const newPassword = () => `demo-${randomBytes(12).toString('base64url')}`;
const SYSTEM = {
  id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications', owner: 'hr-lead-1',
  status: 'active', dataCategories: ['personal'], decisionImpact: 'significant', humanOversight: 'none', userFacing: false,
};

export async function runWebDemo({ print = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-web-demo-'));
  const system = await startOpsPilot({
    env: { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl'), WEB_PORT: '0' },
  });
  const steps = [];
  const step = (text, ok) => { steps.push({ text, ok }); print(`  ${ok ? '✓' : '✗'} ${text}`); };
  try {
    const url = system.webUrl;
    print(`OpsPilot AI — web API demo, at ${url} (local only)\n`);
    const call = async (method, path, { body, as } = {}) => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(as ? { Cookie: as.cookie, 'X-CSRF-Token': as.csrf } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
    };
    const passwords = { 'sec.admin': newPassword() };
    const signIn = async (username) => {
      const r = await call('POST', '/api/v1/auth/sign-in', { body: { username, password: passwords[username] } });
      if (r.status !== 200) throw new Error(`${username} could not sign in: ${r.json.error}`);
      return { cookie: r.cookie, csrf: r.json.csrfToken };
    };

    // 1. The first account, as `npm run create-first-admin` would make it.
    await system.services.accounts.bootstrapFirstAdmin({ username: 'sec.admin', password: passwords['sec.admin'], displayName: 'Security Admin' });
    const admin = await signIn('sec.admin');
    step('the security officer signs in (the session token stays in an HttpOnly cookie)', Boolean(admin.cookie));

    for (const [username, role] of [['it.manager', 'IT manager'], ['pm.alice', 'process manager'], ['pm.bob', 'process manager']]) {
      passwords[username] = newPassword();
      const r = await call('POST', '/api/v1/accounts', { as: admin, body: { username, displayName: username, role, password: passwords[username], reason: 'Demo team' } });
      step(`account ${username} (${role}) created → ${r.status}`, r.status === 201);
    }
    const noCsrf = await call('POST', '/api/v1/accounts', { as: { cookie: admin.cookie }, body: { username: 'mallory', displayName: 'M', role: 'security officer', password: newPassword(), reason: 'x' } });
    step(`a request without the CSRF token is refused → ${noCsrf.status}`, noCsrf.status === 403);

    // 2. The system to act on.
    const it = await signIn('it.manager');
    const reg = await call('POST', '/api/v1/inventory/systems', { as: it, body: { system: SYSTEM, reason: 'Recorded for oversight' } });
    step(`the IT manager registers "${SYSTEM.name}" → ${reg.status}`, reg.status === 201);

    // 3. A high-risk action waits for a second person.
    const alice = await signIn('pm.alice');
    const workflow = {
      workflowId: 'WF-DEMO-WEB', name: 'Pause the CV screener for a bias review',
      actions: [{ type: 'inventory.update_status', params: { systemId: SYSTEM.id, status: 'paused', expectedVersion: 1, reason: 'Bias review' } }],
    };
    const started = await call('POST', '/api/v1/workflows', { as: alice, body: workflow });
    const first = started.json.workflow?.actions?.[0];
    step(`pm.alice starts the workflow; the step is ${first?.riskLevel} risk and ${first?.status}`, first?.status === 'awaiting_approval');
    const own = await call('POST', '/api/v1/workflows/WF-DEMO-WEB/steps/1/decision', { as: alice, body: { decision: 'approve', note: 'mine' } });
    step(`pm.alice may not approve their own workflow → ${own.status}: ${own.json.error}`, own.status === 400);

    const bob = await signIn('pm.bob');
    const approved = await call('POST', '/api/v1/workflows/WF-DEMO-WEB/steps/1/decision', { as: bob, body: { decision: 'approve', note: 'Bias review agreed with HR' } });
    step(`pm.bob approves → the workflow is ${approved.json.workflow?.run?.status}`, approved.json.workflow?.run?.status === 'completed');
    const inventory = await call('GET', '/api/v1/inventory', { as: it });
    const status = inventory.json.systems?.find((s) => s.id === SYSTEM.id)?.status;
    step(`the inventory now shows the system as ${status}`, status === 'paused');

    // 4. The record of it.
    const trail = await call('GET', '/api/v1/audit?correlationId=WF-DEMO-WEB', { as: admin });
    step(`the security officer reads the workflow's audit trail: ${trail.json.entries?.length} entries, integrity ${trail.json.integrity?.ok ? 'verified' : 'BROKEN'}`, trail.json.integrity?.ok === true);
    for (const e of trail.json.entries ?? []) print(`      #${String(e.seq).padEnd(4)} ${e.actor.id.padEnd(16)} ${e.action.padEnd(32)} ${e.rationale ?? ''}`);
    const denied = await call('GET', '/api/v1/audit', { as: alice });
    step(`a process manager may not read the audit log → ${denied.status}`, denied.status === 403);
  } finally {
    await system.stop();
  }
  const ok = steps.every((s) => s.ok);
  print(`\n${ok ? 'Every step behaved as expected.' : 'SOME STEPS DID NOT BEHAVE AS EXPECTED.'} Files: ${dir}`);
  return { ok, steps, dir };
}

// Run when called as a script, not when imported by a test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runWebDemo().then(
    (r) => { process.exitCode = r.ok ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
