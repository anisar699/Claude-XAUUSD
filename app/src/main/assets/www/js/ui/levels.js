// Levels: per-timeframe zones, multi-timeframe areas, and the pivot tables.

import { store } from '../store.js';
import { nearestAreas } from '../core/confluence.js';
import { distanceTo, roleOf } from '../core/sr.js';
import { ago, areaMeter, biasCell, meter, px, roleBadge, signed, tagChips } from './format.js';
import { priceRow } from './overview.js';

// The tab strip is built once and then only updated in place, so a focused
// tab keeps focus (keyboard, TalkBack) while prices refresh the list below.
let stripTfs = '';

function tabList() {
  return [['ALL', 'Multi-TF'], ...store.settings.tfs.map((tf) => [tf, tf]), ['PIV', 'Pivots']];
}

function syncStrip(strip) {
  const cur = currentTab();
  const tfs = store.settings.tfs.join();
  if (tfs !== stripTfs || !strip.children.length) {
    stripTfs = tfs;
    strip.innerHTML = tabList()
      .map(([id, label]) => `<button class="chip" role="tab" data-tab="${id}">${label}</button>`)
      .join('');
  }
  for (const b of strip.children) {
    const on = b.dataset.tab === cur;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
}

function currentTab() {
  const t = store.settings.levelsTab;
  return t === 'ALL' || t === 'PIV' || store.settings.tfs.includes(t) ? t : 'ALL';
}

function zoneRow(z, price, now) {
  const role = roleOf(z, price);
  const d = distanceTo(z, price);
  const range = z.hi - z.lo >= 0.05 ? `<span class="lv-range">${px(z.lo)} – ${px(z.hi)}</span>` : '';
  const touches = `${z.touches} ${z.touches === 1 ? 'touch' : 'touches'}`;
  return `<div class="row">
    ${roleBadge(role)}
    <div class="lv-main"><span class="lv-price">${px(z.price)}</span>${range}
      <div class="lv-sub">${touches} · last ${ago(z.lastT, now)}</div></div>
    <div class="lv-side"><div class="lv-dist">${role === 'inside' ? 'at price' : signed(d)}</div>${meter(z.strength)}</div>
  </div>`;
}

function tfCard(a, tf, price) {
  const zones = a.zones[tf] || [];
  const t = a.trend[tf];
  const sub = t ? `${t.partial ? '' : biasCell(t.bias) + ' · '}RSI ${t.rsi == null ? '–' : t.rsi.toFixed(0)} · ATR ${px(t.atr)}` : '';
  if (!zones.length) {
    return `<div class="card"><div class="card-h"><h2>${tf} zones</h2></div><div class="empty">Not enough candles for this timeframe yet.</div></div>`;
  }
  const above = zones.filter((z) => roleOf(z, price) === 'resistance');
  const inside = zones.filter((z) => roleOf(z, price) === 'inside');
  const below = zones.filter((z) => roleOf(z, price) === 'support');
  const none = (side) => `<div class="row-none">No ${side} in this timeframe's lookback: price is at the edge of its recent range. Check a higher timeframe.</div>`;
  return `<div class="card">
    <div class="card-h"><h2>${tf} zones</h2><span>${sub}</span></div>
    <div class="rows">
      ${above.length ? above.map((z) => zoneRow(z, price, a.now)).join('') : none('resistance above')}
      ${inside.map((z) => zoneRow(z, price, a.now)).join('')}
      ${priceRow(price)}
      ${below.length ? below.map((z) => zoneRow(z, price, a.now)).join('') : none('support below')}
    </div>
  </div>`;
}

function areaRow(z, price, role) {
  const dist = role === 'resistance' ? z.lo - price : role === 'support' ? z.hi - price : 0;
  const range = z.hi - z.lo >= 0.05 ? `<span class="lv-range">${px(z.lo)} – ${px(z.hi)}</span>` : '';
  return `<div class="row">
    ${roleBadge(role)}
    <div class="lv-main"><span class="lv-price">${px(z.price)}</span>${range}${tagChips(z.tags, 8)}</div>
    <div class="lv-side"><div class="lv-dist">${role === 'inside' ? 'at price' : signed(dist)}</div>${areaMeter(z)}</div>
  </div>`;
}

function allCard(a, price) {
  const near = nearestAreas(a.conf, price, 10, 0.1);
  return `<div class="card">
    <div class="card-h"><h2>Multi-timeframe areas</h2><span>${store.settings.tfs.join(' · ')}</span></div>
    <div class="rows">
      ${near.above.slice().reverse().map((z) => areaRow(z, price, 'resistance')).join('') || '<div class="row-none">No resistance above price in the loaded history.</div>'}
      ${near.at.map((z) => areaRow(z, price, 'inside')).join('')}
      ${priceRow(price)}
      ${near.below.map((z) => areaRow(z, price, 'support')).join('') || '<div class="row-none">No support below price in the loaded history.</div>'}
    </div>
  </div>
  <p class="note">An area groups levels from different sources that sit within ${px(a.tol)} of each other, drawn as a narrow band around their centre. More sources and higher timeframes give more bars; bars measure how much history backs a level, not how likely price is to turn there.</p>`;
}

function pivotCard(a, price) {
  const k = a.key;
  const cols = ['D', 'W', 'M'];
  if (!cols.some((c) => k[c].pivots)) return '<div class="card"><div class="empty">Not enough candles yet.</div></div>';
  const cell = (v) => (v == null ? '–' : px(v));
  const rows = ['R3', 'R2', 'R1', 'PP', 'S1', 'S2', 'S3']
    .map((n) => `<tr${n === 'PP' ? ' class="pp"' : ''}><td class="k">${n}</td>${cols.map((c) => `<td>${cell(k[c].pivots && k[c].pivots[n])}</td>`).join('')}</tr>`)
    .join('');
  const prevRows = [['High', 'h'], ['Low', 'l'], ['Close', 'c']]
    .map(([label, f]) => `<tr><td class="k">${label}</td>${cols.map((c) => `<td>${cell(k[c].prev && k[c].prev[f])}</td>`).join('')}</tr>`)
    .join('');
  const head = '<thead><tr><th></th><th>Daily</th><th>Weekly</th><th>Monthly</th></tr></thead>';
  return `<div class="card">
      <div class="card-h"><h2>Pivot points</h2><span>classic · price ${px(price)}</span></div>
      <table>${head}<tbody>${rows}</tbody></table>
    </div>
    <div class="card">
      <div class="card-h"><h2>Previous period</h2><span>day · week · month</span></div>
      <table>${head}<tbody>${prevRows}</tbody></table>
    </div>
    <p class="note">Days roll at 17:00 New York, the convention most MT4/MT5 brokers use, so these should match a broker chart closely.</p>`;
}

export function renderLevels(el) {
  const a = store.analysis;
  if (!a) {
    el.innerHTML = `<div class="card"><div class="empty">${store.status.syncing ? 'Loading market data…' : 'No data yet.'}</div></div>`;
    stripTfs = '';
    return;
  }
  const price = store.price();
  const tab = currentTab();
  const body = tab === 'ALL' ? allCard(a, price) : tab === 'PIV' ? pivotCard(a, price) : tfCard(a, tab, price);
  let strip = el.querySelector(':scope > .chips');
  let list = el.querySelector(':scope > .lv-body');
  if (!strip || !list) {
    el.innerHTML = '<div class="chips" role="tablist" aria-label="Level source"></div><div class="lv-body"></div>';
    strip = el.firstElementChild;
    list = el.lastElementChild;
    stripTfs = '';
  }
  syncStrip(strip);
  list.innerHTML = body;
  if (centerNext) focusPrice(el);
}

// The lists run from the highest level down, so open them at the price row.
let centerNext = true;

function focusPrice(el) {
  const row = el.querySelector('.row-price');
  if (!row) return;
  centerNext = false;
  el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2);
}

export function showLevels(el) {
  centerNext = true;
  renderLevels(el);
}

export function initLevels(el) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    store.setSettings({ levelsTab: b.dataset.tab });
    el.scrollTop = 0;
    showLevels(el);
  });
}
