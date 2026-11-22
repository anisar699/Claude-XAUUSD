// Data sources. Every outside request goes through the app's own /api/proxy
// route (served by the Android shell, or by tools/dev-server.mjs in a browser),
// which adds the headers a WebView page cannot set and sidesteps CORS.

const TIMEOUT_MS = 20000;

export function proxied(url) {
  return '/api/proxy?u=' + encodeURIComponent(url);
}

// Seconds to wait from a Retry-After header: a number of seconds or an HTTP
// date (judged against the server's own clock when known). Capped at an hour.
export function parseRetryAfter(value, nowSec) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Math.min(3600, Number(v));
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(3600, Math.round(at / 1000 - nowSec)));
}

// The proxy passes the feed's own Date header on as X-Upstream-Date: the
// server's clock, so freshness does not depend on the phone's clock.
function serverTime(res) {
  const d = res.headers && res.headers.get ? res.headers.get('X-Upstream-Date') : null;
  const t = d ? Date.parse(d) / 1000 : NaN;
  return Number.isFinite(t) ? t : null;
}

// { text, serverT }. A failed request throws an Error with `status` and,
// when the feed (or the proxy's shared cooldown) asked for it, `retryAfter`
// in seconds.
export async function fetchResponse(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(proxied(url), { signal: ctl.signal, cache: 'no-store' });
    const text = await res.text();
    const serverT = serverTime(res);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 300);
      const ra = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
      err.retryAfter = parseRetryAfter(ra, serverT != null ? serverT : Date.now() / 1000);
      throw err;
    }
    return { text, serverT };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url) {
  return (await fetchResponse(url)).text;
}

const MIN_T = 946684800; // 2000-01-01
const MAX_T = 4102444800; // 2100-01-01

// Keep only well-formed candles: whole-second times in a sane range, finite
// positive prices, high above and low below the open and close. A later row
// with the same time replaces an earlier one. Sorted by time.
export function cleanCandles(rows) {
  const byTime = new Map();
  for (const c of rows) {
    if (!c || !Number.isInteger(c.t) || c.t < MIN_T || c.t > MAX_T) continue;
    if (![c.o, c.h, c.l, c.c].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) continue;
    const eps = 1e-6 * c.h;
    if (c.h + eps < Math.max(c.o, c.c) || c.l - eps > Math.min(c.o, c.c) || c.h < c.l) continue;
    byTime.set(c.t, c);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

const clean = cleanCandles;

// ---- Dukascopy (default; real spot XAU/USD bid candles, no key) -------------

const DUKA_INTERVAL = { M1: '1MIN', M5: '5MIN', M15: '15MIN', M30: '30MIN', H1: '1HOUR', D1: '1DAY' };

export function dukaUrl(tf, limit, beforeMs) {
  const q = new URLSearchParams({
    path: 'chart/json3',
    instrument: 'XAU/USD',
    offer_side: 'B',
    interval: DUKA_INTERVAL[tf],
    splits: 'true',
    stocks: 'true',
    limit: String(limit),
    time_direction: 'P',
    timestamp: String(beforeMs),
    jsonp: 'cb',
  });
  return 'https://freeserv.dukascopy.com/2.0/index.php?' + q.toString();
}

export function parseDuka(text) {
  const a = text.indexOf('(');
  const b = text.lastIndexOf(')');
  if (a < 0 || b <= a) throw new Error('Unexpected Dukascopy response');
  const rows = JSON.parse(text.slice(a + 1, b));
  if (!Array.isArray(rows)) throw new Error('Unexpected Dukascopy response');
  return clean(
    rows.map((r) => ({ t: Math.round(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] || 0 })),
  );
}

// ---- Twelve Data (optional backup; needs the user's own free API key) -------

const TWELVE_INTERVAL = { M1: '1min', M5: '5min', M15: '15min', M30: '30min', H1: '1h', D1: '1day' };

export function twelveUrl(tf, limit, key) {
  const q = new URLSearchParams({
    symbol: 'XAU/USD',
    interval: TWELVE_INTERVAL[tf],
    outputsize: String(Math.min(5000, limit)),
    timezone: 'UTC',
    apikey: key,
  });
  return 'https://api.twelvedata.com/time_series?' + q.toString();
}

export function parseTwelve(text) {
  const j = JSON.parse(text);
  if (j.status === 'error' || !Array.isArray(j.values)) {
    throw new Error(j.message ? String(j.message).slice(0, 200) : 'Unexpected Twelve Data response');
  }
  return clean(
    j.values.map((v) => {
      const s = String(v.datetime);
      const iso = s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z';
      return { t: Date.parse(iso) / 1000, o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: 0 };
    }),
  );
}

const TWELVE_BUDGET_KEY = 'xau.twelve.budget.v1';
const TWELVE_PER_MINUTE = 7; // free plan: 8 a minute; one spare for Test connection
const TWELVE_PER_DAY = 780; // free plan: 800 a day

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBudget() {
  try {
    const b = JSON.parse(localStorage.getItem(TWELVE_BUDGET_KEY) || 'null');
    if (b && Array.isArray(b.recent) && typeof b.day === 'string' && Number.isFinite(b.count)) return b;
  } catch {
    /* fall through */
  }
  return { recent: [], day: '', count: 0 };
}

// Wait for a free slot in the shared per-minute budget and count the request
// against the daily one. Without storage it cannot coordinate and just goes.
export async function takeTwelveSlot(now = () => Date.now(), wait = sleep) {
  for (let tries = 0; tries < 10; tries++) {
    const t = now();
    let b;
    try {
      b = readBudget();
    } catch {
      return;
    }
    const today = new Date(t).toISOString().slice(0, 10);
    if (b.day !== today) b = { recent: [], day: today, count: 0 };
    b.recent = b.recent.filter((x) => t - x < 60000);
    if (b.count >= TWELVE_PER_DAY) throw new Error('Twelve Data daily limit reached; it resets at 00:00 UTC');
    if (b.recent.length < TWELVE_PER_MINUTE) {
      b.recent.push(t);
      b.count++;
      try {
        localStorage.setItem(TWELVE_BUDGET_KEY, JSON.stringify(b));
      } catch {
        /* ignore */
      }
      return;
    }
    await wait(Math.max(1000, 60000 - (t - Math.min(...b.recent)) + 100));
  }
  throw new Error('Twelve Data rate limit: try again in a minute');
}

export const PROVIDERS = {
  dukascopy: {
    id: 'dukascopy',
    name: 'Dukascopy',
    perRequest: 1000,
    pages: { H1: 3, D1: 2 },
    pollSec: 15,
    resyncSec: 1800,
    parallel: 3,
    async candles(tf, limit, beforeSec) {
      const before = beforeSec ? beforeSec * 1000 : Date.now() + 60000;
      return parseDuka(await fetchText(dukaUrl(tf, limit, before)));
    },
  },
  twelvedata: {
    id: 'twelvedata',
    name: 'Twelve Data',
    perRequest: 1000,
    // One larger request instead of paging, and slow polling, to stay inside
    // the free plan's 8 requests a minute and 800 a day: about 380 a trading
    // day per page, so the open app and the background monitor fit together.
    single: { H1: 3000, D1: 2000 },
    pollSec: 240,
    resyncSec: 14400,
    parallel: 1,
    async candles(tf, limit, _beforeSec, key) {
      if (!key) throw new Error('Twelve Data API key is missing');
      await takeTwelveSlot();
      return parseTwelve(await fetchText(twelveUrl(tf, limit, key)));
    },
  },
};

// ---- Live quote (Swissquote public feed, no key) ---------------------------

export function parseSwissquote(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || !arr.length) throw new Error('Unexpected quote response');
  let best = null;
  for (const entry of arr) {
    const profiles = (entry && entry.spreadProfilePrices) || [];
    const p = profiles.find((x) => x && x.spreadProfile === 'prime') || profiles[0];
    if (!p) continue;
    const bid = Number(p.bid);
    const ask = Number(p.ask);
    const ts = Number(entry.ts);
    // Finite prices, not crossed, a spread under 2% and a real timestamp.
    if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid && ask - bid < bid * 0.02)) continue;
    if (!(Number.isFinite(ts) && ts / 1000 > MIN_T && ts / 1000 < MAX_T)) continue;
    if (!best || ts > best.ts) best = { bid, ask, ts };
  }
  if (!best) throw new Error('Unexpected quote response');
  return { bid: best.bid, ask: best.ask, t: Math.round(best.ts / 1000) };
}

// { bid, ask, t, serverT }: serverT is the server's clock when it answered
// (null if unknown), for judging how old the quote is.
export async function fetchQuote() {
  const r = await fetchResponse('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
  return { ...parseSwissquote(r.text), serverT: r.serverT };
}
