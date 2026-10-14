// Races on governance configuration (STORY-009). Run with: npm test
//
// Two people acting on the same thing at the same moment must not produce two
// outcomes. These run over a real PostgreSQL wire connection, so each request uses
// its own pooled connection, as in production.
// Limit: the engine behind the socket is a single PGlite session, so this proves
// the code's locking and retry logic, not isolation between two server sessions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { connectPostgres } from '../src/inventory/db.js';
import { createGovernanceService, migrateGovernance, GovernanceRequestError } from '../src/governance/service.js';
import { examplePack } from '../src/governance/packs/index.js';
import { createAuditLog } from '../src/audit/auditLog.js';

const CO1 = { id: 'co-1', role: 'compliance officer' };
const CO2 = { id: 'co-2', role: 'compliance officer' };
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

async function setup() {
  await db.exec('TRUNCATE policy_versions');
  const audit = createAuditLog({ file: join(mkdtempSync(join(tmpdir(), 'gov-race-')), 'audit.jsonl') });
  return { audit, gov: createGovernanceService({ db, audit }) };
}

test('approve and reject at the same moment: exactly one decision wins, and only it is logged', async () => {
  for (let round = 1; round <= 10; round += 1) {
    const { audit, gov } = await setup();
    const p = await gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: `Round ${round}` });
    const results = await Promise.allSettled([
      gov.approveProposal({ user: SEC, jurisdiction: 'UK', version: p.version, note: 'Approve' }),
      gov.rejectProposal({ user: CO2, jurisdiction: 'UK', version: p.version, note: 'Reject' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, `round ${round}: exactly one decision succeeds`);
    assert.ok(lost[0].reason instanceof GovernanceRequestError && /not waiting for a decision/.test(lost[0].reason.message), `round ${round}: ${lost[0].reason}`);

    const { rows: [row] } = await db.query('SELECT status, decided_by FROM policy_versions WHERE jurisdiction = $1 AND version = $2', ['UK', p.version]);
    assert.equal(row.status, won[0].value.status, 'the database holds the decision that was reported');
    const decisions = audit.readAll().filter((e) => e.action === 'governance.approved' || e.action === 'governance.rejected');
    assert.equal(decisions.length, 1, `round ${round}: one decision in the audit log`);
    assert.equal(decisions[0].actor.id, row.decided_by);
  }
});

test('two proposals at the same moment get different version numbers, and both are kept', async () => {
  const { audit, gov } = await setup();
  const a = examplePack('EU');
  const b = examplePack('EU');
  b.controls.approvals.approvalDeadlineHours = 24;
  const [va, vb] = await Promise.all([
    gov.proposePolicy({ user: CO1, policy: a, reason: 'First' }),
    gov.proposePolicy({ user: CO2, policy: b, reason: 'Second' }),
  ]);
  assert.deepEqual([va.version, vb.version].sort(), [1, 2]);
  const { rows } = await db.query("SELECT version FROM policy_versions WHERE jurisdiction = 'EU' ORDER BY version");
  assert.deepEqual(rows.map((r) => r.version), [1, 2]);
  assert.equal(audit.readAll().filter((e) => e.action === 'governance.proposed').length, 2);
});

test('the same proposal sent twice at the same moment becomes one version', async () => {
  const { audit, gov } = await setup();
  const [x, y] = await Promise.all([
    gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt' }),
    gov.proposePolicy({ user: CO1, policy: examplePack('UK'), reason: 'Adopt' }),
  ]);
  assert.equal(x.version, y.version);
  assert.equal(audit.readAll().filter((e) => e.action === 'governance.proposed').length, 1);
});
