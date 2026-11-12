// App state: settings, cached candles, polling, and the derived analysis.

import { PROVIDERS, fetchQuote } from './data/providers.js';
import { analyse } from './core/model.js';
import { mergeSeries, trimTo } from './core/candles.js';
import { ANALYSIS_TFS, marketStatus } from './core/time.js';

const SETTINGS_KEY = 'xau.settings.v1';
const CACHE_KEY = 'xau.cache.v1';

// Raw feed series. D1U is the feed's own UTC-midnight daily candle.
const FEEDS = { M1: 'M1', M5: 'M5', M15: 'M15', M30: 'M30', H1: 'H1', D1U: 'D1' };
const KEEP = { M1: 1500, M5: 1500, M15: 1500, M30: 1500, H1: 3600, D1U: 2600 };
const DEEP = new Set(['H1', 'D1U']);
const SYNC_ORDER = ['M1', 'H1', 'D1U', 'M30', 'M15', 'M5'];

const QUOTE_FRESH_SEC = 90;

export const DEFAULTS = {
  source: 'dukascopy',
  twelveKey: '',
  quoteSec: 5,
  tfs: ['M15', 'M30', 'H1', 'H4', 'D1', 'W1'],
  chartTf: 'H1',
  chartLayers: { zones: true, areas: false, pivots: false, ema: false },
  levelsTab: 'ALL',
};

const nowSec = () => Math.floor(Date.now() / 1000);

function emptyRaw() {
  return Object.fromEntries(Object.keys(FEEDS).map((k) => [k, []]));
}

function readJson(key) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function loadSettings() {
  const s = readJson(SETTINGS_KEY) || {};
  const out = { ...DEFAULTS, ...s, chartLayers: { ...DEFAULTS.chartLayers, ...(s.chartLayers || {}) } };
  out.tfs = ANALYSIS_TFS.filter((tf) => (Array.isArray(out.tfs) ? out.tfs : DEFAULTS.tfs).includes(tf));
  if (!out.tfs.length) out.tfs = DEFAULTS.tfs.slice();
  if (!PROVIDERS[out.source]) out.source = DEFAULTS.source;
  if (!out.tfs.includes(out.chartTf)) out.chartTf = out.tfs.includes('H1') ? 'H1' : out.tfs[0];
  return out;
}

export const store = {
  settings: loadSettings(),
  raw: emptyRaw(),
  analysis: null,
  quote: null,
  status: {
    syncing: false,
    fromCache: false,
    cacheSavedAt: 0,
    lastSync: 0,
    lastData: 0,
    lastQuote: 0,
    error: null,
    quoteError: null,
  },

  _listeners: new Set(),
  _generation: 0,
  _lastQuoteTry: 0,
  _lastM1Try: 0,
  _lastSyncTry: 0,
  _quoteBusy: false,
  _m1Busy: false,
  _recomputeTimer: null,
  _lastSave: 0,

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },
  emit(type) {
    for (const fn of this._listeners) {
      try {
        fn(type);
      } catch (e) {
        console.error(e);
      }
    }
  },

  provider() {
    return PROVIDERS[this.settings.source];
  },

  // Live bid while quotes keep arriving, otherwise the last candle close.
  // Freshness is judged by when the quote was received, so a wrong device
  // clock cannot make a good quote look stale.
  price() {
    const q = this.quote;
    if (q && nowSec() - q.at < QUOTE_FRESH_SEC) return q.bid;
    return this.analysis ? this.analysis.lastPrice : q ? q.bid : null;
  },
  priceIsLive() {
    const q = this.quote;
    const t = nowSec();
    return !!(q && t - q.at < QUOTE_FRESH_SEC && marketStatus(t).open);
  },

  init() {
    this._loadCache();
    this._recompute();
    this.sync();
    setInterval(() => this._tick(), 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._tick();
    });
  },

  setSettings(patch) {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable: settings last for this session only */
    }
    const sourceChanged =
      this.settings.source !== before.source ||
      (this.settings.source === 'twelvedata' && this.settings.twelveKey !== before.twelveKey);
    if (sourceChanged) {
      // Candles from different feeds are never mixed.
      this._generation++;
      this.raw = emptyRaw();
      this.analysis = null;
      this.status = { ...this.status, syncing: false, fromCache: false, lastSync: 0, lastData: 0, error: null };
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch {
        /* ignore */
      }
      this.emit('data');
      this.sync();
    } else if (patch.tfs) {
      this._recompute();
    }
    this.emit('settings');
  },

  clearCache() {
    this._generation++;
    this.raw = emptyRaw();
    this.analysis = null;
    this.status = { ...this.status, syncing: false, fromCache: false, lastSync: 0, lastData: 0, error: null };
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* ignore */
    }
    this.emit('data');
    this.sync();
  },

  async testSource(source, key) {
    const c = await PROVIDERS[source].candles('M1', 5, undefined, key);
    if (!c.length) throw new Error('The feed answered but returned no candles');
    return c[c.length - 1];
  },

  // ---- sync -----------------------------------------------------------------

  async sync() {
    if (this.status.syncing) return;
    const gen = this._generation;
    const prov = this.provider();
    const key = this.settings.twelveKey;
    this._lastSyncTry = nowSec();
    this.status.syncing = true;
    this.emit('status');

    const queue = SYNC_ORDER.slice();
    const errors = [];
    let okCount = 0;
    const worker = async () => {
      while (queue.length && gen === this._generation) {
        const feed = queue.shift();
        try {
          if (DEEP.has(feed)) await this._syncDeep(feed, prov, key, gen);
          else await this._syncShallow(feed, prov, key, gen);
          okCount++;
          if (gen === this._generation) this._scheduleRecompute();
        } catch (e) {
          errors.push(`${feed}: ${e.message || e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: prov.parallel }, worker));
    if (gen !== this._generation) return;

    const t = nowSec();
    this.status.syncing = false;
    this.status.lastSync = t;
    if (okCount) {
      this.status.lastData = t;
      this.status.fromCache = false;
    }
    this.status.error = errors.length ? errors[0] : null;
    this._recompute();
    if (okCount) this._saveCache();
    this.emit('status');
  },

  _overlaps(cur, fresh) {
    return cur.length && fresh.length && fresh[0].t <= cur[cur.length - 1].t;
  },

  async _syncShallow(feed, prov, key, gen) {
    const fresh = await prov.candles(FEEDS[feed], prov.perRequest, undefined, key);
    if (gen !== this._generation || !fresh.length) return;
    const cur = this.raw[feed];
    this.raw[feed] = trimTo(this._overlaps(cur, fresh) ? mergeSeries(cur, fresh) : fresh, KEEP[feed]);
  },

  async _syncDeep(feed, prov, key, gen) {
    const tf = FEEDS[feed];
    if (prov.single) {
      const fresh = await prov.candles(tf, prov.single[tf], undefined, key);
      if (gen !== this._generation || !fresh.length) return;
      const cur = this.raw[feed];
      this.raw[feed] = trimTo(this._overlaps(cur, fresh) ? mergeSeries(cur, fresh) : fresh, KEEP[feed]);
      return;
    }
    const pages = prov.pages[tf];
    const per = prov.perRequest;
    let s = await prov.candles(tf, per, undefined, key);
    if (gen !== this._generation || !s.length) return;
    const cur = this.raw[feed];
    if (this._overlaps(cur, s)) s = mergeSeries(cur, s);
    this.raw[feed] = trimTo(s, KEEP[feed]);
    this._scheduleRecompute();
    // Page back for older history only when the cache does not already hold it.
    for (let fetched = 1; fetched < pages && s.length < (pages - 0.5) * per; fetched++) {
      const older = await prov.candles(tf, per, s[0].t, key);
      if (gen !== this._generation) return;
      if (!older.length || older[0].t >= s[0].t) break;
      s = mergeSeries(older, s);
      this.raw[feed] = trimTo(s, KEEP[feed]);
    }
  },

  async _pollM1() {
    if (this._m1Busy || this.status.syncing) return;
    this._m1Busy = true;
    this._lastM1Try = nowSec();
    const gen = this._generation;
    const prov = this.provider();
    const key = this.settings.twelveKey;
    try {
      const cur = this.raw.M1;
      let fresh = await prov.candles('M1', 10, undefined, key);
      if (gen !== this._generation) return;
      const last = cur[cur.length - 1];
      if (last && fresh.length && fresh[0].t > last.t + 120) {
        // More than the small window was missed (app was in the background).
        const missed = Math.ceil((fresh[fresh.length - 1].t - last.t) / 60) + 5;
        fresh = await prov.candles('M1', Math.min(prov.perRequest, missed), undefined, key);
        if (gen !== this._generation) return;
      }
      if (fresh.length) {
        this.raw.M1 = trimTo(this._overlaps(cur, fresh) ? mergeSeries(cur, fresh) : fresh, KEEP.M1);
        this.status.lastData = nowSec();
        this.status.fromCache = false;
        this.status.error = null;
        this._recompute();
        if (nowSec() - this._lastSave > 300) this._saveCache();
      }
    } catch (e) {
      if (gen === this._generation) {
        this.status.error = `M1: ${e.message || e}`;
        this.emit('status');
      }
    } finally {
      this._m1Busy = false;
    }
  },

  async _pollQuote() {
    if (this._quoteBusy) return;
    this._quoteBusy = true;
    this._lastQuoteTry = nowSec();
    try {
      const q = await fetchQuote();
      this.quote = { ...q, at: nowSec() };
      this.status.lastQuote = this.quote.at;
      this.status.quoteError = null;
      this.emit('quote');
    } catch (e) {
      this.status.quoteError = String(e.message || e);
      this.emit('status');
    } finally {
      this._quoteBusy = false;
    }
  },

  _tick() {
    if (!document.hidden) {
      const t = nowSec();
      const prov = this.provider();
      const open = marketStatus(t).open;
      // Nothing changes while the market is closed, so poll slowly.
      const quoteEvery = open ? this.settings.quoteSec : Math.max(60, this.settings.quoteSec);
      const m1Every = open ? prov.pollSec : 600;
      const sinceSync = t - Math.max(this.status.lastSync, this._lastSyncTry);
      const retrySoon = !this.status.lastData && sinceSync >= 30;
      if (!this.status.syncing && (sinceSync >= prov.resyncSec || retrySoon)) this.sync();
      else if (t - this._lastM1Try >= m1Every && this.raw.M1.length) this._pollM1();
      if (t - this._lastQuoteTry >= quoteEvery) this._pollQuote();
    }
    this.emit('tick');
  },

  // ---- derived --------------------------------------------------------------

  _scheduleRecompute() {
    if (this._recomputeTimer) return;
    this._recomputeTimer = setTimeout(() => {
      this._recomputeTimer = null;
      this._recompute();
    }, 60);
  },

  _recompute() {
    try {
      this.analysis = analyse(this.raw, { now: nowSec(), tfs: this.settings.tfs });
    } catch (e) {
      console.error(e);
      this.status.error = `Analysis failed: ${e.message || e}`;
    }
    this.emit('data');
  },

  // ---- cache ----------------------------------------------------------------

  _saveCache() {
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const raw = {};
    for (const k of Object.keys(FEEDS)) raw[k] = this.raw[k].map((c) => [c.t, r3(c.o), r3(c.h), r3(c.l), r3(c.c)]);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, source: this.settings.source, savedAt: nowSec(), raw }));
      this._lastSave = nowSec();
    } catch {
      // Over quota or storage disabled: the app still works, it just starts cold.
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch {
        /* ignore */
      }
    }
  },

  _loadCache() {
    const c = readJson(CACHE_KEY);
    if (!c || c.v !== 1 || c.source !== this.settings.source || !c.raw) return;
    let any = false;
    for (const k of Object.keys(FEEDS)) {
      const rows = Array.isArray(c.raw[k]) ? c.raw[k] : [];
      this.raw[k] = rows
        .filter((r) => Array.isArray(r) && r.length >= 5 && r.every((x) => Number.isFinite(x)))
        .map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: 0 }));
      if (this.raw[k].length) any = true;
    }
    if (any) {
      this.status.fromCache = true;
      this.status.cacheSavedAt = c.savedAt || 0;
    }
  },
};
