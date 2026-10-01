import { loadData, dataAge, relativeAge, projectName, todayISO } from './data.js';
import { makeSample } from './sample.js';
import { esc, fmtTimestamp } from './ui.js';
import { TABS } from './tabs/index.js';
import { renderRoute } from './router.js';

const MODE_KEY = 'command-center-mode';
const app = document.getElementById('app');

let real = null;
let sampleCache = null;
let mode = readMode();

// Storage can be unavailable (private window, blocked site data). Real is the
// safe default either way, so a failed read or write only loses the preference.
function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'sample' ? 'sample' : 'real';
  } catch (err) {
    console.warn('Could not read the saved mode; defaulting to Real.', err);
    return 'real';
  }
}

function saveMode(value) {
  try {
    localStorage.setItem(MODE_KEY, value);
  } catch (err) {
    console.warn('Could not save the mode; it will reset on reload.', err);
  }
}

// "Data as of" always describes the synced files, in both modes.
function stamp(now) {
  const age = dataAge(real.manifest, now);
  if (age.level === 'unknown') {
    return `<span class="stamp unknown">Data age unknown — manifest.json is missing or has no generated_at. Sync from the portal to refresh.</span>`;
  }
  const text = `Data as of ${fmtTimestamp(age.at)} (${relativeAge(age.ageMs)})`;
  return age.level === 'stale'
    ? `<span class="stamp stale">⚠ ${esc(text)} — over a week old, sync from the portal to refresh</span>`
    : `<span class="stamp">${esc(text)}</span>`;
}

function render() {
  const now = new Date();
  const data = mode === 'sample' ? (sampleCache ??= makeSample(real)) : real;
  const ctx = { sample: data.sample, now, today: todayISO(now) };
  const { tab, html: view } = renderRoute(data, location.hash, ctx);

  const [shortName, ...rest] = projectName(real.plan).split(' — ');
  document.title = `${shortName} — Command Center`;

  app.innerHTML = `
    <header class="topbar">
      <div class="wrap topbar-row">
        <div class="brand">${esc(shortName)} Command Center<small>${esc(rest.join(' — '))}</small></div>
        ${stamp(now)}
        <div class="mode-switch" role="group" aria-label="Data mode">
          <button type="button" data-mode="real" aria-pressed="${mode === 'real'}">Real</button>
          <button type="button" class="sample" data-mode="sample" aria-pressed="${mode === 'sample'}">Sample</button>
        </div>
      </div>
      <nav class="wrap tabs" aria-label="Tabs">
        ${TABS.map((t) => `<a href="#/${t.id}"${t === tab ? ' aria-current="page"' : ''}>${esc(t.title)}</a>`).join('')}
      </nav>
    </header>
    <main class="wrap">
      ${data.sample ? `<div class="banner banner-sample" role="status">SAMPLE DATA — everything on this screen is made up to show the layout. Switch to Real before you demo.</div>` : ''}
      ${view}
    </main>`;

  app.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    saveMode(mode);
    render();
  }));
  tab?.mount?.(app, data, ctx);
}

function renderLoadError(err) {
  const fromDisk = location.protocol === 'file:';
  app.innerHTML = `<div class="load-error">
    <h1>Could not load the project data</h1>
    <p>${esc(err.message)}</p>
    ${fromDisk
      ? `<p>This page was opened straight from disk, and browsers block it from reading the
         <code>.colaberry/</code> files that way. In the repo folder run <code>npx serve</code>
         and open the address it prints.</p>`
      : `<p>The Command Center reads <code>.colaberry/plan.json</code> and
         <code>.colaberry/progress.json</code> from this repo. Check both are committed, then
         sync from the portal and reload.</p>`}
  </div>`;
}

async function boot() {
  try {
    real = await loadData();
  } catch (err) {
    console.error(err);
    renderLoadError(err);
    return;
  }
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  render();
}

boot();
