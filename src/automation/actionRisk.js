// How risky is one automated action? (STORY-005, REQ-007)
//
// Every action in a workflow is classified before it runs:
//   low  → it runs automatically
//   high → it waits for a person to approve it
//
// classifyAction() is pure: it reads the action and what the caller looked up
// about it (the AI system it touches, from the STORY-004 inventory) and returns
//   { level: 'low' | 'high', reasons: [{ rule, effect, why }] }
// where effect is 'base' (the starting level), 'high' (a rule raised it) or
// 'ignored' (a request to lower it that was refused). Every level is explained,
// so the audit log can say WHY an action ran unattended or waited.
//
// Guarding against incorrect risk categorisation:
//   - an author may mark an action high; marking it low never lowers what the
//     rules decided (the refusal is recorded as a reason);
//   - an unknown action type, missing details, or an AI system the inventory
//     does not know or has not assessed are all HIGH — when in doubt, a person decides.

export const RISK_LEVELS = Object.freeze(['low', 'high']);
export const DEFAULT_PAYMENT_LIMIT = 1000;

// The action types this build knows, and how risky each is on its own.
export const ACTION_TYPES = Object.freeze({
  notify: { base: 'low', what: 'sends a notification' },
  create_ticket: { base: 'low', what: 'opens a ticket' },
  'inventory.update_status': { base: 'low', what: 'changes an AI system\'s status in the inventory' },
  payment: { base: 'high', what: 'moves money' },
});

const TAKES_OUT_OF_USE = new Set(['paused', 'retired']);
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export function classifyAction(action, { system, paymentLimit = DEFAULT_PAYMENT_LIMIT } = {}) {
  const reasons = [];
  const raise = (rule, why) => reasons.push({ rule, effect: 'high', why });

  if (!action || typeof action !== 'object' || !isNonEmpty(action.type)) {
    raise('action.invalid', 'The action has no type, so what it would do is unknown.');
    return { level: 'high', reasons };
  }

  // ---- 1. Where it starts: its type ----
  const known = ACTION_TYPES[action.type];
  if (known) reasons.push({ rule: `type.${action.type}`, effect: known.base === 'high' ? 'high' : 'base', why: `It ${known.what}; ${known.base} risk on its own.` });
  else raise('type.unknown', `"${action.type}" is not a known action type; treated as high risk until a rule exists for it.`);

  const params = action.params && typeof action.params === 'object' ? action.params : {};

  // ---- 2. The AI system it touches, as the inventory sees it ----
  if (params.systemId !== undefined) {
    if (!system) raise('system.not_in_inventory', `AI system ${params.systemId} is not in the inventory, so its risk is unknown.`);
    else if (system.riskLevel === 'high') raise('system.high_risk', `It touches ${system.name}, which the inventory rates high risk.`);
    else if (system.riskLevel === 'unassessed') raise('system.unassessed', `It touches ${system.name}, which has not been risk-assessed yet.`);
  }

  // ---- 3. Rules for particular action types ----
  if (action.type === 'inventory.update_status') {
    if (!isNonEmpty(params.systemId) || !isNonEmpty(params.status)) {
      raise('inventory.incomplete', 'It does not say which system or which status, so its effect is unknown.');
    } else if (TAKES_OUT_OF_USE.has(params.status) && system?.status === 'active') {
      raise('inventory.takes_out_of_use', `It would set ${system.name} to ${params.status}, taking an AI system in active use out of service.`);
    }
  }
  if (action.type === 'payment') {
    const amount = params.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      raise('payment.amount_unknown', 'The payment amount is missing or invalid.');
    } else if (amount > paymentLimit) {
      raise('payment.over_limit', `It pays ${amount}, over the limit of ${paymentLimit} for unattended payments.`);
    }
  }

  // ---- 4. Can it be undone? ----
  if (action.irreversible === true) raise('irreversible', 'It cannot be undone once it runs.');

  // ---- 5. What the workflow's author said. Up is honoured; down never is. ----
  const computed = reasons.some((r) => r.effect === 'high') ? 'high' : 'low';
  if (action.declaredRisk !== undefined) {
    if (action.declaredRisk === 'high') raise('declared.high', 'The workflow author marked it high risk.');
    else if (action.declaredRisk === 'low') {
      if (computed === 'high') reasons.push({ rule: 'declared.low_ignored', effect: 'ignored', why: 'The workflow author marked it low risk, but the rules above make it high; a label cannot lower the risk.' });
    } else raise('declared.invalid', `The declared risk ${JSON.stringify(action.declaredRisk)} is not low or high.`);
  }

  return { level: reasons.some((r) => r.effect === 'high') ? 'high' : 'low', reasons };
}
