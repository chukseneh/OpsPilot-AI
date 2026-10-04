// The dashboard's pages, as plain HTML strings. Pure functions: data in, HTML out.
// Everything that comes from data goes through esc(), so nothing in a report (a
// process name, an activity, a user id) can inject markup or script into the page.
// The server catches anything thrown here and shows an error page instead of half
// a page (the "rendering error" failure path).

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

const when = (iso) => (iso ? `${esc(iso.slice(0, 10))} ${esc(iso.slice(11, 16))} UTC` : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Colours as tokens, light and dark, matching the Command Center's palette.
const STYLE = `
:root { --bg:#f5f6f8; --surface:#fff; --surface-2:#eceef2; --border:#d7dbe1; --text:#1d222a; --muted:#5a6472;
  --accent:#2f5d8a; --accent-soft:#e3ecf5; --ok:#2e7d4f; --warn:#9a5800; --warn-bg:#fff3dc; --bad:#b3261e; color-scheme:light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#14171c; --surface:#1c2027; --surface-2:#252a33;
  --border:#343a45; --text:#e6e9ee; --muted:#9aa3b0; --accent:#7fb0e0; --accent-soft:#22303f; --ok:#6cc28f; --warn:#f0b660;
  --warn-bg:#3a2c14; --bad:#f28b82; color-scheme:dark; } }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.5 }
a { color:var(--accent) } .wrap { max-width:1080px; margin:0 auto; padding:0 16px }
header { background:var(--surface); border-bottom:1px solid var(--border) } .bar { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; padding:12px 16px; max-width:1080px; margin:0 auto }
.brand { font-weight:700; margin-right:auto; text-decoration:none; color:inherit } .who { color:var(--muted); font-size:.9rem }
.demo { background:var(--warn-bg); color:var(--warn); font-size:.85rem; padding:6px 16px; text-align:center }
h1 { font-size:1.5rem; margin:24px 0 4px } h2 { font-size:1.15rem; margin:28px 0 8px } .lede { color:var(--muted); margin:0 0 16px }
.counts { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:12px 0 }
.count { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px }
.count b { display:block; font-size:1.6rem } .count span { color:var(--muted); font-size:.85rem }
.finding { background:var(--surface); border:1px solid var(--border); border-left:4px solid var(--accent); border-radius:8px; padding:12px 16px; margin:8px 0 }
.finding.automation { border-left-color:var(--ok) } .finding h3 { margin:0 0 4px; font-size:1rem } .finding p { margin:4px 0 }
.examples { color:var(--muted); font-size:.85rem } .empty { padding:16px; border:1px dashed var(--border); border-radius:10px; background:var(--surface); color:var(--muted) }
.table-wrap { overflow-x:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px }
table { width:100%; border-collapse:collapse; font-size:.9rem } th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--border); vertical-align:top }
th { background:var(--surface-2); color:var(--muted) } tr:last-child td { border-bottom:0 }
.notice { background:var(--warn-bg); color:var(--warn); padding:10px 14px; border-radius:8px; margin:12px 0 }
.error h1 { color:var(--bad) } form.signin { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; max-width:420px }
label { display:block; margin:10px 0 4px; font-weight:600 } input { width:100%; font:inherit; padding:8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text) }
button { font:inherit; padding:8px 16px; border:0; border-radius:6px; background:var(--accent); color:var(--surface); cursor:pointer; margin-top:12px }
.linkish { background:none; color:var(--accent); padding:0; margin:0; text-decoration:underline }
ul.plain { padding-left:18px } footer.wrap { color:var(--muted); font-size:.8rem; padding:32px 16px }
`;

export function page({ title, user, body }) {
  const who = user
    ? `<span class="who">Signed in as <b>${esc(user.id)}</b> (${esc(user.role)})</span>
       <form method="post" action="/sign-out" style="display:inline"><button class="linkish" type="submit">Sign out</button></form>`
    : '<a href="/sign-in">Sign in</a>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — OpsPilot dashboard</title><style>${STYLE}</style></head>
<body>
<header><div class="bar"><a class="brand" href="/">OpsPilot AI · Process analysis dashboard</a>${who}</div>
<div class="demo">Demo sign-in — a stand-in for real authentication. Who you are is what you typed.</div></header>
<main class="wrap">${body}</main>
<footer class="wrap">Every page view is recorded in the audit log with your user id and the time.</footer>
</body></html>`;
}

function findingCard(f) {
  const examples = f.exampleCases?.length
    ? `<p class="examples">Example cases: ${f.exampleCases.map((c) => `${esc(c.caseId)} (${esc(c.duration)})`).join(', ')}</p>` : '';
  return `<div class="finding${f.type === 'automation' ? ' automation' : ''}"><h3>${esc(f.id)}. ${esc(f.title)}</h3><p>${esc(f.explanation)}</p>${examples}</div>`;
}

function findingSections(report) {
  const section = (title, type, none) => {
    const fs = report.findings.filter((f) => f.type === type);
    return `<h2>${title} (${fs.length})</h2>${fs.length ? fs.map(findingCard).join('') : `<div class="empty">${none}</div>`}`;
  };
  return section('Automation opportunities', 'automation', 'No step met the automation-candidate rule.')
    + section('Bottlenecks', 'bottleneck', 'No step met the bottleneck rule.')
    + section('Duplicated work', 'duplicate', 'No duplicated work was found.');
}

function counts(c) {
  const box = (n, label) => `<div class="count"><b>${esc(n)}</b><span>${label}</span></div>`;
  return `<div class="counts">${box(c.automationCandidates, 'automation opportunities')}${box(c.bottlenecks, 'bottlenecks')}${box(c.duplicates, 'kinds of duplicated work')}</div>`;
}

const skippedNote = (skipped) => (skipped
  ? `<div class="notice">${plural(skipped, 'saved analysis', 'saved analyses')} could not be read and ${skipped === 1 ? 'is' : 'are'} not shown.</div>` : '');

// Criterion 1: the results and the automation opportunities, on the first page.
export function renderDashboard({ user, analyses, skipped = 0, latest }) {
  const rows = analyses.map((a) => `<tr>
    <td><a href="/analyses/${encodeURIComponent(a.analysisId)}">${esc(a.process)}</a><br><span class="examples">${esc(a.analysisId)}</span></td>
    <td>${when(a.generatedAt)}</td><td>${esc(a.requestedBy)}</td><td>${esc(a.cases)}</td>
    <td>${esc(a.counts.automationCandidates)}</td><td>${esc(a.counts.bottlenecks)}</td><td>${esc(a.counts.duplicates)}</td></tr>`).join('');
  const top = analyses[0];
  return page({
    title: 'Dashboard', user,
    body: `<h1>Process analysis results</h1>
      <p class="lede">${plural(analyses.length, 'analysis', 'analyses')} available. The latest is shown first.</p>
      ${skippedNote(skipped)}
      <h2>Latest: ${esc(latest.process)}</h2>
      <p class="lede">Run by ${esc(top.requestedBy)} on ${when(latest.generatedAt)} · ${esc(latest.scope.cases)} cases from ${when(latest.scope.period.from)} to ${when(latest.scope.period.to)} ·
        <a href="/analyses/${encodeURIComponent(latest.analysisId)}">full report</a></p>
      <p><b>${esc(latest.summary.headline)}</b></p>
      ${counts(top.counts)}
      ${findingSections(latest)}
      <h2>All analyses</h2>
      <div class="table-wrap"><table><thead><tr><th>Process</th><th>Run</th><th>By</th><th>Cases</th><th>Automation opportunities</th><th>Bottlenecks</th><th>Duplicated work</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
  });
}

// Criterion 2: no data → say so, and say how data gets here.
export function renderNoData({ user, skipped = 0 }) {
  return page({
    title: 'No data yet', user,
    body: `<h1>Process analysis results</h1>
      ${skippedNote(skipped)}
      <div class="empty"><b>No process analysis data is available yet.</b><br>
      Results appear here once a process analyst or operations manager runs an analysis of a process event log.</div>`,
  });
}

export function renderAnalysis({ user, report }) {
  return page({
    title: report.process, user,
    body: `<p><a href="/">← All analyses</a></p>
      <h1>${esc(report.process)}</h1>
      <p class="lede">Analysis ${esc(report.analysisId)}, run by ${esc(report.requestedBy?.id)} on ${when(report.generatedAt)} ·
        ${esc(report.scope.cases)} cases, ${esc(report.scope.events)} events, ${when(report.scope.period.from)} to ${when(report.scope.period.to)} ·
        median case ${esc(report.scope.medianCaseDuration)}</p>
      <p><b>${esc(report.summary.headline)}</b></p>
      ${counts({ automationCandidates: report.summary.automationCandidates, bottlenecks: report.summary.bottlenecks, duplicates: report.summary.duplicates })}
      ${findingSections(report)}
      <h2>How this was found</h2><ul class="plain">${report.method.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <h2>What this report does not tell you</h2><ul class="plain">${report.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
  });
}

export function renderSignIn({ error, roles = [] } = {}) {
  return page({
    title: 'Sign in', user: null,
    body: `<h1>Sign in</h1>
      <p class="lede">Demo sign-in: enter who you are. Allowed roles: ${roles.map(esc).join(', ')}.</p>
      ${error ? `<div class="notice">${esc(error)}</div>` : ''}
      <form class="signin" method="post" action="/sign-in">
        <label for="userId">User id</label><input id="userId" name="userId" required maxlength="64" autocomplete="off">
        <label for="role">Role</label><input id="role" name="role" required maxlength="64" list="roles" autocomplete="off">
        <datalist id="roles">${roles.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
        <button type="submit">Sign in</button>
      </form>`,
  });
}

export function renderError({ user = null, status, title, message }) {
  const back = status === 401 ? '<p><a href="/sign-in">Sign in</a></p>' : '<p><a href="/">Back to the dashboard</a></p>';
  return page({ title, user, body: `<div class="error"><h1>${esc(title)}</h1><p>${esc(message)}</p>${back}<p class="examples">HTTP ${esc(status)}</p></div>` });
}
