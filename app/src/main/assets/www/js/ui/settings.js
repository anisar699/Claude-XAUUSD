// Settings: timeframes, refresh rate, data source, data status.

import { store } from '../store.js';
import { ANALYSIS_TFS } from '../core/time.js';
import { PROVIDERS } from '../data/providers.js';
import { alertDistances } from '../core/alerts.js';
import { clearAlerts, readAlerts } from '../data/alertlog.js';
import { clearLevelRecord, levelRecProblem, levelReport, readLevelState } from '../data/levelrec.js';
import { clock, dateTime, esc, px } from './format.js';

const TF_HINT = {
  M5: 'Scalping; about two days of history',
  M15: 'About five days of history',
  M30: 'About ten days of history',
  H1: 'About four weeks of history',
  H4: 'About three months of history',
  D1: 'About fourteen months of history',
  W1: 'About three years of history',
};
const QUOTE_CHOICES = [2, 5, 10, 30];

// Provided by the Android shell (MainActivity). Missing in a desktop browser.
const native = () => window.AndroidApp || null;
const STRENGTH_CHOICES = [2, 3, 4, 5];
const DISTANCE_CHOICES = ['auto', 1, 2, 3, 5];

let root;
let message = '';
let lastAlertState = '';
let lastAlertRecent = '';
let pendingSource = null; // Twelve Data picked but no key saved yet

// Monitoring state and its controls. Rebuilt only when something changed, so
// a refresh never swaps a button out from under a finger.
function alertStateBlock() {
  const n = native();
  if (!n) return '<p class="note">Background alerts work in the Android app. This is the browser preview.</p>';
  const on = n.monitoring();
  const allowed = n.notificationsAllowed();
  const unrestricted = n.batteryUnrestricted();
  let html = `<div class="kv"><span>Background monitoring</span><span>${esc(monitorText(n, on))}</span></div>`;
  const channel = n.alertChannelEnabled ? n.alertChannelEnabled() : true;
  if (on && !allowed) {
    html += '<p class="note" style="padding-top:10px">Notifications are switched off for this app, so alerts cannot be shown.</p>';
  } else if (!channel) {
    html += '<p class="note" style="padding-top:10px">The "Level alerts" notification category is switched off, so alerts will not be shown. Monitoring itself still runs.</p>';
  }
  html += '<div class="btns" style="padding-top:12px">';
  html += on
    ? '<button class="btn" data-act="mon-stop">Stop monitoring</button>'
    : '<button class="btn" data-act="mon-start">Start background monitoring</button>';
  if (!allowed) html += '<button class="btn" data-act="mon-notif">Notification settings</button>';
  else if (!channel) html += '<button class="btn" data-act="mon-channel">Level alerts settings</button>';
  if (!unrestricted) html += '<button class="btn" data-act="mon-battery">Battery settings</button>';
  html += '</div>';
  if (!unrestricted) {
    html += '<p class="note">Android may pause the app when the phone sits idle. For dependable alerts, set battery use for this app to Unrestricted.</p>';
  }
  return html;
}

// What the service reports from the monitor page's heartbeats, so "On"
// means the checks are really running.
const MONITOR_STATES = {
  starting: 'On · starting',
  running: 'On · checking levels',
  warmup: 'On · loading history, alerts start when ready',
  paused: 'On · alerts paused',
  restarting: 'On · restarting the monitor',
};

function monitorText(n, on) {
  const raw = n.monitorState ? String(n.monitorState()) : '';
  const [state, ...rest] = raw.split('|');
  const line = rest.join('|');
  if (!on) return state === 'failed' ? 'Off · it stopped responding; start it again' : 'Off';
  const base = MONITOR_STATES[state] || 'On';
  // The paused status line already says why and that alerts are paused.
  return state === 'paused' && line ? `On · ${line}` : base;
}

function alertRecentBlock() {
  const list = readAlerts().slice(0, 8);
  if (!list.length) return '<div class="kv"><span>Recent alerts</span><span>none yet</span></div>';
  return (
    list.map((a) => `<div class="kv"><span>${dateTime(a.t)}</span><span><b>${esc(a.title)}</b><br>${esc(a.body || '')}</span></div>`).join('') +
    '<div class="btns" style="padding-top:12px"><button class="btn" data-act="alerts-clear">Clear list</button></div>'
  );
}

function alertsCard() {
  const p = store.settings.alerts;
  const a = store.analysis;
  const auto = alertDistances({ distance: 'auto' }, a ? a.atrH1 : 0).near;
  const chip = (attr, value, label, on) => `<button class="chip${on ? ' on' : ''}" aria-pressed="${on}" ${attr}="${value}">${label}</button>`;
  lastAlertState = alertStateBlock();
  lastAlertRecent = alertRecentBlock();
  return `
    <div class="card">
      <div class="card-h"><h2>Alerts</h2><span>multi-timeframe areas</span></div>
      <div id="al-state">${lastAlertState}</div>
      <label class="opt"><input type="checkbox" data-alert="approach"${p.approach ? ' checked' : ''}>
        <span><span class="opt-t">Near a level</span><div class="opt-d">Price comes within the distance below of an area, after being away from it.</div></span></label>
      <label class="opt"><input type="checkbox" data-alert="breaks"${p.breaks ? ' checked' : ''}>
        <span><span class="opt-t">Through a level</span><div class="opt-d">Price moves clean through an area to the other side.</div></span></label>
      <div class="field" style="padding-top:8px">
        <label class="lbl">A break counts when</label>
        <div class="seg">${chip('data-breakon', 'live', 'Live price is through', p.breakOn !== 'close')}${chip('data-breakon', 'close', 'A candle closes beyond', p.breakOn === 'close')}</div>
      </div>
      <label class="opt"><input type="checkbox" data-alert="retests"${p.retests ? ' checked' : ''}>
        <span><span class="opt-t">Break and retest</span><div class="opt-d">Price comes back to an area it broke in the last 48 hours, from the new side: broken resistance tested as support, or the other way round.</div></span></label>
      <label class="opt"><input type="checkbox" data-alert="sweeps"${p.sweeps ? ' checked' : ''}>
        <span><span class="opt-t">Liquidity sweep</span><div class="opt-d">A candle wicks beyond an area and closes back on the side it came from: a possible stop hunt.</div></span></label>
      <div class="field" style="padding-top:8px">
        <label class="lbl">Candles for close-confirmed breaks and sweeps</label>
        <div class="seg">${chip('data-candletf', 'M15', '15 minutes', p.candleTf !== 'H1')}${chip('data-candletf', 'H1', '1 hour', p.candleTf === 'H1')}</div>
      </div>
      <label class="opt"><input type="checkbox" data-alert="roundOnly"${p.roundOnly ? ' checked' : ''}>
        <span><span class="opt-t">Round numbers on their own</span><div class="opt-d">Also alert on areas made only of a round number ($50 / $100 steps) with no swing zone or pivot there.</div></span></label>
      <div class="field" style="padding-top:10px">
        <label class="lbl">Minimum rank (bars: how much history backs the level, compared with the other levels now)</label>
        <div class="seg">${STRENGTH_CHOICES.map((n) => chip('data-strength', n, `${n}+`, p.minStrength === n)).join('')}</div>
      </div>
      <div class="field">
        <label class="lbl">Distance for "near"</label>
        <div class="seg">${DISTANCE_CHOICES.map((d) => chip('data-distance', d, d === 'auto' ? `Auto ($${auto.toFixed(1)})` : `$${d}`, p.distance === d)).join('')}</div>
      </div>
      <div id="al-recent">${lastAlertRecent}</div>
      <p class="note" style="padding-top:10px">Tested on two years of hourly and ten months of 15-minute gold data, sweeps and retests at these areas led to a move in the expected direction about as often as the same events at random levels. They tell you what price is doing at a level; they are not a signal on their own.</p>
      <p class="note">All alerts pause while the market is closed, the price is not live or the minute candles stop updating. A level also waits while a timeframe it comes from is still loading its history, is out of date, or its feed has a problem; levels from other timeframes keep working. Monitoring shows a permanent notification and keeps the phone awake only while the market is open. It does not restart by itself after the phone reboots or the app is updated.</p>
    </div>`;
}

function statusBlock() {
  const st = store.status;
  const raw = store.raw;
  const used = new Set(store.feeds());
  const feedLine = (k, label) => {
    const s = raw[k];
    const what = s.length ? `${s.length} candles · to ${dateTime(s[s.length - 1].t)}` : 'none';
    return `<div class="kv"><span>${label}</span><span>${used.has(k) ? what : 'not used (timeframe off)'}</span></div>`;
  };
  const q = store.quote;
  const a = store.analysis;
  const wait = store.cooldownLeft();
  const notReady = a ? store.settings.tfs.filter((tf) => !a.ready.includes(tf) && !a.stale.includes(tf)) : [];
  const skew = store.clockOffset;
  return `
    <div class="kv"><span>Candle source</span><span>${esc(store.provider().name)}${st.syncing ? ' · updating…' : ''}</span></div>
    <div class="kv"><span>Candles updated</span><span>${st.lastData ? clock(st.lastData) : st.fromCache ? `saved copy from ${dateTime(st.cacheSavedAt)}` : 'not yet'}</span></div>
    <div class="kv"><span>Live price (Swissquote)</span><span>${q ? `${px(q.bid)} / ${px(q.ask)} · ${clock(q.at)}` : st.quoteError ? esc(st.quoteError) : 'not yet'}</span></div>
    ${feedLine('M1', '1 minute')}
    ${feedLine('M5', '5 minute')}
    ${feedLine('M15', '15 minute')}
    ${feedLine('M30', '30 minute')}
    ${feedLine('H1', '1 hour (builds H4 and D1)')}
    ${feedLine('D1U', 'Daily (builds W1)')}
    ${(st.errors || []).map((e) => `<div class="kv"><span>Problem</span><span>${esc(e)}</span></div>`).join('')}
    ${wait ? `<div class="kv"><span>Rate limit</span><span>${esc(store.provider().name)} asked to wait · next request in ${wait} s</span></div>` : ''}
    ${a && a.stale.length ? `<div class="kv"><span>Out of date</span><span>${esc(a.stale.join(', '))}</span></div>` : ''}
    ${notReady.length ? `<div class="kv"><span>Still loading history</span><span>${esc(notReady.join(', '))}</span></div>` : ''}
    ${a && a.gaps.length ? `<div class="kv"><span>Missing candles</span><span>${esc(a.gaps.join(', '))} (recent data has a hole)</span></div>` : ''}
    ${skew != null && Math.abs(skew) >= 30 ? `<div class="kv"><span>Phone clock</span><span>${Math.round(skew)} s off the price server; times use the server's clock</span></div>` : ''}
    ${st.quoteError && q ? `<div class="kv"><span>Live price error</span><span>${esc(st.quoteError)}</span></div>` : ''}`;
}

// The broker's prices: an offset to the feed's, and when the day starts.
function brokerCard() {
  const s = store.settings;
  const off = s.brokerOffset;
  const live = store.priceIsLive();
  const feed = live ? store.quote.bid : null;
  return `<div class="card">
    <div class="card-h"><h2>Your broker</h2><span>match your MT4 / MT5 chart</span></div>
    <div class="kv"><span>Price offset</span><span><b>${off >= 0 ? '+' : '−'}${Math.abs(off).toFixed(2)}</b> added to every price</span></div>
    <div class="grid2" style="padding-top:8px">
      <label class="fld"><span class="lbl">Your broker's bid right now</span><input id="br-bid" class="inp" type="number" inputmode="decimal" step="0.01" placeholder="${feed == null ? 'needs a live price' : px(feed + off)}"></label>
      <label class="fld"><span class="lbl">Or set the offset ($)</span><input id="br-off" class="inp" type="number" inputmode="decimal" step="0.01" value="${off}"></label>
    </div>
    <div class="btns"><button class="btn" data-act="br-cal"${live ? '' : ' disabled'}>Match my broker</button><button class="btn" data-act="br-set">Use this offset</button></div>
    <div class="field" style="padding-top:10px">
      <label class="lbl">Your broker's day (and H4, week, month) starts at</label>
      <div class="seg">
        <button class="chip${s.dayBoundary !== 'utc' ? ' on' : ''}" data-day="ny">17:00 New York (GMT+2/+3 servers)</button>
        <button class="chip${s.dayBoundary === 'utc' ? ' on' : ''}" data-day="utc">00:00 UTC (GMT+0 servers)</button>
      </div>
    </div>
    <div class="field">
      <label class="lbl" for="acc-contract">Ounces per lot (trade planner)</label>
      <input id="acc-contract" class="inp" type="number" inputmode="decimal" step="1" value="${s.account.contract}">
    </div>
    <div class="msg" id="br-msg" role="status">${esc(brokerMsg)}</div>
    <p class="note">Feeds and brokers quote gold a little differently. Type the bid your broker shows right now and tap "Match my broker": levels, candles, the chart and alerts then read in your broker's prices. Most brokers' servers run on GMT+2/+3, so their day starts at 17:00 New York. Brokers on GMT+0 (for example Exness) start it at 00:00 UTC. XAUUSD is usually 100 oz per lot; check your broker's contract size.</p>
  </div>`;
}

let brokerMsg = '';

// ---- level record -------------------------------------------------------------

let lrMsg = '';
let lrClearArmed = 0; // "Start over" needs a second tap within 5 s
let lastLevelRec = '';

function levelRecBlock() {
  const rec = readLevelState();
  if (!rec) return '<div class="kv"><span>Level record</span><span>starts when market data has loaded</span></div>';
  const c = rec.count || {};
  const gaps = rec.gaps || [];
  const hours = Math.round(gaps.reduce((a, g) => a + (g[1] - g[0]) / 3600, 0));
  let html = `<div class="kv"><span>Recording since</span><span>${dateTime(rec.since)}</span></div>`;
  html += `<div class="kv"><span>Recorded up to</span><span>${dateTime(rec.at)}</span></div>`;
  html += `<div class="kv"><span>Levels recorded</span><span>${c.levels || 0} (${rec.open.filter((l) => l.kind === 'real').length} followed now)</span></div>`;
  html += `<div class="kv"><span>Tests · breaks</span><span>${c.tests || 0} · ${c.breaks || 0}</span></div>`;
  if (gaps.length) html += `<div class="kv"><span>Not recorded</span><span>${gaps.length} stretch${gaps.length > 1 ? 'es' : ''}, ${hours} h in all</span></div>`;
  const problem = levelRecProblem();
  if (problem) html += `<p class="note warn" style="padding-top:8px">${esc(problem)}</p>`;
  return html;
}

function levelRecCard() {
  lastLevelRec = levelRecBlock();
  const armed = Date.now() < lrClearArmed;
  return `<div class="card">
    <div class="card-h"><h2>Level record</h2><span>how price reacted at each level</span></div>
    <div id="lr-state">${lastLevelRec}</div>
    <div class="btns" style="padding-top:12px">
      <button class="btn" data-act="lr-csv">Download report (CSV)</button>
      <button class="btn" data-act="lr-clear">${armed ? 'Tap again to delete the record' : 'Start over'}</button>
    </div>
    <div class="msg" id="lr-msg" role="status">${esc(lrMsg)}</div>
    <p class="note">Every level the app shows is recorded with what price did there: tested, held, broke, swept, retested. It works from closed 15-minute candles, so it carries on while the app is closed: when the app or background monitoring runs again, it fills in up to 7 days. The report is two files: a summary by timeframe, source, strength, side, session and test number, and every event, one row each.</p>
    <p class="note">Each level is compared with two random levels at the same distance from price, scored by the same rules. A kind of level is useful only where it holds more often than its random levels by more than the margin in the summary. On 200 days of past data the app's levels held about as often as the random ones (30% of tests each).</p>
  </div>`;
}

function exportLevelReport() {
  const r = levelReport();
  if (!r.rows) {
    lrMsg = 'Nothing recorded yet: the first rows come when price reaches a level.';
    return renderSettings();
  }
  const n = native();
  if (n && n.shareLevelReport) {
    if (!n.shareLevelReport(r.summary, r.header)) {
      lrMsg = 'Could not prepare the report files.';
      return renderSettings();
    }
  } else {
    for (const [name, text] of [['xauusd-level-summary.csv', r.summary], ['xauusd-level-events.csv', r.events]]) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  }
  lrMsg = `Report made from ${r.rows} rows.`;
  renderSettings();
}

export function renderSettings() {
  if (!root || root.hidden) return;
  const s = store.settings;
  const source = pendingSource || s.source;
  const keyValue = root.querySelector('#td-key') ? root.querySelector('#td-key').value : s.twelveKey;

  root.innerHTML = `
    ${alertsCard()}
    ${brokerCard()}
    ${levelRecCard()}
    <div class="card">
      <div class="card-h"><h2>Timeframes</h2><span>zones, trend, multi-TF areas</span></div>
      ${ANALYSIS_TFS.map(
        (tf) => `<label class="opt"><input type="checkbox" data-tf="${tf}"${s.tfs.includes(tf) ? ' checked' : ''}>
          <span><span class="opt-t">${tf}</span><div class="opt-d">${TF_HINT[tf]}</div></span></label>`,
      ).join('')}
    </div>

    <div class="card">
      <div class="card-h"><h2>Live price refresh</h2><span>while the market is open</span></div>
      <div class="field"><div class="seg">
        ${QUOTE_CHOICES.map((n) => `<button class="chip${s.quoteSec === n ? ' on' : ''}" aria-pressed="${s.quoteSec === n}" data-quote="${n}">${n}s</button>`).join('')}
      </div></div>
    </div>

    <div class="card">
      <div class="card-h"><h2>Candle data source</h2></div>
      <label class="opt"><input type="radio" name="src" value="dukascopy"${source === 'dukascopy' ? ' checked' : ''}>
        <span><span class="opt-t">Dukascopy</span><div class="opt-d">Spot XAU/USD, no key needed. Unofficial feed: it can change or stop without notice.</div></span></label>
      <label class="opt"><input type="radio" name="src" value="twelvedata"${source === 'twelvedata' ? ' checked' : ''}>
        <span><span class="opt-t">Twelve Data</span><div class="opt-d">Backup. Needs your own free API key from twelvedata.com. Updates every 4 minutes to stay inside the free plan.</div></span></label>
      <div class="field" id="td-box"${source === 'twelvedata' ? '' : ' hidden'} style="padding-top:10px">
        <label class="lbl" for="td-key">Twelve Data API key (stored only on this phone)</label>
        <input id="td-key" class="inp" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your key">
      </div>
      <div class="btns">
        <button class="btn" data-act="save-key"${source === 'twelvedata' ? '' : ' hidden'}>Save key and use</button>
        <button class="btn" data-act="test">Test connection</button>
      </div>
      <div class="msg" id="src-msg" role="status">${esc(message)}</div>
    </div>

    <div class="card">
      <div class="card-h"><h2>Data status</h2></div>
      <div id="st-status">${statusBlock()}</div>
      <div class="btns" style="padding-top:12px">
        <button class="btn" data-act="refresh">Refresh now</button>
        <button class="btn" data-act="clear">Clear saved data</button>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h2>About</h2><span>version 1.7.0</span></div>
      <p class="note">This app calculates support and resistance from price history. It does not give buy or sell signals and is not financial advice. Prices come from third-party feeds and can differ from your broker by a small amount.</p>
      <p class="note">Candles: Dukascopy (personal use) or Twelve Data. Live price: Swissquote public quotes. Charts: TradingView Lightweight Charts™ (Apache 2.0).</p>
    </div>`;

  // Set through the DOM property so the key is never parsed as markup.
  root.querySelector('#td-key').value = keyValue;
}

export function renderSettingsStatus() {
  if (!root || root.hidden) return;
  const el = root.querySelector('#st-status');
  if (el) el.innerHTML = statusBlock();
  const state = alertStateBlock();
  const stateEl = root.querySelector('#al-state');
  if (stateEl && state !== lastAlertState) {
    lastAlertState = state;
    stateEl.innerHTML = state;
  }
  const lr = levelRecBlock();
  const lrEl = root.querySelector('#lr-state');
  if (lrEl && lr !== lastLevelRec) {
    lastLevelRec = lr;
    lrEl.innerHTML = lr;
  }
  const recent = alertRecentBlock();
  const recentEl = root.querySelector('#al-recent');
  if (recentEl && recent !== lastAlertRecent) {
    lastAlertRecent = recent;
    recentEl.innerHTML = recent;
  }
}

function setMessage(text) {
  message = text;
  const el = root.querySelector('#src-msg');
  if (el) el.textContent = text;
}

async function runTest() {
  const source = pendingSource || store.settings.source;
  const key = root.querySelector('#td-key').value.trim();
  if (source === 'twelvedata' && !key) return setMessage('Enter your Twelve Data API key first.');
  setMessage(`Testing ${PROVIDERS[source].name}…`);
  try {
    const c = await store.testSource(source, key);
    setMessage(`${PROVIDERS[source].name} works. Latest 1-minute candle: ${dateTime(c.t)}, close ${px(c.c)}.`);
  } catch (e) {
    setMessage(`${PROVIDERS[source].name} failed: ${e.message || e}${e.body ? ` — ${e.body}` : ''}`);
  }
}

function setAlertPrefs(patch) {
  store.setSettings({ alerts: { ...store.settings.alerts, ...patch } });
  renderSettings();
}

export function initSettings(el) {
  root = el;
  // The Android shell calls this after a permission answer or a service
  // start / stop, so the controls show the new state straight away.
  window.__onNativeState = () => renderSettings();

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[data-alert]')) {
      setAlertPrefs({ [t.dataset.alert]: t.checked });
    } else if (t.id === 'acc-contract') {
      const v = Number(t.value);
      if (v > 0) store.setSettings({ account: { ...store.settings.account, contract: v } });
    } else if (t.matches('input[data-tf]')) {
      const set = new Set(store.settings.tfs);
      if (t.checked) set.add(t.dataset.tf);
      else set.delete(t.dataset.tf);
      const tfs = ANALYSIS_TFS.filter((tf) => set.has(tf));
      if (!tfs.length) {
        t.checked = true; // at least one timeframe has to stay on
        return;
      }
      const patch = { tfs };
      if (!tfs.includes(store.settings.chartTf)) patch.chartTf = tfs.includes('H1') ? 'H1' : tfs[0];
      store.setSettings(patch);
    } else if (t.matches('input[name="src"]')) {
      message = '';
      if (t.value === 'dukascopy') {
        pendingSource = null;
        store.setSettings({ source: 'dukascopy' });
      } else if (store.settings.twelveKey) {
        pendingSource = null;
        store.setSettings({ source: 'twelvedata' });
      } else {
        pendingSource = 'twelvedata';
        message = 'Paste your API key, then tap "Save key and use". Dukascopy stays active until then.';
      }
      renderSettings();
    }
  });

  el.addEventListener('click', (e) => {
    const quote = e.target.closest('[data-quote]');
    const act = e.target.closest('[data-act]');
    const strength = e.target.closest('[data-strength]');
    const distance = e.target.closest('[data-distance]');
    const breakOn = e.target.closest('[data-breakon]');
    const candleTf = e.target.closest('[data-candletf]');
    const day = e.target.closest('[data-day]');
    if (breakOn) setAlertPrefs({ breakOn: breakOn.dataset.breakon });
    else if (candleTf) setAlertPrefs({ candleTf: candleTf.dataset.candletf });
    else if (day) {
      store.setSettings({ dayBoundary: day.dataset.day });
      renderSettings();
    } else if (strength) {
      setAlertPrefs({ minStrength: Number(strength.dataset.strength) });
    } else if (distance) {
      const d = distance.dataset.distance;
      setAlertPrefs({ distance: d === 'auto' ? 'auto' : Number(d) });
    } else if (quote) {
      store.setSettings({ quoteSec: Number(quote.dataset.quote) });
      renderSettings();
    } else if (act) {
      const a = act.dataset.act;
      const n = native();
      if (a === 'mon-start' && n) n.startMonitoring();
      else if (a === 'mon-stop' && n) n.stopMonitoring();
      else if (a === 'mon-notif' && n) n.openNotificationSettings();
      else if (a === 'mon-channel' && n) n.openAlertChannelSettings();
      else if (a === 'mon-battery' && n) n.openBatterySettings();
      else if (a === 'lr-csv') exportLevelReport();
      else if (a === 'lr-clear') {
        if (Date.now() < lrClearArmed) {
          lrClearArmed = 0;
          lrMsg = clearLevelRecord() ? 'Record deleted. A new one starts now.' : 'Could not delete the record.';
        } else {
          lrClearArmed = Date.now() + 5000;
          lrMsg = 'This deletes every recorded level. Download the report first if you want to keep it.';
          setTimeout(() => {
            if (lrClearArmed && Date.now() >= lrClearArmed) {
              lrClearArmed = 0;
              renderSettings();
            }
          }, 5100);
        }
        renderSettings();
      } else if (a === 'alerts-clear') {
        clearAlerts();
        renderSettingsStatus();
      } else if (a === 'test') runTest();
      else if (a === 'refresh') store.sync();
      else if (a === 'clear') store.clearCache();
      else if (a === 'br-cal') {
        const v = Number(root.querySelector('#br-bid').value);
        if (!store.priceIsLive() || !(v > 0)) brokerMsg = 'Type your broker\'s current bid while the price here is live.';
        else {
          const off = Math.round((v - store.quote.bid) * 100) / 100;
          if (Math.abs(off) > 50) brokerMsg = 'That is more than $50 away from the feed: check the number.';
          else {
            store.setSettings({ brokerOffset: off });
            brokerMsg = `Offset set to ${off >= 0 ? '+' : ''}${off.toFixed(2)}.`;
          }
        }
        renderSettings();
      } else if (a === 'br-set') {
        const off = Number(root.querySelector('#br-off').value);
        if (!Number.isFinite(off) || Math.abs(off) > 50) brokerMsg = 'The offset must be between −50 and +50.';
        else {
          store.setSettings({ brokerOffset: Math.round(off * 100) / 100 });
          brokerMsg = 'Offset saved.';
        }
        renderSettings();
      }
      else if (a === 'save-key') {
        const key = root.querySelector('#td-key').value.trim();
        if (!key) return setMessage('Enter your Twelve Data API key first.');
        pendingSource = null;
        message = 'Key saved. Loading candles from Twelve Data…';
        store.setSettings({ source: 'twelvedata', twelveKey: key });
        renderSettings();
      }
    }
  });
}
