// Trades: plan a trade from a level, saved plans, the trade journal and its
// statistics. Plans and trades stay on the phone (data/trades.js).

import { store } from '../store.js';
import { latestWindow, SESSIONS } from '../core/sessions.js';
import { journalCsv, journalStats, planFromArea, planNumbers, positionSize, tradeResult } from '../core/planner.js';
import { deletePlan, deleteTrade, newId, readHits, readPlans, readTrades, savePlan, saveTrade } from '../data/trades.js';
import { dateTime, esc, px } from './format.js';

const SETUPS = ['Support bounce', 'Resistance rejection', 'Breakout', 'Break & retest', 'Sweep / stop hunt', 'Trend continuation', 'Other'];
const TFS = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const native = () => window.AndroidApp || null;

let root = null;
let draft = null; // the plan being edited: { id?, dir, entry, sl, tps: [..3], level, note }
let form = null; // the trade being edited in the journal, or null
let message = '';
let jMessage = '';
let go = () => {}; // switches to this tab (set by main.js)

export function setNavigator(fn) {
  go = fn;
}

// Called from the level lists: start a plan from the area at that price.
export function planFromLevel(lo, hi, price) {
  const a = store.analysis;
  const now = store.price();
  if (!a || now == null) return;
  const area = (a.conf || []).find((z) => Math.abs(z.price - price) < 0.005) || { lo, hi, price };
  const p = planFromArea(area, { price: now, areas: a.conf, atr: a.atrH1, spread: store.spread() });
  draft = { ...p, tps: [...p.tps, null, null, null].slice(0, 3), note: '' };
  message = '';
  go();
}

const num = (v) => (v === '' || v == null ? NaN : Number(v));
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '');
const money = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}` : '–');

function sessionAt(t) {
  const names = SESSIONS.filter((s) => {
    const w = latestWindow(s, t);
    return w && t < w.end;
  }).map((s) => s.name);
  return names.length ? names.join(' + ') : 'Off-session';
}

// ---- planner ----------------------------------------------------------------

function draftPlan() {
  return { ...draft, tps: draft.tps.filter(Number.isFinite) };
}

function plannerResults() {
  const acc = store.settings.account;
  const plan = draftPlan();
  const size = positionSize({ balance: acc.balance, riskPct: acc.riskPct, entry: plan.entry, sl: plan.sl, contract: acc.contract });
  const n = planNumbers(plan, { lots: size.lots, contract: acc.contract });
  if (!Number.isFinite(plan.entry) || !Number.isFinite(plan.sl)) return '<p class="note">Enter an entry and a stop loss.</p>';
  if (!n.valid) return `<p class="note warn">The stop must be ${plan.dir === 'long' ? 'below' : 'above'} the entry for a ${plan.dir}.</p>`;
  const rows = n.targets
    .map((x, i) => `<div class="kv"><span>Target ${i + 1} · ${px(x.price)}</span><span><b>${x.rr.toFixed(2)}R</b> · ${money(x.money)}</span></div>`)
    .join('');
  const small = size.tooSmall ? `<p class="note warn">Your risk (${money(size.riskMoney)}) is less than 0.01 lot at this stop (${money(n.risk * acc.contract * 0.01)}). Widen the risk or use a smaller account setting.</p>` : '';
  return `
    <div class="kv"><span>Stop distance</span><span>${px(n.risk)}</span></div>
    <div class="kv"><span>Risk allowed (${acc.riskPct}% of ${money(acc.balance)})</span><span>${money(size.riskMoney)}</span></div>
    <div class="kv"><span>Position size</span><span><b>${size.lots.toFixed(2)} lots</b> · risk ${money(size.actualRisk)}</span></div>
    ${rows || '<div class="kv"><span>Targets</span><span>none set</span></div>'}
    ${small}`;
}

function plannerCard() {
  if (!draft) {
    return `<div class="card">
      <div class="card-h"><h2>Plan a trade</h2><span>from a level</span></div>
      <p class="note">Tap a level on Overview or Levels to plan a trade from it: entry at its edge, stop beyond it, targets at the next levels. Or start from the current price.</p>
      <div class="btns" style="padding-top:8px"><button class="btn" data-act="plan-blank">New plan at current price</button></div>
      <div class="msg" role="status">${esc(message)}</div>
    </div>`;
  }
  const acc = store.settings.account;
  const field = (f, label, v) => `<label class="fld"><span class="lbl">${label}</span><input class="inp" type="number" inputmode="decimal" step="0.01" data-f="${f}" value="${fmt(v)}"></label>`;
  return `<div class="card">
    <div class="card-h"><h2>Plan a trade</h2><span>${draft.level ? `level ${px(draft.level)}` : 'manual'}</span></div>
    <div class="field"><div class="seg">
      <button class="chip${draft.dir === 'long' ? ' on' : ''}" data-dir="long">Buy / long</button>
      <button class="chip${draft.dir === 'short' ? ' on' : ''}" data-dir="short">Sell / short</button>
    </div></div>
    <div class="grid2">
      ${field('entry', 'Entry', draft.entry)}
      ${field('sl', 'Stop loss', draft.sl)}
      ${field('tp0', 'Target 1', draft.tps[0])}
      ${field('tp1', 'Target 2', draft.tps[1])}
      ${field('tp2', 'Target 3', draft.tps[2])}
    </div>
    <div class="grid2">
      <label class="fld"><span class="lbl">Balance ($)</span><input class="inp" type="number" inputmode="decimal" step="1" data-acc="balance" value="${acc.balance}"></label>
      <label class="fld"><span class="lbl">Risk per trade (%)</span><input class="inp" type="number" inputmode="decimal" step="0.1" data-acc="riskPct" value="${acc.riskPct}"></label>
    </div>
    <div id="plan-results">${plannerResults()}</div>
    <div class="btns" style="padding-top:10px">
      <button class="btn" data-act="plan-save">${draft.id ? 'Update plan' : 'Save plan and alert at entry'}</button>
      <button class="btn" data-act="plan-log">Log as trade</button>
      <button class="btn" data-act="plan-clear">Clear</button>
    </div>
    <div class="msg" role="status">${esc(message)}</div>
    <p class="note">Stop = beyond the area by a quarter of the hourly ATR plus the spread. Sizes use ${acc.contract} oz per lot (change in Settings). Check your broker's minimum stop distance and margin before trading.</p>
  </div>`;
}

function plansCard() {
  const plans = readPlans();
  if (!plans.length) return '';
  const hits = readHits();
  const rows = plans
    .map((p) => {
      const n = planNumbers(p);
      const tp = n.targets.length ? ` · TP ${px(n.targets[0].price)} (${n.targets[0].rr.toFixed(1)}R)` : '';
      const status = hits[p.id] ? `<span class="pill hit">Entry reached ${dateTime(hits[p.id])}</span>` : '<span class="pill">Waiting for entry</span>';
      return `<div class="row plan">
        <div class="lv-main"><span class="lv-price">${p.dir === 'long' ? 'BUY' : 'SELL'} ${px(p.entry)}</span>
          <div class="lv-sub">SL ${px(p.sl)}${tp}${p.lots ? ` · ${p.lots} lots` : ''}</div>${status}</div>
        <div class="lv-side btns-col">
          <button class="btn sm" data-act="plan-edit" data-id="${p.id}">Edit</button>
          <button class="btn sm" data-act="plan-trade" data-id="${p.id}">Log trade</button>
          <button class="btn sm" data-act="plan-del" data-id="${p.id}">Delete</button>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="card"><div class="card-h"><h2>Saved plans</h2><span>alert when price reaches the entry</span></div>
    <div class="rows">${rows}</div>
    <p class="note">Entry alerts are sent by background monitoring (Settings › Alerts), while it runs and the price is live.</p></div>`;
}

// ---- journal ------------------------------------------------------------------

function localInput(t) {
  const d = new Date(t * 1000);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

function journalForm() {
  const f = form;
  const field = (k, label, v, step = '0.01') => `<label class="fld"><span class="lbl">${label}</span><input class="inp" type="number" inputmode="decimal" step="${step}" data-j="${k}" value="${fmt(v)}"></label>`;
  const opt = (list, cur) => list.map((x) => `<option${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('');
  return `<div class="jform">
    <label class="fld"><span class="lbl">Opened (your time)</span><input class="inp" type="datetime-local" data-j="time" value="${localInput(f.t)}"></label>
    <div class="field"><div class="seg">
      <button class="chip${f.dir === 'long' ? ' on' : ''}" data-jdir="long">Buy / long</button>
      <button class="chip${f.dir === 'short' ? ' on' : ''}" data-jdir="short">Sell / short</button>
    </div></div>
    <div class="grid2">
      ${field('entry', 'Entry', f.entry)}
      ${field('sl', 'Stop loss', f.sl)}
      ${field('tp', 'Target', f.tp)}
      ${field('exit', 'Exit (empty = still open)', f.exit)}
      <label class="fld"><span class="lbl">Lots</span><input class="inp" type="number" inputmode="decimal" step="0.01" data-j="lots" value="${f.lots ?? ''}"></label>
      <label class="fld"><span class="lbl">Timeframe</span><select class="inp" data-j="tf"><option></option>${opt(TFS, f.tf)}</select></label>
    </div>
    <label class="fld"><span class="lbl">Setup</span><select class="inp" data-j="setup">${opt(SETUPS, f.setup)}</select></label>
    <label class="fld"><span class="lbl">Notes</span><textarea class="inp" rows="2" data-j="notes">${esc(f.notes || '')}</textarea></label>
    <div class="msg" role="status">${esc(jMessage)}</div>
    <div class="btns" style="padding-top:8px">
      <button class="btn" data-act="j-save">Save trade</button>
      <button class="btn" data-act="j-cancel">Cancel</button>
      ${f.saved ? '<button class="btn" data-act="j-del">Delete</button>' : ''}
    </div>
  </div>`;
}

function journalCard() {
  const trades = readTrades();
  const contract = store.settings.account.contract;
  const rows = trades
    .slice(0, 100)
    .map((t) => {
      const open = !Number.isFinite(t.exit);
      const r = open ? null : tradeResult(t, contract);
      const res = open ? '<span class="pill">open</span>' : `<b class="${r.win ? 'up' : 'down'}">${r.r == null ? '' : `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R · `}${money(r.pnl)}</b>`;
      return `<button class="row trade" data-act="j-edit" data-id="${t.id}">
        <div class="lv-main"><span class="lv-price">${t.dir === 'long' ? 'BUY' : 'SELL'} ${px(t.entry)}${open ? '' : ` → ${px(t.exit)}`}</span>
          <div class="lv-sub">${dateTime(t.t)} · ${esc(t.setup || '')}${t.tf ? ` · ${esc(t.tf)}` : ''} · ${esc(t.session || '')}</div></div>
        <div class="lv-side">${res}</div>
      </button>`;
    })
    .join('');
  return `<div class="card">
    <div class="card-h"><h2>Trade journal</h2><span>${trades.length} trade${trades.length === 1 ? '' : 's'}</span></div>
    ${form ? journalForm() : '<div class="btns" style="padding:4px 0 8px"><button class="btn" data-act="j-new">Add trade</button>' + (trades.length ? '<button class="btn" data-act="j-csv">Share as CSV</button>' : '') + '</div>'}
    <div class="rows">${rows || '<div class="row-none">No trades yet. Log the trades you take to see what works for you.</div>'}</div>
  </div>`;
}

function statsCard() {
  const s = journalStats(readTrades(), store.settings.account.contract);
  if (!s.all.n) return '';
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const r2 = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  const pf = (x) => (x == null ? '–' : x === Infinity ? '∞' : x.toFixed(2));
  const table = (title, groups) =>
    `<table><thead><tr><th>${title}</th><th>Trades</th><th>Win</th><th>Avg R</th><th>P/L</th></tr></thead><tbody>${groups
      .map((g) => `<tr><td class="k">${esc(g.key)}</td><td>${g.n}</td><td>${pct(g.winRate)}</td><td>${r2(g.avgR)}</td><td>${money(g.pnl)}</td></tr>`)
      .join('')}</tbody></table>`;
  const a = s.all;
  return `<div class="card">
    <div class="card-h"><h2>Your statistics</h2><span>${a.n} closed${s.open ? ` · ${s.open} open` : ''}</span></div>
    <div class="tiles">
      <div class="tile"><div class="tile-k">Win rate</div><div class="tile-v">${pct(a.winRate)}</div><div class="tile-s">${a.wins} of ${a.n}</div></div>
      <div class="tile"><div class="tile-k">Average</div><div class="tile-v">${r2(a.avgR)}</div><div class="tile-s">per trade (expectancy)</div></div>
      <div class="tile"><div class="tile-k">Profit / loss</div><div class="tile-v">${money(a.pnl)}</div><div class="tile-s">total ${r2(a.totalR)}</div></div>
      <div class="tile"><div class="tile-k">Profit factor</div><div class="tile-v">${pf(a.profitFactor)}</div><div class="tile-s">gains ÷ losses</div></div>
    </div>
    ${table('Setup', s.bySetup)}
    ${table('Session', s.bySession)}
    ${table('Direction', s.byDir.map((g) => ({ ...g, key: g.key === 'long' ? 'Buy' : g.key === 'short' ? 'Sell' : g.key })))}
    <p class="note">A setup needs 20–30 trades before its numbers mean much. Average R above zero is what makes a setup worth keeping.</p>
  </div>`;
}

// ---- render and events ------------------------------------------------------

export function renderTrades() {
  if (!root || root.hidden) return;
  root.innerHTML = plannerCard() + plansCard() + journalCard() + statsCard();
}

// Data or price updates: only the parts that depend on them, so typing in a
// field is never interrupted.
export function refreshTrades() {
  if (!root || root.hidden) return;
  const el = root.querySelector('#plan-results');
  if (el && draft) el.innerHTML = plannerResults();
}

function readForm() {
  const get = (k) => root.querySelector(`[data-j="${k}"]`);
  const t = Date.parse(get('time').value);
  return {
    ...form,
    t: Number.isFinite(t) ? Math.floor(t / 1000) : form.t,
    entry: num(get('entry').value),
    sl: num(get('sl').value),
    tp: num(get('tp').value),
    exit: num(get('exit').value),
    lots: num(get('lots').value),
    tf: get('tf').value,
    setup: get('setup').value,
    notes: get('notes').value.trim().slice(0, 500),
  };
}

function shareCsv() {
  const csv = journalCsv(readTrades(), store.settings.account.contract);
  const n = native();
  if (n && n.shareText) return n.shareText('XAUUSD trade journal', csv);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'xauusd-journal.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function initTrades(el) {
  root = el;
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.f && draft) {
      const v = num(t.value);
      if (t.dataset.f.startsWith('tp')) draft.tps[Number(t.dataset.f.slice(2))] = v;
      else draft[t.dataset.f] = v;
      refreshTrades();
    } else if (t.dataset.acc) {
      const v = num(t.value);
      if (!(v >= 0)) return;
      store.setSettings({ account: { ...store.settings.account, [t.dataset.acc]: v } });
      refreshTrades();
    }
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act],[data-dir],[data-jdir]');
    if (!b) return;
    if (b.dataset.dir && draft) {
      draft.dir = b.dataset.dir;
      return renderTrades();
    }
    if (b.dataset.jdir && form) {
      form = { ...readForm(), dir: b.dataset.jdir };
      return renderTrades();
    }
    const act = b.dataset.act;
    const id = b.dataset.id;
    message = '';
    jMessage = '';
    if (act === 'plan-blank') {
      const p = store.price();
      if (p == null) message = 'No price yet.';
      else {
        const atr = store.analysis ? store.analysis.atrH1 || 5 : 5;
        draft = { dir: 'long', entry: Math.round(p * 100) / 100, sl: Math.round((p - atr) * 100) / 100, tps: [Math.round((p + 2 * atr) * 100) / 100, null, null], level: null, note: '' };
      }
    } else if (act === 'plan-clear') draft = null;
    else if (act === 'plan-save' && draft) {
      const plan = draftPlan();
      const n = planNumbers(plan);
      if (!n.valid) message = 'Check the entry and stop loss first.';
      else {
        const acc = store.settings.account;
        const size = positionSize({ balance: acc.balance, riskPct: acc.riskPct, entry: plan.entry, sl: plan.sl, contract: acc.contract });
        savePlan({ id: draft.id || newId(), created: Math.floor(Date.now() / 1000), dir: plan.dir, entry: plan.entry, sl: plan.sl, tps: plan.tps, lots: size.lots, level: plan.level });
        draft = null;
        message = 'Plan saved. With background monitoring on, you get a notification when price reaches the entry.';
      }
    } else if ((act === 'plan-log' && draft) || act === 'plan-trade') {
      const p = act === 'plan-log' ? draftPlan() : readPlans().find((x) => x.id === id);
      if (p) {
        const acc = store.settings.account;
        const lots = p.lots || positionSize({ balance: acc.balance, riskPct: acc.riskPct, entry: p.entry, sl: p.sl, contract: acc.contract }).lots;
        const t = Math.floor(Date.now() / 1000);
        form = { id: newId(), t, dir: p.dir, entry: p.entry, sl: p.sl, tp: p.tps[0], exit: NaN, lots, setup: p.dir === 'long' ? 'Support bounce' : 'Resistance rejection', tf: 'H1', notes: '' };
      }
    } else if (act === 'plan-edit') {
      const p = readPlans().find((x) => x.id === id);
      if (p) draft = { ...p, tps: [...p.tps, null, null, null].slice(0, 3) };
      el.scrollTop = 0;
    } else if (act === 'plan-del') deletePlan(id);
    else if (act === 'j-new') {
      const p = store.price();
      form = { id: newId(), t: Math.floor(Date.now() / 1000), dir: 'long', entry: p == null ? NaN : Math.round(p * 100) / 100, sl: NaN, tp: NaN, exit: NaN, lots: NaN, setup: SETUPS[0], tf: 'H1', notes: '' };
    } else if (act === 'j-edit') {
      const t = readTrades().find((x) => x.id === id);
      if (t) form = { ...t, saved: true };
    } else if (act === 'j-cancel') form = null;
    else if (act === 'j-del' && form) {
      deleteTrade(form.id);
      form = null;
    } else if (act === 'j-save' && form) {
      const f = readForm();
      if (!Number.isFinite(f.entry)) {
        jMessage = 'Enter at least the entry price.';
        form = f;
      } else {
        const { saved, ...trade } = f;
        saveTrade({ ...trade, session: sessionAt(trade.t) });
        form = null;
      }
    } else if (act === 'j-csv') shareCsv();
    renderTrades();
  });
}
