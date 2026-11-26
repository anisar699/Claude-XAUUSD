// Market structure on one timeframe, from closed candles:
//   - the last two swing highs and lows: higher high (HH), lower high (LH)
//     or equal high (EH, within 0.05 ATR), the same for lows (HL, LL, EL),
//     and the trend they make;
//   - the latest break of structure (BOS): a candle close beyond the most
//     recent confirmed swing high or low. A break against the direction of
//     the one before it is a change of character (CHoCH).
// Swings are the same k-candle swings the zones use, so a hole in the data
// never makes one.

import { findSwings } from './sr.js';
import { atr, median } from './indicators.js';

export const STRUCTURE_K = 3;
// Two swing highs (or lows) closer than this share of ATR are equal (EH / EL).
export const EQUAL_ATR = 0.05;

export function marketStructure(candles, k = STRUCTURE_K) {
  if (!candles || candles.length < 4 * k + 2) return null;
  const swings = findSwings(candles, k);
  const highs = swings.filter((s) => s.kind === 'H');
  const lows = swings.filter((s) => s.kind === 'L');
  if (highs.length < 2 || lows.length < 2) return null;
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const tol = EQUAL_ATR * (median(atr(candles, 14).slice(-60)) || 0);
  const cmp = (a, b) => (a - b > tol ? 1 : b - a > tol ? -1 : 0);
  const hc = cmp(h2.price, h1.price);
  const lc = cmp(l2.price, l1.price);
  const high = hc > 0 ? 'HH' : hc < 0 ? 'LH' : 'EH';
  const low = lc > 0 ? 'HL' : lc < 0 ? 'LL' : 'EL';
  // Up: higher highs and higher lows (one of them may be equal); down the
  // mirror; anything else (both equal, or expanding / contracting) is a range.
  const trend = hc >= 0 && lc >= 0 && hc + lc > 0 ? 'up' : hc <= 0 && lc <= 0 && hc + lc < 0 ? 'down' : 'range';

  // Walk forward. A swing counts from the candle that confirms it (k later).
  // Each swing can be broken once.
  let lastHigh = null;
  let lastLow = null;
  let hi = 0;
  let lo = 0;
  let bos = null;
  let prevDir = null;
  for (let i = 0; i < candles.length; i++) {
    while (hi < highs.length && highs[hi].i + k <= i) lastHigh = { ...highs[hi++], broken: false };
    while (lo < lows.length && lows[lo].i + k <= i) lastLow = { ...lows[lo++], broken: false };
    const c = candles[i].c;
    let dir = null;
    let level = null;
    if (lastHigh && !lastHigh.broken && c > lastHigh.price) {
      dir = 'up';
      level = lastHigh.price;
      lastHigh.broken = true;
    } else if (lastLow && !lastLow.broken && c < lastLow.price) {
      dir = 'down';
      level = lastLow.price;
      lastLow.broken = true;
    }
    if (dir) {
      bos = { dir, level, t: candles[i].t, close: c, choch: prevDir != null && prevDir !== dir };
      prevDir = dir;
    }
  }
  return {
    trend,
    high,
    low,
    lastHigh: { price: h2.price, t: h2.t },
    lastLow: { price: l2.price, t: l2.t },
    bos,
  };
}
