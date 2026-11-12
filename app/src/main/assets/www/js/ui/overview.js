// Overview: nearest multi-timeframe areas around price, trend table, session stats.

import { store } from '../store.js';
import { nearestAreas } from '../core/confluence.js';
import { biasCell, meter, px, roleBadge, signed, tagChips } from './format.js';

function areaRow(z, price, role) {
  const dist = role === 'resistance' ? z.lo - price : role === 'support' ? z.hi - price : 0;
  const range = z.hi - z.lo >= 0.05 ? `<span class="lv-range">${px(z.lo)} – ${px(z.hi)}</span>` : '';
  return `<div class="row">
    ${roleBadge(role)}
    <div class="lv-main"><span class="lv-price">${px(z.price)}</span>${range}${tagChips(z.tags)}</div>
    <div class="lv-side"><div class="lv-dist">${role === 'inside' ? 'at price' : signed(dist)}</div>${meter(z.strength)}</div>
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
      if (!t) return `<tr><td class="k">${tf}</td><td colspan="3">Not enough candles yet</td></tr>`;
      const bias = t.partial ? '<span class="bias neutral">–</span>' : biasCell(t.bias);
      return `<tr><td class="k">${tf}</td><td>${bias}</td><td>${t.rsi == null ? '–' : t.rsi.toFixed(0)}</td><td>${px(t.atr)}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>TF</th><th>Trend</th><th>RSI 14</th><th>ATR 14</th></tr></thead><tbody>${rows}</tbody></table>`;
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
      <div class="card-h"><h2>Session</h2><span>New York close days</span></div>
      ${sessionTiles(a, price)}
    </div>
    <p class="note">Tags show where a level comes from: a timeframe's swing zone, a pivot (D/W/M), a previous high or low (PDH, PWL…), or a round number. Levels are calculated from price history and are not trade signals.</p>`;
}
