// The walk-forward scoring rules (1.4.0 developer audit, F08, P09 and P10).
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchedBand, reaction, score, setSeed, summarise, tally, turningPoints, SWING_K } from '../tools/sr-backtest.mjs';

const bar = (h, l, c = (h + l) / 2) => ({ t: 0, o: c, h, l, c, v: 0 });

test('a candle that jumps past a band is not a touch (P10)', () => {
  // Price at 104 below a band at 105-106; the next candle trades 109-111.
  const c = [bar(104.5, 103.5, 104), bar(111, 109, 110), bar(111, 109, 110)];
  assert.equal(reaction(c, 0, 2, 1, 105, 106), 'jump');
  // Trading inside the band and closing beyond it is a touch and a break.
  const d = [bar(104.5, 103.5, 104), bar(107, 104, 106.5)];
  assert.equal(reaction(d, 0, 1, 1, 105, 106), 'broke');
});

test('turning points are only those confirmed inside the window', () => {
  const H = 12;
  const n = 40;
  const c = Array.from({ length: n }, () => bar(101, 99, 100));
  const peak = 10 + H - SWING_K + 1; // right wing would end one candle after the window
  c[peak] = bar(110, 99, 100);
  for (let k = peak + 1; k < n; k++) c[k] = bar(100, 90, 95);
  assert.deepEqual(turningPoints(c, 10, H, 1), [], 'its wing reaches past the window');
  assert.deepEqual(turningPoints(c, 10, H + 1, 1), [110], 'with one more candle it counts');
});

test('a flat top of equal highs is one turning point (P09)', () => {
  const c = Array.from({ length: 30 }, () => bar(101, 99, 100));
  for (const k of [10, 11, 12]) c[k] = bar(108, 100, 104);
  for (let k = 13; k < 30; k++) c[k] = bar(100, 90, 95);
  // The flat top at 108 counts once, and so does the flat bottom at 90 after it.
  assert.deepEqual(turningPoints(c, 2, 25, 1), [108, 90]);
});

test('the matched control keeps side, width and distance band', () => {
  setSeed(3);
  const A = 2;
  const above = { price: 1010.5, lo: 1010, hi: 1011 }; // near edge 10 above price 1000: 5 ATR, band 10
  for (let k = 0; k < 50; k++) {
    const b = matchedBand(above, 1000, A);
    assert.ok(b.lo > 1000, 'same side');
    assert.ok(Math.abs(b.hi - b.lo - 1) < 1e-9, 'same width');
    assert.equal(Math.floor((b.lo - 1000) / (0.5 * A)), 10, 'same distance band');
  }
  const around = { price: 1000, lo: 999.5, hi: 1000.5 };
  for (let k = 0; k < 20; k++) {
    const b = matchedBand(around, 1000, A);
    assert.ok(b.lo <= 1000 && b.hi >= 1000, 'a band around price stays around price');
  }
});

test('a test point without zones counts for neither real nor random', () => {
  const c = Array.from({ length: 80 }, (_, k) => bar(101 + Math.sin(k), 99 + Math.sin(k)));
  const T = tally();
  score(T, c, 10, 24, 1, []); // no zones
  score(T, c, 40, 24, 1, [{ price: 500, lo: 499, hi: 501 }]); // none within 6 ATR
  const s = summarise(T);
  assert.equal(T.windows, 2);
  assert.equal(T.empty, 2);
  assert.equal(s.tests, 0);
  assert.equal(T.real.tps, 0);
  assert.equal(T.matched.tps, 0);
  score(T, c, 10, 24, 1, [{ price: 100, lo: 99.9, hi: 100.1 }]);
  assert.ok(Math.abs(T.real.tps - T.matched.tps) < 1e-9, 'the same turning points for both');
  assert.ok(Math.abs(T.real.tps - T.uniform.tps) < 1e-9);
});
