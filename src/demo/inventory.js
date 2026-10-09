// STORY-004 demo: the AI system inventory in PostgreSQL, on SYNTHETIC systems.
//
//   node src/demo/inventory.js      runs on PGlite (PostgreSQL inside Node, in memory)
//
// With DATABASE_URL set it uses that PostgreSQL server instead (the connection
// string is never printed). The demo only adds its synthetic systems; it never
// deletes anything, and running it again changes nothing that is already there.
//
// Shows: registering systems (an incomplete one refused), viewing the inventory
// with every detail, risk ratings filled in from a STORY-003 assessment, a status
// change reflected in the inventory, the three failure paths (out-of-date update,
// unauthorised change, unreachable database), and the audit trail.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

import { createAuditLog } from '../audit/auditLog.js';
import { createFileResultStore } from '../orchestration/resultStore.js';
import { createRiskAssessmentService } from '../risk/service.js';
import { openPGlite, connectPostgres, migrate } from '../inventory/db.js';
import { createInventoryService } from '../inventory/service.js';
import { sampleAiSystems, SAMPLE_LABEL } from './sampleAiSystems.js';

const IT = { id: 'it-manager-1', role: 'IT manager' };
const OFFICER = { id: 'compliance-officer-1', role: 'compliance officer' };

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// One line per system: the REQ-006 columns.
function table(systems) {
  const cols = [['System', 22], ['Department', 11], ['Purpose', 48], ['Risk', 11], ['Owner', 15], ['Status', 8], ['v', 2]];
  const line = (cells) => cells.map((c, i) => String(c ?? '').slice(0, cols[i][1]).padEnd(cols[i][1])).join(' ');
  return [line(cols.map(([h]) => h)), line(cols.map(([, w]) => '-'.repeat(w))),
    ...systems.map((s) => line([s.name, s.department, s.purpose, s.riskLevel, s.owner, s.status, s.version]))].join('\n');
}

export async function runInventoryDemo({ print = console.log, databaseUrl = process.env.DATABASE_URL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-inventory-'));
  const audit = createAuditLog({ file: join(dir, 'audit.jsonl') });
  const db = databaseUrl ? await connectPostgres({ connectionString: databaseUrl }) : await openPGlite();
  const out = {};
  try {
    await migrate(db);
    const inventory = createInventoryService({ db, audit });
    const risk = createRiskAssessmentService({ audit, store: createFileResultStore({ file: join(dir, 'risk-assessments.json') }) });

    const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
    print(`OpsPilot AI — AI system inventory demo. Data: ${SAMPLE_LABEL}.`);
    print(`Database: ${db.kind === 'pglite' ? 'PGlite (PostgreSQL inside Node, in memory)' : 'PostgreSQL server from DATABASE_URL'}`);

    rule('1. it-manager-1 registers the 5 AI systems');
    out.registered = [];
    for (const system of sampleAiSystems()) {
      try {
        const r = await inventory.registerSystem({ user: IT, system, reason: 'Initial inventory load' });
        out.registered.push(r.system.id);
        print(`  ${r.created ? 'registered ' : 'unchanged  '} ${system.name}`);
      } catch (err) {
        if (err.name !== 'InventoryRequestError') throw err;
        out.refusedRegistration = err.message;
        print(`  REFUSED     ${system.name}\n${err.message.split('\n').map((l) => `              ${l}`).join('\n')}`);
      }
    }

    rule('2. compliance-officer-1 views the inventory');
    print(table((await inventory.listSystems({ user: OFFICER })).systems));

    rule('3. A risk assessment of the inventory (STORY-003) fills the Risk column');
    const assessment = await risk.runAssessment({ assessmentId: 'demo-inventory-risk-1', user: OFFICER, systems: await inventory.systemsForAssessment({ user: OFFICER }) });
    const recorded = await inventory.recordRiskAssessment({ user: OFFICER, result: assessment });
    print(`Assessment ${assessment.status}; risk recorded for ${recorded.recorded.length} system(s)${recorded.unchanged.length ? `, ${recorded.unchanged.length} already up to date` : ''}.\n`);
    print(table((await inventory.listSystems({ user: OFFICER })).systems));

    rule('4. it-manager-1 pauses the CV screener while a bias review runs');
    const cv = (await inventory.listSystems({ user: IT })).systems.find((s) => s.id === 'ai-cv-screen');
    out.statusChange = await inventory.updateStatus({ user: IT, systemId: cv.id, status: 'paused', expectedVersion: cv.version, reason: 'Bias review pending' });
    print(`${out.statusChange.changed ? 'Changed' : 'Already paused; unchanged'}: version ${cv.version} → ${out.statusChange.system.version}. The inventory now shows:\n`);
    out.afterChange = (await inventory.listSystems({ user: OFFICER })).systems;
    print(table(out.afterChange));

    rule('5. Failure paths');
    const attempt = async (label, fn) => {
      try { await fn(); return `${label}: unexpectedly allowed`; } catch (err) { return `${label}\n   → ${err.name}: ${err.message}`; }
    };
    out.stale = await attempt('a) Someone retires the CV screener from a screen loaded before the pause (version 1)',
      () => inventory.updateStatus({ user: IT, systemId: 'ai-cv-screen', status: 'retired', expectedVersion: 1, reason: 'Replaced by a new screening tool' }));
    out.unauthorised = await attempt('b) compliance-officer-1 tries to change a status',
      () => inventory.updateStatus({ user: OFFICER, systemId: 'ai-help-chat', status: 'retired', expectedVersion: 1, reason: 'No longer needed' }));
    // A closed local port, with an obviously fake password to show it never appears in the error.
    const down = new URL(`postgres://127.0.0.1:${await freePort()}/opspilot`);
    down.username = 'demo';
    down.password = 'FAKE-demo-password';
    out.unreachable = await attempt('c) Connecting to a PostgreSQL server that is down',
      () => connectPostgres({ connectionString: down.href, maxAttempts: 2, retryDelayMs: 50, onPoolError: () => {} }));
    print([out.stale, out.unauthorised, out.unreachable].join('\n\n'));

    rule('6. Audit trail (every entry: timestamp + user id)');
    out.entries = audit.readAll();
    for (const e of out.entries) {
      const d = e.detail ?? {};
      const what = d.from !== undefined ? `${d.from} → ${d.to}` : e.rationale ?? '';
      print(`  ${e.at}  ${e.actor.id.padEnd(21)} ${e.action.padEnd(33)} ${(e.subject ?? '').padEnd(21)} ${what}`.trimEnd());
    }
    out.audit = audit.verify();
    print(`\nAudit chain: ${out.audit.ok ? `verified — ${out.audit.count} entries, none edited or removed` : `BROKEN at #${out.audit.brokenAt}`}`);
    print(`Files: ${dir}`);
    return out;
  } finally {
    await db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runInventoryDemo().then(
    (r) => { process.exitCode = r.audit.ok && r.statusChange.system.status === 'paused' ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
