// Support / resistance zones from swing highs and lows.
//
// 1. Find swing points (a high or low that stands out from the k candles on
//    each side). Swings that also stand out over a wider window count more.
// 2. Weight each swing by how recent it is and how hard price turned there.
// 3. Group swings that sit within a tolerance (a fraction of ATR) of each
//    other: the densest group becomes a zone, its swings are removed, repeat.
// 4. Discount zones that price has since chopped back and forth through.
// 5. Draw each zone as a narrow band around its centre, not across the whole
//    spread of the swings that formed it.
//
// Only closed candles may be passed in (model.js drops the forming one), so a
// zone cannot appear or vanish while a candle is still moving.
//
// The per-timeframe settings below were chosen with tools/sr-backtest.mjs
// (walk-forward test on two years of hourly and nine years of daily gold
// data; README has the numbers). For M5 to H4, centring on the densest swing,
// using 5-candle swings and favouring recent swings marked more of the later
// turning points; on D1 and W1 the original settings did better.

import { atr, median } from './indicators.js';

// lookback      candles used
// tolAtr        swings this close (x ATR) are grouped into one zone
// kMinor        a swing must stand out from k candles on each side
// recency       how fast older swings lose weight (share of the lookback)
// center        'seed' = the densest swing price, 'mean' = weighted average
// halfWidthAtr  half the drawn zone width, x ATR
const INTRADAY = { kMinor: 5, recency: 0.3, center: 'seed', halfWidthAtr: 0.1 };
export const SR_PARAMS = {
  M5: { lookback: 576, tolAtr: 0.7, ...INTRADAY },
  M15: { lookback: 480, tolAtr: 0.6, ...INTRADAY },
  M30: { lookback: 480, tolAtr: 0.5, ...INTRADAY },
  H1: { lookback: 480, tolAtr: 0.45, ...INTRADAY },
  H4: { lookback: 360, tolAtr: 0.4, ...INTRADAY },
  D1: { lookback: 300, tolAtr: 0.3, kMinor: 3, recency: 0.6, center: 'mean', halfWidthAtr: 0.05 },
  W1: { lookback: 156, tolAtr: 0.25, kMinor: 3, recency: 0.6, center: 'mean', halfWidthAtr: 0.03 },
};

const K_MINOR = 3;
const K_MAJOR = 10;
const MAJOR_WEIGHT = 2.5;
const MAX_ZONES = 14;
const MIN_RATIO = 0.1;

// A swing is judged on 2k+1 consecutive candles. If data is missing anywhere
// in that window (a feed hole, or a period the history starts partway into),
// the candles are not really neighbours and the swing is not counted.
export function findSwings(c, k) {
  const out = [];
  const bad = new Array(c.length + 1);
  bad[0] = 0;
  for (let i = 0; i < c.length; i++) bad[i + 1] = bad[i] + (c[i].gap || c[i].partial ? 1 : 0);
  for (let i = k; i < c.length - k; i++) {
    if (bad[i + k + 1] - bad[i - k] > 0) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k && (isHigh || isLow); j++) {
      if (c[i - j].h >= c[i].h || c[i + j].h > c[i].h) isHigh = false;
      if (c[i - j].l <= c[i].l || c[i + j].l < c[i].l) isLow = false;
    }
    if (isHigh) out.push({ i, t: c[i].t, price: c[i].h, kind: 'H' });
    if (isLow) out.push({ i, t: c[i].t, price: c[i].l, kind: 'L' });
  }
  return out;
}

// Greedy density clustering shared by per-timeframe zones and cross-timeframe
// confluence. Points are {price, w, ...}. Returns clusters sorted by score.
export function clusterByPrice(points, tol, maxClusters = 50) {
  let rest = points.slice();
  const clusters = [];
  while (rest.length && clusters.length < maxClusters) {
    let best = null;
    let bestScore = -1;
    for (const p of rest) {
      let s = 0;
      for (const q of rest) {
        const d = Math.abs(q.price - p.price);
        if (d <= tol) s += q.w * (1 - d / tol);
      }
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    const members = [];
    const next = [];
    for (const q of rest) (Math.abs(q.price - best.price) <= tol ? members : next).push(q);
    rest = next;
    let wSum = 0;
    let pSum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of members) {
      wSum += m.w;
      pSum += m.w * m.price;
      if (m.price < lo) lo = m.price;
      if (m.price > hi) hi = m.price;
    }
    // Clamp: the weighted mean can land a rounding error outside [lo, hi].
    const price = Math.min(hi, Math.max(lo, pSum / wSum));
    // `seed` is the densest point the cluster was grown from.
    clusters.push({ price, seed: best.price, lo, hi, score: wSum, members });
  }
  return clusters;
}

// How far price moved away from a swing over the next 2k candles, in ATR.
function reactionMove(c, s, k, atrValue) {
  const end = Math.min(c.length - 1, s.i + 2 * k);
  let move = 0;
  for (let j = s.i + 1; j <= end; j++) {
    const d = s.kind === 'H' ? s.price - c[j].l : c[j].h - s.price;
    if (d > move) move = d;
  }
  return move / atrValue;
}

function reactionWeight(move) {
  return Math.sqrt(Math.min(3, Math.max(0.5, move)));
}

function countCrossings(c, fromIndex, price, band) {
  let state = 0;
  let crossings = 0;
  for (let i = fromIndex; i < c.length; i++) {
    const close = c[i].c;
    const s = close > price + band ? 1 : close < price - band ? -1 : 0;
    if (s !== 0 && s !== state) {
      if (state !== 0) crossings++;
      state = s;
    }
  }
  return crossings;
}

// Settings shared by every timeframe. `options` in computeZones() overrides
// any of these or of SR_PARAMS, so tools/sr-backtest.mjs can compare variants
// with the same code the app runs.
export const ZONE_DEFAULTS = {
  tolScale: 1, // multiplies tolAtr
  width: 'core', // 'core' = centre +- halfWidthAtr, 'range' = full spread of the swings
  maxZones: MAX_ZONES,
  minRatio: MIN_RATIO,
  minMove: 0, // drop swings that price did not turn away from by this much (ATR)
  crossPenalty: 0.3, // score divisor per extra close back and forth through the zone
  flipBonus: 1.2, // score multiplier when the zone was both support and resistance
};

// The engine as it was in version 1.1, for comparison.
export const ZONES_V1 = { kMinor: K_MINOR, recency: 0.6, center: 'mean', width: 'range' };

export function computeZones(candles, tf, options) {
  const p = SR_PARAMS[tf] || SR_PARAMS.H1;
  const o = { ...ZONE_DEFAULTS, ...p, ...options };
  if (!candles || candles.length < 40) return [];
  const c = candles.slice(Math.max(0, candles.length - p.lookback));
  const n = c.length;
  const atrSeries = atr(c, 14);
  const atrValue = median(atrSeries.slice(-60));
  if (!atrValue) return [];
  const tol = p.tolAtr * o.tolScale * atrValue;

  const major = new Set(findSwings(c, K_MAJOR).map((s) => s.kind + s.i));
  const points = [];
  for (const s of findSwings(c, o.kMinor)) {
    const move = reactionMove(c, s, o.kMinor, atrValue);
    if (move < o.minMove) continue;
    const isMajor = major.has(s.kind + s.i);
    const recency = Math.exp(-(n - 1 - s.i) / (n * o.recency));
    const w = (isMajor ? MAJOR_WEIGHT : 1) * recency * reactionWeight(move);
    points.push({ ...s, major: isMajor, w });
  }
  if (!points.length) return [];

  const zones = clusterByPrice(points, tol, o.maxZones * 2).map((cl) => {
    const centre = o.center === 'seed' ? cl.seed : cl.price;
    let lo = cl.lo;
    let hi = cl.hi;
    if (o.width === 'core') {
      // A narrow band around the centre instead of the full spread of the
      // member swings; never wider than that spread allows.
      const half = o.halfWidthAtr * atrValue;
      lo = Math.max(cl.lo, centre - half);
      hi = Math.min(cl.hi, centre + half);
    }
    const highs = cl.members.filter((m) => m.kind === 'H').length;
    const lows = cl.members.length - highs;
    const firstI = Math.min(...cl.members.map((m) => m.i));
    const lastT = Math.max(...cl.members.map((m) => m.t));
    const crossings = countCrossings(c, firstI, centre, tol / 2);
    let score = cl.score;
    if (highs && lows) score *= o.flipBonus;
    score /= 1 + o.crossPenalty * Math.max(0, crossings - 1);
    return {
      tf,
      price: centre,
      lo,
      hi,
      touches: cl.members.length,
      highs,
      lows,
      majors: cl.members.filter((m) => m.major).length,
      crossings,
      lastT,
      score,
    };
  });

  const max = Math.max(...zones.map((z) => z.score));
  return zones
    .map((z) => ({ ...z, ratio: z.score / max, strength: strengthOf(z.score / max) }))
    .filter((z) => z.ratio >= o.minRatio)
    .sort((a, b) => b.score - a.score)
    .slice(0, o.maxZones)
    .sort((a, b) => b.price - a.price);
}

export function strengthOf(ratio) {
  if (ratio >= 0.7) return 5;
  if (ratio >= 0.45) return 4;
  if (ratio >= 0.27) return 3;
  if (ratio >= 0.15) return 2;
  return 1;
}

// Which side of price a zone is on right now.
export function roleOf(zone, price) {
  if (price > zone.hi) return 'support';
  if (price < zone.lo) return 'resistance';
  return 'inside';
}

export function distanceTo(zone, price) {
  if (price > zone.hi) return zone.hi - price;
  if (price < zone.lo) return zone.lo - price;
  return 0;
}
