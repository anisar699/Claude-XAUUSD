import test from 'node:test';
import assert from 'node:assert/strict';

import { bucketEnd, bucketOf, marketStatus, nyOffsetSec, utcDayRepresentative } from '../app/src/main/assets/www/js/core/time.js';
import { aggregateTf, extendWith, mergeSeries, stitchDays, utcDaysToServerDays } from '../app/src/main/assets/www/js/core/candles.js';
import { atr, ema, rsi, trendOf } from '../app/src/main/assets/www/js/core/indicators.js';
import { clusterByPrice, computeZones, distanceTo, findSwings, roleOf } from '../app/src/main/assets/www/js/core/sr.js';
import { classicPivots, keyLevels, splitCurrent } from '../app/src/main/assets/www/js/core/pivots.js';
import { buildLevelPool, confluence, nearestAreas } from '../app/src/main/assets/www/js/core/confluence.js';
import { analyse, buildSeries } from '../app/src/main/assets/www/js/core/model.js';

const utc = (...a) => Date.UTC(...a) / 1000;
const H = 3600;
const candle = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });

// ---- time -----------------------------------------------------------------

test('New York offset follows US daylight saving', () => {
  assert.equal(nyOffsetSec(utc(2026, 2, 8, 6, 59, 59)), -5 * H);
  assert.equal(nyOffsetSec(utc(2026, 2, 8, 7, 0, 0)), -4 * H);
  assert.equal(nyOffsetSec(utc(2026, 10, 1, 5, 59, 59)), -4 * H);
  assert.equal(nyOffsetSec(utc(2026, 10, 1, 6, 0, 0)), -5 * H);
  assert.equal(nyOffsetSec(utc(2026, 6, 15, 12)), -4 * H);
  assert.equal(nyOffsetSec(utc(2026, 0, 15, 12)), -5 * H);
});

test('daily candle rolls at 17:00 New York', () => {
  // Winter: 17:00 New York is 22:00 UTC.
  assert.equal(bucketOf('D1', utc(2026, 10, 12, 7, 21)), utc(2026, 10, 11, 22));
  assert.equal(bucketOf('D1', utc(2026, 10, 12, 21, 59)), utc(2026, 10, 11, 22));
  assert.equal(bucketOf('D1', utc(2026, 10, 12, 22, 0)), utc(2026, 10, 12, 22));
  // Summer: 17:00 New York is 21:00 UTC.
  assert.equal(bucketOf('D1', utc(2026, 6, 15, 20, 59)), utc(2026, 6, 14, 21));
  assert.equal(bucketOf('D1', utc(2026, 6, 15, 21, 0)), utc(2026, 6, 15, 21));
});

test('H4 candles align to the same server clock', () => {
  assert.equal(bucketOf('H4', utc(2026, 10, 12, 7, 21)), utc(2026, 10, 12, 6));
  assert.equal(bucketOf('H4', utc(2026, 10, 11, 22, 30)), utc(2026, 10, 11, 22));
  assert.equal(bucketOf('H4', utc(2026, 6, 15, 12, 30)), utc(2026, 6, 15, 9));
});

test('weekly candle starts with the Sunday evening open', () => {
  const week = utc(2026, 10, 8, 22);
  assert.equal(bucketOf('W1', utc(2026, 10, 8, 23, 0)), week);
  assert.equal(bucketOf('W1', utc(2026, 10, 12, 7, 21)), week);
  assert.equal(bucketOf('W1', utc(2026, 10, 13, 21, 30)), week);
  assert.equal(bucketOf('W1', utc(2026, 10, 6, 20, 0)), utc(2026, 10, 1, 22));
});

test('monthly bucket is stable across a daylight saving switch', () => {
  const nov = utc(2026, 9, 31, 21); // server midnight on 1 Nov, still on summer time
  assert.equal(bucketOf('MN', utc(2026, 10, 2, 10)), nov);
  assert.equal(bucketOf('MN', utc(2026, 10, 12, 7, 21)), nov);
  assert.equal(bucketOf('MN', utc(2026, 10, 30, 21, 59)), nov);
  assert.equal(bucketEnd('MN', nov), utc(2026, 10, 30, 22));
  assert.equal(bucketOf('MN', utc(2026, 10, 30, 22, 0)), utc(2026, 10, 30, 22));
});

test('market hours', () => {
  assert.equal(marketStatus(utc(2026, 10, 12, 7, 21)).open, true);
  const sat = marketStatus(utc(2026, 10, 14, 12));
  assert.equal(sat.open, false);
  assert.equal(sat.nextChange, utc(2026, 10, 15, 23));
  const friClose = marketStatus(utc(2026, 10, 13, 22, 30));
  assert.equal(friClose.open, false);
  assert.equal(friClose.nextChange, utc(2026, 10, 15, 23));
  const dailyBreak = marketStatus(utc(2026, 10, 12, 22, 30));
  assert.equal(dailyBreak.open, false);
  assert.equal(dailyBreak.nextChange, utc(2026, 10, 12, 23));
  assert.equal(marketStatus(utc(2026, 10, 15, 23, 30)).open, true);
  assert.equal(marketStatus(utc(2026, 10, 15, 22, 30)).open, false);
  const thu = marketStatus(utc(2026, 10, 12, 7, 21));
  assert.equal(thu.nextChange, utc(2026, 10, 12, 22));
});

// ---- candles ---------------------------------------------------------------

test('aggregate M1 into M5', () => {
  const m1 = [candle(0, 10, 11, 9, 10.5), candle(60, 10.5, 12, 10, 11), candle(240, 11, 11.5, 8, 9), candle(300, 9, 9.5, 8.5, 9.2)];
  const m5 = aggregateTf(m1, 'M5');
  assert.equal(m5.length, 2);
  assert.deepEqual({ ...m5[0], v: 0 }, { t: 0, o: 10, h: 12, l: 8, c: 9, v: 0 });
  assert.equal(m5[1].t, 300);
});

test('extendWith builds the in-progress candle from finer candles', () => {
  const m5 = [candle(300, 10, 11, 9, 10), candle(600, 10, 12, 9.5, 11)];
  const m1 = [candle(540, 9, 9, 9, 9), candle(840, 11, 13, 11, 11.5), candle(900, 11.5, 11.8, 11.2, 11.6), candle(960, 11.6, 14, 11.6, 13.9)];
  const out = extendWith(m5, m1, 'M5');
  assert.equal(out.length, 3);
  assert.equal(out[0].c, 10, 'older candles untouched');
  assert.equal(out[1].h, 13);
  assert.equal(out[1].c, 11.5);
  assert.deepEqual([out[2].t, out[2].o, out[2].h, out[2].l, out[2].c], [900, 11.5, 14, 11.2, 13.9]);
  assert.equal(m5[1].h, 12, 'input not mutated');
});

test('mergeSeries prefers the newer copy', () => {
  const a = [candle(1, 1, 1, 1, 1), candle(2, 2, 2, 2, 2)];
  const b = [candle(2, 2, 9, 2, 9), candle(3, 3, 3, 3, 3)];
  const m = mergeSeries(a, b);
  assert.deepEqual(m.map((c) => c.t), [1, 2, 3]);
  assert.equal(m[1].c, 9);
});

test('UTC daily feed: Sunday stub folds into Monday', () => {
  const days = [
    candle(utc(2026, 10, 6), 4085, 4106, 4027, 4069), // Fri
    candle(utc(2026, 10, 8), 4064, 4073, 4054, 4055), // Sun stub
    candle(utc(2026, 10, 9), 4055, 4148, 4050, 4138), // Mon
    candle(utc(2026, 10, 10), 4138, 4141, 4013, 4038), // Tue
  ];
  assert.equal(utcDayRepresentative(days[1].t), days[1].t + 23 * H);
  const out = utcDaysToServerDays(days);
  assert.equal(out.length, 3);
  assert.equal(out[1].t, utc(2026, 10, 8, 22));
  assert.deepEqual([out[1].o, out[1].h, out[1].l, out[1].c], [4064, 4148, 4050, 4138]);
  const weeks = aggregateTf(out, 'W1');
  assert.equal(weeks.length, 2);
  assert.equal(weeks[1].o, 4064);
});

test('stitchDays keeps exact days where hourly history is complete', () => {
  const older = [1, 2, 3, 4, 5].map((d) => candle(d * 86400, 1, 1, 1, 1));
  const exact = [4, 5, 6].map((d) => candle(d * 86400, 2, 2, 2, 2));
  const out = stitchDays(older, exact);
  assert.deepEqual(out.map((c) => [c.t / 86400, c.c]), [[1, 1], [2, 1], [3, 1], [4, 1], [5, 2], [6, 2]]);
});

// ---- indicators ------------------------------------------------------------

test('ema, rsi, atr', () => {
  const e = ema([1, 2, 3, 4, 5, 6], 3);
  assert.equal(e[1], null);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
  assert.equal(e[5], 5);

  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14).at(-1), 100);
  const flatThenDown = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(flatThenDown, 14).at(-1), 0);

  const cs = Array.from({ length: 30 }, (_, i) => candle(i, 100, 102, 98, 100));
  assert.equal(atr(cs, 14).at(-1), 4);
});

test('trend bias', () => {
  const rising = Array.from({ length: 300 }, (_, i) => candle(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
  assert.equal(trendOf(rising).bias, 'bull');
  const falling = Array.from({ length: 300 }, (_, i) => candle(i, 500 - i, 501 - i, 499 - i, 499.5 - i));
  assert.equal(trendOf(falling).bias, 'bear');
  assert.equal(trendOf(rising.slice(0, 100)).partial, true);
});

// ---- support / resistance --------------------------------------------------

function zigzag(n, low, high, period) {
  const v = (i) => {
    const x = (i % (2 * period)) / period;
    return low + (high - low) * (x <= 1 ? x : 2 - x);
  };
  return Array.from({ length: n }, (_, i) => {
    const o = v(i);
    const c = v(i + 1);
    return candle(i * 3600, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c);
  });
}

test('findSwings marks each turning point once', () => {
  const c = zigzag(100, 100, 110, 10);
  const swings = findSwings(c, 3);
  const highs = swings.filter((s) => s.kind === 'H');
  const lows = swings.filter((s) => s.kind === 'L');
  assert.equal(highs.length, 5);
  assert.ok(highs.every((s) => Math.abs(s.price - 110.2) < 1e-9));
  assert.ok(lows.every((s) => Math.abs(s.price - 99.8) < 1e-9));
});

test('computeZones finds the range edges', () => {
  const zones = computeZones(zigzag(300, 100, 110, 10), 'H1');
  assert.equal(zones.length, 2);
  assert.ok(Math.abs(zones[0].price - 110.2) < 0.01);
  assert.ok(Math.abs(zones[1].price - 99.8) < 0.01);
  assert.ok(zones[0].touches >= 10);
  assert.equal(roleOf(zones[0], 105), 'resistance');
  assert.equal(roleOf(zones[1], 105), 'support');
  assert.ok(Math.abs(distanceTo(zones[0], 105) - 5.2) < 0.01);
  assert.ok(Math.abs(distanceTo(zones[1], 105) + 5.2) < 0.01);
});

test('clusterByPrice groups nearby points and keeps the rest apart', () => {
  const cl = clusterByPrice(
    [{ price: 100, w: 1 }, { price: 100.4, w: 1 }, { price: 99.7, w: 2 }, { price: 110, w: 1 }],
    1,
  );
  assert.equal(cl.length, 2);
  assert.equal(cl[0].members.length, 3);
  assert.equal(cl[0].score, 4);
  assert.equal(cl[0].lo, 99.7);
  assert.equal(cl[0].hi, 100.4);
  assert.equal(cl[1].price, 110);
});

// ---- pivots ----------------------------------------------------------------

test('classic pivots', () => {
  assert.deepEqual(classicPivots(110, 100, 105), { R3: 120, R2: 115, R1: 110, PP: 105, S1: 100, S2: 95, S3: 90 });
});

test('previous period switches once the current one has ended', () => {
  const thu = utc(2026, 10, 11, 22);
  const fri = utc(2026, 10, 12, 22);
  const d1 = [candle(thu, 1, 2, 0.5, 1.5), candle(fri, 1.5, 3, 1, 2.5)];
  let s = splitCurrent(d1, 'D1', fri + 10 * H);
  assert.equal(s.prev.t, thu);
  assert.equal(s.current.t, fri);
  s = splitCurrent(d1, 'D1', fri + 30 * H); // weekend
  assert.equal(s.prev.t, fri);
  assert.equal(s.current, null);
  const k = keyLevels({ D1: d1, W1: [], MN: [] }, fri + 30 * H);
  assert.equal(k.D.pivots.PP, (3 + 1 + 2.5) / 3);
  assert.equal(k.W.pivots, null);
});

// ---- confluence ------------------------------------------------------------

test('confluence merges levels from several sources', () => {
  const zonesByTf = {
    H4: [{ price: 4001, ratio: 1 }, { price: 3950, ratio: 0.5 }],
    D1: [{ price: 3999, ratio: 0.8 }],
  };
  const key = { D: { short: 'D', pivots: { PP: 3975, R1: 4002.5, S1: 3930, R2: 4040, S2: 3900, R3: 4060, S3: 3880 }, prev: { h: 4010, l: 3940 } } };
  const pool = buildLevelPool({ zonesByTf, key, price: 3970, span: 60 });
  assert.ok(pool.some((p) => p.tag === '4000' && p.w === 3.5));
  assert.ok(pool.some((p) => p.tag === 'PDH' && p.price === 4010));
  const conf = confluence(pool, 4);
  assert.ok(conf.every((z, i) => i === 0 || conf[i - 1].price > z.price), 'sorted high to low');
  const top = conf.find((z) => Math.abs(z.price - 4000.5) < 2);
  assert.ok(top);
  for (const tag of ['H4', 'D1', '4000', 'D-R1']) assert.ok(top.tags.includes(tag), tag);
  assert.equal(top.strength, 5);
  const near = nearestAreas(conf, 3970, 3);
  assert.ok(near.above.length >= 1 && near.above[0].lo > 3970);
  assert.ok(near.below.length >= 1 && near.below[0].hi < 3970);
  assert.ok(near.above.every((z, i) => i === 0 || near.above[i - 1].lo <= z.lo));
});

// ---- whole model -----------------------------------------------------------

function tradingHours(endT, count) {
  const out = [];
  let t = Math.floor(endT / H) * H;
  while (out.length < count) {
    if (marketStatus(t).open) out.unshift(t);
    t -= H;
  }
  return out;
}

function walk(times, start, stepSec) {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  let p = start;
  return times.map((t) => {
    const o = p;
    const c = o + (rnd() - 0.5) * 12;
    const h = Math.max(o, c) + rnd() * 4;
    const l = Math.min(o, c) - rnd() * 4;
    p = c;
    return { t, o, h, l, c, v: stepSec };
  });
}

test('analyse produces levels for every timeframe on New-York-close candles', () => {
  const now = utc(2026, 10, 12, 7, 21);
  const h1 = walk(tradingHours(now - H, 3000), 4000, H);
  const lastH1 = h1.at(-1);
  const m1Times = Array.from({ length: 60 + 21 }, (_, i) => lastH1.t + i * 60);
  const m1 = walk(m1Times, lastH1.o, 60);
  const raw = { M1: m1, M5: [], M15: [], M30: [], H1: h1.slice(0, -1), D1U: [] };

  const series = buildSeries(raw);
  assert.equal(series.H1.at(-1).t, utc(2026, 10, 12, 7), 'in-progress hour built from M1');
  assert.equal(series.H1.at(-1).c, m1.at(-1).c);
  assert.equal(series.H4.at(-1).t, utc(2026, 10, 12, 6));
  assert.equal(series.D1.at(-1).t, utc(2026, 10, 11, 22));
  for (const d of series.D1) {
    const dow = new Date((d.t + 4 * H) * 1000).getUTCDay(); // server date
    assert.ok(dow >= 1 && dow <= 5, 'no weekend daily candles');
  }
  for (let i = 1; i < series.W1.length - 1; i++) {
    const days = series.D1.filter((d) => bucketOf('W1', d.t) === series.W1[i].t);
    assert.equal(days.length, 5);
  }

  const tfs = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
  const a = analyse(raw, { now, tfs });
  assert.equal(a.lastPrice, m1.at(-1).c);
  for (const tf of ['H1', 'H4', 'D1']) {
    assert.ok(a.zones[tf].length >= 3, `${tf} zones`);
    assert.ok(a.zones[tf].every((z) => z.lo <= z.price && z.price <= z.hi && z.strength >= 1 && z.strength <= 5));
    assert.ok(a.zones[tf].every((z, i) => i === 0 || a.zones[tf][i - 1].lo > z.hi), `${tf} zones do not overlap`);
  }
  assert.ok(a.key.D.pivots && a.key.W.pivots && a.key.M.pivots);
  assert.equal(a.key.D.current.t, utc(2026, 10, 11, 22));
  assert.equal(a.prevClose, series.D1.at(-2).c);
  assert.ok(a.conf.length > 5);
  assert.ok(a.trend.H1 && ['bull', 'bear', 'neutral'].includes(a.trend.H1.bias));
});
