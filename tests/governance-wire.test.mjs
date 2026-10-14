// Regression test: policy dates over a real PostgreSQL connection, on a server
// clock EAST of UTC (STORY-009). Run with: npm test
//
// The bug: the pg driver turns a DATE into a JavaScript Date at LOCAL midnight;
// converting that with toISOString() made "2026-12-01" come back as "2026-11-30"
// in Paris or Tokyo — so the audit trail would have said a policy took effect a
// day before it did. Every other test used PGlite directly and could not see it.
//
// This file runs in its own process, so forcing the timezone here affects nothing else.
process.env.TZ = 'Europe/Paris';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { createServer } = await import('node:net');
const { PGlite } = await import('@electric-sql/pglite');
const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
const { connectPostgres } = await import('../src/inventory/db.js');
const { createGovernanceService, migrateGovernance } = await import('../src/governance/service.js');
const { createGovernanceView } = await import('../src/governance/view.js');
const { examplePack } = await import('../src/governance/packs/index.js');
const { createAuditLog } = await import('../src/audit/auditLog.js');

const CO1 = { id: 'co-1', role: 'compliance officer' };
const SEC = { id: 'sec-1', role: 'security officer' };

let engine; let server; let db;
before(async () => {
  engine = await PGlite.create();
  const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  server = new PGLiteSocketServer({ db: engine, host: '127.0.0.1', port, maxConnections: 10 });
  await server.start();
  db = await connectPostgres({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres` });
  await migrateGovernance(db);
});
after(async () => { await db?.close(); await server?.stop(); await engine?.close(); });

test('the test really runs east of UTC, where the pg driver shifts a bare DATE back a day', async () => {
  assert.equal(new Date('2026-12-01T00:00:00').getTimezoneOffset(), -60, 'Paris is UTC+1 in December');
  const { rows: [r] } = await db.query("SELECT '2026-12-01'::date AS d");
  assert.equal(r.d.toISOString().slice(0, 10), '2026-11-30', 'the trap this test guards against');
});

test('effective dates come back exactly as written, and switch over on the right day', async () => {
  let t = Date.parse('2026-10-14T09:00:00Z');
  const now = () => new Date(t);
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'gov-wire-')), 'audit.jsonl'), now });
  const gov = createGovernanceService({ db, audit, now });
  const view = createGovernanceView({ governance: gov, jurisdiction: 'EU', audit });

  const v1 = await gov.proposePolicy({ user: CO1, policy: examplePack('EU'), reason: 'Adopt' });
  assert.equal(v1.effectiveFrom, '2026-10-14');
  await gov.approveProposal({ user: SEC, jurisdiction: 'EU', version: 1, note: 'ok' });

  const update = examplePack('EU');
  update.controls.approvals.approvalDeadlineHours = 24;
  const v2 = await gov.proposePolicy({ user: CO1, policy: update, effectiveFrom: '2026-12-01', reason: 'Update' });
  assert.equal(v2.effectiveFrom, '2026-12-01', 'not 2026-11-30');
  const approved = await gov.approveProposal({ user: SEC, jurisdiction: 'EU', version: 2, note: 'ok' });
  assert.equal(approved.effectiveFrom, '2026-12-01');
  assert.equal(audit.readAll().filter((e) => e.action === 'governance.approved').at(-1).detail.effectiveFrom, '2026-12-01', 'and so does the audit trail');

  // The day before (late on 30 November UTC): still version 1. On 1 December: version 2.
  t = Date.parse('2026-11-30T23:30:00Z');
  assert.equal((await gov.getActivePolicy({ jurisdiction: 'EU' })).version, 1);
  t = Date.parse('2026-12-01T00:00:01Z');
  await view.refresh();
  assert.equal(view.current().version, 2);
  assert.equal(view.current().effectiveFrom, '2026-12-01');
  assert.match(audit.readAll().at(-1).rationale, /version 2 \(in force from 2026-12-01\)/);

  const versions = await gov.listVersions({ user: SEC, jurisdiction: 'EU' });
  assert.deepEqual(versions.map((v) => v.effectiveFrom), ['2026-12-01', '2026-10-14']);
});
