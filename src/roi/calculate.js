// The ROI calculation (STORY-008, REQ-009). Pure: assumptions in (already checked
// by validateAssumptions, money in minor units), figures out — each with the
// formula that produced it, written out with the real numbers so a person can
// check it by hand.
//
//   time saved per year   = cases × minutes × automation rate ÷ 60        (hours)
//   saving per year       = hours saved × cost per hour
//   annual savings        = time savings + other savings
//   total savings         = annual savings × years
//   total costs           = one-off costs + yearly costs × years
//   net benefit           = total savings − total costs
//   ROI                   = net benefit ÷ total costs                      (%)
//   payback               = one-off costs ÷ (annual savings − yearly costs) × 12   (months)
//
// The same is worked out three times: expected, low (savings down and costs up by
// the stated uncertainty) and high (the reverse).
//
// "Calculation errors" are never shown as numbers:
//   - every money figure must be an exact whole number of minor units; anything
//     that overflows that raises CalculationError;
//   - zero total costs gives "ROI cannot be calculated", not Infinity;
//   - yearly costs at or above annual savings give "never pays back", not a
//     negative number of months;
//   - net benefit is also worked out a second, independent way (adding up the
//     year-by-year cash flows); if the two disagree, CalculationError.

export class CalculationError extends Error {
  constructor(message, options) { super(message, options); this.name = 'CalculationError'; }
}

export function formatMoney(minor, currency) {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100).toLocaleString('en-GB');
  return `${sign}${currency} ${major}.${String(abs % 100).padStart(2, '0')}`;
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// Every money figure passes through here: whole minor units, or a CalculationError.
function exact(minor, what) {
  if (!Number.isSafeInteger(minor)) {
    throw new CalculationError(`${what} cannot be represented exactly (${minor}); the assumptions are too large to calculate safely.`);
  }
  return minor;
}

// Independent check: the cash flows (year 0: −one-off; each year: savings − costs) must add up to the net benefit.
export function checkNetBenefit(net, cashFlows, label = 'expected') {
  const total = cashFlows.reduce((s, x) => s + x, 0);
  if (total !== net) {
    throw new CalculationError(`The ${label} net benefit does not agree with its year-by-year cash flows (${net} vs ${total}); the result was not shown.`);
  }
}

export function calculateRoi(a) {
  const money = (minor) => formatMoney(minor, a.currency);
  const N = a.horizonYears;

  // ---- Savings, item by item ----
  const timeItems = a.timeSavings.map((t) => {
    const minutes = t.casesPerYear * t.minutesPerCase * t.automationRate;
    const hours = minutes / 60;
    const saving = exact(Math.round((minutes * t.costPerHourMinor) / 60), `The saving for "${t.label}"`);
    return {
      label: t.label,
      hoursSavedPerYear: Math.round(hours * 10) / 10,
      savingPerYear: saving,
      formula: `${t.casesPerYear} cases × ${t.minutesPerCase} min × ${pct(t.automationRate)} ÷ 60 = ${Math.round(hours * 10) / 10} h × ${money(t.costPerHourMinor)}/h = ${money(saving)}`,
    };
  });
  const otherItems = a.otherSavings.map((s) => ({ label: s.label, savingPerYear: s.amountPerYearMinor, formula: `stated: ${money(s.amountPerYearMinor)} per year` }));

  const annualSavings = exact(sum([...timeItems, ...otherItems].map((i) => i.savingPerYear)), 'Annual savings');
  const oneOff = exact(sum(a.costs.oneOff.map((c) => c.amountMinor)), 'One-off costs');
  const yearly = exact(sum(a.costs.perYear.map((c) => c.amountMinor)), 'Yearly costs');

  // ---- One scenario: savings and costs scaled by the given factors ----
  function scenario(label, savingsFactor, costsFactor) {
    const s = exact(Math.round(annualSavings * savingsFactor), `${label} annual savings`);
    const o = exact(Math.round(oneOff * costsFactor), `${label} one-off costs`);
    const y = exact(Math.round(yearly * costsFactor), `${label} yearly costs`);
    const totalSavings = exact(s * N, `${label} total savings`);
    const totalCosts = exact(o + y * N, `${label} total costs`);
    const net = exact(totalSavings - totalCosts, `${label} net benefit`);
    checkNetBenefit(net, [-o, ...Array.from({ length: N }, () => s - y)], label);

    const notes = [];
    let roiPercent = null;
    if (totalCosts > 0) roiPercent = Math.round((net / totalCosts) * 1000) / 10;
    else notes.push('ROI cannot be calculated: total costs are zero.');

    const yearlyNet = s - y;
    let paybackMonths = null;
    if (yearlyNet <= 0) notes.push('Never pays back: yearly costs are at least as large as annual savings.');
    else paybackMonths = o === 0 ? 0 : Math.round((o / yearlyNet) * 12 * 10) / 10;
    if (paybackMonths !== null && paybackMonths > N * 12) notes.push(`Does not pay back within the ${N}-year horizon.`);

    return {
      annualSavings: s, oneOffCosts: o, yearlyCosts: y, totalSavings, totalCosts, netBenefit: net, roiPercent, paybackMonths, notes,
      formulas: {
        totalSavings: `${money(s)} × ${N} years = ${money(totalSavings)}`,
        totalCosts: `${money(o)} + ${money(y)} × ${N} years = ${money(totalCosts)}`,
        netBenefit: `${money(totalSavings)} − ${money(totalCosts)} = ${money(net)}`,
        roi: roiPercent === null ? 'not calculable (total costs are zero)' : `${money(net)} ÷ ${money(totalCosts)} = ${roiPercent}%`,
        payback: paybackMonths === null ? 'never (yearly costs ≥ annual savings)' : `${money(o)} ÷ (${money(s)} − ${money(y)}) × 12 = ${paybackMonths} months`,
      },
    };
  }

  const { savings: us, costs: uc } = a.uncertainty;
  return {
    name: a.name,
    currency: a.currency,
    horizonYears: N,
    savings: [...timeItems, ...otherItems],
    expected: scenario('expected', 1, 1),
    low: scenario('low', 1 - us, 1 + uc),
    high: scenario('high', 1 + us, 1 - uc),
    range: `low: savings −${pct(us)}, costs +${pct(uc)}; high: savings +${pct(us)}, costs −${pct(uc)}`,
  };
}
