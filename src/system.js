// Starting OpsPilot for real (STORY-006: "logs are immutable and securely stored").
//
// The pieces that make the audit log secure — the signing key, the anchors, the
// timers — only protect anything if they are actually switched on. This is the
// ONE way to start the system, and it cannot start with them off:
//
//   const system = await startOpsPilot({ env: process.env });
//   system.services.inventory / .risk / .workflows / .auditReader / .documents / .roi / .governance / .simulation
//   await system.stop();
//
// Settings (environment variables — never put them in a file in this repo):
//   AUDIT_LOG_KEY     required; at least 32 characters. Signs every audit entry.
//   DATABASE_URL      a PostgreSQL server, or
//   PGLITE_DATA_DIR   a folder for a local PGlite database (development)
//   AUDIT_LOG_FILE    default data/audit.jsonl
//   AUDIT_LOG_ID      default "main" (which anchors belong to this log)
//   DOCUMENTS_DIR     where uploaded files are kept; default "documents" beside the audit log
//   GOVERNANCE_JURISDICTION  optional, e.g. UK or EU: whose approved governance policy
//                    applies (STORY-009). Unset: the built-in rules apply.
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
import { createDocumentService, migrateDocuments } from './documents/service.js';
import { createFileBlobStore } from './documents/blobStore.js';
import { createRoiService, migrateRoi, analysisLookupFrom, documentLookupFrom } from './roi/service.js';
import { resolveThresholds } from './roi/checks.js';
import { createPolicyAwareRiskModel } from './risk/riskModel.js';
import { createGovernanceService, migrateGovernance } from './governance/service.js';
import { createGovernanceView } from './governance/view.js';
import { createSimulationService, migrateSimulations } from './simulation/service.js';

export class StartupRefusedError extends Error {
  constructor(message, options) { super(message, options); this.name = 'StartupRefusedError'; }
}

const SYSTEM = { type: 'system', id: 'opspilot' };

// `executors` adds action types beyond the one real executor this build has
// (inventory status changes). Others fail cleanly ("No executor") until a real
// connector is supplied — the system never quietly uses a stand-in.
// `roiThresholds` overrides the ROI plausibility thresholds (src/roi/checks.js),
// e.g. { minCostPerHour: 15, maxCostPerHour: 120 } for this organisation.
// `now` replaces the clock used by the audit log and governance (dates a policy
// takes effect, review dates) — for demos and tests that need to move time on.
export async function startOpsPilot({ env = process.env, executors = {}, timers = {}, roiThresholds = {}, now } = {}) {
  // ---- 1. Settings ----
  if (!env.AUDIT_LOG_KEY) throw new StartupRefusedError('AUDIT_LOG_KEY is not set; OpsPilot will not start without the audit log signing key.');
  if (!env.DATABASE_URL && !env.PGLITE_DATA_DIR) {
    throw new StartupRefusedError('No database is configured: set DATABASE_URL (PostgreSQL) or PGLITE_DATA_DIR (a local development folder).');
  }
  try {
    resolveThresholds(roiThresholds); // checked before anything is opened
  } catch (err) {
    throw new StartupRefusedError(err.message, { cause: err });
  }
  const jurisdiction = env.GOVERNANCE_JURISDICTION || null;
  if (jurisdiction && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction)) {
    throw new StartupRefusedError(`GOVERNANCE_JURISDICTION "${jurisdiction}" must look like UK, EU or US-CA.`);
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
    audit = openAuditLogFromEnv({ file, env, ...(now ? { now } : {}) });
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
    await migrateDocuments(db);
    await migrateRoi(db);
    await migrateGovernance(db);
    await migrateSimulations(db);
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
  // The governance policy in force (STORY-009) is read by the services each time
  // they need a control, through `view`; with no jurisdiction it is always null.
  const governanceService = createGovernanceService({ db, audit, ...(now ? { now } : {}) });
  const view = createGovernanceView({ governance: governanceService, jurisdiction, audit });
  const inventory = createInventoryService({ db, audit });
  const documents = createDocumentService({
    db, audit, governance: view, blobs: createFileBlobStore({ dir: resolve(env.DOCUMENTS_DIR ?? join(dirname(file), 'documents')) }),
  });
  const services = {
    inventory,
    documents,
    risk: createRiskAssessmentService({ audit, store: createFileResultStore({ file: join(dirname(file), 'risk-assessments.json') }), model: createPolicyAwareRiskModel(view) }),
    workflows: createWorkflowEngine({ db, audit, governance: view, executors: { 'inventory.update_status': createInventoryStatusExecutor({ inventory }), ...executors } }),
    // Who may read the audit log comes from the policy in force, checked on every read.
    auditReader: {
      readAuditLog: (args) => createAuditReader({
        audit, file, key: env.AUDIT_LOG_KEY, anchors,
        ...(view.current() ? { roles: view.current().controls.recordKeeping.auditReaderRoles } : {}),
      }).readAuditLog(args),
    },
    // Approving or rejecting a version refreshes the policy in force straight away.
    governance: {
      ...governanceService,
      approveProposal: async (args) => { const r = await governanceService.approveProposal(args); await view.refresh(); return r; },
      rejectProposal: async (args) => { const r = await governanceService.rejectProposal(args); await view.refresh(); return r; },
      inForce: () => view.current(),
    },
    // Simulations run in their own sandbox (STORY-010), never in this database;
    // only their reports are kept here.
    simulation: createSimulationService({ db, audit }),
    // ROI checks its assumptions against saved process analyses (the STORY-002 store
    // beside the log) and against documents, read with the asking user's access rights.
    roi: createRoiService({
      db, audit,
      lookupAnalysis: analysisLookupFrom(createFileResultStore({ file: join(dirname(file), 'analyses.json') })),
      lookupDocument: documentLookupFrom(documents),
      thresholds: roiThresholds,
    }),
  };

  // ---- 7. Record the start, anchor it, and start the timers ----
  try {
    audit.append({ correlationId: 'system', actor: SYSTEM, action: 'system.started', detail: { database: db.kind, auditLog: { keyed: true, anchored: true, entries: integrity.count }, jurisdiction } });
    await view.refresh();
    await anchors.anchor();
  } catch (err) {
    await closeDb();
    throw err instanceof AuditWriteError ? new StartupRefusedError(`Could not write to the audit log: ${err.message}`, { cause: err }) : err;
  }
  const approvalTimer = services.workflows.startApprovalTimer(timers.approvals ?? {});
  const anchorTimer = anchors.startTimer({ audit, ...(timers.anchors ?? {}) });
  const governanceTimer = view.startTimer(timers.governance ?? {});

  let stopping = null;
  function stop() {
    // Safe to call twice: the second call waits for the first.
    stopping ??= (async () => {
      await approvalTimer.stop();
      await anchorTimer.stop();
      await governanceTimer.stop();
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
