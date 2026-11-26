// App state: settings, cached candles, polling, and the derived analysis.

import { PROVIDERS, cleanCandles, fetchQuote } from './data/providers.js';
import { analyse } from './core/model.js';
import { mergeSeries, trimTo } from './core/candles.js';
import { ANALYSIS_TFS, marketStatus, setServerTime } from './core/time.js';
import { ALERT_DEFAULTS } from './core/alerts.js';

const SETTINGS_KEY = 'xau.settings.v1';
const CACHE_KEY = 'xau.cache.v1';

// Raw feed series. D1U is the feed's own UTC-midnight daily candle.
const FEEDS = { M1: 'M1', M5: 'M5', M15: 'M15', M30: 'M30', H1: 'H1', D1U: 'D1' };
const KEEP = { M1: 1500, M5: 1500, M15: 1500, M30: 1500, H1: 3600, D1U: 2600 };
const DEEP = new Set(['H1', 'D1U']);
const SYNC_ORDER = ['M1', 'H1', 'D1U', 'M30', 'M15', 'M5'];
// Feeds only needed while their own timeframe is switched on. M1, H1 and D1U
// feed everything else (forming candles, H4, days, weeks, pivots).
const OPTIONAL = { M5: 'M5', M15: 'M15', M30: 'M30' };

export function feedsNeeded(tfs) {
  return SYNC_ORDER.filter((f) => !OPTIONAL[f] || tfs.includes(OPTIONAL[f]));
}

// A quote is live only if all hold: it arrived recently (monotonic clock, so
// changing the phone's clock cannot extend it), the feed's own timestamp has
// moved recently (a frozen feed is not live), and that timestamp is recent by
// the server's clock (a delayed or replayed quote is not live, and a wrong
// phone clock cannot make an old quote look new).
const QUOTE_FRESH_MS = 90 * 1000;
const QUOTE_STILL_MS = 120 * 1000;
const QUOTE_MAX_AGE_SEC = 90;
const QUOTE_FUTURE_SEC = 15;
// Retry a failed feed after 30 s, doubling up to 5 minutes.
const RETRY_BASE_SEC = 30;
const RETRY_MAX_SEC = 300;
// After a rate-limit answer without Retry-After: wait 60 s, doubling to 15 min.
const COOLDOWN_BASE_SEC = 60;
const COOLDOWN_MAX_SEC = 900;
// Failed quote requests back off up to 2 minutes.
const QUOTE_RETRY_MAX_SEC = 120;
// Failed minute-candle polls back off up to 5 minutes.
const M1_RETRY_MAX_SEC = 300;

export const DEFAULTS = {
  source: 'dukascopy',
  twelveKey: '',
  quoteSec: 5,
  tfs: ['M15', 'M30', 'H1', 'H4', 'D1', 'W1'],
  chartTf: 'H1',
  chartLayers: { zones: true, areas: false, pivots: false, ema: false, sessions: false, structure: false },
  levelsTab: 'ALL',
  alerts: { ...ALERT_DEFAULTS },
  // The broker's price minus the feed's, in dollars: added to every price.
  brokerOffset: 0,
  // When the broker's day (and H4 / week / month) starts: 'ny' = 17:00 New
  // York, 'utc' = 00:00 UTC.
  dayBoundary: 'ny',
  // For the trade planner: account size, risk per trade (%), ounces per lot.
  account: { balance: 1000, riskPct: 1, contract: 100 },
};

const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);

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
    account: { ...DEFAULTS.account, ...(s.account || {}) },
  };
  out.brokerOffset = num(out.brokerOffset, -50, 50, 0);
  if (out.dayBoundary !== 'utc') out.dayBoundary = 'ny';
  out.account = {
    balance: num(out.account.balance, 0, 1e9, DEFAULTS.account.balance),
    riskPct: num(out.account.riskPct, 0, 100, DEFAULTS.account.riskPct),
    contract: num(out.account.contract, 0.0001, 1e6, DEFAULTS.account.contract),
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

  // Server clock minus phone clock (seconds), from the quote feed's Date
  // header. null until known.
  clockOffset: null,

  _listeners: new Set(),
  _generation: 0,
  _lastQuoteTry: 0,
  _lastM1Try: 0,
  _lastSyncTry: 0,
  _quoteBusy: false,
  _m1Busy: false,
  _recomputeTimer: null,
  _lastSave: 0,
  // Every candle request gets a number when it starts. A response is merged
  // into the series as it is when the response arrives, and on candles both
  // have, the answer to the later request wins: a slow old request cannot
  // undo what a newer one brought.
  _seq: 0,
  _committed: {},
  // Provider id -> time (s) before which no request may go to it.
  _cooldown: {},
  _cooldownHits: {},
  _m1Fails: 0,
  _quoteFails: 0,
  _quoteRetryAt: 0,

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
    if (this.priceIsLive()) return this.liveBid();
    return this.analysis ? this.analysis.lastPrice : this.quote ? this.liveBid() : null;
  },

  // The quote's bid in the broker's prices (with the offset), and its spread.
  liveBid() {
    return this.quote ? this.quote.bid + this.settings.brokerOffset : null;
  },
  spread() {
    return this.quote ? Math.max(0, this.quote.ask - this.quote.bid) : 0;
  },
  priceIsLive() {
    const q = this.quote;
    if (!q) return false;
    const m = monoMs();
    if (m - q.mono >= QUOTE_FRESH_MS || m - q.changedMono >= QUOTE_STILL_MS) return false;
    const age = this.serverNow() - q.t;
    if (age > QUOTE_MAX_AGE_SEC || age < -QUOTE_FUTURE_SEC) return false;
    return marketStatus(nowSec()).open;
  },

  serverNow() {
    return nowSec() + (this.clockOffset || 0);
  },

  // The feeds this page fetches for the timeframes switched on.
  feeds() {
    return feedsNeeded(this.settings.tfs);
  },

  // ---- per-feed health -------------------------------------------------------

  _feedFailed(feed, message, scheduleRetry = true) {
    this.feedErrors[feed] = message;
    if (scheduleRetry) {
      const fails = (this.feedFails[feed] || 0) + 1;
      this.feedFails[feed] = fails;
      const backoff = nowSec() + Math.min(RETRY_MAX_SEC, RETRY_BASE_SEC * 2 ** (fails - 1));
      this.feedRetryAt[feed] = Math.max(backoff, this._cooldown[this.settings.source] || 0);
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
    for (const f of this.feeds()) if (this.feedErrors[f]) list.push(`${f}: ${this.feedErrors[f]}`);
    this.status.errors = list;
    this.status.error = list.length ? list[0] : null;
  },

  // Feeds that failed on their last try, among those in use.
  failedFeeds() {
    return this.feeds().filter((f) => this.feedErrors[f]);
  },

  // ---- request gate ---------------------------------------------------------

  // Seconds left before the provider may be asked again (0 = now).
  cooldownLeft(provId = this.settings.source) {
    return Math.max(0, (this._cooldown[provId] || 0) - nowSec());
  },

  // Every candle request goes through here. While the provider has asked to
  // slow down nothing is sent; a rate-limit answer starts (or extends) that
  // wait for every feed of the provider, honouring its Retry-After. The
  // native proxy keeps the same wait for every page of the app, so the
  // monitor and the open app cannot hammer a provider between them.
  async _candles(prov, tf, limit, before, key) {
    const wait = this.cooldownLeft(prov.id);
    if (wait > 0) {
      const e = new Error(`${prov.name} asked to slow down; next try in ${wait} s`);
      e.cooldown = true;
      throw e;
    }
    try {
      const c = await prov.candles(tf, limit, before, key);
      this._cooldownHits[prov.id] = 0;
      return c;
    } catch (e) {
      if (e.status === 429 || e.retryAfter != null) {
        const hits = (this._cooldownHits[prov.id] || 0) + 1;
        this._cooldownHits[prov.id] = hits;
        const sec = e.retryAfter != null ? Math.max(1, e.retryAfter) : Math.min(COOLDOWN_MAX_SEC, COOLDOWN_BASE_SEC * 2 ** (hits - 1));
        this._cooldown[prov.id] = Math.max(this._cooldown[prov.id] || 0, nowSec() + sec);
        e.message = `${prov.name} rate limit (HTTP ${e.status || 429}); next try in ${sec} s`;
      }
      throw e;
    }
  },

  // Merge a response into the series as it is now (not as it was when the
  // request started). seq: the request's number from _seq.
  _commit(feed, fresh, seq) {
    const cur = this.raw[feed];
    const newer = seq >= (this._committed[feed] || 0);
    let next;
    if (!cur.length) next = fresh;
    else if (this._overlaps(cur, fresh)) next = newer ? mergeSeries(cur, fresh) : mergeSeries(fresh, cur);
    else if (newer && fresh[0].t > cur[cur.length - 1].t) next = fresh; // after a gap: start again from the fresh candles
    else next = mergeSeries(cur, fresh.filter((c) => c.t < cur[0].t)); // only older history from this answer
    this.raw[feed] = trimTo(next, KEEP[feed]);
    if (newer) this._committed[feed] = seq;
  },

  // `background: true` is the monitoring service's page. It has no window, so
  // page visibility means nothing there and timers may be throttled: the
  // native side calls tick() on its own clock instead.
  init(opts = {}) {
    this._background = !!opts.background;
    setServerTime(this.settings.dayBoundary);
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
    setServerTime(this.settings.dayBoundary);
    if (sourceChanged) this._resetData(false);
    else if (before.tfs.join() !== this.settings.tfs.join()) this._tfsChanged(before.tfs);
    else if (this._pricingChanged(before)) this._recompute();
    this.emit('settings');
  },

  _pricingChanged(before) {
    return before.brokerOffset !== this.settings.brokerOffset || before.dayBoundary !== this.settings.dayBoundary;
  },

  // A timeframe switched on may need a feed this page has not been fetching.
  _tfsChanged(beforeTfs) {
    const had = new Set(feedsNeeded(beforeTfs));
    const added = this.feeds().filter((f) => !had.has(f));
    // Due now: fetched straight away, or right after a sync in progress.
    for (const f of added) this.feedRetryAt[f] = nowSec();
    this._updateErrors();
    this._recompute();
    if (added.length) this.sync(added);
  },

  // Candles from different feeds are never mixed: drop everything and reload.
  _resetData(clearSaved) {
    this._generation++;
    this.raw = emptyRaw();
    this.analysis = null;
    this.feedErrors = {};
    this.feedFails = {};
    this.feedRetryAt = {};
    this._committed = {};
    this._m1Fails = 0;
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
    setServerTime(this.settings.dayBoundary);
    if (sourceChanged) this._resetData(true);
    else if (patch.tfs) this._tfsChanged(before.tfs);
    else if (this._pricingChanged(before)) this._recompute();
    this.emit('settings');
  },

  clearCache() {
    this._resetData(true);
  },

  async testSource(source, key) {
    const c = await this._candles(PROVIDERS[source], 'M1', 5, undefined, key);
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

    const queue = full ? this.feeds() : this.feeds().filter((f) => feeds.includes(f));
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
    const seq = ++this._seq;
    const fresh = this._received(await this._candles(prov, FEEDS[feed], prov.perRequest, undefined, key));
    if (gen !== this._generation) return;
    this._commit(feed, fresh, seq);
  },

  async _syncDeep(feed, prov, key, gen) {
    const tf = FEEDS[feed];
    if (prov.single) {
      const seq = ++this._seq;
      const fresh = this._received(await this._candles(prov, tf, prov.single[tf], undefined, key));
      if (gen !== this._generation) return;
      this._commit(feed, fresh, seq);
      return;
    }
    const pages = prov.pages[tf];
    const per = prov.perRequest;
    const seq = ++this._seq;
    const first = this._received(await this._candles(prov, tf, per, undefined, key));
    if (gen !== this._generation) return;
    this._commit(feed, first, seq);
    this._scheduleRecompute();
    // Page back for older history only when the cache does not already hold it.
    for (let fetched = 1; fetched < pages && this.raw[feed].length < (pages - 0.5) * per; fetched++) {
      const oldest = this.raw[feed][0].t;
      const pageSeq = ++this._seq;
      const older = await this._candles(prov, tf, per, oldest, key);
      if (gen !== this._generation) return;
      if (!older.length || older[0].t >= oldest) break;
      // Older history only adds candles before what is held; it never
      // replaces newer ones.
      this._commit(feed, older.filter((c) => c.t < oldest), Math.min(pageSeq, seq));
    }
  },

  // Small, frequent update of the minute candles. A failure is shown and the
  // next poll waits longer (doubling, up to 5 minutes); a rate limit waits as
  // long as the provider asked. An empty minute series is filled by the feed
  // retry in _tick instead.
  async _pollM1() {
    if (this._m1Busy || this.status.syncing || !this.raw.M1.length) return;
    this._m1Busy = true;
    this._lastM1Try = nowSec();
    const gen = this._generation;
    const prov = this.provider();
    const key = this.settings.twelveKey;
    try {
      let seq = ++this._seq;
      let fresh = this._received(await this._candles(prov, 'M1', 10, undefined, key));
      if (gen !== this._generation) return;
      const cur = this.raw.M1;
      const last = cur[cur.length - 1];
      if (fresh[0].t > last.t + 60) {
        // More than the small window was missed (app was in the background):
        // fetch the whole stretch so the minute candles have no hole.
        const missed = Math.ceil((fresh[fresh.length - 1].t - last.t) / 60) + 5;
        seq = ++this._seq;
        fresh = this._received(await this._candles(prov, 'M1', Math.min(prov.perRequest, missed), undefined, key));
        if (gen !== this._generation) return;
      }
      this._commit('M1', fresh, seq);
      this._m1Fails = 0;
      this.status.lastData = nowSec();
      this.status.fromCache = false;
      this._feedOk('M1');
      this._recompute();
      if (nowSec() - this._lastSave > 300) this._saveCache();
    } catch (e) {
      if (gen === this._generation) {
        this._m1Fails++;
        this._feedFailed('M1', String(e.message || e), false);
        this.emit('status');
      }
    } finally {
      this._m1Busy = false;
    }
  },

  // Seconds between minute polls: the provider's normal pace, longer after
  // failures, and never before a requested cooldown ends.
  _m1Delay(base) {
    if (!this._m1Fails) return base;
    return Math.min(M1_RETRY_MAX_SEC, base * 2 ** this._m1Fails);
  },

  async _pollQuote() {
    if (this._quoteBusy || nowSec() < this._quoteRetryAt) return;
    this._quoteBusy = true;
    this._lastQuoteTry = nowSec();
    try {
      const q = await fetchQuote();
      if (q.serverT != null) this.clockOffset = q.serverT - nowSec();
      this._quoteFails = 0;
      this._quoteRetryAt = 0;
      this.status.quoteError = null;
      const prev = this.quote;
      // An answer older than the quote already held arrived late or out of
      // order: keep the newer one.
      if (prev && q.t < prev.t) {
        this.emit('status');
        return;
      }
      const m = monoMs();
      const moved = !prev || q.t !== prev.t;
      this.quote = { bid: q.bid, ask: q.ask, t: q.t, at: nowSec(), mono: m, changedMono: moved ? m : prev.changedMono };
      this.status.lastQuote = this.quote.at;
      this.emit('quote');
    } catch (e) {
      this._quoteFails++;
      const wait = e.retryAfter != null ? e.retryAfter : Math.min(QUOTE_RETRY_MAX_SEC, this.settings.quoteSec * 2 ** this._quoteFails);
      this._quoteRetryAt = nowSec() + wait;
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
      const m1Every = this._m1Delay(!open ? 600 : bg ? Math.max(60, prov.pollSec) : prov.pollSec);
      const sinceSync = t - Math.max(this.status.lastSync, this._lastSyncTry);
      // Nothing goes to a provider that asked to slow down until its wait ends.
      if (!this.status.syncing && !this.cooldownLeft(prov.id)) {
        const due = this.feeds().filter((f) => this.feedRetryAt[f] && t >= this.feedRetryAt[f]);
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
      this.analysis = analyse(this.raw, { now: nowSec(), tfs: this.settings.tfs, offset: this.settings.brokerOffset });
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
