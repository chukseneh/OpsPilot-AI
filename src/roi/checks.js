// Flagging assumptions that are probably wrong (STORY-008, acceptance: "Given user
// assumptions are incorrect, When ROI is calculated, Then it flags potential errors").
//
//   await checkAssumptions(assumptions, result, { lookupAnalysis, lookupDocument }) → warnings
//
// A warning is { kind, code, path, message }. Warnings never change a number:
// the estimate is still shown, with the warnings beside it, for a person to judge.
//
// Two kinds:
//   plausibility — values that are possible but unusual (thresholds below, and
//                  stated in each message so the reader can disagree with them);
//   evidence     — an assumption linked to something the system observed that
//                  does not agree with it:
//                    { analysisId, activity }  STORY-002 analysis: assumed cases per
//                      year vs the observed count scaled to a year; assumed minutes
//                      per case vs the observed median duration
//                    { documentId, field }     STORY-007 document: an assumed cost or
//                      saving vs the document's figure (a contract value is spread
//                      over its term for a yearly cost), and its currency
//                  A link that leads nowhere, or to a document still flagged or
//                  rejected, is itself a warning — evidence is never silently skipped.
//
// lookupAnalysis(id) returns a saved STORY-002 report or null; lookupDocument(id) a
// STORY-007 document or null. Each lookup has a time limit; a lookup that fails or
// times out becomes a warning, not a crash and not a silent pass.

import { formatMoney } from './calculate.js';

export const DEFAULT_THRESHOLDS = Object.freeze({
  maxAutomationRate: 0.9,
  minCostPerHour: 10,
  maxCostPerHour: 250,
  maxHoursPerItem: 2000, // about one full-time person's year
  maxRoiPercent: 1000,
  minPaybackMonths: 1,
  analysisTolerance: 0.5, // assumed vs observed may differ by up to 50 %
  documentTolerance: 0.05, // assumed vs document figure may differ by up to 5 %
  minObservedDays: 30,
  lookupTimeoutMs: 5000,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const pct = (x) => `${Math.round(x * 100)}%`;
const differs = (assumed, observed, tolerance) => observed === 0 ? assumed !== 0 : Math.abs(assumed - observed) / observed > tolerance;

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkAssumptions(a, result, {
  lookupAnalysis = async () => null, lookupDocument = async () => null, thresholds = {},
} = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const warnings = [];
  const warn = (kind, code, path, message) => warnings.push({ kind, code, path, message });
  const money = (minor) => formatMoney(minor, a.currency);

  // ---- Plausibility: the assumptions themselves ----
  a.timeSavings.forEach((s, i) => {
    const at = `timeSavings[${i}]`;
    if (s.automationRate > t.maxAutomationRate) warn('plausibility', 'automation_rate_high', `${at}.automationRate`, `"${s.label}": ${pct(s.automationRate)} of the work automated is unusually high (above ${pct(t.maxAutomationRate)}); most automation leaves some steps to people.`);
    if (s.automationRate === 0 || s.casesPerYear === 0) warn('plausibility', 'saves_nothing', at, `"${s.label}": with ${s.casesPerYear} cases and ${pct(s.automationRate)} automated, this saves nothing.`);
    const perHour = s.costPerHourMinor / 100;
    if (perHour < t.minCostPerHour || perHour > t.maxCostPerHour) warn('plausibility', 'cost_per_hour_unusual', `${at}.costPerHour`, `"${s.label}": ${money(s.costPerHourMinor)} per hour is outside the usual ${t.minCostPerHour}–${t.maxCostPerHour}; check it is the full hourly cost of the people doing the work.`);
    const hours = (s.casesPerYear * s.minutesPerCase * s.automationRate) / 60;
    if (hours > t.maxHoursPerItem) warn('plausibility', 'hours_saved_high', at, `"${s.label}": ${Math.round(hours)} hours saved a year is more than ${Math.round(hours / t.maxHoursPerItem * 10) / 10} full-time people; check the volume and minutes per case.`);
  });
  a.costs.oneOff.concat(a.costs.perYear).forEach((c) => {
    if (c.amountMinor === 0) warn('plausibility', 'zero_cost', 'costs', `"${c.label}" costs nothing; automation rarely has no cost.`);
  });
  if (a.uncertainty.savings === 0 && a.uncertainty.costs === 0) warn('plausibility', 'no_uncertainty', 'uncertainty', 'No uncertainty was stated, so the low and high cases equal the expected one; real estimates are rarely exact.');

  // ---- Plausibility: results that look too good, or bad even at best ----
  const e = result.expected;
  if (e.roiPercent !== null && e.roiPercent > t.maxRoiPercent) warn('plausibility', 'roi_very_high', 'result', `An ROI of ${e.roiPercent}% is far above ${t.maxRoiPercent}%; results this good usually mean an assumption is too optimistic.`);
  if (e.paybackMonths !== null && e.paybackMonths < t.minPaybackMonths && e.oneOffCosts > 0) warn('plausibility', 'payback_very_fast', 'result', `Paying back in ${e.paybackMonths} months is unusually fast; check the savings and the one-off costs.`);
  if (result.high.netBenefit < 0) warn('plausibility', 'loses_even_at_best', 'result', `Even the high case loses ${money(-result.high.netBenefit)} over ${a.horizonYears} years.`);

  // ---- Evidence ----
  const items = [
    ...a.timeSavings.map((s, i) => ({ s, path: `timeSavings[${i}]`, type: 'time' })),
    ...a.otherSavings.map((s, i) => ({ s, path: `otherSavings[${i}]`, type: 'saving', minor: s.amountPerYearMinor, perYear: true })),
    ...a.costs.oneOff.map((s, i) => ({ s, path: `costs.oneOff[${i}]`, type: 'cost', minor: s.amountMinor, perYear: false })),
    ...a.costs.perYear.map((s, i) => ({ s, path: `costs.perYear[${i}]`, type: 'cost', minor: s.amountMinor, perYear: true })),
  ].filter((x) => x.s.evidence);

  for (const { s, path, type, minor, perYear } of items) {
    const ev = s.evidence;
    const at = `${path}.evidence`;
    try {
      if (ev.analysisId) {
        if (type !== 'time') { warn('evidence', 'evidence_wrong_kind', at, `"${s.label}": a process analysis can only support a time saving, not a ${type}.`); continue; }
        await checkAgainstAnalysis(s, at, await withTimeout(Promise.resolve(lookupAnalysis(ev.analysisId)), t.lookupTimeoutMs, `Looking up analysis ${ev.analysisId}`));
      } else {
        if (type === 'time') { warn('evidence', 'evidence_wrong_kind', at, `"${s.label}": a document figure cannot support a time saving; link a process analysis instead.`); continue; }
        checkAgainstDocument(s, at, minor, perYear, await withTimeout(Promise.resolve(lookupDocument(ev.documentId)), t.lookupTimeoutMs, `Looking up document ${ev.documentId}`));
      }
    } catch (err) {
      warn('evidence', 'evidence_unavailable', at, `"${s.label}": the evidence could not be checked (${err.message}); the assumption is unconfirmed.`);
    }
  }
  return warnings;

  async function checkAgainstAnalysis(s, at, report) {
    const ev = s.evidence;
    if (!report) { warn('evidence', 'evidence_missing', at, `"${s.label}": analysis ${ev.analysisId} was not found.`); return; }
    const act = report.activities?.find((x) => x.activity.trim().toLowerCase() === ev.activity.trim().toLowerCase());
    if (!act) { warn('evidence', 'evidence_missing', at, `"${s.label}": analysis ${ev.analysisId} has no step "${ev.activity}".`); return; }

    const days = (Date.parse(report.scope.period.to) - Date.parse(report.scope.period.from)) / DAY_MS;
    if (days < t.minObservedDays) warn('evidence', 'evidence_period_short', at, `"${s.label}": analysis ${ev.analysisId} covers only ${Math.round(days * 10) / 10} days; scaling it to a year is unreliable.`);
    const observedPerYear = days > 0 ? Math.round((act.occurrences / days) * 365) : null;
    if (observedPerYear !== null && differs(s.casesPerYear, observedPerYear, t.analysisTolerance)) {
      warn('evidence', 'volume_differs', `${at}`, `"${s.label}": assumes ${s.casesPerYear} cases a year, but analysis ${ev.analysisId} saw ${act.occurrences} in ${Math.round(days)} days (about ${observedPerYear} a year) — more than ${pct(t.analysisTolerance)} apart.`);
    }
    if (typeof act.medianDurationMs !== 'number') warn('evidence', 'evidence_incomplete', at, `"${s.label}": analysis ${ev.analysisId} does not record a numeric duration for "${act.activity}".`);
    else {
      const observedMinutes = act.medianDurationMs / 60000;
      if (differs(s.minutesPerCase, observedMinutes, t.analysisTolerance)) {
        warn('evidence', 'duration_differs', at, `"${s.label}": assumes ${s.minutesPerCase} minutes a case, but the observed median for "${act.activity}" is ${Math.round(observedMinutes * 10) / 10} minutes — more than ${pct(t.analysisTolerance)} apart.`);
      }
    }
  }

  function checkAgainstDocument(s, at, minor, perYear, doc) {
    const ev = s.evidence;
    if (!doc) { warn('evidence', 'evidence_missing', at, `"${s.label}": document ${ev.documentId} was not found.`); return; }
    if (!['extracted', 'reviewed'].includes(doc.status)) { warn('evidence', 'evidence_unconfirmed', at, `"${s.label}": document ${ev.documentId} is ${doc.status.replace(/_/g, ' ')}, so its figures are not confirmed.`); return; }
    const f = doc.fields?.[ev.field];
    if (!f || typeof f.value !== 'number') { warn('evidence', 'evidence_missing', at, `"${s.label}": document ${ev.documentId} has no amount "${ev.field}".`); return; }
    const docCurrency = doc.fields.currency?.value;
    if (docCurrency && docCurrency !== a.currency) { warn('evidence', 'currency_differs', at, `"${s.label}": document ${ev.documentId} is in ${docCurrency}, but the estimate is in ${a.currency}.`); return; }

    let documentMinor = Math.round(f.value * 100);
    let basis = `${ev.field} ${money(documentMinor)}`;
    const termMonths = doc.fields.term?.value?.months;
    if (perYear && doc.kind === 'contract' && termMonths) {
      documentMinor = Math.round((documentMinor * 12) / termMonths);
      basis += ` over ${termMonths} months = ${money(documentMinor)} a year`;
    }
    if (differs(minor, documentMinor, t.documentTolerance)) {
      warn('evidence', 'amount_differs', at, `"${s.label}": assumes ${money(minor)}${perYear ? ' a year' : ''}, but document ${ev.documentId} says ${basis} — more than ${pct(t.documentTolerance)} apart.`);
    }
  }
}
