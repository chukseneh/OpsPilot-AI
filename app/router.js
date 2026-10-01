import { esc } from './ui.js';
import { findTab } from './tabs/index.js';

export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { tabId: parts[0] ?? 'overview', sub: parts.slice(1) };
}

// One route → one view. Used by the page and by the tests, so both see the same thing.
export function renderRoute(data, hash, ctx) {
  const { tabId, sub } = parseRoute(hash);
  const tab = findTab(tabId);
  const html = tab
    ? tab.render(data, sub, ctx)
    : `<h1>Not found</h1><p class="lede">There is no tab called “${esc(tabId)}”.</p>`;
  return { tab, html };
}
