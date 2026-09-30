// gate — the only way an action gets carried out.
// evaluate() checks an action against policy.json; submit() records the decision and,
// only on allow, performs the side effect. The side effect (act) is private to this module.
const fs = require('fs');
const path = require('path');

const POLICY_FILE = path.join(__dirname, 'policy.json');
const DATA_DIR = path.join(__dirname, 'data');
const LEDGER = path.join(DATA_DIR, 'ledger.jsonl');
const DECISIONS = path.join(DATA_DIR, 'decisions.jsonl');

// Operators a rule may use. Numeric operators only match real numbers, so a missing or
// malformed amount never satisfies a condition by accident.
const OPS = {
  eq: { test: (v, x) => v === x, says: 'is' },
  gt: { test: (v, x) => typeof v === 'number' && v > x, says: 'exceeds' },
  gte: { test: (v, x) => typeof v === 'number' && v >= x, says: 'is at least' },
  lt: { test: (v, x) => typeof v === 'number' && v < x, says: 'is below' },
  lte: { test: (v, x) => typeof v === 'number' && v <= x, says: 'does not exceed' },
};

function loadPolicy() {
  const policy = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
  if (!Array.isArray(policy.rules)) throw new Error('policy.json has no "rules" array');
  return policy.rules;
}

// Returns the list of facts that made the rule match, or null if it does not match.
// An unknown operator never matches.
function match(rule, action) {
  const facts = [];
  for (const [field, conds] of Object.entries(rule.when || {})) {
    for (const [op, expected] of Object.entries(conds)) {
      const o = OPS[op];
      if (!o || !o.test(action[field], expected)) return null;
      facts.push({ field, value: action[field], says: o.says, expected });
    }
  }
  return facts.length ? facts : null;
}

function describe(ruleId, facts) {
  // Name the deciding facts; the actionType scoping is only mentioned if it is all there is.
  const deciding = facts.filter((f) => f.field !== 'actionType');
  const shown = deciding.length ? deciding : facts;
  return `${ruleId}: ` + shown.map((f) => `${f.field} ${f.value} ${f.says} ${f.expected}`).join(', ');
}

// Deny rules win over allow rules. Anything no rule speaks to is denied (fail-closed).
// A policy that cannot be read also denies.
function evaluate(action) {
  let rules;
  try {
    rules = loadPolicy();
  } catch (err) {
    return { verdict: 'deny', ruleId: 'policy-unavailable', reason: `policy could not be loaded: ${err.message}` };
  }
  const matches = [];
  for (const rule of rules) {
    const facts = match(rule, action);
    if (facts) matches.push({ rule, facts });
  }
  const hit = matches.find((m) => m.rule.verdict !== 'allow') || matches.find((m) => m.rule.verdict === 'allow');
  if (!hit) return { verdict: 'deny', ruleId: 'default-deny', reason: 'no rule permits this action' };
  // Any verdict other than exactly "allow" (including typos) is treated as deny.
  const verdict = hit.rule.verdict === 'allow' ? 'allow' : 'deny';
  return { verdict, ruleId: hit.rule.id, reason: describe(hit.rule.id, hit.facts) };
}

function append(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Carries out an action by appending one line to the ledger. Not exported.
function act(action) {
  const entry = {
    actionId: action.actionId,
    actionType: action.actionType,
    resource: action.resource,
    amount: action.amount,
    at: new Date().toISOString(),
  };
  if (action.actionType === 'export_and_email') {
    entry.rowsExported = action.context.rows;
    entry.emailsSent = action.context.recipients;
  }
  append(LEDGER, entry);
  return entry;
}

// The single entry point: evaluate, record the decision, act only on allow.
// The action is copied first so the object that was evaluated is the object that is acted on.
// The decision is written before act runs; if it cannot be written, nothing is acted on.
function submit(proposed) {
  const action = structuredClone(proposed);
  const decision = evaluate(action);
  append(DECISIONS, {
    actionId: action.actionId,
    actionType: action.actionType,
    amount: action.amount,
    verdict: decision.verdict,
    ruleId: decision.ruleId,
    reason: decision.reason,
    at: new Date().toISOString(),
  });
  const ledgerEntry = decision.verdict === 'allow' ? act(action) : null;
  return { decision, ledgerEntry };
}

module.exports = { evaluate, submit };
