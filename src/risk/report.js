// Turns a risk assessment report (built by service.js) into plain text a
// compliance officer can read top to bottom: the summary, then one block per
// system — worst rating first — with each risk's category, severity, reason and
// suggested mitigations, then what was not assessed and what the report cannot tell you.

import { SEVERITIES } from './riskModel.js';

const label = (category) => category.replace(/_/g, ' ');
const worstFirst = (a, b) => SEVERITIES.indexOf(b.riskLevel) - SEVERITIES.indexOf(a.riskLevel) || a.name.localeCompare(b.name);

export function renderRiskReportText(report) {
  const { summary } = report;
  const lines = [
    `AI system risk assessment ${report.assessmentId}`,
    `Requested by ${report.requestedBy.id} at ${report.assessedAt}; risk model: ${report.model.id} v${report.model.version}`,
    '',
    `Registered: ${summary.registered}   Assessed: ${summary.assessed}   Not assessed (incomplete data): ${summary.unassessed}   Model failed: ${summary.failed}`,
    `Systems by overall risk: ${Object.entries(summary.systemsByRiskLevel).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `Risks by category: ${Object.entries(summary.risksByCategory).filter(([, n]) => n > 0).map(([k, n]) => `${label(k)} ${n}`).join(', ') || 'none'}`,
  ];

  for (const s of [...report.systems].sort(worstFirst)) {
    lines.push('', `[${s.riskLevel.toUpperCase()}] ${s.name} (${s.systemId}) — ${s.department}, owner ${s.owner}, ${s.systemStatus}`);
    if (s.risks.length === 0) lines.push('  No rule raised a risk.');
    s.risks.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${label(r.category)} — ${r.severity}: ${r.why}`);
      for (const m of r.mitigations) lines.push(`       → ${m}`);
    });
  }

  if (report.failed.length) {
    lines.push('', 'Not assessed — the risk model failed (run again to retry):');
    for (const f of report.failed) lines.push(`- ${f.name} (${f.systemId}): ${f.reason}`);
  }
  if (report.notice) lines.push('', report.notice);
  lines.push('', 'What this report cannot tell you:', ...report.limits.map((l) => `- ${l}`));
  return lines.join('\n');
}
