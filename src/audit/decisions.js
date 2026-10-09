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
  'analysis.denied', 'analysis.rejected', 'dashboard.denied',
  // Risk assessment (STORY-003)
  'risk.denied', 'risk.rejected', 'risk.system_assessed',
  // Inventory (STORY-004)
  'inventory.denied', 'inventory.register_rejected', 'inventory.register_conflict', 'inventory.update_rejected',
  'inventory.update_conflict', 'inventory.status_changed', 'inventory.risk_recorded', 'inventory.risk_rejected',
  // Workflows and approvals (STORY-005)
  'workflow.denied', 'workflow.rejected', 'workflow.decision_refused', 'workflow.action_classified',
  'workflow.approval_requested', 'workflow.action_approved', 'workflow.action_rejected',
  'workflow.approval_escalated', 'workflow.approval_expired',
  // The audit log itself (STORY-006)
  'audit.read_denied', 'audit.repaired',
]));

export const isDecision = (action) => DECISION_ACTIONS.has(action);
