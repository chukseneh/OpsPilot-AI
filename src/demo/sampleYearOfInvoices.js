// SYNTHETIC SAMPLE DATA for the STORY-008 ROI demo — made up, not from any real
// organisation. A year of invoice processing (1 October 2025 to 30 September 2026),
// so an ROI estimate can be checked against a year of observed volume and timings.
//
// The STORY-002 sample (sampleProcessData.js) is deliberately small — 30 invoices
// in September, with problems planted for the analysis demo — and too short to
// scale to a year. This one is plain: about 500 invoices a month on working days,
// with the same step names and similar step durations.
//
// Seeded, so every run produces exactly the same event log.

export const YEAR_SAMPLE_LABEL = 'SYNTHETIC sample data: a made-up year of invoice processing';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleYearOfInvoices({ cases = 6000, seed = 2025 } = {}) {
  const random = rng(seed);
  const between = (lo, hi) => lo + Math.round(random() * (hi - lo));
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;

  // The working days (Monday to Friday) of the year.
  const days = [];
  for (let d = Date.UTC(2025, 9, 1); d <= Date.UTC(2026, 8, 30); d += DAY) {
    const weekday = new Date(d).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(d);
  }

  const events = [];
  for (let i = 0; i < cases; i += 1) {
    const caseId = `YR-${100001 + i}`;
    // Spread the invoices evenly over the working days, starting between 08:00 and 14:00.
    let t = days[Math.floor((i * days.length) / cases)] + (8 * 60 + between(0, 360)) * MIN;
    const step = (activity, actor, minutes) => {
      events.push({ caseId, activity, actor, startedAt: new Date(t).toISOString(), endedAt: new Date(t + minutes * MIN).toISOString() });
      t += minutes * MIN;
    };
    const clerk = `ap-clerk-${1 + (i % 4)}`;
    step('Receive invoice', clerk, between(3, 5));
    t += between(10, 30) * MIN;
    step('Enter invoice into system', clerk, between(6, 8));
    t += between(15, 45) * MIN;
    step('Check purchase order', 'ap-clerk-5', between(12, 20));
    t += between(60, 240) * MIN;
    step('Manager approval', `manager-${1 + (i % 3)}`, between(10, 40));
    t += between(20, 60) * MIN;
    step('Schedule payment', 'ap-clerk-1', between(4, 5));
  }
  return { process: 'Invoice processing (a year)', _note: YEAR_SAMPLE_LABEL, events };
}
