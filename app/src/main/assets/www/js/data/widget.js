// The home-screen widget: price, change and the nearest areas, handed to the
// Android side (LevelsWidget.kt) by whichever page is running: the app
// screen or the background monitor. At most every 15 s, and only when
// something shown changed (or once a minute, to refresh its time).

import { nearestAreas } from '../core/confluence.js';

let lastKey = '';
let lastAt = 0;
let lastLive = null;

export function widgetData(store) {
  const a = store.analysis;
  const price = store.price();
  if (!a || price == null) return null;
  const near = nearestAreas(a.conf, price, 1);
  const r = near.above[0];
  const s = near.below[0];
  const chg = a.prevClose ? price - a.prevClose : null;
  return {
    price: price.toFixed(2),
    change: chg == null ? '' : `${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(2)} (${chg >= 0 ? '+' : '−'}${Math.abs((chg / a.prevClose) * 100).toFixed(2)}%)`,
    up: chg == null ? null : chg >= 0,
    r: r ? `R ${r.price.toFixed(2)}  (+${(r.lo - price).toFixed(2)})` : 'R –',
    s: s ? `S ${s.price.toFixed(2)}  (−${(price - s.hi).toFixed(2)})` : 'S –',
    live: store.priceIsLive(),
    session: a.sessions && a.sessions.active.length ? a.sessions.active.join(' + ') : '',
  };
}

export function pushWidget(store, bridge = typeof window !== 'undefined' ? window.AndroidApp || window.AndroidMonitor : null) {
  if (!bridge || !bridge.widget) return;
  const now = Date.now();
  const d = widgetData(store);
  if (!d) return;
  // A change between live and not live goes out at once; otherwise at most
  // every 15 s, and only when something shown changed (or once a minute).
  if (now - lastAt < 15000 && d.live === lastLive) return;
  const key = JSON.stringify(d);
  if (key === lastKey && now - lastAt < 60000) return;
  lastLive = d.live;
  lastKey = key;
  lastAt = now;
  bridge.widget(JSON.stringify({ ...d, at: now }));
}
