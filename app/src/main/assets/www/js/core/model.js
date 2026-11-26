// Turns raw feed candles into everything the screens show. Pure: no network,
// storage or DOM, so it runs the same in the app and in tests.

import { aggregateTf, extendWith, markGaps, stitchDays, utcDaysToServerDays } from './candles.js';
import { bucketEnd, bucketOf } from './time.js';
import { atr, lastValue, trendOf } from './indicators.js';
import { computeZones } from './sr.js';
import { keyLevels } from './pivots.js';
import { buildLevelPool, confluence } from './confluence.js';
import { marketStructure } from './structure.js';
import { sessionStats } from './sessions.js';

// Candle length of each raw intraday feed, for finding holes in it.
const FEED_STEP = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600 };

// raw: { M1, M5, M15, M30, H1, D1U } where D1U is the feed's UTC-midnight
// daily series. H4 and D1 are rebuilt from hourly candles on New-York-close
// boundaries; W1 and MN from those days.
export function buildSeries(raw) {
  const g = {};
  for (const [feed, step] of Object.entries(FEED_STEP)) g[feed] = markGaps(raw[feed] || [], step, feed === 'M1' ? 300 : step);
  const M1 = g.M1;
  const M5 = extendWith(g.M5, M1, 'M5');
  const M15 = extendWith(g.M15, M1, 'M15');
  const M30 = extendWith(g.M30, M1, 'M30');
  const H1 = extendWith(g.H1, M1, 'H1');
  const H4 = aggregateTf(H1, 'H4', 3600);
  const D1 = stitchDays(utcDaysToServerDays(raw.D1U || []), aggregateTf(H1, 'D1', 3600));
  // Weeks and months know when their first day should be, so a history that
  // starts partway into one marks it partial (V16-12).
  const W1 = aggregateTf(D1, 'W1', 'D1');
  const MN = aggregateTf(D1, 'MN', 'D1');
  return { M1, M5, M15, M30, H1, H4, D1, W1, MN };
}

// The candles whose period has ended by `now`. Zones are found on these only:
// a forming candle can still make or break a swing.
export function closedOnly(series, tf, now) {
  let n = series.length;
  while (n > 0 && bucketEnd(tf, series[n - 1].t) > now) n--;
  return n === series.length ? series : series.slice(0, n);
}

// The most recent price the candle feeds know: the last candle of whichever
// intraday feed has seen furthest. A feed that fell behind does not win just
// because it is a finer timeframe. `at` is how far that candle is known: when
// it was fetched, or its end, whichever is earlier. The feed's own UTC daily
// candles are only a fallback when no intraday feed has data: their end
// (UTC midnight) says nothing about when trading in them stopped.
const OBSERVED = ['M1', 'M5', 'M15', 'M30', 'H1'];

export function latestObservation(raw, now) {
  let best = null;
  for (const feed of OBSERVED) {
    const s = raw[feed];
    if (!s || !s.length) continue;
    const c = s[s.length - 1];
    const at = Math.min(now, bucketEnd(feed, c.t), c.asOf != null ? c.asOf : Infinity);
    if (!best || at > best.at) best = { price: c.c, t: c.t, at, feed };
  }
  if (best) return best;
  const d = raw.D1U;
  if (!d || !d.length) return null;
  const c = d[d.length - 1];
  return { price: c.c, t: c.t, at: Math.min(now, c.t + 86400, c.asOf != null ? c.asOf : Infinity), feed: 'D1U' };
}

// Closed candles a timeframe needs before its zones count as ready: a cold
// start with an hour of minute candles builds one candle on every timeframe,
// and that must not pass for a real history.
export const READY_MIN = { M5: 120, M15: 120, M30: 120, H1: 120, H4: 60, D1: 60, W1: 26 };

// AREA_HALF_WIDTH_ATR: multi-timeframe areas are drawn as their centre +- this
// share of the hourly ATR. zoneOptions / areaHalfWidthAtr exist for the
// walk-forward tests.
export const AREA_HALF_WIDTH_ATR = 0.1;

// Every price moved by `offset` (the broker's price minus the feed's), so
// levels, candles and pivots read in the broker's own prices.
export function shiftRaw(raw, offset) {
  if (!offset) return raw;
  const out = {};
  for (const [k, s] of Object.entries(raw)) {
    out[k] = (s || []).map((c) => ({ ...c, o: c.o + offset, h: c.h + offset, l: c.l + offset, c: c.c + offset }));
  }
  return out;
}

export function analyse(rawIn, { now, tfs, zoneOptions, areaHalfWidthAtr = AREA_HALF_WIDTH_ATR, offset = 0 }) {
  const raw = shiftRaw(rawIn, offset);
  const series = buildSeries(raw);
  const last = latestObservation(raw, now);
  if (!last) return null;

  // Timeframes whose candles stop before the newest observation's period:
  // their feed failed or fell behind and the minute data cannot bridge the
  // gap. Their levels are shown but alerts must not rely on them.
  const stale = tfs.filter((tf) => {
    const s = series[tf];
    return !s || !s.length || s[s.length - 1].t < bucketOf(tf, last.at - 1);
  });

  const zones = {};
  const trend = {};
  const structure = {};
  const closedCount = {};
  // Timeframes with missing data among their newest candles.
  const gaps = [];
  for (const tf of tfs) {
    const closed = closedOnly(series[tf], tf, now);
    closedCount[tf] = closed.length;
    zones[tf] = computeZones(closed, tf, zoneOptions);
    trend[tf] = trendOf(series[tf]);
    structure[tf] = marketStructure(closed.slice(-400));
    if (series[tf].slice(-3).some((c) => c.gap)) gaps.push(tf);
  }
  // ready: enough closed history, and current.
  const ready = tfs.filter((tf) => closedCount[tf] >= (READY_MIN[tf] || 60) && !stale.includes(tf));

  const key = keyLevels(series, now);
  const atrH1 = lastValue(atr(series.H1.slice(-300), 14));
  const atrD1 = lastValue(atr(series.D1.slice(-300), 14));
  const price = last.price;
  const tol = Math.max(0.35 * (atrH1 || 0), price * 0.0004);
  const span = Math.max(2.5 * (atrD1 || 0), 100);
  const halfWidth = areaHalfWidthAtr && atrH1 ? areaHalfWidthAtr * atrH1 : 0;
  const conf = confluence(buildLevelPool({ zonesByTf: zones, key, price, span }), tol, halfWidth);

  const day = key.D.current
    ? { open: key.D.current.o, high: key.D.current.h, low: key.D.current.l }
    : null;
  // Close of the day before the latest daily candle. While a day is forming
  // that is yesterday's close; at the weekend it makes the change shown the
  // last session's own change instead of a meaningless zero.
  const d1 = series.D1;
  const prevClose = d1.length > 1 ? d1[d1.length - 2].c : null;
  const sessions = sessionStats(
    [
      { candles: series.M1, step: 60 },
      { candles: series.M5, step: 300 },
      { candles: series.M15, step: 900 },
    ],
    Math.min(now, last.at),
  );

  return {
    now,
    offset,
    lastPrice: price,
    lastT: last.t,
    lastAt: last.at,
    lastFeed: last.feed,
    series,
    zones,
    trend,
    structure,
    sessions,
    key,
    conf,
    tol,
    atrH1,
    atrD1,
    day,
    prevClose,
    stale,
    gaps,
    ready,
  };
}
