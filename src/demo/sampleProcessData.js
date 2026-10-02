// SYNTHETIC SAMPLE DATA FOR THE DEMO — made up, not from any real organisation or
// system. A seeded generator, so every run produces exactly the same event log.
//
// The made-up "Invoice approval" process, with problems planted on purpose:
//   Receive invoice → Enter invoice into system → Check purchase order
//     → (long wait) → Manager approval → Schedule payment
//   - a 3–6 hour wait before Manager approval            (a bottleneck)
//   - Check purchase order redone in some cases          (rework)
//   - two managers approving the same invoice at once    (duplicated effort)
//   - short, routine entry and scheduling steps          (automation candidates)

export const SAMPLE_LABEL = 'SYNTHETIC sample data (made up for the demo)';

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

export function sampleInvoiceProcess({ cases = 30, seed = 2026 } = {}) {
  const random = rng(seed);
  const between = (lo, hi) => lo + Math.round(random() * (hi - lo));
  const MIN = 60 * 1000;
  const events = [];

  for (let i = 0; i < cases; i += 1) {
    const caseId = `INV-${1001 + i}`;
    let t = Date.UTC(2026, 8, 1 + (i % 26), 8 + (i % 3), between(0, 50)); // spread over September
    const step = (activity, actor, minutes) => {
      events.push({ caseId, activity, actor, startedAt: new Date(t).toISOString(), endedAt: new Date(t + minutes * MIN).toISOString() });
      t += minutes * MIN;
    };
    const wait = (minutes) => { t += minutes * MIN; };

    step('Receive invoice', `ap-clerk-${1 + (i % 2)}`, between(3, 5));
    wait(between(10, 20));
    step('Enter invoice into system', `ap-clerk-${1 + (i % 2)}`, between(6, 8));
    wait(between(15, 30));
    step('Check purchase order', 'ap-clerk-3', between(10, 20));
    if (i % 5 === 1) { // rework: the check is sent back and done again
      wait(between(60, 120));
      step('Check purchase order', 'ap-clerk-3', between(10, 20));
    }
    wait(between(180, 360));
    if (i % 10 === 4) { // two managers pick up the same approval at once
      const start = t;
      step('Manager approval', 'manager-1', between(20, 40));
      const end = t;
      t = start + 5 * MIN;
      step('Manager approval', 'manager-2', between(15, 25));
      t = Math.max(t, end);
    } else {
      step('Manager approval', `manager-${1 + (i % 2)}`, between(10, 60));
    }
    wait(between(20, 40));
    step('Schedule payment', 'ap-clerk-1', between(4, 5));
  }
  return { process: 'Invoice approval', _note: SAMPLE_LABEL, events };
}

// The same log with gaps, to show what happens when data is incomplete.
export function sampleWithGaps() {
  const data = sampleInvoiceProcess();
  delete data.events[3].endedAt;
  data.events[10].actor = '';
  data.events[22].startedAt = '2026-09-03 14:00'; // no time zone
  return data;
}
