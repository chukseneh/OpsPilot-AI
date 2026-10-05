// The risk model for STORY-003: given one AI system (already checked complete by
// systemData.js), which risks does it carry, in which category, how severe, and
// what should be done about each?
//
// Any risk model has the same interface, so a Claude-backed model can replace this
// one later without the service changing:
//
//   model = { id, version, assess(system, { signal }) → { risks } }   (may be async)
//
// A risk is { category, severity, rule, why, mitigations: [text, ...] }.
//
// This model is rule-based: each rule is named, reads only fields of the system
// record, and says in plain words why it fired, so a compliance officer can check
// every finding by hand. It is a first screen, not a legal classification — it
// does not apply any one jurisdiction's law (that is STORY-009's configurable
// governance controls).
//
// checkModelOutput() is how the service refuses to trust ANY model blindly: an
// output that is not well-formed (unknown category, no severity, no mitigation)
// throws RiskModelError instead of being reported as a finding.

import { DECISION_IMPACTS } from './systemData.js';

export const RISK_CATEGORIES = Object.freeze(['privacy', 'fairness', 'human_oversight', 'transparency', 'security', 'accountability']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high']); // lowest first

export class RiskModelError extends Error {
  constructor(message, options) { super(message, options); this.name = 'RiskModelError'; }
}

const has = (system, ...categories) => categories.some((c) => system.dataCategories.includes(c));
const atLeast = (impact, floor) => DECISION_IMPACTS.indexOf(impact) >= DECISION_IMPACTS.indexOf(floor);
const AFFECTS_PEOPLE = (s) => atLeast(s.decisionImpact, 'significant');

// Each rule returns a severity when it applies, or null when it does not.
export const RULES = Object.freeze([
  {
    rule: 'privacy.personal-data',
    category: 'privacy',
    severity: (s) => (has(s, 'sensitive_personal') ? 'high' : has(s, 'personal') ? 'medium' : null),
    why: (s) => `It processes ${has(s, 'sensitive_personal') ? 'sensitive personal data (special-category data such as health or ethnicity)' : 'personal data'}.`,
    mitigations: [
      'Complete a data protection impact assessment before (further) use.',
      'Collect and keep only the personal data the purpose needs, with a set retention period.',
      'Restrict access to the data and the system to named roles.',
    ],
  },
  {
    rule: 'fairness.decisions-about-people',
    category: 'fairness',
    severity: (s) => (!AFFECTS_PEOPLE(s) || !has(s, 'personal', 'sensitive_personal') ? null
      : s.decisionImpact === 'critical' || has(s, 'sensitive_personal') ? 'high' : 'medium'),
    why: (s) => `Its outputs have ${s.decisionImpact} impact on people and are based on personal data, so it can treat groups of people unequally.`,
    mitigations: [
      'Test outcomes for bias across relevant groups before release and on a regular schedule.',
      'Give affected people a way to challenge a decision and reach a person.',
    ],
  },
  {
    rule: 'human_oversight.missing',
    category: 'human_oversight',
    severity: (s) => (!AFFECTS_PEOPLE(s) ? null
      : s.humanOversight === 'none' ? 'high'
        : s.humanOversight === 'review' && s.decisionImpact === 'critical' ? 'medium' : null),
    why: (s) => (s.humanOversight === 'none'
      ? `Its outputs have ${s.decisionImpact} impact and take effect with no person involved.`
      : 'Its outputs have critical impact but a person only reviews them; nobody approves each one before it takes effect.'),
    mitigations: [
      'Require a named person to approve each high-impact output before it takes effect.',
      'Define when the system must stop and escalate to a person.',
    ],
  },
  {
    rule: 'transparency.user-facing',
    category: 'transparency',
    severity: (s) => (!s.userFacing ? null : AFFECTS_PEOPLE(s) ? 'medium' : 'low'),
    why: (s) => `People interact with it directly${AFFECTS_PEOPLE(s) ? ` and its outputs have ${s.decisionImpact} impact on them` : ''}.`,
    mitigations: [
      'Tell people clearly that they are dealing with an AI system.',
      'Explain the main reasons behind an output when someone asks, and offer a route to a person.',
    ],
  },
  {
    rule: 'security.sensitive-data',
    category: 'security',
    severity: (s) => (has(s, 'confidential', 'financial', 'sensitive_personal') ? 'medium' : null),
    why: (s) => `It handles ${s.dataCategories.filter((c) => ['confidential', 'financial', 'sensitive_personal'].includes(c)).join(', ').replace(/_/g, ' ')} data, a target for leaks and misuse.`,
    mitigations: [
      'Limit access to least privilege and log every access to the data.',
      'Test the system against misuse of its inputs (for example prompt injection) before release.',
    ],
  },
  {
    rule: 'accountability.inactive-status',
    category: 'accountability',
    severity: (s) => (s.status === 'paused' || s.status === 'retired' ? 'low' : null),
    why: (s) => `It is registered as ${s.status}; if it is still running, nobody is accountable for it.`,
    mitigations: [
      'Confirm with the owner that it is no longer used, and remove its access and data if so.',
    ],
  },
]);

const bySeverityThenCategory = (a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity)
  || RISK_CATEGORIES.indexOf(a.category) - RISK_CATEGORIES.indexOf(b.category)
  || a.rule.localeCompare(b.rule);

export function createRuleBasedRiskModel({ rules = RULES } = {}) {
  return {
    id: 'rule-based',
    version: '1',
    assess(system, { signal } = {}) {
      signal?.throwIfAborted();
      const risks = [];
      for (const r of rules) {
        const severity = r.severity(system);
        if (severity) risks.push({ category: r.category, severity, rule: r.rule, why: r.why(system), mitigations: [...r.mitigations] });
      }
      return { risks: risks.sort(bySeverityThenCategory) };
    },
  };
}

// Checks what a model returned and returns a clean copy, sorted. Throws
// RiskModelError naming the first thing wrong.
export function checkModelOutput(output) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.risks)) {
    throw new RiskModelError('the risk model did not return { risks: [...] }');
  }
  const text = (v) => typeof v === 'string' && v.trim() !== '';
  const risks = output.risks.map((r, i) => {
    const at = `risk #${i + 1}`;
    if (!r || typeof r !== 'object') throw new RiskModelError(`${at} is not an object`);
    if (!RISK_CATEGORIES.includes(r.category)) throw new RiskModelError(`${at} has unknown category ${JSON.stringify(r.category)}`);
    if (!SEVERITIES.includes(r.severity)) throw new RiskModelError(`${at} has unknown severity ${JSON.stringify(r.severity)}`);
    if (!text(r.rule)) throw new RiskModelError(`${at} does not name the rule that raised it`);
    if (!text(r.why)) throw new RiskModelError(`${at} does not say why it was raised`);
    if (!Array.isArray(r.mitigations) || r.mitigations.length === 0 || !r.mitigations.every(text)) {
      throw new RiskModelError(`${at} has no suggested mitigation`);
    }
    return { category: r.category, severity: r.severity, rule: r.rule, why: r.why, mitigations: [...r.mitigations] };
  });
  return { risks: risks.sort(bySeverityThenCategory) };
}

// A system's overall rating is its most severe risk. 'low' when no rule fired:
// the screen found nothing, which is not proof of no risk — the report says so.
export const overallRiskLevel = (risks) => risks.reduce(
  (worst, r) => (SEVERITIES.indexOf(r.severity) > SEVERITIES.indexOf(worst) ? r.severity : worst),
  'low',
);
