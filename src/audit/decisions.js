// Which audit entries record a DECISION (STORY-006, acceptance: "Given a decision
// is made, When it is logged, Then it includes the decision rationale").
//
// A decision is a choice between alternatives — allow or refuse, approve or
// reject, high or low risk, retry or give up, which agent runs a task. The audit
// log refuses to write one of these without a rationale (see auditLog.js), so a
// decision can never be recorded without its "why".
//
// Plain actions — a request arriving, a run starting or finishing, a system
// being registered, a view — are not on this list: they still carry who and
// when, and may carry a reason, but are not refused without one.
//
// Adding a new kind of decision anywhere in the code? Add its action name here.

export const DECISION_ACTIONS = Object.freeze(new Set([
  // Orchestration (STORY-001)
  'operation.rejected', 'task.assigned', 'task.reassigned', 'task.retry_scheduled', 'task.failed',
  'agent.marked_unhealthy', 'agent.recovered',
  // Process analysis and its dashboard (STORY-002, STORY-011)
  'analysis.denied', 'analysis.rejected', 'dashboard.denied', 'dashboard.sign_in_rejected',
  // Risk assessment (STORY-003)
  'risk.denied', 'risk.rejected', 'risk.system_assessed', 'risk.system_unassessed',
  // Inventory (STORY-004)
  'inventory.denied', 'inventory.register_rejected', 'inventory.register_conflict', 'inventory.update_rejected',
  'inventory.update_conflict', 'inventory.status_changed', 'inventory.risk_recorded', 'inventory.risk_rejected',
  // Workflows and approvals (STORY-005)
  'workflow.denied', 'workflow.rejected', 'workflow.decision_refused', 'workflow.action_classified',
  'workflow.approval_requested', 'workflow.action_approved', 'workflow.action_rejected',
  'workflow.approval_escalated', 'workflow.approval_expired',
  // The audit log itself (STORY-006)
  'audit.read_denied', 'audit.repaired',
  // Documents (STORY-007)
  'document.denied', 'document.rejected', 'document.extracted', 'document.flagged',
  'document.review_accepted', 'document.review_rejected', 'document.review_refused',
  // ROI estimates (STORY-008)
  'roi.denied', 'roi.rejected', 'roi.calculated', 'roi.calculation_failed',
  // Governance controls (STORY-009)
  'governance.denied', 'governance.proposal_refused', 'governance.decision_refused',
  'governance.approved', 'governance.rejected', 'governance.review_overdue',
  // Simulations (STORY-010)
  'simulation.denied', 'simulation.rejected', 'simulation.completed',
  // Web accounts (extra to the plan)
  'account.denied', 'account.refused', 'account.bootstrapped', 'account.created', 'account.role_changed',
  'account.disabled', 'account.enabled', 'account.password_reset', 'account.locked', 'account.sign_in_failed',
  'session.rejected', 'session.expired', 'session.csrf_rejected',
  'api.refused', 'api.rate_limited',
]));

export const isDecision = (action) => DECISION_ACTIONS.has(action);
