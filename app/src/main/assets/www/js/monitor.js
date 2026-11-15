// Background monitor. Runs in a WebView owned by the Android foreground
// service (MonitorService.kt), with no screen. It keeps the same data and
// analysis as the app going and turns level alerts into notifications.
//
// The service calls window.__monitorTick() every few seconds; nothing here
// relies on page timers, which a windowless WebView may throttle.

import { store } from './store.js';
import { createAlertState, describeAlert, evaluateAlerts } from './core/alerts.js';
import { nearestAreas } from './core/confluence.js';
import { marketStatus } from './core/time.js';
import { appendAlerts } from './data/alertlog.js';

// Provided by MonitorService: status(text) updates the ongoing notification,
// alert(title, body, key) posts an alert notification.
const bridge = window.AndroidMonitor || null;
const state = createAlertState();
const nowSec = () => Math.floor(Date.now() / 1000);
const px = (v) => v.toFixed(2);

// Newest one-minute candle older than this (seconds) = data not updating.
const STALE_CANDLES_SEC = 420;
let lastStatus = '';

function setStatus(text) {
  if (text === lastStatus) return;
  lastStatus = text;
  if (bridge) bridge.status(text);
}

// Whole dollars, so the ongoing notification does not redraw on every tick.
function summary(a, price) {
  const near = nearestAreas(a.conf, price, 1);
  const whole = (v) => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v));
  const parts = [price.toFixed(0)];
  if (near.above[0]) parts.push(`R ${px(near.above[0].price)} (${whole(near.above[0].lo - price)})`);
  if (near.below[0]) parts.push(`S ${px(near.below[0].price)} (${whole(near.below[0].hi - price)})`);
  return parts.join(' · ');
}

// Tell the service when the market opens and closes, so it can let the phone
// sleep while the market is closed (see MonitorService.marketState).
let reported = '';
function reportMarket(m) {
  const key = `${m.open}:${m.nextChange}`;
  if (key === reported || !bridge || !bridge.marketState) return;
  reported = key;
  bridge.marketState(m.open, m.nextChange * 1000);
}

function evaluate() {
  const t = nowSec();
  const m = marketStatus(t);
  reportMarket(m);
  const a = store.analysis;
  if (!a) return setStatus(store.status.error ? 'Cannot load market data · retrying' : 'Loading market data…');
  // Alerts need a live price and current candles. Without both, say so rather
  // than judge levels against old numbers.
  if (!m.open) return setStatus(`Market closed · last ${px(a.lastPrice)} · alerts paused`);
  if (!store.priceIsLive()) return setStatus('No live price · alerts paused');
  if (t - a.lastT > STALE_CANDLES_SEC) return setStatus('Candles not updating · alerts paused');
  if (a.stale.length) return setStatus(`${a.stale.join(', ')} candles out of date · alerts paused`);
  // A feed that failed leaves its timeframes with old or missing candles.
  if (store.status.errors.length) return setStatus(`Data problem (${store.status.errors[0]}) · alerts paused`);

  const price = store.price();
  const alerts = evaluateAlerts(state, { now: t, price, areas: a.conf, tol: a.tol, atrH1: a.atrH1, prefs: store.settings.alerts });
  setStatus(summary(a, price));
  if (!alerts.length) return;

  const texts = alerts.map(describeAlert);
  appendAlerts(texts.map((x) => ({ t, title: x.title, body: x.body })));
  if (!bridge) return;
  if (texts.length === 1) bridge.alert(texts[0].title, texts[0].body, texts[0].key);
  else {
    const body = texts.slice(0, 4).map((x) => `${x.title} · ${x.body}`).join('\n');
    bridge.alert(`${texts[0].title} + ${texts.length - 1} more`, body, `group:${t}`);
  }
}

window.__monitorTick = () => {
  store.reloadSettings();
  store.tick();
  evaluate();
};

store.on((type) => {
  if (type === 'quote' || type === 'data') evaluate();
});
store.init({ background: true });
setStatus('Loading market data…');
