import { esc, card, back, table, emptyState, notFound, reqLink, plural } from '../ui.js';

const BASE = '#/data-model';

export function renderDataModel(data, sub, ctx) {
  const model = data.dataModel;
  const entities = model?.entities ?? [];
  if (sub[0]) {
    const e = entities.find((x) => x.name === sub[0]);
    return e ? detail(e, entities, data) : notFound(`No table called “${sub[0]}” in the model.`, BASE, 'Data model');
  }

  const head = `<h1>Data model</h1>
    <p class="lede">The tables behind the system, derived from your requirements. Defined in
      <code>knowledge/data-model.json</code>; requirement text is read from the plan.</p>`;
  if (!entities.length) return `${head}${emptyState('No data model has been proposed yet.')}`;

  // Requirements no table claims — computed, so the list stays honest as the plan changes.
  const claimed = new Set(entities.flatMap((e) => e.requirements ?? []));
  const unclaimed = (data.plan.requirements ?? []).filter((r) => !claimed.has(r.id));

  return `${head}
    <div class="banner banner-paused"><strong>Status: ${esc(model.status ?? 'proposed')}.</strong>
      A starting point for review — no table has been created. Change the JSON file, not this page.</div>
    <div class="cards">${entities.map((e) => card(ctx, {
      href: `${BASE}/${encodeURIComponent(e.name)}`, label: 'Table', value: e.name,
      sub: `${esc(e.purpose)}<br>${plural((e.fields ?? []).length, 'field', 'fields')} · ${(e.requirements ?? []).map(esc).join(', ') || 'no requirement'}`,
    })).join('')}</div>
    <h2>Relationships</h2>
    ${table(['From', 'Field', 'To'], entities.flatMap((e) => (e.fields ?? []).filter((f) => f.ref).map((f) => [
      `<a href="${BASE}/${encodeURIComponent(e.name)}">${esc(e.name)}</a>`, esc(f.name), `<a href="${BASE}/${encodeURIComponent(f.ref)}">${esc(f.ref)}</a>`,
    ])))}
    <h2>Requirements no table serves yet</h2>
    ${unclaimed.length ? table(['Requirement', 'Statement'], unclaimed.map((r) => [reqLink(r.id), esc(r.statement)]))
      : '<p class="muted">Every requirement in the plan is served by at least one table.</p>'}`;
}

function detail(e, entities, { plan }) {
  const reqs = new Map((plan.requirements ?? []).map((r) => [r.id, r]));
  const referencedBy = entities.filter((x) => (x.fields ?? []).some((f) => f.ref === e.name));
  return `<h1>${esc(e.name)}</h1>
    <p class="lede">${esc(e.purpose)}</p>
    <h2>Fields</h2>
    ${table(['Field', 'Type', 'Notes'], (e.fields ?? []).map((f) => [
      `<code>${esc(f.name)}</code>`, esc(f.type),
      `${f.ref ? `→ <a href="${BASE}/${encodeURIComponent(f.ref)}">${esc(f.ref)}</a> ` : ''}${esc(f.notes ?? '')}`,
    ]))}
    <h2>Referenced by</h2>
    <p>${referencedBy.map((x) => `<a href="${BASE}/${encodeURIComponent(x.name)}">${esc(x.name)}</a>`).join(', ') || 'No other table.'}</p>
    <h2>Requirements it serves</h2>
    ${(e.requirements ?? []).length ? table(['Requirement', 'Statement'], e.requirements.map((id) => [
      reqLink(id), esc(reqs.get(id)?.statement ?? 'Not in the plan any more — check this table is still needed.'),
    ])) : emptyState('No requirement listed.')}
    ${back(BASE, 'Data model')}`;
}
