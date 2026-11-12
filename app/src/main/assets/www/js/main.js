// Entry point: header, tab switching, and wiring store events to the screens.

import { store } from './store.js';
import { marketStatus } from './core/time.js';
import { clock, dateTime, duration, esc, px, signed } from './ui/format.js';
import { renderOverview } from './ui/overview.js';
import { initLevels, renderLevels, showLevels } from './ui/levels.js';
import { initChart, onChartQuote, renderChart } from './ui/chart.js';
import { initSettings, renderSettings, renderSettingsStatus } from './ui/settings.js';

const $ = (id) => document.getElementById(id);
const views = {
  overview: $('view-overview'),
  levels: $('view-levels'),
  chart: $('view-chart'),
  settings: $('view-settings'),
};
let active = 'overview';

function renderActive() {
  if (active === 'overview') renderOverview(views.overview);
  else if (active === 'levels') renderLevels(views.levels);
  else if (active === 'chart') renderChart();
  else renderSettings();
}

function show(name) {
  active = name;
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  for (const b of document.querySelectorAll('.nav button')) {
    const on = b.dataset.view === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (name === 'levels') showLevels(views.levels);
  else renderActive();
}

function renderHeader() {
  const now = Math.floor(Date.now() / 1000);
  const a = store.analysis;
  const price = store.price();
  $('price').textContent = price == null ? '–' : px(price);

  const chg = $('chg');
  if (price != null && a && a.prevClose) {
    const d = price - a.prevClose;
    const pct = (d / a.prevClose) * 100;
    chg.className = 'chg ' + (d >= 0 ? 'up' : 'down');
    chg.textContent = `${d >= 0 ? '▲' : '▼'} ${signed(d)} (${signed(pct)}%)`;
    chg.title = 'Change from the previous daily close';
  } else {
    chg.className = 'chg';
    chg.textContent = '';
  }

  const m = marketStatus(now);
  const mkt = $('mkt');
  mkt.className = 'mkt' + (m.open ? ' open' : '');
  mkt.innerHTML = `<i></i>${m.open ? 'Market open' : `Closed · opens in ${duration(m.nextChange - now)}`}`;

  const upd = $('upd');
  if (store.priceIsLive()) upd.textContent = `Live · ${clock(store.quote.at)}`;
  else if (a) upd.textContent = `Last · ${dateTime(a.lastT)}`;
  else upd.textContent = '';
}

function renderBanner() {
  const st = store.status;
  const el = $('banner');
  let html = '';
  if (!store.analysis) {
    if (st.error && !st.syncing) html = `<b>Could not load market data.</b> ${esc(st.error)}. Retrying…`;
    else html = 'Loading market data…';
  } else if (st.error) {
    const since = st.lastData ? clock(st.lastData) : st.cacheSavedAt ? dateTime(st.cacheSavedAt) : 'earlier';
    html = `<b>Update failed.</b> Showing data from ${since}. ${esc(st.error)}`;
  } else if (st.fromCache) {
    html = `Showing saved data from ${dateTime(st.cacheSavedAt)} while the latest loads…`;
  }
  el.hidden = !html;
  el.innerHTML = html;
}

// The list screens are rebuilt on every price update. Doing that while a
// finger is down could swallow the tap, so the rebuild waits for the touch to
// end.
let touching = false;
let renderPending = false;

function refreshLists() {
  if (touching) renderPending = true;
  else renderActive();
}

document.addEventListener('touchstart', () => (touching = true), { passive: true });
for (const ev of ['touchend', 'touchcancel']) {
  document.addEventListener(
    ev,
    (e) => {
      if (e.touches.length) return;
      touching = false;
      if (renderPending) {
        renderPending = false;
        // After the click that follows this touch has been delivered.
        setTimeout(() => {
          if (active === 'overview' || active === 'levels') renderActive();
        }, 0);
      }
    },
    { passive: true },
  );
}

store.on((type) => {
  if (type === 'tick') {
    renderHeader();
    return;
  }
  renderHeader();
  renderBanner();
  if (type === 'quote') {
    if (active === 'overview' || active === 'levels') refreshLists();
    else if (active === 'chart') onChartQuote();
    else renderSettingsStatus();
  } else if (type === 'status') {
    if (active === 'settings') renderSettingsStatus();
    // Before the first data arrives the screens show a loading / failed
    // message, which depends on the sync status.
    else if (!store.analysis) renderActive();
  } else if (type === 'data') {
    if (active === 'settings') renderSettingsStatus();
    else if (active === 'chart') renderActive();
    else refreshLists();
  }
});

document.querySelector('.nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) show(b.dataset.view);
});

// Called by the Android shell on the system back button: returns true when
// the app handled it (went back to Overview), false to let the app close.
window.__onBack = () => {
  if (active !== 'overview') {
    show('overview');
    return true;
  }
  return false;
};

initLevels(views.levels);
initChart(views.chart);
initSettings(views.settings);
show('overview');
renderHeader();
renderBanner();
store.init();
