// Regression tests for the 1.4.0 developer audit (F02, F04, F06, F07, F11).
// Each test mirrors one of the audit's probes.
import test from 'node:test';
import assert from 'node:assert/strict';

import { marketStatus, unexpectedGap } from '../app/src/main/assets/www/js/core/time.js';
import { aggregateTf, markGaps } from '../app/src/main/assets/www/js/core/candles.js';
import { findSwings } from '../app/src/main/assets/www/js/core/sr.js';
import { keyLevels } from '../app/src/main/assets/www/js/core/pivots.js';
import { buildLevelPool, confluence } from '../app/src/main/assets/www/js/core/confluence.js';
import { analyse, closedOnly, latestObservation } from '../app/src/main/assets/www/js/core/model.js';
import { createAlertState, evaluateAlerts, gateAreas } from '../app/src/main/assets/www/js/core/alerts.js';

const utc = (...a) => Date.UTC(...a) / 1000;
const H = 3600;

// Hourly start times while the market is open, from `from`, `n` of them.
function openHours(from, n) {
  const out = [];
  for (let t = from; out.length < n; t += H) if (marketStatus(t).open) out.push(t);
  return out;
}

// A deterministic wavy hourly series around 3995 (no single dominant swing).
function wavy(times) {
  return times.map((t, i) => {
    const mid = 3995 + 3 * Math.sin(i / 3) + 1.5 * Math.sin(i / 7.3);
    return { t, o: mid - 0.4, h: mid + 1, l: mid - 1, c: mid + 0.4, v: 0 };
  });
}

// ---- F02: forming candles and holes ----------------------------------------

test('a forming candle cannot make or remove a zone (F02, P01)', () => {
  const times = openHours(utc(2026, 10, 2, 1), 200);
  const h1 = wavy(times);
  // A clear high 4,002 six candles from the end: with 5-candle wings it is
  // confirmed only once the fifth right-hand candle has closed.
  const i = h1.length - 6;
  h1[i] = { ...h1[i], h: 4002 };
  const last = h1[h1.length - 1];
  const now = last.t + 1800; // halfway through the newest hour
  const run = (formingHigh) => {
    const raw = { H1: h1.map((c, k) => (k === h1.length - 1 ? { ...c, h: formingHigh, asOf: now } : c)) };
    return analyse(raw, { now, tfs: ['H1'] }).zones.H1;
  };
  const a = run(4000.5);
  const b = run(4003);
  assert.deepEqual(a, b, 'the forming candle does not change any zone');
  assert.ok(!a.some((z) => Math.abs(z.price - 4002) < 0.5), 'not shown before the confirming candle closes');

  // Once that candle has closed (below the high), the swing counts.
  const closed = { H1: h1.map((c, k) => (k === h1.length - 1 ? { ...c, h: 4000.5 } : c)) };
  const later = analyse(closed, { now: last.t + H, tfs: ['H1'] }).zones.H1;
  assert.ok(later.some((z) => Math.abs(z.price - 4002) < 0.5), 'confirmed after it closes');
});

test('closedOnly drops only candles still forming', () => {
  const s = [{ t: 0 }, { t: H }, { t: 2 * H }];
  assert.equal(closedOnly(s, 'H1', 3 * H).length, 3);
  assert.equal(closedOnly(s, 'H1', 3 * H - 1).length, 2);
});

test('holes are told apart from closures and holidays', () => {
  // Thursday 15:00 UTC: an hour missing in the middle of the session.
  assert.equal(unexpectedGap(utc(2026, 10, 12, 14), utc(2026, 10, 12, 16), H), true);
  // Weekend: Friday's last hour to Sunday's open (23:00 UTC in winter).
  assert.equal(unexpectedGap(utc(2026, 10, 13, 21), utc(2026, 10, 15, 23), H), false);
  // Daily break.
  assert.equal(unexpectedGap(utc(2026, 10, 12, 21), utc(2026, 10, 12, 23), H), false);
  // Early holiday close (Thanksgiving 2026: no candles after 19:00 UTC).
  assert.equal(unexpectedGap(utc(2026, 10, 26, 19), utc(2026, 10, 26, 23), H), false);
  // A whole day shut (Christmas): from the 24th's session to the 25th's reopening.
  assert.equal(unexpectedGap(utc(2026, 11, 24, 18), utc(2026, 11, 25, 23), H), false);
  // Down across the break and two hours into the next session: a hole.
  assert.equal(unexpectedGap(utc(2026, 10, 12, 19), utc(2026, 10, 13, 2), H), true);
  // A feed whose week starts an hour after ours is not a hole.
  assert.equal(unexpectedGap(utc(2026, 10, 13, 21), utc(2026, 10, 16, 0), H), false);
});

test('a missing hour marks the 4H candle and keeps swings away from it (F02, P02)', () => {
  const times = openHours(utc(2026, 10, 9, 1), 120);
  const h1 = wavy(times);
  // Drop one hour in the middle of a session.
  const gapAt = h1.findIndex((c) => c.t === utc(2026, 10, 12, 15));
  assert.ok(gapAt > 0);
  const holed = h1.filter((_, k) => k !== gapAt);
  const marked = markGaps(holed, H);
  assert.equal(marked.filter((c) => c.gap).length, 1, 'one candle follows the hole');
  const h4 = aggregateTf(marked, 'H4', H);
  const bad = h4.filter((c) => c.gap);
  assert.equal(bad.length, 1, 'the 4H candle containing it is marked');
  // A swing right at the hole is not counted.
  const j = gapAt; // index of the candle after the hole in `marked`
  const spiky = marked.map((c, k) => (k === j ? { ...c, h: 4050 } : c));
  assert.ok(!findSwings(spiky, 3).some((s) => s.kind === 'H' && s.price === 4050));
  const clean = markGaps(h1, H).map((c, k) => (k === gapAt ? { ...c, h: 4050 } : c));
  assert.ok(findSwings(clean, 3).some((s) => s.kind === 'H' && s.price === 4050), 'the same spike without the hole is a swing');

  // The analysis reports the hole while it is among the newest candles.
  const recent = holed.filter((c) => c.t <= utc(2026, 10, 12, 16));
  const a = analyse({ H1: recent }, { now: utc(2026, 10, 12, 17), tfs: ['H1', 'H4'] });
  assert.ok(a.gaps.includes('H1') && a.gaps.includes('H4'));
});

// ---- F04: which price is the latest -----------------------------------------

test('the newest observation wins, not the finest timeframe (F04, P06)', () => {
  const now = utc(2026, 10, 12, 12, 30);
  const raw = {
    // The minute feed stopped at 11:05 at 3,990.
    M1: [{ t: utc(2026, 10, 12, 11, 5), o: 3990, h: 3990, l: 3990, c: 3990, asOf: utc(2026, 10, 12, 11, 5, 30) }],
    // The hourly feed was fetched at 12:29 with the forming candle at 4,000.
    H1: [{ t: utc(2026, 10, 12, 12), o: 3998, h: 4001, l: 3997, c: 4000, asOf: utc(2026, 10, 12, 12, 29) }],
  };
  const o = latestObservation(raw, now);
  assert.equal(o.price, 4000);
  assert.equal(o.feed, 'H1');
  assert.equal(o.at, utc(2026, 10, 12, 12, 29));
  // A complete candle is known up to its end, not up to when it was fetched.
  const fri = { M1: [{ t: utc(2026, 10, 13, 21, 59), o: 1, h: 1, l: 1, c: 1, asOf: utc(2026, 10, 14, 10) }] };
  assert.equal(latestObservation(fri, utc(2026, 10, 14, 10)).at, utc(2026, 10, 13, 22));
});

// ---- F06 / F07: alert readiness and dependencies ------------------------------

test('one minute candle: nothing is ready and a round number alone never alerts (F06, P05)', () => {
  const now = utc(2026, 10, 12, 12, 0, 30);
  const raw = { M1: [{ t: utc(2026, 10, 12, 12), o: 3994, h: 3994.5, l: 3993.5, c: 3994, asOf: now }] };
  const a = analyse(raw, { now, tfs: ['M15', 'H1', 'H4', 'D1'] });
  assert.deepEqual(a.ready, [], 'no timeframe has a usable history');
  const round = a.conf.find((z) => z.price === 4000);
  assert.ok(round && round.reference, '4,000 is a reference price');
  assert.equal(round.strength, 5, 'it still ranks first in a pool of round numbers');
  const { allowed, held } = gateAreas(a.conf, { ready: a.ready, badFeeds: [], prefs: {} });
  assert.equal(allowed.length, 0);
  assert.ok(held.every((h) => h.why === 'round number only'));

  // Even passed straight to the alert logic, the default skips it.
  const st = createAlertState();
  const area = { ...round, lo: 4000, hi: 4000 };
  evaluateAlerts(st, { now, price: 3990, areas: [area], tol: 2, atrH1: 10, prefs: {} });
  const out = evaluateAlerts(st, { now: now + 5, price: 3999, areas: [area], tol: 2, atrH1: 10, prefs: {} });
  assert.equal(out.length, 0);
  // Opted in, it works like any other area.
  const st2 = createAlertState();
  evaluateAlerts(st2, { now, price: 3990, areas: [area], tol: 2, atrH1: 10, prefs: { roundOnly: true } });
  assert.equal(evaluateAlerts(st2, { now: now + 5, price: 3999, areas: [area], tol: 2, atrH1: 10, prefs: { roundOnly: true } }).length, 1);
});

test('a ready hourly history makes its areas alertable; a failed feed holds only its own (F07)', () => {
  const times = openHours(utc(2026, 9, 1, 1), 700);
  const h1 = wavy(times);
  const last = h1[h1.length - 1];
  const now = last.t + H;
  const a = analyse({ H1: h1, M15: [] }, { now, tfs: ['M15', 'H1', 'H4'] });
  assert.ok(a.ready.includes('H1') && a.ready.includes('H4'));
  assert.ok(!a.ready.includes('M15'), 'M15 has no history of its own yet');
  const zoneArea = a.conf.find((z) => z.tfs.includes('H1'));
  assert.ok(zoneArea, 'an area built from H1 zones');
  assert.deepEqual(zoneArea.feeds.sort(), ['H1', 'M1'].concat(zoneArea.feeds.includes('D1U') ? ['D1U'] : []).sort());

  const ok = gateAreas([zoneArea], { ready: a.ready, badFeeds: ['M15'], prefs: {} });
  assert.equal(ok.allowed.length, 1, 'an M15 failure does not hold an H1 area');
  const held = gateAreas([zoneArea], { ready: a.ready, badFeeds: ['H1'], prefs: {} });
  assert.equal(held.allowed.length, 0, 'an H1 failure holds it');
  assert.equal(held.held[0].why, 'feed problem');
});

// ---- F11: estimated pivots ----------------------------------------------------

test('pivots from an estimated or partial period are marked and not alerted on (F11)', () => {
  const day = (t, extra = {}) => ({ t, o: 4000, h: 4010, l: 3990, c: 4005, v: 0, ...extra });
  const d1 = [day(utc(2026, 10, 10, 22), { approx: true }), day(utc(2026, 10, 11, 22))];
  const now = utc(2026, 10, 12, 10);
  const k = keyLevels({ D1: d1, W1: [], MN: [] }, now);
  assert.equal(k.D.approx, true);
  const pool = buildLevelPool({ zonesByTf: {}, key: k, price: 4003, span: 0 });
  const areas = confluence(pool, 0.5, 0);
  assert.ok(areas.length && areas.every((z) => z.approx));
  assert.equal(gateAreas(areas, { ready: ['H1'], badFeeds: [], prefs: {} }).allowed.length, 0);
  const exact = keyLevels({ D1: [day(utc(2026, 10, 10, 22)), day(utc(2026, 10, 11, 22))], W1: [], MN: [] }, now);
  assert.equal(exact.D.approx, false);
});

test('a minute or two missing from the minute candles does not mark the hour; half an hour does', () => {
  const start = utc(2026, 10, 12, 12);
  const minutes = (skip) => {
    const out = [];
    for (let t = start; t < start + 50 * 60; t += 60) if (!skip(t)) out.push({ t, o: 4000, h: 4001, l: 3999, c: 4000, v: 0 });
    return out;
  };
  const now = start + 50 * 60;
  const small = analyse({ M1: minutes((t) => t === start + 600 || t === start + 660) }, { now, tfs: ['H1'] });
  assert.ok(!small.gaps.includes('H1'));
  const big = analyse({ M1: minutes((t) => t >= start + 600 && t < start + 2400) }, { now, tfs: ['H1'] });
  assert.ok(big.gaps.includes('H1'));
});

test('at the weekend the last trade time comes from the intraday feeds, not the UTC daily candle', () => {
  const sun = utc(2026, 10, 22, 11, 47);
  const fri = utc(2026, 10, 20, 21, 59);
  const raw = {
    M1: [{ t: fri, o: 3538, h: 3538.5, l: 3537.9, c: 3538.18, asOf: sun }],
    H1: [{ t: utc(2026, 10, 20, 21), o: 3540, h: 3541, l: 3536, c: 3538.18, asOf: sun }],
    D1U: [{ t: utc(2026, 10, 20), o: 3620, h: 3626, l: 3514, c: 3538.2, asOf: sun }],
  };
  const o = latestObservation(raw, sun);
  assert.equal(o.at, utc(2026, 10, 20, 22), 'Friday 22:00 UTC, the close');
  const a = analyse(raw, { now: sun, tfs: ['H1'] });
  assert.deepEqual(a.stale, [], 'nothing is out of date at the weekend');
  assert.equal(latestObservation({ D1U: raw.D1U }, sun).feed, 'D1U', 'daily candles still serve when nothing else is there');
});
