import test from 'node:test';
import assert from 'node:assert/strict';

import { bucketEnd, bucketOf, marketStatus, nyOffsetSec, utcDayRepresentative } from '../app/src/main/assets/www/js/core/time.js';
import { aggregateTf, extendWith, mergeSeries, stitchDays, utcDaysToServerDays } from '../app/src/main/assets/www/js/core/candles.js';
import { atr, ema, rsi, trendOf } from '../app/src/main/assets/www/js/core/indicators.js';
import { clusterByPrice, computeZones, distanceTo, findSwings, roleOf, SR_PARAMS, ZONES_V1 } from '../app/src/main/assets/www/js/core/sr.js';
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

test('bucketEnd follows the server clock across daylight saving', () => {
  // The week of 1 Nov 2026 starts on summer time and ends on winter time.
  const week = bucketOf('W1', utc(2026, 9, 28, 12));
  assert.equal(bucketEnd('W1', week), bucketOf('W1', utc(2026, 10, 3, 12)));
  assert.equal(bucketEnd('W1', week) - week, 7 * 86400 + 3600);
  const friday = bucketOf('D1', utc(2026, 9, 30, 12));
  assert.equal(bucketEnd('D1', friday) - friday, 86400, 'an ordinary day is 24 h');
  const monday = bucketOf('D1', utc(2026, 10, 2, 12)); // first day on winter time
  assert.equal(monday, utc(2026, 10, 1, 22));
  assert.equal(bucketEnd('D1', monday), utc(2026, 10, 2, 22));
  assert.equal(bucketEnd('H4', bucketOf('H4', utc(2026, 10, 12, 7))), bucketOf('H4', utc(2026, 10, 12, 11)));
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
  // Weekends when the clocks change: the Sunday open is 18:00 New York time
  // in the new offset.
  assert.equal(marketStatus(utc(2026, 2, 7, 12)).nextChange, utc(2026, 2, 8, 22), 'March: opens 22:00 UTC (EDT)');
  assert.equal(marketStatus(utc(2026, 9, 31, 12)).nextChange, utc(2026, 10, 1, 23), 'November: opens 23:00 UTC (EST)');
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
  // The 600 candle was fetched while still forming, at 840.
  const m5 = [candle(300, 10, 11, 9, 10), { ...candle(600, 10, 12, 9.5, 11), asOf: 840 }];
  const m1 = [candle(540, 9, 9, 9, 9), candle(840, 11, 13, 11, 11.5), candle(900, 11.5, 11.8, 11.2, 11.6), candle(960, 11.6, 14, 11.6, 13.9)];
  const out = extendWith(m5, m1, 'M5');
  assert.equal(out.length, 3);
  assert.equal(out[0].c, 10, 'older candles untouched');
  assert.equal(out[1].h, 13);
  assert.equal(out[1].c, 11.5);
  assert.deepEqual([out[2].t, out[2].o, out[2].h, out[2].l, out[2].c], [900, 11.5, 14, 11.2, 13.9]);
  assert.equal(m5[1].h, 12, 'input not mutated');
});

test('a stale minute candle cannot move a newer coarse close (audit F07)', () => {
  const hour = utc(2026, 10, 12, 11);
  const h1 = [candle(hour, 3990, 4010, 3980, 4000)]; // complete: fetched after 12:00
  const m1 = [candle(hour + 60, 3901, 3905, 3899, 3900)]; // delayed 11:01 snapshot
  const out = extendWith(h1, m1, 'H1');
  assert.equal(out[0].c, 4000, 'close kept');
  assert.equal(out[0].l, 3899, 'its low is still a real traded price');
  // While the hour is forming (fetched at 11:30), later minutes do move it.
  const forming = [{ ...candle(hour, 3990, 4010, 3980, 4000), asOf: hour + 1800 }];
  assert.equal(extendWith(forming, [candle(hour + 60, 1, 1, 1, 1)], 'H1')[0].c, 4000, '11:01 is older than the snapshot');
  assert.equal(extendWith(forming, [candle(hour + 1800, 4000, 4002, 3999, 4001)], 'H1')[0].c, 4001, '11:30 is newer');
});

test('extendWith does not build candles across a gap in the finer data', () => {
  const h1 = [candle(utc(2026, 10, 10, 5), 1, 2, 0.5, 1.5)];
  // Minute candles that start two days after the hourly series ends.
  const m1 = [candle(utc(2026, 10, 12, 7, 30), 3, 3.5, 2.5, 3), candle(utc(2026, 10, 12, 7, 31), 3, 3.2, 2.9, 3.1)];
  assert.deepEqual(extendWith(h1, m1, 'H1'), h1);
  // Contiguous minute candles do extend it.
  const next = [candle(utc(2026, 10, 10, 6), 1.5, 1.6, 1.4, 1.55)];
  const out = extendWith(h1, next, 'H1');
  assert.equal(out.length, 2);
  assert.equal(out[1].t, utc(2026, 10, 10, 6));
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
  assert.equal(rsi(new Array(30).fill(100), 14).at(-1), 50, 'flat prices are neutral');
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

test('zones are drawn as narrow bands around their centre', () => {
  // Swing highs spread over 1.2 around 110.6: one zone, centred on the
  // densest point, drawn no wider than 2 x halfWidthAtr x ATR.
  const c = [];
  let t = 0;
  for (let k = 0; k < 40; k++) {
    const top = 110 + (k % 4) * 0.4; // 110, 110.4, 110.8, 111.2
    for (let j = 0; j < 12; j++) {
      const x = j < 6 ? j / 6 : (12 - j) / 6;
      const mid = 100 + (top - 100) * x;
      c.push(candle(t++ * 3600, mid, mid + 0.2, mid - 0.2, mid));
    }
  }
  const atrNow = atr(c, 14).at(-1);
  const wide = computeZones(c, 'H1', ZONES_V1).find((z) => z.price > 105);
  const narrow = computeZones(c, 'H1').find((z) => z.price > 105);
  assert.ok(wide.hi - wide.lo > 0.8, `old zone spans the swings (${(wide.hi - wide.lo).toFixed(2)})`);
  assert.ok(narrow.hi - narrow.lo <= 2 * SR_PARAMS.H1.halfWidthAtr * atrNow + 1e-9, `new zone is narrow (${(narrow.hi - narrow.lo).toFixed(2)})`);
  assert.ok(narrow.lo <= narrow.price && narrow.price <= narrow.hi);
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
  assert.ok(pool.some((p) => p.tag === '4000' && p.w === 3));
  assert.ok(pool.some((p) => p.tag === 'PDH' && p.price === 4010));
  assert.ok(!pool.some((p) => p.tag === 'D-R3' || p.tag === 'D-S3'), 'R3/S3 tested worse than random lines and are left out');
  const w = (tag) => pool.find((p) => p.tag === tag).w;
  assert.ok(w('D-R1') > w('D-PP'), 'R1/S1 count more than PP');
  const conf = confluence(pool, 4);
  assert.ok(conf.every((z, i) => i === 0 || conf[i - 1].price > z.price), 'sorted high to low');
  const narrow = confluence(pool, 4, 0.5);
  assert.ok(narrow.every((z) => z.hi - z.lo <= 1 + 1e-9 && z.lo <= z.price && z.price <= z.hi), 'areas narrowed to +-0.5');
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
