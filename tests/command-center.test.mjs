// Command Center checks, run with: node --test tests/
// Renders every tab from the real .colaberry files (and the sample twin) and
// follows every internal link, so "every tab reachable, every card drills down"
// and "nothing invented" are tested rather than eyeballed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TABS } from '../app/tabs/index.js';
import { renderRoute } from '../app/router.js';
import { makeSample } from '../app/sample.js';
import { dataAge, loadData } from '../app/data.js';
import { answer } from '../app/ask.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

function realData() {
  return {
    plan: read('.colaberry/plan.json'),
    progress: read('.colaberry/progress.json'),
    manifest: read('.colaberry/manifest.json'),
    knowledge: read('knowledge/notes.json'),
    dataModel: read('knowledge/data-model.json'),
    systemStatus: null,
    agentRuns: null,
    measurements: null,
    sample: false,
  };
}

const ctxFor = (data) => ({ sample: data.sample, now: new Date(), today: '2026-10-01' });
const render = (data, hash) => renderRoute(data, hash, ctxFor(data)).html;
const links = (html) => [...html.matchAll(/href="(#\/[^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));
const isNotFound = (html) => /<h1>Not found<\/h1>/.test(html);

// Breadth-first over every internal link reachable from the nine tabs.
function crawl(data) {
  const seen = new Map();
  const queue = TABS.map((t) => `#/${t.id}`);
  while (queue.length) {
    const hash = queue.shift();
    if (seen.has(hash)) continue;
    const html = render(data, hash);
    seen.set(hash, html);
    for (const l of links(html)) if (!seen.has(l)) queue.push(l);
  }
  return seen;
}

for (const [mode, make] of [['real', realData], ['sample', () => makeSample(realData())]]) {
  test(`${mode}: every tab and every linked page renders, none is "Not found"`, () => {
    const pages = crawl(make());
    assert.ok(pages.size > 60, `expected many pages, crawled ${pages.size}`);
    for (const [hash, html] of pages) {
      assert.ok(!isNotFound(html), `${hash} is a dead link`);
      assert.ok(!/undefined|NaN|\[object Object\]/.test(html), `${hash} leaks undefined/NaN`);
      assert.ok(!/Not built yet/.test(html), `${hash} is still a placeholder`);
    }
  });

  test(`${mode}: every card on every tab links one level down`, () => {
    const data = make();
    for (const t of TABS) {
      const html = render(data, `#/${t.id}`);
      // Project's drill-down items are its Gantt rows; everywhere else they are cards.
      const cards = [...html.matchAll(/<a class="(?:card|gantt-row)" href="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(cards.length > 0, `${t.id} has no cards`);
      for (const href of cards) {
        assert.ok(href.startsWith(`#/${t.id}/`), `${t.id} card ${href} is not one level down`);
        assert.ok(!isNotFound(render(data, href)), `${href} does not resolve`);
      }
    }
  });
}

test('sample: every card on every tab carries the SAMPLE label', () => {
  const data = makeSample(realData());
  for (const t of TABS) {
    const html = render(data, `#/${t.id}`);
    const cards = (html.match(/<a class="card"/g) ?? []).length;
    const chips = (html.match(/chip-sample/g) ?? []).length;
    assert.equal(chips, cards, `${t.id}: ${cards} cards but ${chips} SAMPLE labels`);
  }
});

test('real: no card carries a SAMPLE label', () => {
  const data = realData();
  for (const t of TABS) assert.ok(!/chip-sample/.test(render(data, `#/${t.id}`)), t.id);
});

test('deleting a story from the plan removes it from every tab', () => {
  const data = realData();
  const gone = 'STORY-011';
  data.plan.stories = data.plan.stories.filter((s) => s.id !== gone);
  for (const r of data.plan.releases) r.story_ids = r.story_ids.filter((id) => id !== gone);
  for (const r of data.plan.requirements) r.fulfilled_by = r.fulfilled_by.filter((id) => id !== gone);
  // progress.json still lists it (platform-owned); only the pages that list
  // progress.json itself may mention it: criteria, points, and "What is live"
  // (verified stories, which STORY-011 is once the platform has verified it).
  const progressListings = new Set(['#/overview/criteria', '#/overview/points', '#/overview/live']);
  for (const [hash, html] of crawl(data)) {
    if (progressListings.has(hash)) continue;
    assert.ok(!html.includes(gone), `${hash} still shows ${gone}`);
  }
});

test('real: systems are grey and "not checked from here", never green', () => {
  const html = render(realData(), '#/systems');
  const systems = realData().plan.derived.systems;
  assert.equal((html.match(/dot-unknown/g) ?? []).length, systems.length);
  assert.ok(!/dot-ok|Connected</.test(html));
});

test('real: agents show "No runs recorded", never a success rate', () => {
  const html = render(realData(), '#/agents');
  assert.ok(html.includes('No runs recorded'));
  assert.ok(!/succeeded|success rate|0%/.test(html));
  assert.ok(html.includes('No skills registered yet'));
});

test('real: outcomes shows an empty state instead of invented numbers', () => {
  const html = render(realData(), '#/outcomes');
  assert.ok(html.includes('no measures yet'));
});

test('a story with no verification block reads "Not checked yet", not 0', () => {
  const data = realData();
  data.progress.stories.find((s) => s.id === 'STORY-002').verification = null;
  const html = render(data, '#/project/story/STORY-002');
  assert.ok(html.includes('Not checked yet'));
  assert.ok(html.includes('not checked yet'));
});

test('data age: fresh, stale after a week, unknown without a manifest', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(dataAge({ generated_at: '2026-10-09T12:00:00Z' }, now).level, 'ok');
  assert.equal(dataAge({ generated_at: '2026-10-01T00:00:00Z' }, now).level, 'stale');
  assert.equal(dataAge(null, now).level, 'unknown');
  assert.equal(dataAge({ generated_at: 'not a date' }, now).level, 'unknown');
});

test('loadData fails loudly when a required file is missing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (path) => ({ ok: false, status: 404, json: async () => ({}), path });
  try {
    await assert.rejects(loadData(), /plan\.json returned HTTP 404/);
  } finally {
    globalThis.fetch = original;
  }
});

test('ask: answers from the data and cites the tab; refuses what it cannot answer', () => {
  const data = realData();
  const req = answer('What is REQ-008?', data);
  assert.match(req.text, /log all actions/);
  assert.equal(req.source, 'Knowledge base');
  const gaps = answer('Which requirements have gaps?', data);
  assert.match(gaps.text, /REQ-002/);
  const nope = answer('What is the weather in Paris?', data);
  assert.equal(nope.source, null);
  assert.match(nope.text, /can’t answer/);
});
