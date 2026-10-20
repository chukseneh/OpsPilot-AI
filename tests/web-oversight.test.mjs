// Web access, step 4d: the governance, audit and simulation endpoints, over real HTTP.
// Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGovernanceService, migrateGovernance } from '../src/governance/service.js';
import { examplePack } from '../src/governance/packs/index.js';
import { createAuditReader } from '../src/audit/reader.js';
import { createAuditLog } from '../src/audit/auditLog.js';
import { createSimulationService, migrateSimulations, SimulationNotFoundError } from '../src/simulation/service.js';
import { openPGlite } from '../src/inventory/db.js';
import { migrateAccounts } from '../src/web/accounts.js';
import { migrateSessions } from '../src/web/sessions.js';
import { oversightRoutes } from '../src/web/oversightRoutes.js';
import { startHarness } from './helpers/webHarness.mjs';

const PEOPLE = {
  'co.one': 'compliance officer',
  'co.two': 'compliance officer',
  'sec.officer': 'security officer',
  'tester': 'system tester',
  'da.analyst': 'data analyst',
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

let pg;
before(async () => { pg = await openPGlite(); await migrateGovernance(pg); await migrateSimulations(pg); await migrateAccounts(pg); await migrateSessions(pg); });
after(async () => { await pg.close(); });

async function setup({ waitMs, simulations } = {}) {
  await pg.exec('TRUNCATE policy_versions, simulation_runs');
  const file = join(mkdtempSync(join(tmpdir(), 'web-oversight-')), 'audit.jsonl');
  const audit = createAuditLog({ file });
  const now = () => new Date('2026-10-12T09:00:00Z');
  const h = await startHarness({
    db: pg, people: PEOPLE, audit,
    routes: () => oversightRoutes({
      governance: createGovernanceService({ db: pg, audit, now }),
      auditReader: createAuditReader({ audit, file }),
      simulations: simulations ?? createSimulationService({ db: pg, audit }),
      audit,
      ...(waitMs !== undefined && { waitMs }),
    }),
  });
  const people = {};
  for (const name of Object.keys(PEOPLE)) people[name] = await h.signIn(name);
  const propose = (as = people['co.one'], over = {}) => h.call('POST', '/api/v1/governance/proposals', {
    as, body: { policy: examplePack('UK'), reason: 'Adopt the UK policy pack', ...over },
  });
  return { ...h, people, propose };
}
const withApi = (name, opts, fn) => test(name, async () => {
  const ctx = await setup(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
});

// ---- Governance ----

withApi('propose, then a different officer approves: the policy is in force and anyone may read it', {}, async ({ call, people, propose, audit }) => {
  const proposed = await propose();
  assert.equal(proposed.status, 200, proposed.text);
  assert.deepEqual([proposed.json.version.status, proposed.json.version.version, proposed.json.version.proposedBy], ['proposed', 1, 'co.one']);
  assert.equal((await call('GET', '/api/v1/governance/UK/active', { as: people['da.analyst'] })).status, 404, 'nothing in force yet');

  const approved = await call('POST', '/api/v1/governance/UK/versions/1/approve', { as: people['sec.officer'], body: { note: 'Reviewed with counsel' } });
  assert.equal(approved.status, 200, approved.text);
  assert.deepEqual([approved.json.version.status, approved.json.version.decidedBy], ['approved', 'sec.officer']);

  const active = await call('GET', '/api/v1/governance/UK/active', { as: people['da.analyst'] });
  assert.equal(active.status, 200);
  assert.equal(active.json.policy.version, 1);
  const viewed = audit.readAll().filter((e) => e.action === 'governance.viewed' && e.actor.id === 'da.analyst');
  assert.deepEqual(viewed.map((e) => e.detail.version), [null, 1], 'each view is logged with the version shown');
});

test('reading the policy in force needs a known person with a project role; refusals are logged', async () => {
  await pg.exec('TRUNCATE policy_versions');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'web-oversight-')), 'audit.jsonl') });
  const gov = createGovernanceService({ db: pg, audit, now: () => new Date('2026-10-12T09:00:00Z') });
  await assert.rejects(gov.viewActivePolicy({ user: { id: 'u-1', role: 'user' }, jurisdiction: 'UK' }), /may not view the governance policy in force/);
  await assert.rejects(gov.viewActivePolicy({ jurisdiction: 'UK' }), /No user was given/);
  assert.deepEqual(audit.readAll().map((e) => e.action), ['governance.denied', 'governance.denied']);
});

withApi('the two-person rule and the roles hold over the API', {}, async ({ call, people, propose }) => {
  assert.equal((await propose(people['sec.officer'])).status, 403, 'only compliance officers propose');
  await propose();
  const own = await call('POST', '/api/v1/governance/UK/versions/1/approve', { as: people['co.one'], body: { note: 'mine' } });
  assert.equal(own.status, 400);
  assert.match(own.json.error, /two-person rule/);
  assert.equal((await call('POST', '/api/v1/governance/UK/versions/1/approve', { as: people['da.analyst'], body: { note: 'x' } })).status, 403);
  assert.match((await call('POST', '/api/v1/governance/UK/versions/1/approve', { as: people['co.two'], body: {} })).json.error, /a note is required/);

  const rejected = await call('POST', '/api/v1/governance/UK/versions/1/reject', { as: people['co.two'], body: { note: 'Needs legal review' } });
  assert.equal(rejected.json.version.status, 'rejected');
  assert.equal((await call('POST', '/api/v1/governance/UK/versions/abc/approve', { as: people['co.two'], body: { note: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/governance/UK/versions/9/approve', { as: people['co.two'], body: { note: 'x' } })).status, 400);
});

withApi('a misconfigured or back-dated proposal is refused with the reasons', {}, async ({ people, propose }) => {
  const pack = examplePack('UK');
  const broken = await propose(people['co.one'], { policy: { ...pack, controls: { ...pack.controls, approvals: { ...pack.controls.approvals, approvalDeadlineHours: -5 } } } });
  assert.equal(broken.status, 400);
  assert.match(broken.json.error, /misconfigured/);
  const backdated = await propose(people['co.one'], { effectiveFrom: '2026-01-01' });
  assert.equal(backdated.status, 400);
  assert.match(backdated.json.error, /retroactively/);
});

withApi('the version list is for approvers; the same proposal twice makes one version', {}, async ({ call, people, propose }) => {
  await propose();
  await propose();
  const list = await call('GET', '/api/v1/governance/UK/versions', { as: people['sec.officer'] });
  assert.deepEqual(list.json.versions.map((v) => v.version), [1]);
  assert.equal((await call('GET', '/api/v1/governance/UK/versions', { as: people['tester'] })).status, 403);
});

// ---- Audit ----

withApi('security and compliance officers read the audit log with filters, in pages, with its integrity', {}, async ({ call, people, propose }) => {
  await propose();
  await propose(); // a second governance.* entry (proposal_unchanged), so there are two pages
  const r = await call('GET', '/api/v1/audit?action=governance.&limit=1', { as: people['sec.officer'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.integrity.ok, true);
  assert.equal(r.json.entries.length, 1);
  assert.ok(r.json.entries[0].action.startsWith('governance.'));
  assert.equal(typeof r.json.nextAfter, 'number');
  const next = await call('GET', `/api/v1/audit?action=governance.&after=${r.json.nextAfter}`, { as: people['sec.officer'] });
  assert.ok(next.json.entries.every((e) => e.seq > r.json.nextAfter));

  const mine = await call('GET', '/api/v1/audit?actorId=co.one', { as: people['co.two'] });
  assert.ok(mine.json.entries.length > 0 && mine.json.entries.every((e) => e.actor.id === 'co.one'));
});

withApi('reading the audit log is refused for other roles and for bad queries; every read is logged', {}, async ({ call, people, audit }) => {
  const denied = await call('GET', '/api/v1/audit', { as: people['tester'] });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /may not read the audit log/);
  assert.equal((await call('GET', '/api/v1/audit?colour=red', { as: people['sec.officer'] })).status, 400);
  assert.equal((await call('GET', '/api/v1/audit?limit=many', { as: people['sec.officer'] })).status, 400);
  assert.equal((await call('GET', '/api/v1/audit?limit=100000', { as: people['sec.officer'] })).status, 400);
  assert.equal((await call('GET', '/api/v1/audit?from=yesterday', { as: people['sec.officer'] })).status, 400);
  await call('GET', '/api/v1/audit', { as: people['sec.officer'] });
  const actions = audit.readAll().map((e) => e.action);
  assert.ok(actions.includes('audit.read_denied') && actions.includes('audit.read'));
});

withApi('there is no endpoint to repair the audit log', {}, async ({ call, people }) => {
  for (const path of ['/api/v1/audit/repair', '/api/v1/audit']) {
    const r = await call('POST', path, { as: people['sec.officer'], body: { reason: 'try' } });
    assert.ok([404, 405].includes(r.status), `${path} → ${r.status}`);
  }
});

// ---- Simulations ----

withApi('a quick simulation answers with its report', {}, async ({ call, people }) => {
  const r = await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-WEB-1', generate: { seed: 3, workflows: 2 } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.simulation.runId, r.json.simulation.requestedBy, r.json.simulation.verdict], ['SIM-WEB-1', 'tester', 'passed']);
  const list = await call('GET', '/api/v1/simulations', { as: people['tester'] });
  assert.deepEqual(list.json.simulations.map((s) => s.runId), ['SIM-WEB-1']);
});

withApi('a long simulation answers 202, keeps running, and its report appears when done', { waitMs: 1 }, async ({ call, people, audit }) => {
  const started = await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-WEB-2', generate: { seed: 4, workflows: 2 } } });
  assert.equal(started.status, 202, started.text);
  assert.deepEqual(started.json, { runId: 'SIM-WEB-2', status: 'running', poll: '/api/v1/simulations/SIM-WEB-2' });

  const repeat = await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-WEB-2', generate: { seed: 4, workflows: 2 } } });
  assert.ok([200, 202].includes(repeat.status), 'repeating joins the same run');
  assert.equal((await call('GET', '/api/v1/simulations/SIM-WEB-2', { as: people['da.analyst'] })).status, 403, 'a running run is not revealed to others');

  let report = null;
  for (let i = 0; i < 120 && !report; i += 1) {
    const poll = await call('GET', '/api/v1/simulations/SIM-WEB-2', { as: people['tester'] });
    if (poll.status === 200) report = poll.json.simulation;
    else { assert.equal(poll.status, 202); await sleep(500); }
  }
  assert.ok(report, 'the report appeared');
  assert.equal(report.verdict, 'passed');
  assert.equal(audit.readAll().filter((e) => e.action === 'simulation.started').length, 1, 'it ran once');
});

withApi('reusing a running run id for another scenario is refused; the first run still completes', { waitMs: 1 }, async ({ call, people, audit }) => {
  await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-WEB-3', generate: { seed: 5, workflows: 1 } } });
  const clash = await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-WEB-3', generate: { seed: 6, workflows: 1 } } });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /different scenario/);
  for (let i = 0; i < 120; i += 1) {
    if ((await call('GET', '/api/v1/simulations/SIM-WEB-3', { as: people['tester'] })).status === 200) break;
    await sleep(500);
  }
  assert.ok(audit.readAll().some((e) => e.action === 'simulation.completed' && e.subject === 'SIM-WEB-3'));
});

// A stand-in service whose run fails a moment after the API has answered 202.
const failingLater = {
  runSimulation: () => new Promise((_, reject) => { setTimeout(() => reject(new Error('sandbox crashed')), 100); }),
  getSimulation: async ({ runId }) => { throw new SimulationNotFoundError(`No simulation run ${runId}.`); },
  listSimulations: async () => [],
};

withApi('a simulation that fails after the 202 is logged, not lost, and stops showing as running', { waitMs: 1, simulations: failingLater }, async ({ call, people, audit }) => {
  const started = await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-WEB-4', generate: { seed: 1, workflows: 1 } } });
  assert.equal(started.status, 202);
  assert.equal((await call('GET', '/api/v1/simulations/SIM-WEB-4', { as: people['tester'] })).status, 202, 'running');
  await sleep(300);
  const failed = audit.readAll().find((e) => e.action === 'simulation.background_failed');
  assert.ok(failed, 'the failure is in the audit log');
  assert.deepEqual([failed.subject, failed.actor.id], ['SIM-WEB-4', 'tester']);
  assert.match(failed.rationale, /answered with 202 then failed: Error: sandbox crashed/);
  assert.equal((await call('GET', '/api/v1/simulations/SIM-WEB-4', { as: people['tester'] })).status, 404, 'no longer running, never saved');
});

withApi('simulation refusals: wrong role 403, bad request 400, unknown run 404', {}, async ({ call, people }) => {
  assert.equal((await call('POST', '/api/v1/simulations', { as: people['da.analyst'], body: { runId: 'SIM-X', generate: { seed: 1, workflows: 1 } } })).status, 403);
  const both = await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-X' } });
  assert.equal(both.status, 400);
  assert.match(both.json.error, /either a scenario or generate/);
  assert.equal((await call('POST', '/api/v1/simulations', { as: people['tester'], body: { runId: 'SIM-X', generate: { seed: 1, workflows: 1 }, timeoutMs: 0 } })).status, 400);
  assert.equal((await call('GET', '/api/v1/simulations/SIM-NONE', { as: people['tester'] })).status, 404);
});
