// STORY-010 demo: simulating workflows on SYNTHETIC data.
//
//   node src/demo/simulation.js
//
// Starts OpsPilot (PGlite, throwaway signing key) and runs every simulation through
// services.simulation — each in its own sandbox, never in the live system.
//
// Shows: a hand-written scenario passing step by step (including an approval and
// a personal-data rule under the illustrative EU policy); a generated scenario
// passing against independent expectations; incorrect synthetic data refused;
// an unexpected behaviour caught as CRITICAL; a data generation error; a timeout;
// and the audit trail, with the live inventory untouched.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { startOpsPilot } from '../system.js';

const TESTER = { id: 'system-tester-1', role: 'system tester' };
const IT = { id: 'it-manager-1', role: 'IT manager' };

const sys = (id, label, riskLevel, over = {}) => ({
  id, name: `${label} (SYNTHETIC)`, department: 'Finance', purpose: 'Invented for simulation', owner: 'SYN-owner',
  status: 'active', dataCategories: ['internal'], decisionImpact: 'low', humanOversight: 'review', userFacing: false, riskLevel, ...over,
});

export const INVOICE_SCENARIO = {
  id: 'SIM-invoice-payments', synthetic: true, label: 'SYNTHETIC — invoice payments, invented for simulation',
  policy: 'EU',
  systems: [
    sys('SYN-ledger', 'Ledger sync', 'low'),
    sys('SYN-claims', 'Claims triage', 'low', { dataCategories: ['personal'] }),
  ],
  workflows: [
    {
      id: 'SYN-WF-routine', name: 'Routine ticket (SYNTHETIC)',
      actions: [{ type: 'create_ticket', params: { title: 'Reconcile ledger' } }, { type: 'notify', params: { systemId: 'SYN-ledger', to: 'finance' } }],
      expect: { steps: [{ riskLevel: 'low', outcome: 'succeeded' }, { riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' },
    },
    {
      id: 'SYN-WF-payment', name: 'Pay a supplier (SYNTHETIC)',
      actions: [{ type: 'payment', params: { amount: 2400, to: 'SYN-supplier' } }, { type: 'notify', params: { systemId: 'SYN-ledger', to: 'finance' } }],
      decide: [{ step: 1, decision: 'approve' }],
      expect: { steps: [{ riskLevel: 'high', outcome: 'succeeded' }, { riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' },
    },
    {
      id: 'SYN-WF-personal', name: 'Notify about a personal-data system under EU rules (SYNTHETIC)',
      actions: [{ type: 'notify', params: { systemId: 'SYN-claims', to: 'claims-owner' } }],
      expect: { steps: [{ riskLevel: 'high', outcome: 'awaiting_approval' }], final: 'awaiting_approval' },
    },
  ],
};

export async function runSimulationDemo({ print = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opspilot-simulation-'));
  const idle = { timers: { setInterval: () => ({}), clearInterval: () => {} } };
  const sys0 = await startOpsPilot({
    env: { AUDIT_LOG_KEY: randomBytes(32).toString('hex'), PGLITE_DATA_DIR: join(dir, 'db'), AUDIT_LOG_FILE: join(dir, 'audit.jsonl') },
    timers: { approvals: idle, anchors: idle, governance: idle },
  });
  const sim = sys0.services.simulation;
  const out = {};
  const rule = (title) => print(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  const attempt = async (fn) => { try { return { ok: await fn() }; } catch (err) { return { err }; } };
  const showSteps = (report, scenario) => {
    for (const w of scenario.workflows) {
      const got = report.report.workflows.find((x) => x.id === w.id);
      const verdict = report.report.comparison.workflows.find((x) => x.id === w.id).verdict;
      print(`   ${verdict === 'passed' ? '✔' : '✖'} ${w.name}`);
      w.expect.steps.forEach((e, j) => {
        const a = got?.actions[j];
        const fmt = (risk, outcome) => `${risk ? `${risk}, ` : ''}${outcome}`;
        print(`       step ${j + 1} ${w.actions[j].type.padEnd(14)} expected ${fmt(e.riskLevel, e.outcome).padEnd(26)} got ${a ? fmt(a.riskLevel, a.outcome) : 'nothing'}${a?.reasons?.length ? `   [${a.reasons.join(', ')}]` : ''}`);
      });
    }
  };
  try {
    print('OpsPilot AI — workflow simulation on SYNTHETIC data. Every run uses its own sandbox.');

    rule('1. A hand-written scenario executes as expected (EU example policy applied)');
    out.passed = await sim.runSimulation({ user: TESTER, runId: 'RUN-invoices', scenario: INVOICE_SCENARIO });
    showSteps(out.passed, INVOICE_SCENARIO);
    print(`   Verdict: ${out.passed.verdict.toUpperCase()} — ${out.passed.summary.steps.matched} of ${out.passed.summary.steps.checked} steps as expected`);

    rule('2. A generated scenario (seed 42, 10 workflows) against independent expectations');
    out.generated = await sim.runSimulation({ user: TESTER, runId: 'RUN-generated-42', generate: { seed: 42, workflows: 10 } });
    print(`   Verdict: ${out.generated.verdict.toUpperCase()} — ${out.generated.summary.workflows.passed} of ${out.generated.summary.workflows.total} workflows, ${out.generated.summary.steps.checked} steps checked`);

    rule('3. Incorrect synthetic data is refused — nothing runs');
    const bad = structuredClone(INVOICE_SCENARIO);
    bad.synthetic = false;
    bad.systems[0].id = 'ai-ledger-prod';
    bad.workflows[0].expect.steps.pop();
    out.incorrect = (await attempt(() => sim.runSimulation({ user: TESTER, runId: 'RUN-bad-data', scenario: bad }))).err;
    print(`   ${out.incorrect.name}:`);
    for (const p of out.incorrect.problems) print(`     ✗ ${p.path} ${p.problem}`);

    const mismatches = (report) => report.report.comparison.workflows.flatMap((w) => w.mismatches)
      .forEach((m) => print(`     ${m.severity === 'critical' ? '‼ CRITICAL' : '•'} ${m.message}`));

    rule('4a. Unexpected behaviour: a payment wrongly expected to run unattended');
    print('   (The engine was STRICTER than expected — a mismatch, but not a dangerous one.)');
    const wrong = structuredClone(INVOICE_SCENARIO);
    wrong.id = 'SIM-wrong-expectation';
    delete wrong.workflows[1].decide;
    wrong.workflows[1].expect = { steps: [{ riskLevel: 'low', outcome: 'succeeded' }, { riskLevel: 'low', outcome: 'succeeded' }], final: 'completed' };
    out.unexpected = await sim.runSimulation({ user: TESTER, runId: 'RUN-wrong', scenario: wrong });
    print(`   Verdict: ${out.unexpected.verdict.toUpperCase()} (${out.unexpected.summary.critical} critical)`);
    mismatches(out.unexpected);

    rule('4b. Unexpected behaviour: the same scenario WITHOUT the EU policy');
    print('   (A step expected to need a person ran WITHOUT one — the dangerous direction, graded CRITICAL.)');
    const noPolicy = structuredClone(INVOICE_SCENARIO);
    noPolicy.id = 'SIM-no-policy';
    delete noPolicy.policy;
    out.critical = await sim.runSimulation({ user: TESTER, runId: 'RUN-no-policy', scenario: noPolicy });
    print(`   Verdict: ${out.critical.verdict.toUpperCase()} (${out.critical.summary.critical} critical)`);
    mismatches(out.critical);

    rule('5. A data generation error, and a timeout');
    out.generationError = (await attempt(() => sim.runSimulation({ user: TESTER, runId: 'RUN-gen-bad', generate: { seed: 1, workflows: 0 } }))).err;
    print(`   Generator asked for 0 workflows → ${out.generationError.message}`);
    out.timedOut = await sim.runSimulation({ user: TESTER, runId: 'RUN-too-slow', generate: { seed: 7, workflows: 50 }, timeoutMs: 300 });
    print(`   50 workflows with a 300 ms limit → ${out.timedOut.verdict.toUpperCase()}: ${out.timedOut.report.error} (${out.timedOut.summary.workflows.unchecked} left unchecked, not counted as passing)`);

    rule('6. Logged for review — and nothing touched the live system');
    out.entries = sys0.audit.readAll().filter((e) => e.action.startsWith('simulation.'));
    for (const e of out.entries) {
      print(`  #${String(e.seq).padStart(2)} ${e.actor.id.padEnd(16)} ${e.action.padEnd(22)} ${e.subject ?? ''}`);
      if (e.rationale) print(`        ${e.rationale.length > 150 ? `${e.rationale.slice(0, 147)}...` : e.rationale}`);
    }
    const saved = await sim.getSimulation({ user: TESTER, runId: 'RUN-invoices' });
    print(`\n  Saved report RUN-invoices keeps the sandbox's own log: ${saved.sandboxLog.length} entries (e.g. ${[...new Set(saved.sandboxLog.map((e) => e.action))].slice(0, 4).join(', ')}, …)`);
    out.liveInventory = (await sys0.services.inventory.listSystems({ user: IT })).systems.length;
    out.liveWorkflowEntries = sys0.audit.readAll().filter((e) => e.action.startsWith('workflow.')).length;
    print(`  Live inventory: ${out.liveInventory} systems; live workflow entries: ${out.liveWorkflowEntries} — simulations never reached the live system.`);
    out.audit = sys0.audit.verify();
    print(`  Main audit chain: ${out.audit.ok ? `verified — ${out.audit.count} entries, keyed, none edited or removed` : `BROKEN at #${out.audit.brokenAt}`}`);
    return out;
  } finally {
    await sys0.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSimulationDemo().then(
    (r) => { process.exitCode = r.audit.ok && r.passed.verdict === 'passed' ? 0 : 1; },
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
