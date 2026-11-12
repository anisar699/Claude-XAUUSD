// Data sources. Every outside request goes through the app's own /api/proxy
// route (served by the Android shell, or by tools/dev-server.mjs in a browser),
// which adds the headers a WebView page cannot set and sidesteps CORS.

const TIMEOUT_MS = 20000;

export function proxied(url) {
  return '/api/proxy?u=' + encodeURIComponent(url);
}

export async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(proxied(url), { signal: ctl.signal, cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 300);
      throw err;
    }
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function clean(rows) {
  return rows
    .filter((c) => Number.isFinite(c.t) && [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0))
    .sort((a, b) => a.t - b.t);
}

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
    order: 'ASC',
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
    // the free plan's 8 requests a minute and 800 a day.
    single: { H1: 3000, D1: 2000 },
    pollSec: 120,
    resyncSec: 7200,
    parallel: 1,
    async candles(tf, limit, _beforeSec, key) {
      if (!key) throw new Error('Twelve Data API key is missing');
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
    const profiles = entry.spreadProfilePrices || [];
    const p = profiles.find((x) => x.spreadProfile === 'prime') || profiles[0];
    if (!p || !(p.bid > 0) || !(p.ask > 0)) continue;
    if (!best || entry.ts > best.ts) best = { bid: p.bid, ask: p.ask, ts: entry.ts };
  }
  if (!best) throw new Error('Unexpected quote response');
  return { bid: best.bid, ask: best.ask, t: Math.round(best.ts / 1000) };
}

export async function fetchQuote() {
  return parseSwissquote(
    await fetchText('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD'),
  );
}
