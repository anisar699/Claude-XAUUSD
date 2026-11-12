// Classic floor pivots and previous-period highs and lows.

import { bucketEnd } from './time.js';

export function classicPivots(h, l, c) {
  const pp = (h + l + c) / 3;
  return {
    R3: h + 2 * (pp - l),
    R2: pp + (h - l),
    R1: 2 * pp - l,
    PP: pp,
    S1: 2 * pp - h,
    S2: pp - (h - l),
    S3: l - 2 * (h - pp),
  };
}

// The most recent candle whose period has fully ended, and the one still
// forming (null when the latest candle is already complete, e.g. at weekends).
export function splitCurrent(series, tf, now) {
  if (!series || !series.length) return { prev: null, current: null };
  const last = series[series.length - 1];
  if (now >= bucketEnd(tf, last.t)) return { prev: last, current: null };
  return { prev: series.length > 1 ? series[series.length - 2] : null, current: last };
}

const PERIODS = [
  { id: 'D', tf: 'D1', name: 'Daily', short: 'D' },
  { id: 'W', tf: 'W1', name: 'Weekly', short: 'W' },
  { id: 'M', tf: 'MN', name: 'Monthly', short: 'M' },
];

export function keyLevels(seriesByTf, now) {
  const out = {};
  for (const p of PERIODS) {
    const { prev, current } = splitCurrent(seriesByTf[p.tf], p.tf, now);
    out[p.id] = {
      name: p.name,
      short: p.short,
      prev,
      current,
      pivots: prev ? classicPivots(prev.h, prev.l, prev.c) : null,
    };
  }
  return out;
}
