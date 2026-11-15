// Chart: candles with support / resistance lines for the chosen timeframe.

import { store } from '../store.js';
import { ema } from '../core/indicators.js';
import { roleOf } from '../core/sr.js';
import { nearestAreas } from '../core/confluence.js';
import { bucketEnd, serverOffsetSec } from '../core/time.js';
import { px } from './format.js';

const LC = window.LightweightCharts;

// Mirrors the tokens in app.css (the chart library needs literal colours).
const C = {
  surface: '#131722',
  grid: '#1c2231',
  hair: 'rgba(255,255,255,0.10)',
  ink: '#f0efec',
  ink2: '#c3c2b7',
  muted: '#898781',
  up: '#26a69a',
  down: '#ef5350',
  pivot: '#3987e5',
  accent: '#d9a826',
};

const LAYERS = [
  { id: 'zones', label: 'Zones', swatch: 'two' },
  { id: 'areas', label: 'Multi-TF', swatch: 'two dash' },
  { id: 'pivots', label: 'Daily pivots', swatch: 'pivot' },
  { id: 'ema', label: 'EMA 50 / 200', swatch: 'ema' },
];

let root;
let chart = null;
let candleSeries;
let ema50Series;
let ema200Series;
let lineItems = []; // { opts, line, labeled }
let lineSignature = '';
let scaleHint = null; // nearest drawn level on each side of price
let declutterQueued = false;
let shown = null; // { tf, firstT, lastT, len }
let lastBars = []; // chart-time bars currently loaded
let lastCandle = null; // the newest candle, in feed time
let liveBar = null; // the newest candle as drawn, including live-quote extremes
let hoverText = null;

// Intraday candles are shown in the phone's local time. Daily and weekly
// candles are placed on their broker (server) date so the date label is right
// in every timezone.
function chartTime(tf, t) {
  if (tf === 'D1' || tf === 'W1') return t + serverOffsetSec(t);
  return t - new Date(t * 1000).getTimezoneOffset() * 60;
}

function toBars(tf, candles) {
  const out = [];
  let prev = -Infinity;
  for (const c of candles) {
    const time = chartTime(tf, c.t);
    if (time <= prev) continue; // a local clock change can repeat an hour
    prev = time;
    out.push({ time, open: c.o, high: c.h, low: c.l, close: c.c });
  }
  return out;
}

function ensureChart() {
  if (chart) return;
  chart = LC.createChart(root.querySelector('#chart'), {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: C.surface },
      textColor: C.muted,
      fontSize: 11,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.hair, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderColor: C.hair, timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { priceFormatter: (p) => p.toFixed(2) },
  });
  candleSeries = chart.addSeries(LC.CandlestickSeries, {
    upColor: C.up,
    downColor: C.down,
    wickUpColor: C.up,
    wickDownColor: C.down,
    borderVisible: false,
    priceLineColor: C.accent,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    // Stretch the price scale so the next level on each side of price is on
    // screen, unless that would squash the candles.
    autoscaleInfoProvider: (original) => {
      const res = original();
      if (!res || !res.priceRange || !scaleHint) return res;
      let { minValue, maxValue } = res.priceRange;
      const reach = (maxValue - minValue) * 0.6;
      if (scaleHint.below != null && scaleHint.below < minValue && minValue - scaleHint.below <= reach) minValue = scaleHint.below;
      if (scaleHint.above != null && scaleHint.above > maxValue && scaleHint.above - maxValue <= reach) maxValue = scaleHint.above;
      return { ...res, priceRange: { minValue, maxValue } };
    },
  });
  const lineOpts = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false };
  ema50Series = chart.addSeries(LC.LineSeries, { ...lineOpts, color: C.ink });
  ema200Series = chart.addSeries(LC.LineSeries, { ...lineOpts, color: C.muted, lineStyle: LC.LineStyle.Dashed });
  chart.subscribeCrosshairMove((p) => {
    const bar = p && p.time != null && p.seriesData ? p.seriesData.get(candleSeries) : null;
    hoverText = bar ? ohlcText(bar) : null;
    renderLegend();
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(queueDeclutter);
}

// Lines that sit close together on screen cannot all carry a label. Label the
// most important ones (strong and near price) and leave the rest as bare
// lines; the Levels tab lists every value.
function queueDeclutter() {
  if (declutterQueued) return;
  declutterQueued = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      declutterQueued = false;
      declutter();
    }),
  );
}

const LABEL_GAP_PX = 17;

function declutter() {
  if (!chart || !lineItems.length) return;
  const height = root.querySelector('#chart').clientHeight;
  const taken = [];
  const price = store.price();
  const priceY = price == null ? null : candleSeries.priceToCoordinate(price);
  if (priceY != null) taken.push(priceY);
  const order = lineItems.slice().sort((a, b) => b.opts.priority - a.opts.priority);
  for (const it of order) {
    const y = candleSeries.priceToCoordinate(it.opts.price);
    const show = y != null && y >= 0 && y <= height && taken.every((t) => Math.abs(t - y) >= LABEL_GAP_PX);
    if (show) taken.push(y);
    if (show !== it.labeled) {
      it.labeled = show;
      it.line.applyOptions({ axisLabelVisible: show, title: show ? it.opts.title : '' });
    }
  }
}

function ohlcText(b) {
  return `O <b>${px(b.open)}</b> H <b>${px(b.high)}</b> L <b>${px(b.low)}</b> C <b>${px(b.close)}</b>`;
}

function renderLegend() {
  const el = root.querySelector('#chart-legend');
  const tf = store.settings.chartTf;
  const last = liveBar || lastBars[lastBars.length - 1];
  const ohlc = hoverText || (last ? ohlcText(last) : '');
  let extra = '';
  const t = store.analysis && store.analysis.trend[tf];
  if (store.settings.chartLayers.ema && t) {
    extra = `<br>EMA 50 <b>${px(t.ema50)}</b> (solid) · EMA 200 <b>${px(t.ema200)}</b> (dashed)`;
  }
  el.innerHTML = `<b>${tf}</b> ${ohlc}${extra}`;
}

let chipSignature = '';

function renderChips() {
  const s = store.settings;
  // Rebuild only when something changed, so a refresh never swaps a button
  // out from under a finger.
  const sig = JSON.stringify([s.tfs, s.chartTf, s.chartLayers]);
  if (sig === chipSignature) return;
  chipSignature = sig;
  root.querySelector('#chart-tfs').innerHTML = s.tfs
    .map((tf) => `<button class="chip${tf === s.chartTf ? ' on' : ''}" role="tab" aria-selected="${tf === s.chartTf}" data-tf="${tf}">${tf}</button>`)
    .join('');
  root.querySelector('#chart-layers').innerHTML = LAYERS.map(
    (l) => `<button class="chip${s.chartLayers[l.id] ? ' on' : ''}" aria-pressed="${!!s.chartLayers[l.id]}" data-layer="${l.id}"><span class="swatch ${l.swatch}"></span>${l.label}</button>`,
  ).join('');
}

const sameBar = (a, b) => a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

function setCandles(tf, candles) {
  const bars = toBars(tf, candles);
  const n = bars.length;
  const sameShape =
    shown && shown.tf === tf && n >= shown.len && shown.len > 0 && bars[0].time === shown.firstT && bars[shown.len - 1].time === shown.lastT;
  if (sameShape) {
    // The feed can correct older candles; redraw from the first one that changed.
    let from = shown.len - 1;
    for (let i = 0; i < shown.len - 1; i++) {
      if (!sameBar(bars[i], lastBars[i])) {
        from = i;
        break;
      }
    }
    if (from < shown.len - 1) {
      const range = chart.timeScale().getVisibleLogicalRange();
      candleSeries.setData(bars);
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    } else {
      for (let i = from; i < n; i++) candleSeries.update(bars[i]);
    }
  } else {
    const tfChanged = !shown || shown.tf !== tf;
    candleSeries.setData(bars);
    if (tfChanged && n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 110), to: n + 6 });
  }
  shown = n ? { tf, firstT: bars[0].time, lastT: bars[n - 1].time, len: n } : null;
  lastBars = bars;
  lastCandle = candles.length ? { tf, t: candles[candles.length - 1].t } : null;

  // The candle on screen keeps every high and low seen from live quotes during
  // its period, even when a feed update arrives without them.
  const lastBar = bars[n - 1];
  if (lastBar && liveBar && liveBar.tf === tf && liveBar.time === lastBar.time) {
    liveBar = { ...lastBar, tf, high: Math.max(lastBar.high, liveBar.high), low: Math.min(lastBar.low, liveBar.low) };
    if (liveBar.high !== lastBar.high || liveBar.low !== lastBar.low) candleSeries.update(barOf(liveBar));
  } else {
    liveBar = lastBar ? { ...lastBar, tf } : null;
  }

  const on = !!store.settings.chartLayers.ema;
  ema50Series.applyOptions({ visible: on });
  ema200Series.applyOptions({ visible: on });
  if (on) {
    const closes = bars.map((b) => b.close);
    const line = (arr) => arr.map((v, i) => (v == null ? null : { time: bars[i].time, value: v })).filter(Boolean);
    ema50Series.setData(line(ema(closes, 50)));
    ema200Series.setData(line(ema(closes, 200)));
  }
}

const barOf = (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });

function desiredLines(a, tf, price) {
  const L = store.settings.chartLayers;
  const lines = [];
  const colorOf = (role) => (role === 'resistance' ? C.down : role === 'support' ? C.up : C.accent);
  const unit = a.atrD1 || 50;
  const add = (l, weight) => lines.push({ ...l, priority: weight - (3 * Math.abs(price - l.price)) / unit });
  if (L.zones) {
    for (const z of a.zones[tf] || []) {
      const role = roleOf(z, price);
      add({ price: z.price, color: colorOf(role), lineWidth: z.strength >= 4 ? 2 : 1, lineStyle: LC.LineStyle.Solid, title: role === 'resistance' ? 'R' : role === 'support' ? 'S' : '=' }, z.strength);
    }
  }
  if (L.areas) {
    const near = nearestAreas(a.conf, price, 4);
    const area = (z, role) =>
      add({ price: z.price, color: colorOf(role), lineWidth: z.strength >= 4 ? 2 : 1, lineStyle: LC.LineStyle.Dashed, title: z.tags.slice(0, 3).join(' ') }, z.strength + 0.5);
    near.above.forEach((z) => area(z, 'resistance'));
    near.at.forEach((z) => area(z, 'inside'));
    near.below.forEach((z) => area(z, 'support'));
  }
  if (L.pivots && a.key.D.pivots) {
    const weight = { PP: 3.5, R1: 3, S1: 3, R2: 2, S2: 2, R3: 1.5, S3: 1.5 };
    for (const [name, value] of Object.entries(a.key.D.pivots)) {
      add({ price: value, color: C.pivot, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, title: name }, weight[name]);
    }
    if (a.key.D.prev) {
      add({ price: a.key.D.prev.h, color: C.pivot, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, title: 'PDH' }, 3);
      add({ price: a.key.D.prev.l, color: C.pivot, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, title: 'PDL' }, 3);
    }
  }
  return lines;
}

function syncLines(a, tf, price) {
  const want = desiredLines(a, tf, price);
  let below = null;
  let above = null;
  for (const l of want) {
    if (l.price < price && (below == null || l.price > below)) below = l.price;
    if (l.price > price && (above == null || l.price < above)) above = l.price;
  }
  scaleHint = { below, above };
  const sig = want.map((l) => `${l.price.toFixed(2)}|${l.color}|${l.lineWidth}|${l.lineStyle}|${l.title}`).join(';');
  if (sig !== lineSignature) {
    lineSignature = sig;
    for (const it of lineItems) candleSeries.removePriceLine(it.line);
    lineItems = want.map((opts) => ({
      opts,
      labeled: false,
      line: candleSeries.createPriceLine({ price: opts.price, color: opts.color, lineWidth: opts.lineWidth, lineStyle: opts.lineStyle, axisLabelVisible: false, title: '' }),
    }));
  } else {
    // Same lines; priorities shift a little as price moves.
    want.forEach((opts, i) => (lineItems[i].opts = opts));
  }
  queueDeclutter();
}

export function renderChart() {
  if (!root || root.hidden) return;
  renderChips();
  const a = store.analysis;
  const tf = store.settings.chartTf;
  const candles = a ? a.series[tf] : null;
  const empty = root.querySelector('#chart-empty');
  if (!candles || !candles.length) {
    empty.hidden = false;
    empty.textContent = store.status.syncing ? 'Loading candles…' : 'No candles for this timeframe yet.';
    return;
  }
  empty.hidden = true;
  ensureChart();
  // Lines first: they set the price-scale hint the candles are then fitted to.
  syncLines(a, tf, store.price());
  setCandles(tf, candles);
  nudgeLive();
  renderLegend();
}

// Between candle refreshes, move the last candle's close with the live quote.
function nudgeLive() {
  if (!chart || !liveBar || !lastCandle || !store.priceIsLive()) return;
  if (Date.now() / 1000 >= bucketEnd(lastCandle.tf, lastCandle.t)) return; // a new candle has not arrived yet
  const p = store.price();
  liveBar = { ...liveBar, high: Math.max(liveBar.high, p), low: Math.min(liveBar.low, p), close: p };
  candleSeries.update(barOf(liveBar));
}

export function onChartQuote() {
  if (!root || root.hidden || !chart) return;
  const a = store.analysis;
  if (a) syncLines(a, store.settings.chartTf, store.price());
  nudgeLive();
  renderLegend();
}

export function initChart(el) {
  root = el;
  el.addEventListener('click', (e) => {
    const tfBtn = e.target.closest('[data-tf]');
    const layerBtn = e.target.closest('[data-layer]');
    if (tfBtn) {
      store.setSettings({ chartTf: tfBtn.dataset.tf });
      hoverText = null;
      renderChart();
    } else if (layerBtn) {
      const id = layerBtn.dataset.layer;
      const cur = store.settings.chartLayers;
      store.setSettings({ chartLayers: { ...cur, [id]: !cur[id] } });
      renderChart();
    }
  });
}

// For tests: the candles as the chart library holds them, newest last.
export function __debug() {
  if (!candleSeries) return null;
  const bars = candleSeries.data();
  return { ...bars[bars.length - 1], bars };
}
