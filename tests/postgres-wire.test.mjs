// The real-server path, over a real PostgreSQL network connection. Run with: npm test
//
// Every other database test calls PGlite directly. This one runs PGlite behind a
// PostgreSQL wire-protocol server on localhost (@electric-sql/pglite-socket) and
// connects with connectPostgres() and the pg driver — exactly what production
// does with DATABASE_URL. It checks what only that path exercises: the pool,
// BEGIN/COMMIT/ROLLBACK on a pooled client, and how the driver turns text[],
// jsonb, integers and timestamps into JavaScript values.
// Limit: the engine behind the socket is still PGlite (PostgreSQL 18.3 in WASM),
// not a separate PostgreSQL server process.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { connectPostgres, migrate } from '../src/inventory/db.js';
import { createInventoryService, InventoryConflictError } from '../src/inventory/service.js';
import { createWorkflowEngine, migrateWorkflows } from '../src/automation/workflows.js';
import { createStandInExecutor, createInventoryStatusExecutor } from '../src/automation/executors.js';
import { createRiskAssessmentService } from '../src/risk/service.js';
import { createAuditLog, AuditWriteError } from '../src/audit/auditLog.js';
import { createMemoryResultStore } from '../src/orchestration/resultStore.js';

const IT = { id: 'it-1', role: 'IT manager' };
const OFFICER = { id: 'co-1', role: 'compliance officer' };
const PM = { id: 'pm-1', role: 'process manager' };
const PM2 = { id: 'pm-2', role: 'process manager' };

const cv = {
  id: 'ai-cv-screen', name: 'CV screener', department: 'HR', purpose: 'Ranks job applications', owner: 'hr-lead-1',
  status: 'active', dataCategories: ['personal', 'internal'], decisionImpact: 'significant', humanOversight: 'none', userFacing: false,
};

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let engine; let server; let db;
before(async () => {
  engine = await PGlite.create();
  const port = await freePort();
  server = new PGLiteSocketServer({ db: engine, host: '127.0.0.1', port, maxConnections: 10 });
  await server.start();
  db = await connectPostgres({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`, maxAttempts: 2, retryDelayMs: 50 });
  await migrate(db);
  await migrateWorkflows(db);
});
after(async () => {
  await db?.close();
  await server?.stop();
  await engine?.close();
});

const auditFile = () => createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'wire-')), 'audit.jsonl') });
const reset = () => db.exec('TRUNCATE workflow_actions, workflow_runs, ai_systems');

test('connects through the pg driver to a real PostgreSQL wire protocol', async () => {
  assert.equal(db.kind, 'postgres');
  const { rows: [r] } = await db.query('SELECT version() AS v, 1 + 1 AS two');
  assert.match(r.v, /^PostgreSQL 18/);
  assert.equal(r.two, 2);
});

test('inventory over the wire: text[] and timestamps come back as JS values; status change and conflict work', async () => {
  await reset();
  const inventory = createInventoryService({ db, audit: auditFile() });
  const { system } = await inventory.registerSystem({ user: IT, system: cv });
  assert.deepEqual(system.dataCategories, ['internal', 'personal'], 'text[] arrives as a JS array');
  assert.equal(typeof system.version, 'number');
  assert.ok(!Number.isNaN(Date.parse(system.createdAt)));

  const changed = await inventory.updateStatus({ user: IT, systemId: cv.id, status: 'paused', expectedVersion: 1, reason: 'test' });
  assert.deepEqual([changed.changed, changed.system.status, changed.system.version], [true, 'paused', 2]);
  await assert.rejects(inventory.updateStatus({ user: IT, systemId: cv.id, status: 'retired', expectedVersion: 1, reason: 'test' }), InventoryConflictError);
  assert.equal((await inventory.listSystems({ user: IT })).systems[0].status, 'paused');
});

test('a transaction on a pooled connection rolls back when the audit write fails', async () => {
  await reset();
  const audit = { append: (e) => { if (e.action === 'inventory.registered') throw new AuditWriteError('disk full'); return { seq: 1, ...e }; } };
  await assert.rejects(createInventoryService({ db, audit }).registerSystem({ user: IT, system: cv }), AuditWriteError);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM ai_systems')).rows[0].n, 0);
  // The connection that rolled back is healthy for the next caller.
  const ok = await createInventoryService({ db, audit: auditFile() }).registerSystem({ user: IT, system: cv });
  assert.equal(ok.created, true);
});

test('risk assessment recorded into the inventory over the wire', async () => {
  await reset();
  const audit = auditFile();
  const inventory = createInventoryService({ db, audit });
  await inventory.registerSystem({ user: IT, system: cv });
  const result = await createRiskAssessmentService({ audit, store: createMemoryResultStore() })
    .runAssessment({ assessmentId: 'RA-wire', user: OFFICER, systems: await inventory.systemsForAssessment({ user: OFFICER }) });
  const outcome = await inventory.recordRiskAssessment({ user: OFFICER, result });
  assert.deepEqual(outcome.recorded, ['ai-cv-screen']);
  const s = (await inventory.listSystems({ user: IT })).systems[0];
  assert.deepEqual([s.riskLevel, s.riskAssessmentId], ['high', 'RA-wire']);
});

test('workflows over the wire: jsonb round-trips; low runs, high waits, approval runs the real inventory change', async () => {
  await reset();
  const audit = auditFile();
  const inventory = createInventoryService({ db, audit });
  await inventory.registerSystem({ user: IT, system: cv });
  const executors = {
    notify: createStandInExecutor('notify'),
    'inventory.update_status': createInventoryStatusExecutor({ inventory }),
  };
  const wfEngine = createWorkflowEngine({ db, audit, executors, runOptions: { retryDelayMs: 1 } });
  const wf = await wfEngine.startWorkflow({ user: PM, workflowId: 'WF-wire', name: 'Over the wire', actions: [
    { type: 'notify', params: { to: 'hr-lead-1', nested: { list: [1, 2], flag: true } } },
    { type: 'inventory.update_status', params: { systemId: cv.id, status: 'paused' } },
  ] });
  assert.deepEqual(wf.actions[0].params, { to: 'hr-lead-1', nested: { list: [1, 2], flag: true } }, 'jsonb arrives as a JS object');
  assert.deepEqual(wf.actions.map((a) => [a.status, a.riskLevel]), [['succeeded', 'low'], ['awaiting_approval', 'high']]);
  assert.ok(Array.isArray(wf.actions[1].riskReasons));
  assert.equal(wf.actions[1].params.expectedVersion, 1);

  const done = await wfEngine.decide({ user: PM2, workflowId: 'WF-wire', step: 2, decision: 'approve', note: 'test' });
  assert.equal(done.run.status, 'completed');
  assert.equal((await inventory.listSystems({ user: IT })).systems[0].status, 'paused');
  assert.equal(audit.verify().ok, true);
});

test('two racing starts over separate pooled connections still run each action once', async () => {
  await reset();
  const audit = auditFile();
  const notify = createStandInExecutor('notify');
  const wfEngine = createWorkflowEngine({ db, audit, executors: { notify }, runOptions: { retryDelayMs: 1 } });
  const args = { user: PM, workflowId: 'WF-race', name: 'Race', actions: [{ type: 'notify', params: { to: 'x' } }] };
  const [a, b] = await Promise.all([wfEngine.startWorkflow(args), wfEngine.startWorkflow(args)]);
  assert.equal(a.run.id, 'WF-race');
  assert.equal(b.run.id, 'WF-race');
  assert.equal(notify.done().length, 1);
});
