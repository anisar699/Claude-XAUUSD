// Background monitor. Runs in a WebView owned by the Android foreground
// service (MonitorService.kt), with no screen. It keeps the same data and
// analysis as the app going and turns level alerts into notifications.
//
// The service calls window.__monitorTick() every few seconds; nothing here
// relies on page timers, which a windowless WebView may throttle.

import { store } from './store.js';
import { createAlertState, describeAlert, evaluateAlerts, gateAreas } from './core/alerts.js';
import { FEEDS_OF_TF, nearestAreas } from './core/confluence.js';
import { marketStatus } from './core/time.js';
import { closedOnly } from './core/model.js';
import { entryReached, planNumbers } from './core/planner.js';
import { markHit, readHits, readPlans } from './data/trades.js';
import { pushWidget } from './data/widget.js';
import { appendAlerts } from './data/alertlog.js';

// Provided by MonitorService: status(text) updates the ongoing notification,
// alert(title, body, key) posts an alert notification, heartbeat(state)
// tells the service the page is alive and what it is doing.
const bridge = window.AndroidMonitor || null;
const state = createAlertState();
const nowSec = () => Math.floor(Date.now() / 1000);
const px = (v) => v.toFixed(2);

// The minute candles are the shared input of every timeframe: older than
// this (seconds) while the market is open = data not updating.
const STALE_CANDLES_SEC = 420;
let lastStatus = '';

function setStatus(text) {
  if (text === lastStatus) return;
  lastStatus = text;
  if (bridge) bridge.status(text);
}

// One of: running (checking levels), warmup (history still loading),
// paused (market closed or no usable data), with the reason in the status.
let lastBeat = { kind: '', at: 0 };
function beat(kind) {
  const now = Date.now();
  if (kind === lastBeat.kind && now - lastBeat.at < 10000) return;
  lastBeat = { kind, at: now };
  if (bridge && bridge.heartbeat) bridge.heartbeat(kind);
}

// When the newest minute candle is known to be from (seconds), or null.
function minuteAt(t) {
  const m = store.raw.M1;
  if (!m || !m.length) return null;
  const c = m[m.length - 1];
  return Math.min(t, c.t + 60, c.asOf != null ? c.asOf : Infinity);
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

// Saved trade plans: notify once when live price touches a plan's entry
// (the ask for a buy, the bid for a sell). A plan is armed only while price is
// on its waiting side, so saving a plan at its entry does not fire it. An
// edited plan has a new id, so it starts unarmed and unreached. `notified`
// keeps a hit from repeating even if storing it failed.
const planArmed = new Map();
const notified = new Set();

function checkPlans(t, bid, ask) {
  const hits = readHits();
  const out = [];
  for (const plan of readPlans()) {
    if (hits[plan.id] || notified.has(plan.id)) continue;
    if (!entryReached(plan, bid, ask)) {
      planArmed.set(plan.id, true);
      continue;
    }
    if (!planArmed.get(plan.id)) continue;
    notified.add(plan.id);
    markHit(plan.id, t);
    const n = planNumbers(plan);
    const tp = n.targets.length ? ` · TP ${n.targets[0].price.toFixed(2)} (${n.targets[0].rr.toFixed(1)}R)` : '';
    const long = plan.dir === 'long';
    out.push({
      key: `plan:${plan.id}`,
      title: `Plan entry touched: ${long ? 'BUY' : 'SELL'} ${plan.entry.toFixed(2)}`,
      body: `${long ? `Ask ${ask.toFixed(2)}` : `Bid ${bid.toFixed(2)}`} · SL ${plan.sl.toFixed(2)}${tp}${plan.lots ? ` · ${plan.lots} lots` : ''} · no order was placed`,
    });
  }
  return out;
}

// Closed candles for close-confirmed breaks and sweeps, only when they are
// fit for it: current (the newest is the last full period, or the one
// before), with no missing data, and from feeds that are working. Otherwise
// none, and those two checks simply wait (R16-03).
function eventCandles(a, tf, t, badFeeds) {
  const sec = tf === 'H1' ? 3600 : 900;
  const closed = closedOnly(a.series[tf] || [], tf, t).slice(-4);
  if (!closed.length) return [];
  const last = closed[closed.length - 1];
  if (t - (last.t + sec) > sec + 120) return [];
  if (closed.some((c) => c.gap || c.partial)) return [];
  if ((FEEDS_OF_TF[tf] || []).some((f) => badFeeds.includes(f))) return [];
  return closed;
}

function paused(text, kind = 'paused') {
  beat(kind);
  setStatus(text);
}

function evaluate() {
  const t = nowSec();
  const m = marketStatus(t);
  reportMarket(m);
  pushWidget(store, bridge);
  const a = store.analysis;
  if (!a) return paused(store.status.error ? 'Cannot load market data · retrying' : 'Loading market data…', 'warmup');
  // Alerts need a live price and current minute candles. Without both, say
  // so rather than judge levels against old numbers.
  if (!m.open) return paused(`Market closed · last ${px(a.lastPrice)} · alerts paused`);
  if (!store.priceIsLive()) return paused('No live price · alerts paused');
  // Plan entries need only the live price.
  send(t, checkPlans(t, store.price(), store.price() + store.spread()));
  const m1 = minuteAt(t);
  if (m1 == null || t - m1 > STALE_CANDLES_SEC) return paused('Candles not updating · alerts paused');

  // Each area is judged on its own inputs: a timeframe still loading its
  // history, out of date, or whose feed failed holds back only the areas
  // built from it.
  const enabled = store.settings.tfs;
  const ready = a.ready.filter((tf) => !a.gaps.includes(tf));
  const badFeeds = store.failedFeeds();
  if (!ready.length) {
    return paused(badFeeds.length ? `Data problem (${store.status.errors[0]}) · alerts paused` : 'Loading history · alerts start when it is ready', badFeeds.length ? 'paused' : 'warmup');
  }
  const { allowed } = gateAreas(a.conf, { ready, badFeeds, prefs: store.settings.alerts });

  const price = store.price();
  // Closed candles for close-confirmed breaks and sweeps.
  const ctf = store.settings.alerts.candleTf === 'H1' ? 'H1' : 'M15';
  const candles = eventCandles(a, ctf, t, badFeeds);
  const alerts = evaluateAlerts(state, {
    now: t,
    price,
    areas: allowed,
    tol: a.tol,
    atrH1: a.atrH1,
    prefs: store.settings.alerts,
    candles,
    candleSec: ctf === 'H1' ? 3600 : 900,
  });
  const waiting = enabled.filter((tf) => !ready.includes(tf));
  beat('running');
  setStatus(summary(a, price) + (waiting.length ? ` · ${waiting.join(', ')} not ready` : ''));
  send(t, alerts.map(describeAlert));
}

function send(t, texts) {
  if (!texts.length) return;
  appendAlerts(texts.map((x) => ({ t, title: x.title, body: x.body })));
  if (!bridge) return;
  if (texts.length === 1) bridge.alert(texts[0].title, texts[0].body, texts[0].key);
  else {
    const body = texts.slice(0, 4).map((x) => `${x.title} · ${x.body}`).join('\n');
    bridge.alert(`${texts[0].title} + ${texts.length - 1} more`, body, `group:${t}`);
  }
}

// The service calls this after a wake-up alarm: report the market state again
// even if it has not changed, so the service can let the phone sleep again
// if the market is still closed.
window.__monitorResync = () => {
  reported = '';
};

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
