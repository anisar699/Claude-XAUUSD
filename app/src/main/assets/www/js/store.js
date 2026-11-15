// App state: settings, cached candles, polling, and the derived analysis.

import { PROVIDERS, cleanCandles, fetchQuote } from './data/providers.js';
import { analyse } from './core/model.js';
import { mergeSeries, trimTo } from './core/candles.js';
import { ANALYSIS_TFS, marketStatus } from './core/time.js';
import { ALERT_DEFAULTS } from './core/alerts.js';

const SETTINGS_KEY = 'xau.settings.v1';
const CACHE_KEY = 'xau.cache.v1';

// Raw feed series. D1U is the feed's own UTC-midnight daily candle.
const FEEDS = { M1: 'M1', M5: 'M5', M15: 'M15', M30: 'M30', H1: 'H1', D1U: 'D1' };
const KEEP = { M1: 1500, M5: 1500, M15: 1500, M30: 1500, H1: 3600, D1U: 2600 };
const DEEP = new Set(['H1', 'D1U']);
const SYNC_ORDER = ['M1', 'H1', 'D1U', 'M30', 'M15', 'M5'];

// A quote is live only if all hold: it arrived recently (monotonic clock, so
// changing the phone's clock cannot extend it), the feed's own timestamp has
// moved recently (a frozen feed is not live), and that timestamp is close to
// the phone's clock (a replayed old quote is not live).
const QUOTE_FRESH_MS = 90 * 1000;
const QUOTE_STILL_MS = 120 * 1000;
const QUOTE_SKEW_SEC = 600;
// Retry a failed feed after 30 s, doubling up to 5 minutes.
const RETRY_BASE_SEC = 30;
const RETRY_MAX_SEC = 300;

export const DEFAULTS = {
  source: 'dukascopy',
  twelveKey: '',
  quoteSec: 5,
  tfs: ['M15', 'M30', 'H1', 'H4', 'D1', 'W1'],
  chartTf: 'H1',
  chartLayers: { zones: true, areas: false, pivots: false, ema: false },
  levelsTab: 'ALL',
  alerts: { ...ALERT_DEFAULTS },
};

const nowSec = () => Math.floor(Date.now() / 1000);
const monoMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

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
  const out = {
    ...DEFAULTS,
    ...s,
    chartLayers: { ...DEFAULTS.chartLayers, ...(s.chartLayers || {}) },
    alerts: { ...DEFAULTS.alerts, ...(s.alerts || {}) },
  };
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
    error: null, // the first current problem, for the banner
    errors: [], // every current problem, "FEED: message"
    quoteError: null,
  },

  // Per raw feed: the last error, consecutive failures, and when to retry.
  feedErrors: {},
  feedFails: {},
  feedRetryAt: {},
  analysisError: null,

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

  // Live bid while the market is open and quotes keep arriving, otherwise the
  // last candle close. A quote received while the market is closed is the
  // provider's parked weekend price (wide spread), not a tradable one.
  price() {
    if (this.priceIsLive()) return this.quote.bid;
    return this.analysis ? this.analysis.lastPrice : this.quote ? this.quote.bid : null;
  },
  priceIsLive() {
    const q = this.quote;
    if (!q) return false;
    const m = monoMs();
    if (m - q.mono >= QUOTE_FRESH_MS || m - q.changedMono >= QUOTE_STILL_MS) return false;
    const t = nowSec();
    if (Math.abs(t - q.t) > QUOTE_SKEW_SEC) return false;
    return marketStatus(t).open;
  },

  // ---- per-feed health -------------------------------------------------------

  _feedFailed(feed, message, scheduleRetry = true) {
    this.feedErrors[feed] = message;
    if (scheduleRetry) {
      const fails = (this.feedFails[feed] || 0) + 1;
      this.feedFails[feed] = fails;
      this.feedRetryAt[feed] = nowSec() + Math.min(RETRY_MAX_SEC, RETRY_BASE_SEC * 2 ** (fails - 1));
    }
    this._updateErrors();
  },

  _feedOk(feed) {
    delete this.feedErrors[feed];
    delete this.feedFails[feed];
    delete this.feedRetryAt[feed];
    this._updateErrors();
  },

  _updateErrors() {
    const list = [];
    if (this.analysisError) list.push(this.analysisError);
    for (const f of SYNC_ORDER) if (this.feedErrors[f]) list.push(`${f}: ${this.feedErrors[f]}`);
    this.status.errors = list;
    this.status.error = list.length ? list[0] : null;
  },

  // `background: true` is the monitoring service's page. It has no window, so
  // page visibility means nothing there and timers may be throttled: the
  // native side calls tick() on its own clock instead.
  init(opts = {}) {
    this._background = !!opts.background;
    this._settingsRaw = this._readSettingsRaw();
    this._loadCache();
    this._recompute();
    this.sync();
    if (this._background) return;
    setInterval(() => this._tick(), 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._tick();
    });
  },

  tick() {
    this._tick();
  },

  _readSettingsRaw() {
    try {
      return localStorage.getItem(SETTINGS_KEY) || '';
    } catch {
      return '';
    }
  },

  // The app screen and the monitoring page are separate pages sharing one
  // localStorage. This picks up settings the other one saved.
  reloadSettings() {
    const rawNow = this._readSettingsRaw();
    if (rawNow === this._settingsRaw) return;
    this._settingsRaw = rawNow;
    const before = this.settings;
    this.settings = loadSettings();
    const sourceChanged =
      this.settings.source !== before.source ||
      (this.settings.source === 'twelvedata' && this.settings.twelveKey !== before.twelveKey);
    if (sourceChanged) this._resetData(false);
    else if (before.tfs.join() !== this.settings.tfs.join()) this._recompute();
    this.emit('settings');
  },

  // Candles from different feeds are never mixed: drop everything and reload.
  _resetData(clearSaved) {
    this._generation++;
    this.raw = emptyRaw();
    this.analysis = null;
    this.feedErrors = {};
    this.feedFails = {};
    this.feedRetryAt = {};
    this.analysisError = null;
    this.status = { ...this.status, syncing: false, fromCache: false, lastSync: 0, lastData: 0, error: null, errors: [] };
    if (clearSaved) {
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch {
        /* ignore */
      }
    }
    this.emit('data');
    this.sync();
  },

  setSettings(patch) {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable: settings last for this session only */
    }
    this._settingsRaw = this._readSettingsRaw();
    const sourceChanged =
      this.settings.source !== before.source ||
      (this.settings.source === 'twelvedata' && this.settings.twelveKey !== before.twelveKey);
    if (sourceChanged) this._resetData(true);
    else if (patch.tfs) this._recompute();
    this.emit('settings');
  },

  clearCache() {
    this._resetData(true);
  },

  async testSource(source, key) {
    const c = await PROVIDERS[source].candles('M1', 5, undefined, key);
    if (!c.length) throw new Error('The feed answered but returned no candles');
    return c[c.length - 1];
  },

  // ---- sync -----------------------------------------------------------------

  // Fetch every feed, or only `feeds` (used to retry the ones that failed).
  async sync(feeds) {
    if (this.status.syncing) return;
    const full = !feeds;
    const gen = this._generation;
    const prov = this.provider();
    const key = this.settings.twelveKey;
    if (full) this._lastSyncTry = nowSec();
    this.status.syncing = true;
    this.emit('status');

    const queue = full ? SYNC_ORDER.slice() : SYNC_ORDER.filter((f) => feeds.includes(f));
    let okCount = 0;
    const worker = async () => {
      while (queue.length && gen === this._generation) {
        const feed = queue.shift();
        try {
          if (DEEP.has(feed)) await this._syncDeep(feed, prov, key, gen);
          else await this._syncShallow(feed, prov, key, gen);
          if (gen !== this._generation) return;
          this._feedOk(feed);
          okCount++;
          this._scheduleRecompute();
        } catch (e) {
          if (gen === this._generation) this._feedFailed(feed, String(e.message || e));
        }
      }
    };
    await Promise.all(Array.from({ length: prov.parallel }, worker));
    if (gen !== this._generation) return;

    const t = nowSec();
    this.status.syncing = false;
    if (full) this.status.lastSync = t;
    if (okCount) {
      this.status.lastData = t;
      this.status.fromCache = false;
    }
    this._recompute();
    if (okCount) this._saveCache();
    this.emit('status');
  },

  _overlaps(cur, fresh) {
    return cur.length && fresh.length && fresh[0].t <= cur[cur.length - 1].t;
  },

  // The last candle of a fetch is marked with the fetch time (see extendWith).
  _received(fresh) {
    if (!fresh.length) throw new Error('no candles returned');
    fresh[fresh.length - 1] = { ...fresh[fresh.length - 1], asOf: nowSec() };
    return fresh;
  },

  async _syncShallow(feed, prov, key, gen) {
    const fresh = this._received(await prov.candles(FEEDS[feed], prov.perRequest, undefined, key));
    if (gen !== this._generation) return;
    const cur = this.raw[feed];
    this.raw[feed] = trimTo(this._overlaps(cur, fresh) ? mergeSeries(cur, fresh) : fresh, KEEP[feed]);
  },

  async _syncDeep(feed, prov, key, gen) {
    const tf = FEEDS[feed];
    if (prov.single) {
      const fresh = this._received(await prov.candles(tf, prov.single[tf], undefined, key));
      if (gen !== this._generation) return;
      const cur = this.raw[feed];
      this.raw[feed] = trimTo(this._overlaps(cur, fresh) ? mergeSeries(cur, fresh) : fresh, KEEP[feed]);
      return;
    }
    const pages = prov.pages[tf];
    const per = prov.perRequest;
    let s = this._received(await prov.candles(tf, per, undefined, key));
    if (gen !== this._generation) return;
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

  // Small, frequent update of the minute candles. Its failures are shown but
  // not given a retry schedule: the next poll is the retry. An empty minute
  // series is filled by the feed retry in _tick instead.
  async _pollM1() {
    if (this._m1Busy || this.status.syncing || !this.raw.M1.length) return;
    this._m1Busy = true;
    this._lastM1Try = nowSec();
    const gen = this._generation;
    const prov = this.provider();
    const key = this.settings.twelveKey;
    try {
      const cur = this.raw.M1;
      let fresh = this._received(await prov.candles('M1', 10, undefined, key));
      if (gen !== this._generation) return;
      const last = cur[cur.length - 1];
      if (fresh[0].t > last.t + 120) {
        // More than the small window was missed (app was in the background).
        const missed = Math.ceil((fresh[fresh.length - 1].t - last.t) / 60) + 5;
        fresh = this._received(await prov.candles('M1', Math.min(prov.perRequest, missed), undefined, key));
        if (gen !== this._generation) return;
      }
      this.raw.M1 = trimTo(this._overlaps(cur, fresh) ? mergeSeries(cur, fresh) : fresh, KEEP.M1);
      this.status.lastData = nowSec();
      this.status.fromCache = false;
      this._feedOk('M1');
      this._recompute();
      if (nowSec() - this._lastSave > 300) this._saveCache();
    } catch (e) {
      if (gen === this._generation) {
        this._feedFailed('M1', String(e.message || e), false);
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
      const prev = this.quote;
      const m = monoMs();
      const moved = !prev || q.t !== prev.t;
      this.quote = { ...q, at: nowSec(), mono: m, changedMono: moved ? m : prev.changedMono };
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
    if (this._background || !document.hidden) {
      const t = nowSec();
      const prov = this.provider();
      const open = marketStatus(t).open;
      // Nothing changes while the market is closed, so poll slowly. The
      // background monitor also polls more gently than the open app.
      const bg = this._background;
      const quoteEvery = !open ? Math.max(60, this.settings.quoteSec) : bg ? Math.max(10, this.settings.quoteSec) : this.settings.quoteSec;
      const m1Every = !open ? 600 : bg ? Math.max(60, prov.pollSec) : prov.pollSec;
      const sinceSync = t - Math.max(this.status.lastSync, this._lastSyncTry);
      if (!this.status.syncing) {
        const due = SYNC_ORDER.filter((f) => this.feedRetryAt[f] && t >= this.feedRetryAt[f]);
        if (sinceSync >= prov.resyncSec) this.sync();
        else if (due.length) this.sync(due);
        else if (t - this._lastM1Try >= m1Every) this._pollM1();
      }
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
      this.analysisError = null;
    } catch (e) {
      console.error(e);
      this.analysisError = `Analysis failed: ${e.message || e}`;
    }
    this._updateErrors();
    this.emit('data');
  },

  // ---- cache ----------------------------------------------------------------

  _saveCache() {
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const raw = {};
    for (const k of Object.keys(FEEDS)) {
      raw[k] = this.raw[k].map((c) => (c.asOf != null ? [c.t, r3(c.o), r3(c.h), r3(c.l), r3(c.c), c.asOf] : [c.t, r3(c.o), r3(c.h), r3(c.l), r3(c.c)]));
    }
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
      // Saved data passes the same checks as fresh data.
      this.raw[k] = cleanCandles(
        rows
          .filter((r) => Array.isArray(r) && r.length >= 5)
          .map((r) => {
            const candle = { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: 0 };
            if (Number.isFinite(r[5])) candle.asOf = r[5];
            return candle;
          }),
      );
      if (this.raw[k].length) any = true;
    }
    if (any) {
      this.status.fromCache = true;
      this.status.cacheSavedAt = c.savedAt || 0;
    }
  },
};
