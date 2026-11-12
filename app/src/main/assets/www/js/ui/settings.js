// Settings: timeframes, refresh rate, data source, data status.

import { store } from '../store.js';
import { ANALYSIS_TFS } from '../core/time.js';
import { PROVIDERS } from '../data/providers.js';
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

let root;
let message = '';
let pendingSource = null; // Twelve Data picked but no key saved yet

function statusBlock() {
  const st = store.status;
  const raw = store.raw;
  const feedLine = (k, label) => {
    const s = raw[k];
    return `<div class="kv"><span>${label}</span><span>${s.length ? `${s.length} candles · to ${dateTime(s[s.length - 1].t)}` : 'none'}</span></div>`;
  };
  const q = store.quote;
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
    ${st.error ? `<div class="kv"><span>Last error</span><span>${esc(st.error)}</span></div>` : ''}
    ${st.quoteError && q ? `<div class="kv"><span>Live price error</span><span>${esc(st.quoteError)}</span></div>` : ''}`;
}

export function renderSettings() {
  if (!root || root.hidden) return;
  const s = store.settings;
  const source = pendingSource || s.source;
  const keyValue = root.querySelector('#td-key') ? root.querySelector('#td-key').value : s.twelveKey;

  root.innerHTML = `
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
        <span><span class="opt-t">Twelve Data</span><div class="opt-d">Backup. Needs your own free API key from twelvedata.com. Updates every 2 minutes to stay inside the free plan.</div></span></label>
      <div class="field" id="td-box"${source === 'twelvedata' ? '' : ' hidden'} style="padding-top:10px">
        <label class="lbl" for="td-key">Twelve Data API key (stored only on this phone)</label>
        <input id="td-key" class="inp" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your key">
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
      <div class="card-h"><h2>About</h2><span>version 1.0.0</span></div>
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

export function initSettings(el) {
  root = el;

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[data-tf]')) {
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
    if (quote) {
      store.setSettings({ quoteSec: Number(quote.dataset.quote) });
      renderSettings();
    } else if (act) {
      const a = act.dataset.act;
      if (a === 'test') runTest();
      else if (a === 'refresh') store.sync();
      else if (a === 'clear') store.clearCache();
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
