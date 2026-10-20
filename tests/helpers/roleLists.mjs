// Every list of allowed roles in the system, gathered for tests/roles.test.mjs,
// which checks each role named is a real project role. Add new lists here.

export { ANALYSIS_ROLES } from '../../src/analysis/service.js';
export { AUDIT_READER_ROLES } from '../../src/audit/reader.js';
export { REPAIR_ROLES } from '../../src/audit/storage.js';
export { START_ROLES, APPROVER_ROLES as WORKFLOW_APPROVER_ROLES, ESCALATED_APPROVER_ROLES, VIEW_ROLES as WORKFLOW_VIEW_ROLES } from '../../src/automation/workflows.js';
export { ACCOUNT_ADMIN_ROLES } from '../../src/web/accounts.js';
export { DASHBOARD_ROLES } from '../../src/dashboard/server.js';
export { UPLOAD_ROLES, REVIEWER_ROLES } from '../../src/documents/service.js';
export { KNOWN_ROLES } from '../../src/governance/policy.js';
export { PROPOSER_ROLES, APPROVER_ROLES as GOVERNANCE_APPROVER_ROLES, POLICY_READER_ROLES } from '../../src/governance/service.js';
export { EDIT_ROLES, VIEW_ROLES, RECORD_RISK_ROLES } from '../../src/inventory/service.js';
export { RISK_ROLES } from '../../src/risk/service.js';
export { ROI_ROLES } from '../../src/roi/service.js';
export { SIMULATION_ROLES } from '../../src/simulation/service.js';
