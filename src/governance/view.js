// The governance policy in force, as the rest of the system sees it (STORY-009).
//
//   const view = createGovernanceView({ governance, jurisdiction, audit });
//   await view.refresh();      // read the policy in force now
//   view.current()             // { jurisdiction, version, controls, reviewOverdue } or null
//
// Services read view.current() each time they need a control, so they always use
// the policy in force without being restarted. refresh() runs at start-up, after
// every approval, and from a timer (hourly by default) — so a version dated to take
// effect tomorrow switches over by itself — and records each switch in the audit
// log (governance.applied). The timer also raises review-date alerts.
//
// With no jurisdiction selected, current() is always null and every service keeps
// its built-in behaviour.

const errorText = (err) => `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;
const AGENT = { type: 'agent', id: 'governance-agent' };

export function createGovernanceView({ governance, jurisdiction = null, audit }) {
  let current = null;
  let appliedKey; // what was last recorded as in force: "UK v2", or "none"

  async function refresh() {
    if (!jurisdiction) return null;
    const active = await governance.getActivePolicy({ jurisdiction });
    current = active
      ? { jurisdiction: active.policy.jurisdiction, version: active.version, effectiveFrom: active.effectiveFrom, controls: active.policy.controls, illustrative: active.policy.illustrative, reviewOverdue: active.reviewOverdue }
      : null;
    const key = current ? `${jurisdiction} v${current.version}` : 'none';
    if (key !== appliedKey) {
      audit.append({
        correlationId: `governance:${jurisdiction}`, actor: AGENT, action: 'governance.applied', subject: key,
        rationale: current
          ? `Now applying the ${jurisdiction} governance policy, version ${current.version} (in force from ${current.effectiveFrom})${current.illustrative ? '; it is marked ILLUSTRATIVE, not reviewed legal policy' : ''}.`
          : `No approved governance policy is in force for ${jurisdiction}; the built-in rules apply until one is approved.`,
      });
      appliedKey = key;
    }
    return current;
  }

  function startTimer({ everyMs = 60 * 60 * 1000, timers = { setInterval, clearInterval }, onError = (msg) => { console.error(`governance: ${msg}`); } } = {}) {
    let running = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return Promise.resolve(null);
      running ??= (async () => {
        try {
          await refresh();
          return await governance.checkReviewDates();
        } catch (err) {
          // Keep using the last known policy; say so, and try again next time.
          onError(`could not refresh the policy in force; still applying the last one: ${errorText(err)}`);
          try {
            audit.append({ correlationId: `governance:${jurisdiction}`, actor: AGENT, action: 'governance.refresh_failed', rationale: errorText(err) });
          } catch (auditErr) {
            onError(`could not record that in the audit log: ${errorText(auditErr)}`);
          }
          return null;
        } finally {
          running = null;
        }
      })();
      return running;
    };
    const handle = timers.setInterval(tick, everyMs);
    handle?.unref?.();
    return { tick, async stop() { stopped = true; timers.clearInterval(handle); await running; } };
  }

  return { current: () => current, refresh, startTimer, jurisdiction };
}
