// Starting OpsPilot for real (STORY-006: "logs are immutable and securely stored").
//
// The pieces that make the audit log secure — the signing key, the anchors, the
// timers — only protect anything if they are actually switched on. This is the
// ONE way to start the system, and it cannot start with them off:
//
//   const system = await startOpsPilot({ env: process.env });
//   system.services.inventory / .risk / .workflows / .auditReader
//   await system.stop();
//
// Settings (environment variables — never put them in a file in this repo):
//   AUDIT_LOG_KEY     required; at least 32 characters. Signs every audit entry.
//   DATABASE_URL      a PostgreSQL server, or
//   PGLITE_DATA_DIR   a folder for a local PGlite database (development)
//   AUDIT_LOG_FILE    default data/audit.jsonl
//   AUDIT_LOG_ID      default "main" (which anchors belong to this log)
//
// Startup is refused — with the reason, and never the key — when a setting is
// missing, when the log's storage is unhealthy (e.g. a half-written last line:
// run repairAuditLog), or when the log does not match its anchors (tampering:
// a person must investigate). Only then are the services created and the
// approval-delay and anchoring timers started.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { openAuditLogFromEnv, AuditWriteError } from './audit/auditLog.js';
import { createAuditAnchors, migrateAnchors } from './audit/anchors.js';
import { createAuditReader } from './audit/reader.js';
import { checkAuditStorage } from './audit/storage.js';
import { openPGlite, connectPostgres, migrate } from './inventory/db.js';
import { createInventoryService } from './inventory/service.js';
import { createRiskAssessmentService } from './risk/service.js';
import { createWorkflowEngine, migrateWorkflows } from './automation/workflows.js';
import { createInventoryStatusExecutor } from './automation/executors.js';
import { createFileResultStore } from './orchestration/resultStore.js';

export class StartupRefusedError extends Error {
  constructor(message, options) { super(message, options); this.name = 'StartupRefusedError'; }
}

const SYSTEM = { type: 'system', id: 'opspilot' };

// `executors` adds action types beyond the one real executor this build has
// (inventory status changes). Others fail cleanly ("No executor") until a real
// connector is supplied — the system never quietly uses a stand-in.
export async function startOpsPilot({ env = process.env, executors = {}, timers = {} } = {}) {
  // ---- 1. Settings ----
  if (!env.AUDIT_LOG_KEY) throw new StartupRefusedError('AUDIT_LOG_KEY is not set; OpsPilot will not start without the audit log signing key.');
  if (!env.DATABASE_URL && !env.PGLITE_DATA_DIR) {
    throw new StartupRefusedError('No database is configured: set DATABASE_URL (PostgreSQL) or PGLITE_DATA_DIR (a local development folder).');
  }
  const file = resolve(env.AUDIT_LOG_FILE ?? join('data', 'audit.jsonl'));
  const logId = env.AUDIT_LOG_ID ?? 'main';
  mkdirSync(dirname(file), { recursive: true });

  // ---- 2. Is the log's storage healthy? ----
  const health = checkAuditStorage({ file });
  if (!health.ok) {
    throw new StartupRefusedError(`The audit log is not healthy: ${health.problems.join('; ')}. A security officer can run repairAuditLog() to set a damaged end aside.`);
  }

  // ---- 3. Open it with the key (refused for a wrong key or an unkeyed log) ----
  let audit;
  try {
    audit = openAuditLogFromEnv({ file, env });
  } catch (err) {
    throw new StartupRefusedError(`The audit log could not be opened: ${err.message}`, { cause: err });
  }

  // ---- 4. Database and tables ----
  const db = env.DATABASE_URL ? await connectPostgres({ connectionString: env.DATABASE_URL }) : await openPGlite({ dataDir: env.PGLITE_DATA_DIR });
  const closeDb = () => db.close().catch((err) => { console.error(`opspilot: closing the database failed: ${err.message}`); });
  try {
    await migrate(db);
    await migrateWorkflows(db);
    await migrateAnchors(db);
  } catch (err) {
    await closeDb();
    throw err;
  }

  // ---- 5. Does the log still match its anchors? ----
  const anchors = createAuditAnchors({ db, file, key: env.AUDIT_LOG_KEY, logId });
  const integrity = await anchors.verify();
  if (!integrity.ok) {
    await closeDb();
    throw new StartupRefusedError(`The audit log does not match its anchors: ${integrity.reason}. This is not a failed write; a person must investigate before OpsPilot runs again.`);
  }

  // ---- 6. Services, all writing to the one keyed log ----
  const inventory = createInventoryService({ db, audit });
  const services = {
    inventory,
    risk: createRiskAssessmentService({ audit, store: createFileResultStore({ file: join(dirname(file), 'risk-assessments.json') }) }),
    workflows: createWorkflowEngine({ db, audit, executors: { 'inventory.update_status': createInventoryStatusExecutor({ inventory }), ...executors } }),
    auditReader: createAuditReader({ audit, file, key: env.AUDIT_LOG_KEY, anchors }),
  };

  // ---- 7. Record the start, anchor it, and start the timers ----
  try {
    audit.append({ correlationId: 'system', actor: SYSTEM, action: 'system.started', detail: { database: db.kind, auditLog: { keyed: true, anchored: true, entries: integrity.count } } });
    await anchors.anchor();
  } catch (err) {
    await closeDb();
    throw err instanceof AuditWriteError ? new StartupRefusedError(`Could not write to the audit log: ${err.message}`, { cause: err }) : err;
  }
  const approvalTimer = services.workflows.startApprovalTimer(timers.approvals ?? {});
  const anchorTimer = anchors.startTimer({ audit, ...(timers.anchors ?? {}) });

  let stopping = null;
  function stop() {
    // Safe to call twice: the second call waits for the first.
    stopping ??= (async () => {
      await approvalTimer.stop();
      await anchorTimer.stop();
      try {
        audit.append({ correlationId: 'system', actor: SYSTEM, action: 'system.stopped' });
        await anchors.anchor(); // the final state is anchored, so nothing can be cut off after shutdown
      } finally {
        await closeDb();
      }
    })();
    return stopping;
  }

  return { services, audit, anchors, db, file, stop };
}
