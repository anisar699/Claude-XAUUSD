// Turns raw feed candles into everything the screens show. Pure: no network,
// storage or DOM, so it runs the same in the app and in tests.

import { aggregateTf, extendWith, stitchDays, utcDaysToServerDays } from './candles.js';
import { atr, lastValue, trendOf } from './indicators.js';
import { computeZones } from './sr.js';
import { keyLevels } from './pivots.js';
import { buildLevelPool, confluence } from './confluence.js';

// raw: { M1, M5, M15, M30, H1, D1U } where D1U is the feed's UTC-midnight
// daily series. H4 and D1 are rebuilt from hourly candles on New-York-close
// boundaries; W1 and MN from those days.
export function buildSeries(raw) {
  const M1 = raw.M1 || [];
  const M5 = extendWith(raw.M5 || [], M1, 'M5');
  const M15 = extendWith(raw.M15 || [], M1, 'M15');
  const M30 = extendWith(raw.M30 || [], M1, 'M30');
  const H1 = extendWith(raw.H1 || [], M1, 'H1');
  const H4 = aggregateTf(H1, 'H4');
  const D1 = stitchDays(utcDaysToServerDays(raw.D1U || []), aggregateTf(H1, 'D1'));
  const W1 = aggregateTf(D1, 'W1');
  const MN = aggregateTf(D1, 'MN');
  return { M1, M5, M15, M30, H1, H4, D1, W1, MN };
}

function lastClose(series) {
  for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1', 'D1']) {
    const s = series[tf];
    if (s && s.length) return { price: s[s.length - 1].c, t: s[s.length - 1].t };
  }
  return null;
}

// AREA_HALF_WIDTH_ATR: multi-timeframe areas are drawn as their centre +- this
// share of the hourly ATR. zoneOptions / areaHalfWidthAtr exist for the
// walk-forward tests.
export const AREA_HALF_WIDTH_ATR = 0.1;

export function analyse(raw, { now, tfs, zoneOptions, areaHalfWidthAtr = AREA_HALF_WIDTH_ATR }) {
  const series = buildSeries(raw);
  const last = lastClose(series);
  if (!last) return null;

  const zones = {};
  const trend = {};
  for (const tf of tfs) {
    zones[tf] = computeZones(series[tf], tf, zoneOptions);
    trend[tf] = trendOf(series[tf]);
  }

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

  return { now, lastPrice: price, lastT: last.t, series, zones, trend, key, conf, tol, atrH1, atrD1, day, prevClose };
}
