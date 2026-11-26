import test from 'node:test';
import assert from 'node:assert/strict';

import { alertDistances, createAlertState, describeAlert, evaluateAlerts } from '../app/src/main/assets/www/js/core/alerts.js';

const area = (price, strength = 4, half = 1) => ({ price, lo: price - half, hi: price + half, strength, tags: ['H1', 'D-R1'] });
const prefs = { approach: true, breaks: true, minStrength: 3, distance: 2 };
const base = { tol: 3, atrH1: 10, prefs };

// near = 2, rearm = max(4, 5) = 5, break buffer = 1
function run(state, now, price, areas) {
  return evaluateAlerts(state, { ...base, now, price, areas });
}

test('distances scale with ATR on auto and honour a fixed setting', () => {
  assert.deepEqual(alertDistances({ distance: 'auto' }, 20), { near: 3, rearm: 10, buffer: 2 });
  assert.deepEqual(alertDistances({ distance: 2 }, 10), { near: 2, rearm: 5, buffer: 1 });
  assert.equal(alertDistances({ distance: 'auto' }, 1).near, 0.5);
});

test('nothing fires on the first look, even right at a level', () => {
  const s = createAlertState();
  assert.deepEqual(run(s, 0, 3998.5, [area(4000)]), []);
  assert.deepEqual(run(s, 10, 3998.6, [area(4000)]), [], 'not armed until price has been away');
});

test('approach fires once when price returns from a distance, then needs a retreat', () => {
  const s = createAlertState();
  const areas = [area(4000)];
  assert.deepEqual(run(s, 0, 3980, areas), []);
  assert.deepEqual(run(s, 10, 3995, areas), [], 'still 4 away');
  const hit = run(s, 20, 3997.5, areas);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'approach');
  assert.equal(hit[0].role, 'resistance');
  assert.equal(hit[0].distance, 1.5);
  assert.deepEqual(run(s, 30, 3998, areas), [], 'no repeat while it stays near');
  assert.deepEqual(run(s, 40, 3990, areas), [], 'retreat re-arms');
  assert.deepEqual(run(s, 50, 3997.5, areas), [], 'but the 10-minute cooldown holds');
  assert.deepEqual(run(s, 700, 3990, areas), []);
  assert.equal(run(s, 710, 3998, areas).length, 1, 'fires again after cooldown and retreat');
});

test('support approach from above', () => {
  const s = createAlertState();
  const areas = [area(3950)];
  run(s, 0, 3970, areas);
  const hit = run(s, 10, 3952.5, areas);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].role, 'support');
  assert.equal(describeAlert(hit[0]).title, 'Near support 3950.00');
});

test('break needs price clearly through the far side', () => {
  const s = createAlertState();
  const areas = [area(4000)];
  run(s, 0, 3980, areas);
  run(s, 10, 3998, areas); // approach
  assert.deepEqual(run(s, 20, 4000.5, areas), [], 'inside the area');
  assert.deepEqual(run(s, 30, 4001.8, areas), [], 'inside the break buffer');
  const hit = run(s, 40, 4002.5, areas);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'break');
  assert.equal(hit[0].direction, 'up');
  assert.equal(describeAlert(hit[0]).title, 'Price above 4000.00');
  assert.deepEqual(run(s, 50, 4003, areas), [], 'no repeat');
  // Back below: a second break, but inside the 5-minute cooldown.
  assert.deepEqual(run(s, 60, 3997, areas), []);
  // The role has flipped: the area is now support, approached from above:
  // a retest of the broken level.
  run(s, 400, 4010, areas);
  const retest = run(s, 1000, 4002, areas);
  assert.equal(retest[0].kind, 'retest');
  assert.equal(retest[0].role, 'support');
  assert.equal(describeAlert(retest[0]).title, 'Retest of 4000.00: broken resistance, now support');
});


test('weak areas are ignored and each kind can be switched off', () => {
  const s = createAlertState();
  run(s, 0, 3980, [area(4000, 2)]);
  assert.deepEqual(run(s, 10, 3998, [area(4000, 2)]), []);

  const off = createAlertState();
  const p = { ...prefs, approach: false, breaks: false };
  evaluateAlerts(off, { ...base, prefs: p, now: 0, price: 3980, areas: [area(4000)] });
  assert.deepEqual(evaluateAlerts(off, { ...base, prefs: p, now: 10, price: 3998, areas: [area(4000)] }), []);
  assert.deepEqual(evaluateAlerts(off, { ...base, prefs: p, now: 20, price: 4005, areas: [area(4000)] }), []);
});

test('state follows an area that shifts a little when levels are recalculated', () => {
  const s = createAlertState();
  run(s, 0, 3980, [area(4000)]);
  const hit = run(s, 10, 3998.2, [area(4001.2)]); // same area, recalculated 1.2 higher
  assert.equal(hit.length, 1, 'still armed from before');
  // A brand-new area far from any tracked one starts fresh.
  assert.deepEqual(run(s, 20, 3998.2, [area(4001.2), area(3997)]), []);
  assert.equal(s.tracked.length, 2);
  // Areas that disappear are forgotten.
  run(s, 30, 3998.2, [area(3997)]);
  assert.equal(s.tracked.length, 1);
});

test('several areas can alert in the same pass', () => {
  const s = createAlertState();
  const areas = [area(4000), area(4004.5, 5, 0.5)];
  run(s, 0, 3980, areas);
  const hits = run(s, 10, 3998.5, areas);
  assert.deepEqual(hits.map((h) => h.area.price), [4000]);
  const more = run(s, 20, 4002.4, areas);
  assert.deepEqual(more.map((h) => `${h.kind}:${h.area.price}`).sort(), ['approach:4004.5', 'break:4000']);
});

test('a level that is recalculated across price is not a break', () => {
  const s = createAlertState();
  run(s, 0, 3990, [area(4000)]);
  // Price does not move; the area is recalculated 2.5 lower, which puts the
  // price on its other side. Nothing may fire.
  assert.deepEqual(run(s, 400, 3990, [area(3987.5)]), []);
  assert.equal(s.tracked[0].side, 'below', 'the new side is remembered');
  // Price itself then goes back through the moved area: that is a break.
  const hit = run(s, 800, 3985, [area(3987.5)]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'break');
  assert.equal(hit[0].direction, 'down');
});

test('a level that is recalculated closer to price is not an approach', () => {
  const s = createAlertState();
  run(s, 0, 3980, [area(4000)]); // armed: 19 below the area
  assert.deepEqual(run(s, 10, 3980, [area(3982.5)]), [], 'the level came to the price');
  // It is disarmed, so a small move by price does not fire either...
  assert.deepEqual(run(s, 20, 3980.5, [area(3982.5)]), []);
  // ...until price backs off and comes again.
  run(s, 30, 3975, [area(3982.5)]);
  assert.equal(run(s, 700, 3980.5, [area(3982.5)]).length, 1);
});

test('an alert after a long pause says so (audit R05)', () => {
  const s = createAlertState();
  run(s, 0, 3980, [area(4000)]);
  const hit = run(s, 86400, 4005, [area(4000)]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].since, 0);
  assert.match(describeAlert(hit[0]).body, /moved while alerts were paused/);
  // A normal, continuous check carries no such note.
  const s2 = createAlertState();
  run(s2, 0, 3980, [area(4000)]);
  run(s2, 10, 3990, [area(4000)]);
  const live = run(s2, 20, 4005, [area(4000)]);
  assert.equal(live[0].since, null);
  assert.doesNotMatch(describeAlert(live[0]).body, /paused/);
});

// ---- 1.6: close-confirmed breaks, retests, sweeps ----------------------------

const M15 = 900;
const candle = (t, o, h, l, c) => ({ t, o, h, l, c });
function runC(state, now, price, areas, bars, extra = {}) {
  return evaluateAlerts(state, { ...base, prefs: { ...prefs, ...extra }, now, price, areas, candles: bars, candleSec: M15 });
}

test('with breakOn close, a wick through is not a break; a candle close beyond is', () => {
  const s = createAlertState();
  const areas = [area(4000)];
  const c0 = candle(0, 3985, 3990, 3984, 3988);
  runC(s, 900, 3988, areas, [c0], { breakOn: 'close' });
  // Live price pokes through, no alert.
  assert.deepEqual(runC(s, 950, 4003, areas, [c0], { breakOn: 'close' }), []);
  // The candle closes back below: still nothing (but it is a sweep, see below).
  const c1 = candle(900, 3988, 4003, 3987, 3995);
  assert.ok(!runC(s, 1800, 3995, areas, [c0, c1], { breakOn: 'close', sweeps: false }).length);
  // A candle that closes above the area: one break, labelled with its close.
  const c2 = candle(1800, 3995, 4006, 3994, 4004);
  const hit = runC(s, 2700, 4004, areas, [c1, c2], { breakOn: 'close' });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'break');
  assert.equal(hit[0].close, 4004);
  assert.equal(describeAlert(hit[0]).title, 'M15 closed above 4000.00');
  // The same candle seen again does not repeat it.
  assert.deepEqual(runC(s, 2710, 4004.5, areas, [c1, c2], { breakOn: 'close' }), []);
});

test('a sweep: a wick beyond the area and a close back on the side it came from', () => {
  const s = createAlertState();
  const areas = [area(4000)];
  const c0 = candle(0, 3985, 3990, 3984, 3988);
  runC(s, 900, 3988, areas, [c0]);
  const c1 = candle(900, 3988, 4003, 3987, 3995);
  const hit = runC(s, 1800, 3995, areas, [c0, c1]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'sweep');
  assert.equal(hit[0].direction, 'up');
  assert.match(describeAlert(hit[0]).title, /^Sweep above 4000.00/);
  assert.match(describeAlert(hit[0]).body, /M15 wick to 4003.00, closed 3995.00 back below/);
  // Support swept from above.
  const s2 = createAlertState();
  const d0 = candle(0, 4012, 4014, 4010, 4012);
  runC(s2, 900, 4012, areas, [d0]);
  const d1 = candle(900, 4012, 4013, 3997, 4002);
  const hit2 = runC(s2, 1800, 4002, areas, [d0, d1]);
  assert.equal(hit2[0].kind, 'sweep');
  assert.equal(hit2[0].direction, 'down');
  // Switched off: nothing.
  const s3 = createAlertState();
  runC(s3, 900, 3988, areas, [c0], { sweeps: false });
  assert.deepEqual(runC(s3, 1800, 3995, areas, [c0, c1], { sweeps: false }), []);
});

test('a candle that closed before the area was first seen raises nothing', () => {
  const s = createAlertState();
  const areas = [area(4000)];
  const c1 = candle(900, 3988, 4003, 3987, 3995);
  // First sight comes after that candle closed (at 1800).
  runC(s, 2000, 3995, areas, [c1]);
  assert.deepEqual(runC(s, 2005, 3995, areas, [c1]), []);
});

test('retests can be switched off and expire after 48 hours', () => {
  const areas = [area(4000)];
  const go = (extra, wait) => {
    const s = createAlertState();
    runC(s, 0, 3980, areas, [], extra);
    runC(s, 10, 4010, areas, [], extra); // live break up
    runC(s, 20, 4010, areas, [], extra);
    return runC(s, 20 + wait, 4002, areas, [], extra);
  };
  assert.equal(go({}, 600)[0].kind, 'retest');
  assert.equal(go({ retests: false }, 600)[0].kind, 'approach');
  assert.equal(go({}, 49 * 3600)[0].kind, 'approach');
  assert.deepEqual(go({ retests: true, approach: false }, 49 * 3600), []);
});
