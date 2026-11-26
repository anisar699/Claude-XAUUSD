// 1.6 features: sessions, market structure, broker offset and day boundary,
// trade planner and journal, widget snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bucketOf, setServerTime } from '../app/src/main/assets/www/js/core/time.js';
import { aggregateTf, utcDaysToServerDays } from '../app/src/main/assets/www/js/core/candles.js';
import { latestWindow, londonOffsetSec, SESSIONS, sessionStats } from '../app/src/main/assets/www/js/core/sessions.js';
import { marketStructure } from '../app/src/main/assets/www/js/core/structure.js';
import { analyse, shiftRaw } from '../app/src/main/assets/www/js/core/model.js';
import { entryReached, journalCsv, journalStats, planFromArea, planNumbers, positionSize, tradeResult } from '../app/src/main/assets/www/js/core/planner.js';
import { widgetData } from '../app/src/main/assets/www/js/data/widget.js';

const utc = (...a) => Date.UTC(...a) / 1000;
const H = 3600;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16);

// ---- sessions ---------------------------------------------------------------

test('session windows follow each centre\'s daylight saving', () => {
  const at = (t, id) => latestWindow(SESSIONS.find((s) => s.id === id), t);
  // Winter (November): London 08:00-17:00 UTC, New York 13:00-22:00 UTC.
  assert.equal(iso(at(utc(2026, 10, 24, 21), 'london').start), '2026-11-24T08:00');
  assert.equal(iso(at(utc(2026, 10, 24, 21), 'ny').start), '2026-11-24T13:00');
  assert.equal(at(utc(2026, 10, 24, 21), 'ny').active, true);
  // Summer (July): London 07:00 UTC, New York 12:00 UTC.
  assert.equal(iso(at(utc(2026, 6, 15, 10), 'london').start), '2026-07-15T07:00');
  assert.equal(iso(at(utc(2026, 6, 15, 13), 'ny').start), '2026-07-15T12:00');
  // Asia is 00:00-09:00 UTC all year; the weekend is skipped.
  assert.equal(iso(at(utc(2026, 10, 28, 10), 'asia').start), '2026-11-27T00:00');
  assert.equal(londonOffsetSec(utc(2026, 6, 1)), H);
  assert.equal(londonOffsetSec(utc(2026, 11, 1)), 0);
});

test('session high, low and opening range come from candles inside the window', () => {
  const start = utc(2026, 10, 24, 8); // London open (winter)
  const m1 = [];
  for (let t = utc(2026, 10, 24, 0); t < utc(2026, 10, 24, 10); t += 60) {
    const p = t < start ? 4000 : t < start + 1800 ? 4005 : 4010;
    m1.push({ t, o: p, h: p + 1, l: p - 1, c: p });
  }
  const st = sessionStats([m1], utc(2026, 10, 24, 10));
  const ldn = st.sessions.find((s) => s.id === 'london');
  assert.equal(ldn.window.active, true);
  assert.equal(ldn.high, 4011);
  assert.equal(ldn.low, 4004);
  assert.deepEqual(ldn.opening, { high: 4006, low: 4004 });
  assert.equal(ldn.covered, true);
  assert.deepEqual(st.active, ['London']);
  // Asia (to 09:00 UTC) overlaps London's first hour.
  const asia = st.sessions.find((s) => s.id === 'asia');
  assert.equal(asia.window.active, false);
  assert.equal(asia.high, 4011);
  assert.equal(asia.low, 3999);
});

// ---- structure ----------------------------------------------------------------

function zigzag(points, step = H) {
  // Straight legs between turning points, 4 candles per leg.
  const out = [];
  let t = utc(2026, 10, 2, 1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    for (let k = 0; k < 4; k++) {
      const p = a + ((b - a) * k) / 4;
      out.push({ t, o: p, h: Math.max(p, a + ((b - a) * (k + 1)) / 4) + 0.1, l: Math.min(p, a + ((b - a) * (k + 1)) / 4) - 0.1, c: a + ((b - a) * (k + 1)) / 4 });
      t += step;
    }
  }
  return out;
}

test('market structure reads higher highs and lows and the latest break', () => {
  const up = zigzag([100, 110, 104, 116, 108, 122, 114, 126]);
  const s = marketStructure(up);
  assert.equal(s.trend, 'up');
  assert.equal(s.high, 'HH');
  assert.equal(s.low, 'HL');
  assert.equal(s.bos.dir, 'up');
  // Then a fall through the last higher low: a break down against the trend
  // (change of character); a further fall is a plain break of structure.
  const turn = marketStructure(zigzag([100, 110, 104, 116, 108, 122, 114, 126, 112, 118]));
  assert.equal(turn.bos.dir, 'down');
  assert.equal(turn.bos.level, 113.9); // the swing low's candle low
  assert.equal(turn.bos.choch, true);
  const more = marketStructure(zigzag([100, 110, 104, 116, 108, 122, 114, 126, 112, 118, 100, 104]));
  assert.equal(more.bos.dir, 'down');
  assert.equal(more.bos.choch, false);
});

// ---- broker offset and day boundary ---------------------------------------------

test('a UTC day boundary rolls days at midnight UTC and folds Sunday into Monday', () => {
  try {
    setServerTime('utc');
    assert.equal(iso(bucketOf('D1', utc(2026, 10, 24, 23, 30))), '2026-11-24T00:00');
    assert.equal(iso(bucketOf('D1', utc(2026, 10, 22, 23, 30))), '2026-11-23T00:00', 'Sunday evening is Monday');
    assert.equal(iso(bucketOf('W1', utc(2026, 10, 22, 23, 30))), '2026-11-23T00:00');
    assert.equal(iso(bucketOf('H4', utc(2026, 10, 24, 23, 30))), '2026-11-24T20:00');
    const days = utcDaysToServerDays([{ t: utc(2026, 10, 23), o: 1, h: 2, l: 0.5, c: 1.5 }]);
    assert.equal(days[0].approx, undefined, 'UTC days are exact on a UTC server');
    setServerTime('ny');
    assert.equal(iso(bucketOf('D1', utc(2026, 10, 24, 23, 30))), '2026-11-24T22:00');
    assert.equal(utcDaysToServerDays([{ t: utc(2026, 10, 23), o: 1, h: 2, l: 0.5, c: 1.5 }])[0].approx, true);
  } finally {
    setServerTime('ny');
  }
});

test('the broker offset moves every price the analysis returns', () => {
  const h1 = [];
  for (let t = utc(2026, 9, 1, 1), i = 0; h1.length < 300; t += H, i++) {
    const d = new Date(t * 1000).getUTCDay();
    if (d === 6 || d === 0) continue;
    const p = 4000 + 5 * Math.sin(i / 4);
    h1.push({ t, o: p, h: p + 1, l: p - 1, c: p });
  }
  const now = h1[h1.length - 1].t + H;
  const a = analyse({ H1: h1 }, { now, tfs: ['H1'] });
  const b = analyse({ H1: h1 }, { now, tfs: ['H1'], offset: 0.5 });
  assert.ok(Math.abs(b.lastPrice - a.lastPrice - 0.5) < 1e-9);
  assert.equal(a.zones.H1.length, b.zones.H1.length);
  a.zones.H1.forEach((z, i) => assert.ok(Math.abs(b.zones.H1[i].price - z.price - 0.5) < 1e-9));
  assert.equal(shiftRaw({ H1: h1 }, 0).H1, h1, 'no copy without an offset');
});

// ---- planner ------------------------------------------------------------------

const areas = [
  { price: 3597.71, lo: 3595.85, hi: 3599.57 },
  { price: 3560.44, lo: 3558.72, hi: 3560.86 },
  { price: 3550.6, lo: 3550, hi: 3551.4 },
  { price: 3514.36, lo: 3513, hi: 3515 },
];

test('a plan from support: entry at its top, stop below it, targets at the next areas up', () => {
  const p = planFromArea(areas[2], { price: 3555, areas, atr: 20, spread: 0.3 });
  assert.equal(p.dir, 'long');
  assert.equal(p.entry, 3551.4);
  assert.equal(p.sl, 3544.7); // 3550 - (0.25 * 20 + 0.3)
  assert.deepEqual(p.tps, [3558.72, 3595.85]);
  const n = planNumbers(p, { lots: 0.1, contract: 100 });
  assert.ok(n.valid);
  assert.ok(Math.abs(n.targets[0].rr - (3558.72 - 3551.4) / 6.7) < 1e-9);
  assert.ok(Math.abs(n.targets[0].money - 73.2) < 1e-6);
  // A short from resistance mirrors it.
  const s = planFromArea(areas[1], { price: 3555, areas, atr: 20, spread: 0.3 });
  assert.equal(s.dir, 'short');
  assert.equal(s.entry, 3558.72);
  assert.equal(s.sl, 3566.16);
  assert.deepEqual(s.tps, [3551.4, 3515], 'the near (upper) edge of each support below');
  assert.equal(entryReached(p, 3551.5), false);
  assert.equal(entryReached(p, 3551.4), true);
  assert.equal(entryReached(s, 3558.8), true);
});

test('position size never risks more than the limit', () => {
  const r = positionSize({ balance: 10000, riskPct: 1, entry: 3551.4, sl: 3544.7, contract: 100 });
  assert.equal(r.lots, 0.14); // 100 / (6.7 * 100) = 0.149 -> 0.14
  assert.ok(r.actualRisk <= 100);
  assert.equal(positionSize({ balance: 100, riskPct: 1, entry: 3551.4, sl: 3544.7 }).tooSmall, true);
  assert.equal(positionSize({ balance: 100, riskPct: 1, entry: 3551.4, sl: 3551.4 }).lots, 0);
  assert.equal(planNumbers({ dir: 'long', entry: 100, sl: 101, tps: [] }).valid, false, 'stop on the wrong side');
});

// ---- journal --------------------------------------------------------------------

test('journal results and statistics', () => {
  const trades = [
    { id: 'a', t: 1, dir: 'long', entry: 100, sl: 98, exit: 104, lots: 0.1, setup: 'Support bounce', session: 'London' },
    { id: 'b', t: 2, dir: 'short', entry: 100, sl: 101, exit: 101, lots: 0.1, setup: 'Resistance rejection', session: 'New York' },
    { id: 'c', t: 3, dir: 'long', entry: 100, sl: 99, exit: 101.5, lots: 0.2, setup: 'Support bounce', session: 'London' },
    { id: 'd', t: 4, dir: 'long', entry: 100, sl: 99, exit: NaN, lots: 0.1, setup: 'Breakout' },
  ];
  assert.deepEqual(tradeResult(trades[0], 100), { r: 2, pnl: 40, win: true });
  assert.deepEqual(tradeResult(trades[1], 100), { r: -1, pnl: -10, win: false });
  const s = journalStats(trades, 100);
  assert.equal(s.all.n, 3);
  assert.equal(s.open, 1);
  assert.ok(Math.abs(s.all.winRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.all.avgR - (2 - 1 + 1.5) / 3) < 1e-9);
  assert.equal(s.all.pnl, 40 - 10 + 30);
  assert.equal(s.all.profitFactor, 7);
  assert.equal(s.bySetup[0].key, 'Support bounce');
  assert.equal(s.bySetup[0].n, 2);
  const csv = journalCsv([{ ...trades[0], notes: 'took it, "clean"' }], 100).split('\n');
  assert.equal(csv[0].split(',')[0], 'opened_utc');
  assert.match(csv[1], /"took it, ""clean"""$/);
});

// ---- widget ----------------------------------------------------------------------

test('the widget snapshot shows price, change and the nearest areas', () => {
  const store = {
    analysis: { prevClose: 3500, conf: [{ price: 3560, lo: 3559, hi: 3561, ratio: 1, sources: 2 }, { price: 3540, lo: 3539, hi: 3541, ratio: 1, sources: 2 }], sessions: { active: ['London'] } },
    price: () => 3550,
    priceIsLive: () => true,
  };
  const d = widgetData(store);
  assert.equal(d.price, '3550.00');
  assert.equal(d.change, '+50.00 (+1.43%)');
  assert.equal(d.r, 'R 3560.00  (+9.00)');
  assert.equal(d.s, 'S 3540.00  (−9.00)');
  assert.equal(d.session, 'London');
});
