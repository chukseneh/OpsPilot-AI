// Which HTTP status each service error becomes in the web API.
//
// A 4xx error is the caller's to fix, so its message — written by the service as a
// reason, e.g. "role must be one of: …" — is sent back. Anything else is a 500 or
// 503: the client gets a fixed message and a reference id, and the details go to
// the audit log only, never to the client (they may name files, SQL or internals).
// Matched by class, not by name, so an unrelated error that happens to share a
// name cannot leak its message.

import { PermissionDeniedError, AnalysisRequestError } from '../analysis/service.js';
import { RiskRequestError } from '../risk/service.js';
import { GovernanceRequestError, PolicyMisconfiguredError } from '../governance/service.js';
import { WorkflowRequestError } from '../automation/workflows.js';
import { AuditReadRequestError } from '../audit/reader.js';
import { AuditRepairRefusedError } from '../audit/storage.js';
import { DocumentRequestError, DocumentNotFoundError } from '../documents/service.js';
import { UnsupportedFormatError, DocumentReadError } from '../documents/formats.js';
import { InventoryRequestError, InventoryConflictError, SystemNotFoundError } from '../inventory/service.js';
import { DatabaseUnavailableError } from '../inventory/db.js';
import { SimulationRequestError, SimulationNotFoundError } from '../simulation/service.js';
import { ScenarioError } from '../simulation/scenario.js';
import { RoiRequestError, RoiScenarioNotFoundError } from '../roi/service.js';
import { RoiInputError } from '../roi/assumptions.js';
import { AccountError } from './accounts.js';

// Raised by the API layer itself (bad JSON, body too large, …).
export class ApiRequestError extends Error {
  constructor(status, message) { super(message); this.name = 'ApiRequestError'; this.status = status; }
}

const STATUS = [
  [403, [PermissionDeniedError]],
  [400, [AnalysisRequestError, RiskRequestError, GovernanceRequestError, PolicyMisconfiguredError, WorkflowRequestError,
    AuditReadRequestError, DocumentRequestError, DocumentReadError, InventoryRequestError, SimulationRequestError,
    ScenarioError, RoiRequestError, RoiInputError]],
  [415, [UnsupportedFormatError]],
  [404, [DocumentNotFoundError, SystemNotFoundError, SimulationNotFoundError, RoiScenarioNotFoundError]],
  [409, [InventoryConflictError, AuditRepairRefusedError]],
];

// → { status, message } where message is null when it must not be shown.
export function statusFor(err) {
  if (err instanceof ApiRequestError || err instanceof AccountError) return { status: err.status, message: err.message };
  for (const [status, classes] of STATUS) {
    if (classes.some((c) => err instanceof c)) return { status, message: err.message };
  }
  if (err instanceof DatabaseUnavailableError) return { status: 503, message: null };
  return { status: 500, message: null };
}
