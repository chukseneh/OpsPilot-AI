// Small rendering helpers. Everything that comes from data goes through esc().

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

export function fmtDay(ymd) {
  if (!ymd) return 'no date set';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function fmtTimestamp(date) {
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// A number the files did not provide is "not reported", never 0.
export const num = (v) => (typeof v === 'number' ? String(v) : 'not reported');

const STATE_LABEL = {
  verified: 'Verified',
  submitted: 'Submitted',
  in_progress: 'In progress',
  not_started: 'Not started',
};

export function stateBadge(state) {
  const label = STATE_LABEL[state];
  return `<span class="badge state-${label ? state : 'unknown'}">${esc(label ?? 'Not checked yet')}</span>`;
}

export const sampleChip = (ctx) => (ctx.sample ? '<span class="chip chip-sample">SAMPLE</span>' : '');

export function card(ctx, { href, label, value, sub = '', more = 'Open' }) {
  return `<a class="card" href="${esc(href)}">
    ${sampleChip(ctx)}
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    <div class="sub">${sub}</div>
    <span class="more">${esc(more)} →</span>
  </a>`;
}

export const back = (href, label) => `<a class="back" href="${esc(href)}">← ${esc(label)}</a>`;

// headers: plain strings; rows: arrays of HTML strings the caller has already escaped.
export function table(headers, rows) {
  return `<div class="table-wrap"><table>
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

export const emptyState = (html) => `<div class="empty">${html}</div>`;

export const notFound = (what, href, label) =>
  `<h1>Not found</h1><p class="lede">${esc(what)}</p>${back(href, label)}`;

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const storyLink = (id) => `<a href="#/project/story/${encodeURIComponent(id)}">${esc(id)}</a>`;
export const reqLink = (id) => `<a href="#/knowledge/requirement/${encodeURIComponent(id)}">${esc(id)}</a>`;

// Live indicator. With no report from a running system the dot is grey —
// never green by default.
const STATUS = {
  connected: ['ok', 'Connected'],
  not_connected: ['bad', 'Not connected'],
  error: ['bad', 'Error'],
};
export function statusDot(report) {
  const [cls, label] = STATUS[report?.status] ?? ['unknown', 'Not checked from here'];
  return `<span class="dot dot-${cls}" aria-hidden="true"></span>${esc(label)}`;
}
export const checkedAt = (report) =>
  (report?.checked_at ? `Last checked ${fmtTimestamp(new Date(report.checked_at))}` : 'Never checked from here');

export function coverageBadge(c) {
  const cls = { gap: 'state-gap', open: 'state-in_progress', verified: 'state-verified' }[c.key];
  return `<span class="badge ${cls}">${esc(c.label)}</span>`;
}
