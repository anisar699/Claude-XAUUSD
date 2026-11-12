// Support / resistance zones from swing highs and lows.
//
// 1. Find swing points (a high or low that stands out from the k candles on
//    each side). Swings that also stand out over a wider window count more.
// 2. Weight each swing by how recent it is and how hard price turned there.
// 3. Group swings that sit within a tolerance (a fraction of ATR) of each
//    other: the densest group becomes a zone, its swings are removed, repeat.
// 4. Discount zones that price has since chopped back and forth through.

import { atr, median } from './indicators.js';

export const SR_PARAMS = {
  M5: { lookback: 576, tolAtr: 0.7 },
  M15: { lookback: 480, tolAtr: 0.6 },
  M30: { lookback: 480, tolAtr: 0.5 },
  H1: { lookback: 480, tolAtr: 0.45 },
  H4: { lookback: 360, tolAtr: 0.4 },
  D1: { lookback: 300, tolAtr: 0.3 },
  W1: { lookback: 156, tolAtr: 0.25 },
};

const K_MINOR = 3;
const K_MAJOR = 10;
const MAJOR_WEIGHT = 2.5;
const MAX_ZONES = 14;
const MIN_RATIO = 0.1;

export function findSwings(c, k) {
  const out = [];
  for (let i = k; i < c.length - k; i++) {
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
    clusters.push({ price, lo, hi, score: wSum, members });
  }
  return clusters;
}

function reactionWeight(c, s, k, atrValue) {
  const end = Math.min(c.length - 1, s.i + 2 * k);
  let move = 0;
  for (let j = s.i + 1; j <= end; j++) {
    const d = s.kind === 'H' ? s.price - c[j].l : c[j].h - s.price;
    if (d > move) move = d;
  }
  const r = Math.min(3, Math.max(0.5, move / atrValue));
  return Math.sqrt(r);
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

export function computeZones(candles, tf) {
  const p = SR_PARAMS[tf] || SR_PARAMS.H1;
  if (!candles || candles.length < 40) return [];
  const c = candles.slice(Math.max(0, candles.length - p.lookback));
  const n = c.length;
  const atrSeries = atr(c, 14);
  const atrValue = median(atrSeries.slice(-60));
  if (!atrValue) return [];
  const tol = p.tolAtr * atrValue;

  const major = new Set(findSwings(c, K_MAJOR).map((s) => s.kind + s.i));
  const points = findSwings(c, K_MINOR).map((s) => {
    const isMajor = major.has(s.kind + s.i);
    const recency = Math.exp(-(n - 1 - s.i) / (n * 0.6));
    const w = (isMajor ? MAJOR_WEIGHT : 1) * recency * reactionWeight(c, s, K_MINOR, atrValue);
    return { ...s, major: isMajor, w };
  });
  if (!points.length) return [];

  const zones = clusterByPrice(points, tol, MAX_ZONES * 2).map((cl) => {
    const highs = cl.members.filter((m) => m.kind === 'H').length;
    const lows = cl.members.length - highs;
    const firstI = Math.min(...cl.members.map((m) => m.i));
    const lastT = Math.max(...cl.members.map((m) => m.t));
    const crossings = countCrossings(c, firstI, cl.price, tol / 2);
    let score = cl.score;
    if (highs && lows) score *= 1.2;
    score /= 1 + 0.3 * Math.max(0, crossings - 1);
    return {
      tf,
      price: cl.price,
      lo: cl.lo,
      hi: cl.hi,
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
    .filter((z) => z.ratio >= MIN_RATIO)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ZONES)
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
