// AI system inventory service (STORY-004). Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createInventoryService, PermissionDeniedError, InventoryRequestError, InventoryConflictError, SystemNotFoundError,
} from '../src/inventory/service.js';
import { openPGlite, migrate, DatabaseUnavailableError } from '../src/inventory/db.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';

const IT = { id: 'it-mgr-1', role: 'IT_Manager' };
const COMPLIANCE = { id: 'co-3', role: 'compliance officer' };

const system = (over = {}) => ({
  id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications',
  owner: 'hr-lead-1', status: 'active', dataCategories: ['personal'], decisionImpact: 'significant',
  humanOversight: 'none', userFacing: false, ...over,
});
const chat = () => system({ id: 'ai-chat', name: 'Help chatbot', department: 'Support', dataCategories: ['public'], decisionImpact: 'low', humanOversight: 'review', userFacing: true });

// One PGlite instance for the file (it takes ~1 s to start); each test gets an empty table.
let pg;
before(async () => { pg = await openPGlite(); await migrate(pg); });
after(async () => { await pg.close(); });

async function setup({ db } = {}) {
  await pg.exec('TRUNCATE ai_systems');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'inv-')), 'audit.jsonl') });
  const service = createInventoryService({ db: db ?? pg, audit });
  const actions = () => audit.readAll().map((e) => e.action);
  return { audit, service, actions };
}

// ---- Acceptance 1: view lists all systems with details ----

test('the inventory lists every registered system with all its details', async () => {
  const { service } = await setup();
  await service.registerSystem({ user: IT, system: system() });
  await service.registerSystem({ user: IT, system: chat() });

  const { systems, inconsistencies } = await service.listSystems({ user: COMPLIANCE });
  assert.deepEqual(inconsistencies, []);
  assert.deepEqual(systems.map((s) => s.id), ['ai-cv-screen', 'ai-chat']); // by name: CV…, Help…
  const cv = systems[0];
  assert.deepEqual(
    { name: cv.name, department: cv.department, purpose: cv.purpose, owner: cv.owner, status: cv.status, riskLevel: cv.riskLevel },
    { name: 'CV screener', department: 'HR', purpose: 'Ranks job applications', owner: 'hr-lead-1', status: 'active', riskLevel: 'unassessed' },
  );
  assert.equal(cv.version, 1);
  assert.ok(Date.parse(cv.createdAt) && Date.parse(cv.updatedAt));
});

test('an empty inventory is an empty list, not an error', async () => {
  const { service } = await setup();
  assert.deepEqual((await service.listSystems({ user: IT })).systems, []);
});

// ---- Acceptance 2: a status update is reflected ----

test('updating a status is reflected in the inventory, with a new version', async () => {
  const { service } = await setup();
  const { system: registered } = await service.registerSystem({ user: IT, system: system() });
  const r = await service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused', expectedVersion: registered.version, reason: 'Bias review pending' });
  assert.equal(r.changed, true);
  assert.equal(r.system.status, 'paused');
  assert.equal(r.system.version, 2);

  const listed = (await service.listSystems({ user: COMPLIANCE })).systems.find((s) => s.id === 'ai-cv-screen');
  assert.equal(listed.status, 'paused');
  assert.equal(listed.version, 2);
});

// ---- Trust: changes are logged ----

test('every change is in the audit log with who, what, before/after and why; the chain verifies', async () => {
  const { service, audit } = await setup();
  await service.registerSystem({ user: IT, system: system(), reason: 'New HR tool' });
  await service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused', expectedVersion: 1, reason: 'Bias review pending' });

  const entries = audit.readAll();
  const reg = entries.find((e) => e.action === 'inventory.registered');
  assert.equal(reg.subject, 'ai-cv-screen');
  assert.equal(reg.rationale, 'New HR tool');
  assert.equal(reg.detail.after.status, 'active');
  const upd = entries.find((e) => e.action === 'inventory.status_changed');
  assert.deepEqual(upd.detail, { from: 'active', to: 'paused', version: 2 });
  assert.equal(upd.rationale, 'Bias review pending');
  for (const e of entries) { assert.deepEqual(e.actor, { type: 'person', id: 'it-mgr-1' }); assert.ok(Date.parse(e.at)); }
  assert.equal(audit.verify().ok, true);
});

test('views are logged too', async () => {
  const { service, audit } = await setup();
  await service.listSystems({ user: COMPLIANCE });
  const [e] = audit.readAll();
  assert.equal(e.action, 'inventory.viewed');
  assert.equal(e.actor.id, 'co-3');
});

test('if the audit log cannot be written, the change is rolled back', async () => {
  await pg.exec('TRUNCATE ai_systems');
  const audit = { append: (e) => { if (e.action === 'inventory.registered') throw new AuditWriteError('disk full'); return { seq: 1, ...e }; } };
  const service = createInventoryService({ db: pg, audit });
  await assert.rejects(service.registerSystem({ user: IT, system: system() }), AuditWriteError);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM ai_systems')).rows[0].n, 0);
});

test('if the commit fails after the change was logged, a correcting entry follows it', async () => {
  const { audit, actions } = await setup();
  const failingCommit = { ...pg, transaction: async (fn) => { await pg.transaction(async (tx) => { await fn(tx); throw new Error('commit failed'); }); } };
  const service = createInventoryService({ db: failingCommit, audit });
  await assert.rejects(service.registerSystem({ user: IT, system: system() }), /commit failed/);
  assert.deepEqual(actions(), ['inventory.registered', 'inventory.change_failed']);
  assert.match(audit.readAll()[1].rationale, /#1 \(inventory\.registered\) were NOT saved: Error: commit failed/);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM ai_systems')).rows[0].n, 0);
});

// ---- Idempotency ----

test('registering the same system twice creates it once', async () => {
  const { service, actions } = await setup();
  const a = await service.registerSystem({ user: IT, system: system() });
  const b = await service.registerSystem({ user: IT, system: system() });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal((await service.listSystems({ user: IT })).systems.length, 1);
  assert.deepEqual(actions().slice(0, 2), ['inventory.registered', 'inventory.register_unchanged']);
});

test('repeating a status change (e.g. a retry) changes nothing the second time', async () => {
  const { service } = await setup();
  await service.registerSystem({ user: IT, system: system() });
  await service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused', expectedVersion: 1 });
  const again = await service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused', expectedVersion: 1 });
  assert.equal(again.changed, false);
  assert.equal(again.system.version, 2, 'not bumped twice');
});

// ---- Failure path: data inconsistency ----

test('a status change based on an out-of-date read is refused, not applied over the newer change', async () => {
  const { service, actions } = await setup();
  await service.registerSystem({ user: IT, system: system() });
  await service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused', expectedVersion: 1 });
  await assert.rejects(
    service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'retired', expectedVersion: 1 }),
    (err) => err instanceof InventoryConflictError && /you read version 1, it is now version 2, status paused/.test(err.message),
  );
  assert.equal((await service.listSystems({ user: IT })).systems[0].status, 'paused');
  assert.ok(actions().includes('inventory.update_conflict'));
});

test('an id reused with different details is refused', async () => {
  const { service } = await setup();
  await service.registerSystem({ user: IT, system: system() });
  await assert.rejects(service.registerSystem({ user: IT, system: system({ owner: 'someone-else' }) }), InventoryConflictError);
  assert.equal((await service.listSystems({ user: IT })).systems[0].owner, 'hr-lead-1');
});

test('incomplete system data is refused with each problem named', async () => {
  const { service, actions } = await setup();
  const { owner, ...noOwner } = system();
  await assert.rejects(service.registerSystem({ user: IT, system: noOwner }),
    (err) => err instanceof InventoryRequestError && /"owner" is missing/.test(err.message));
  await assert.rejects(service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'live', expectedVersion: 1 }), /status must be one of/);
  await assert.rejects(service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused' }), /expectedVersion is required/);
  await assert.rejects(service.updateStatus({ user: IT, systemId: 'nope', status: 'paused', expectedVersion: 1 }), SystemNotFoundError);
  assert.deepEqual(actions(), ['inventory.register_rejected', 'inventory.update_rejected', 'inventory.update_rejected', 'inventory.update_rejected']);
});

test('a stored row that breaks the rules is shown as an inconsistency, not hidden', async () => {
  const db = await openPGlite();
  // An older or hand-made table without the constraints.
  await db.exec(`CREATE TABLE ai_systems (id text PRIMARY KEY, name text, department text, purpose text, owner text, status text,
    risk_level text, risk_assessment_id text, risk_assessed_at timestamptz, data_categories text[], decision_impact text,
    human_oversight text, user_facing boolean, version int, created_at timestamptz, updated_at timestamptz)`);
  await db.exec(`INSERT INTO ai_systems VALUES ('ai-bad', 'Bad', 'Ops', 'p', NULL, 'live', 'extreme', NULL, NULL, '{internal}', 'low', 'review', false, 1, now(), now())`);
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'inv-')), 'audit.jsonl') });
  const { systems, inconsistencies } = await createInventoryService({ db, audit }).listSystems({ user: IT });
  assert.equal(systems.length, 1, 'still listed');
  const fields = inconsistencies.flatMap((i) => i.problems.map((p) => p.field)).sort();
  assert.deepEqual(fields, ['owner', 'riskLevel', 'status']);
  assert.equal(audit.readAll()[0].detail.inconsistencies, 2);
  await db.close();
});

// ---- Failure path: unauthorized access ----

test('a role that may only view cannot change anything; the refusal is logged', async () => {
  const { service, actions, audit } = await setup();
  await service.registerSystem({ user: IT, system: system() });
  await assert.rejects(service.updateStatus({ user: COMPLIANCE, systemId: 'ai-cv-screen', status: 'retired', expectedVersion: 1 }), PermissionDeniedError);
  await assert.rejects(service.registerSystem({ user: COMPLIANCE, system: chat() }), PermissionDeniedError);
  assert.equal((await service.listSystems({ user: IT })).systems[0].status, 'active');
  const denied = audit.readAll().filter((e) => e.action === 'inventory.denied');
  assert.equal(denied.length, 2);
  assert.match(denied[0].rationale, /may not change AI system status; allowed roles: IT manager/);
  assert.equal(actions().filter((a) => a === 'inventory.status_changed').length, 0);
});

test('other roles cannot even view; no user at all is refused', async () => {
  const { service, audit } = await setup();
  await assert.rejects(service.listSystems({ user: { id: 'pa-1', role: 'process analyst' } }), PermissionDeniedError);
  await assert.rejects(service.listSystems({}), (err) => err instanceof PermissionDeniedError && /No user/.test(err.message));
  assert.deepEqual(audit.readAll().map((e) => [e.action, e.actor.id]), [['inventory.denied', 'pa-1'], ['inventory.denied', 'unknown-requester']]);
});

test('security officers and operations managers may view', async () => {
  const { service } = await setup();
  for (const role of ['security officer', 'operations manager']) {
    assert.deepEqual((await service.listSystems({ user: { id: 'u', role } })).systems, []);
  }
});

// ---- Failure path: database connection failure ----

test('a database that cannot be reached is reported and logged; nothing is claimed', async () => {
  const { audit } = await setup();
  const down = new DatabaseUnavailableError('The inventory database is unavailable (gave up after 3 attempts): ECONNREFUSED');
  const dead = { query: async () => { throw down; }, exec: async () => { throw down; }, transaction: async () => { throw down; } };
  const service = createInventoryService({ db: dead, audit });
  await assert.rejects(service.listSystems({ user: IT }), DatabaseUnavailableError);
  await assert.rejects(service.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'paused', expectedVersion: 1 }), DatabaseUnavailableError);
  const entries = audit.readAll();
  assert.deepEqual(entries.map((e) => [e.action, e.detail.attempted]), [['inventory.db_unavailable', 'view'], ['inventory.db_unavailable', 'update status']]);
  assert.ok(!entries.some((e) => e.action === 'inventory.viewed' || e.action === 'inventory.status_changed'));
});
