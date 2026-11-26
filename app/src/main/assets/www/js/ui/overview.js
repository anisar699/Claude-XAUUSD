// Overview: nearest multi-timeframe areas around price, trend table, session stats.

import { store } from '../store.js';
import { nearestAreas } from '../core/confluence.js';
import { areaMeter, biasCell, px, roleBadge, signed, structureCell, tagChips } from './format.js';

function areaRow(z, price, role) {
  const dist = role === 'resistance' ? z.lo - price : role === 'support' ? z.hi - price : 0;
  const range = z.hi - z.lo >= 0.05 ? `<span class="lv-range">${px(z.lo)} – ${px(z.hi)}</span>` : '';
  return `<div class="row tap" role="button" tabindex="0" data-plan="${z.price}" data-lo="${z.lo}" data-hi="${z.hi}">
    ${roleBadge(role)}
    <div class="lv-main"><span class="lv-price">${px(z.price)}</span>${range}${tagChips(z.tags)}</div>
    <div class="lv-side"><div class="lv-dist">${role === 'inside' ? 'at price' : signed(dist)}</div>${areaMeter(z)}</div>
  </div>`;
}

export function priceRow(price) {
  return `<div class="row-price">Price <b>${px(price)}</b></div>`;
}

function ladder(a, price) {
  const near = nearestAreas(a.conf, price, 4);
  let html = '';
  if (near.above.length) html += near.above.slice().reverse().map((z) => areaRow(z, price, 'resistance')).join('');
  else html += '<div class="row-none">No resistance above price in the loaded history.</div>';
  html += near.at.map((z) => areaRow(z, price, 'inside')).join('');
  html += priceRow(price);
  if (near.below.length) html += near.below.map((z) => areaRow(z, price, 'support')).join('');
  else html += '<div class="row-none">No support below price in the loaded history.</div>';
  return html;
}

function trendTable(a) {
  const rows = store.settings.tfs
    .map((tf) => {
      const t = a.trend[tf];
      if (!t) return `<tr><td class="k">${tf}</td><td colspan="4">Not enough candles yet</td></tr>`;
      const bias = t.partial ? '<span class="bias neutral">–</span>' : biasCell(t.bias);
      return `<tr><td class="k">${tf}</td><td>${bias}</td><td>${structureCell(a.structure && a.structure[tf])}</td><td>${t.rsi == null ? '–' : t.rsi.toFixed(0)}</td><td>${px(t.atr)}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>TF</th><th>Trend</th><th>Structure</th><th>RSI</th><th>ATR</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function sessionTiles(a, price) {
  const d = a.day || (a.key.D.prev ? { open: a.key.D.prev.o, high: a.key.D.prev.h, low: a.key.D.prev.l } : null);
  if (!d) return '';
  const label = a.day ? 'Day' : 'Last session';
  const range = d.high - d.low;
  const ofAtr = a.atrD1 ? `${Math.round((range / a.atrD1) * 100)}% of daily ATR` : '';
  const tile = (k, v, s) => `<div class="tile"><div class="tile-k">${k}</div><div class="tile-v">${v}</div><div class="tile-s">${s}</div></div>`;
  return `<div class="tiles">
    ${tile(`${label} high`, px(d.high), `${signed(d.high - price)} from price`)}
    ${tile(`${label} low`, px(d.low), `${signed(d.low - price)} from price`)}
    ${tile('Previous close', px(a.prevClose), a.prevClose == null ? '' : `${signed(a.prevClose - price)} from price`)}
    ${tile(`${label} range`, px(range), ofAtr)}
  </div>`;
}

const hm = (t) => {
  const d = new Date(t * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Asia, London and New York: their latest window, high and low, opening range.
function sessionsCard(a) {
  const st = a.sessions;
  if (!st) return '';
  const rows = st.sessions
    .filter((s) => s.window)
    .map((s) => {
      const w = s.window;
      const status = w.active ? '<span class="pill hit">now</span>' : `<span class="pill">next ${hm(s.next ? s.next.start : w.start + 86400)}</span>`;
      const hl = s.high == null ? '–' : `H ${px(s.high)} · L ${px(s.low)}${s.covered ? '' : ' (partial)'}`;
      const or = s.opening ? `<div class="lv-sub">Opening range (first 30 min): ${px(s.opening.low)} – ${px(s.opening.high)}</div>` : '';
      return `<div class="row sess"><div class="lv-main"><span class="lv-price">${s.name}</span> <span class="lv-range">${hm(w.start)}–${hm(w.end)}</span> ${status}
        <div class="lv-sub">${w.active ? 'So far' : 'Last session'}: ${hl}</div>${or}</div></div>`;
    })
    .join('');
  const now = st.active.length ? `${st.active.join(' + ')}${st.overlap ? ' overlap' : ''}` : 'between sessions';
  return `<div class="card">
      <div class="card-h"><h2>Sessions</h2><span>now: ${now}</span></div>
      <div class="rows">${rows}</div>
    </div>`;
}

export function renderOverview(el) {
  const a = store.analysis;
  if (!a) {
    el.innerHTML = `<div class="card"><div class="empty">${store.status.syncing ? 'Loading market data…' : 'No data yet.'}</div></div>`;
    return;
  }
  const price = store.price();
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h2>Nearest levels</h2><span>${store.settings.tfs.join(' · ')}</span></div>
      <div class="rows">${ladder(a, price)}</div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Trend by timeframe</h2><span>price vs EMA 50 / 200</span></div>
      ${trendTable(a)}
    </div>
    <div class="card">
      <div class="card-h"><h2>Day</h2><span>${store.settings.dayBoundary === 'utc' ? 'UTC days' : 'New York close days'}</span></div>
      ${sessionTiles(a, price)}
    </div>
    ${sessionsCard(a)}
    <p class="note">Tap a level to plan a trade from it. Structure: the last swing high (HH higher, LH lower, EH equal) and low (HL higher, LL lower, EL equal) and the latest break of structure (BOS), or a change of character (CHoCH) when it broke the other way. Session times are in your phone's time.</p>
    <p class="note">Tags show where a level comes from: a timeframe's swing zone, a pivot (D/W/M), a previous high or low (PDH, PWL…), or a round number.</p>
    <p class="note">Strength bars rank a level against the others shown now: how many swings and timeframes back it, and how recent they are. They are a ranking, not a probability: in testing on past data they did not tell which levels price would turn at, so treat every level as a place to watch, not a trade signal. A round number on its own is shown as a reference price, without bars.</p>`;
}
