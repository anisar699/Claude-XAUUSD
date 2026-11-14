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
  // The role has flipped: the area is now support, approached from above.
  run(s, 400, 4010, areas);
  const retest = run(s, 1000, 4002, areas);
  assert.equal(retest[0].kind, 'approach');
  assert.equal(retest[0].role, 'support');
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
