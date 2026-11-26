// Regression tests for the 1.6.0 developer audit (V16-01 to V16-13, R16-03 to
// R16-06), one per probe where the logic is testable outside the device.
import test from 'node:test';
import assert from 'node:assert/strict';

// trades.js uses localStorage; a memory one that can be made to fail.
const mem = new Map();
let failKey = null;
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    if (failKey && k === failKey) throw new Error('QuotaExceededError');
    mem.set(k, String(v));
  },
  removeItem: (k) => mem.delete(k),
};

const { createAlertState, evaluateAlerts } = await import('../app/src/main/assets/www/js/core/alerts.js');
const { marketStructure } = await import('../app/src/main/assets/www/js/core/structure.js');
const { sessionStats } = await import('../app/src/main/assets/www/js/core/sessions.js');
const { analyse } = await import('../app/src/main/assets/www/js/core/model.js');
const { marketStatus } = await import('../app/src/main/assets/www/js/core/time.js');
const { entryReached, journalCsv, journalStats, tradeResult } = await import('../app/src/main/assets/www/js/core/planner.js');
const T = await import('../app/src/main/assets/www/js/data/trades.js');

const utc = (...a) => Date.UTC(...a) / 1000;
const H = 3600;

// ---- V16-01 ---------------------------------------------------------------------

test('V16-01: a level moving across unchanged closes is not a candle-close break', () => {
  const prefs = { approach: false, breaks: true, sweeps: false, breakOn: 'close', minStrength: 1, distance: 'auto' };
  const run = (s, now, area, bars) => evaluateAlerts(s, { now, price: 3998.9, areas: [area], tol: 3.5, atrH1: 10, prefs, candles: bars, candleSec: 900 });
  const at = (p) => ({ price: p, lo: p - 0.4, hi: p + 0.4, strength: 4, tags: ['H1'] });
  const bar = (t, c) => ({ t, o: c, h: c + 0.2, l: c - 0.2, c });
  const s = createAlertState();
  run(s, 900, at(4000), [bar(0, 3998.9)]);
  run(s, 1000, at(4000), [bar(0, 3998.9)]);
  // The area recalculates to 3997.80 as a new candle closes, also at 3998.90.
  assert.deepEqual(run(s, 1800, at(3997.8), [bar(0, 3998.9), bar(900, 3998.9)]), []);
  // A real move of the closes through an unchanged level still alerts, once.
  const s2 = createAlertState();
  run(s2, 900, at(4000), [bar(0, 3998.0)]);
  const hit = run(s2, 1800, at(4000), [bar(0, 3998.0), bar(900, 4002.0)]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'break');
  assert.deepEqual(run(s2, 1810, at(4000), [bar(0, 3998.0), bar(900, 4002.0)]), []);
});

// ---- V16-13 ---------------------------------------------------------------------

test('V16-13: equal highs and lows are a range, not a downtrend', () => {
  const c = [];
  let t = utc(2026, 10, 2, 1);
  const leg = (a, b) => {
    for (let k = 0; k < 4; k++) {
      const p = a + ((b - a) * k) / 4;
      const q = a + ((b - a) * (k + 1)) / 4;
      c.push({ t, o: p, h: Math.max(p, q) + 0.1, l: Math.min(p, q) - 0.1, c: q });
      t += H;
    }
  };
  const pts = [100, 110, 100, 110, 100, 110, 100, 110];
  for (let i = 1; i < pts.length; i++) leg(pts[i - 1], pts[i]);
  const s = marketStructure(c);
  assert.equal(s.high, 'EH');
  assert.equal(s.low, 'EL');
  assert.equal(s.trend, 'range');
  assert.equal(s.bos, null);
});

// ---- V16-06 ---------------------------------------------------------------------

test('V16-06: a minute feed that fell behind does not hide newer 5-minute highs', () => {
  const now = utc(2026, 10, 24, 10); // London open was 08:00 UTC
  const m1 = [];
  for (let x = utc(2026, 10, 24, 7); x <= utc(2026, 10, 24, 8, 29); x += 60) m1.push({ t: x, o: 4000, h: 4001, l: 3999, c: 4000 });
  const m5 = [];
  for (let x = utc(2026, 10, 24, 6); x <= utc(2026, 10, 24, 9, 55); x += 300) m5.push({ t: x, o: 4000, h: x === utc(2026, 10, 24, 9, 30) ? 4021 : 4001, l: 3999, c: 4000 });
  const ldn = (st) => st.sessions.find((s) => s.id === 'london');
  const st = sessionStats([{ candles: m1, step: 60 }, { candles: m5, step: 300 }], now);
  assert.equal(ldn(st).high, 4021);
  assert.equal(ldn(st).covered, true);
  // Only the lagging minute feed: its numbers, marked partial.
  const only = sessionStats([{ candles: m1, step: 60 }], now);
  assert.equal(ldn(only).high, 4001);
  assert.equal(ldn(only).covered, false);
});

// ---- V16-12 ---------------------------------------------------------------------

test('V16-12: a week the history starts partway into gives estimated pivots', () => {
  // Open-market hours from Monday 16 Nov 23:00 UTC (Tuesday's broker day) on:
  // the previous week, 16-20 Nov, misses its Monday.
  const h1 = [];
  for (let t = utc(2026, 10, 16, 23); t < utc(2026, 10, 24, 6); t += H) {
    if (!marketStatus(t).open) continue;
    const p = 4000 + 5 * Math.sin(h1.length / 5);
    h1.push({ t, o: p, h: p + 1, l: p - 1, c: p });
  }
  const now = utc(2026, 10, 24, 6, 30);
  const a = analyse({ H1: h1, M1: [{ t: utc(2026, 10, 24, 6, 29), o: 4000, h: 4000.5, l: 3999.5, c: 4000, asOf: now }] }, { now, tfs: ['H1'] });
  assert.equal(a.key.W.approx, true, 'the four-day week is an estimate');
  assert.ok(a.conf.filter((z) => z.tags.some((x) => x.startsWith('W-') || x.startsWith('PW'))).every((z) => z.approx));
});

// ---- planner and journal ----------------------------------------------------------------

const plan = (id, entry = 4000) => ({ id, created: 1, dir: 'long', entry, sl: entry - 10, tps: [entry + 20], lots: 0.1 });

test('V16-02: an edited plan replaces the old one and does not inherit its hit', () => {
  mem.clear();
  assert.ok(T.savePlan(plan('a')).ok);
  assert.ok(T.markHit('a', 123));
  assert.ok(T.savePlan(plan('b', 3950), 'a').ok);
  assert.deepEqual(T.readPlans().map((p) => p.id), ['b']);
  assert.equal(T.readHits().a, undefined, 'the old hit is gone');
  assert.equal(T.readHits().b, undefined, 'the new plan starts unreached');
});

test('V16-03: storage failures are reported, and a failed hit is not stored', () => {
  mem.clear();
  failKey = 'xau.plans.v1';
  assert.deepEqual(T.savePlan(plan('a')), { ok: false, reason: 'storage' });
  assert.equal(T.readPlans().length, 0);
  failKey = 'xau.journal.v1';
  assert.deepEqual(T.saveTrade({ id: 't', t: 1, dir: 'long', entry: 4000 }), { ok: false, reason: 'storage' });
  failKey = 'xau.plans.hits.v1';
  assert.equal(T.markHit('a', 1), false);
  assert.equal(T.markHit('a', 2), false);
  assert.deepEqual(T.readHits(), {});
  failKey = null;
});

test('V16-04: a trade keeps the contract size it was made with', () => {
  const tr = { id: 'x', t: 1, dir: 'long', entry: 4000, sl: 3990, exit: 4010, lots: 0.1, contract: 100 };
  assert.equal(tradeResult(tr, 10).pnl, 100, 'the setting now (10) does not rewrite it');
  // Older trades without one get today's setting stamped once.
  mem.clear();
  mem.set('xau.journal.v1', JSON.stringify([{ id: 'old', t: 1, dir: 'long', entry: 4000, sl: 3990, exit: 4010, lots: 0.1 }]));
  T.stampContracts(100);
  assert.equal(T.readTrades()[0].contract, 100);
  T.stampContracts(10);
  assert.equal(tradeResult(T.readTrades()[0], 10).pnl, 100);
});

test('V16-05: negative or malformed volumes are refused', () => {
  const base = { id: 'n', t: 1, dir: 'long', entry: 4000, sl: 3990, exit: 4010 };
  assert.match(T.tradeProblem({ ...base, lots: -0.1 }), /lots/);
  assert.match(T.tradeProblem({ ...base, sl: -5 }), /stop loss/);
  assert.equal(T.tradeProblem({ ...base, lots: NaN }), null, 'volume may be left empty');
  assert.equal(T.tradeProblem({ ...base, exit: NaN, lots: 0.1 }), null, 'an open trade is fine');
  mem.clear();
  assert.equal(T.saveTrade({ ...base, lots: -0.1 }).ok, false);
  mem.set('xau.journal.v1', JSON.stringify([{ ...base, lots: -0.1 }, { ...base, id: 'ok', lots: 0.1 }]));
  assert.deepEqual(T.readTrades().map((t) => t.id), ['ok'], 'a bad stored record is not admitted');
  const s = journalStats([{ ...base, lots: 0.1, contract: 100 }], 100);
  assert.equal(s.all.pnl, 100);
  assert.equal(s.all.winRate, 1);
});

test('R16-04: formula-like text is neutralised in the CSV; numbers are not', () => {
  const csv = journalCsv([{ id: 'c', t: 0, dir: 'short', entry: 4000, sl: 4010, exit: 3990, lots: 0.1, contract: 100, setup: '@SUM(A1)', notes: '=1+1' }], 100).split('\n');
  const cells = csv[1].split(',');
  assert.equal(cells.at(-1), "'=1+1");
  assert.equal(cells[8], "'@SUM(A1)");
  assert.equal(cells[11], '1.00', 'R stays a number');
  assert.equal(csv[0].split(',')[7], 'oz_per_lot');
});

test('R16-05: a buy is touched on the ask, a sell on the bid', () => {
  const long = { dir: 'long', entry: 4000 };
  const short = { dir: 'short', entry: 4000 };
  assert.equal(entryReached(long, 3999.9, 4000.2), false, 'bid there, ask not yet');
  assert.equal(entryReached(long, 3999.7, 4000.0), true);
  assert.equal(entryReached(short, 4000.0, 4000.3), true);
  assert.equal(entryReached(short, 3999.9, 4000.2), false);
});

test('R16-06: full lists refuse new records instead of dropping old ones', () => {
  mem.clear();
  for (let i = 0; i < T.MAX_PLANS; i++) assert.ok(T.savePlan(plan(`p${i}`)).ok);
  assert.deepEqual(T.savePlan(plan('extra')), { ok: false, reason: 'full' });
  assert.equal(T.readPlans().length, T.MAX_PLANS);
  assert.ok(T.savePlan(plan('p3', 4100), 'p3').ok, 'editing still works when full');
  const trades = Array.from({ length: T.MAX_TRADES }, (_, i) => ({ id: `t${i}`, t: i + 1, dir: 'long', entry: 4000 }));
  mem.set('xau.journal.v1', JSON.stringify(trades));
  assert.deepEqual(T.saveTrade({ id: 'new', t: 99999, dir: 'long', entry: 4000 }), { ok: false, reason: 'full' });
  assert.equal(T.readTrades().length, T.MAX_TRADES);
});
