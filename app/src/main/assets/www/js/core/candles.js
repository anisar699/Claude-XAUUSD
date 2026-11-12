// Candle series helpers. A candle is {t, o, h, l, c, v} with t in UTC epoch
// seconds; every series is sorted ascending by t.

import { bucketOf, utcDayRepresentative } from './time.js';

export function aggregate(candles, bucketFn) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = bucketFn(c.t);
    if (!cur || cur.t !== b) {
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
      out.push(cur);
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v || 0;
    }
  }
  return out;
}

export function aggregateTf(candles, tf) {
  return aggregate(candles, (t) => bucketOf(tf, t));
}

// Merge two ascending series; on equal timestamps `b` wins.
export function mergeSeries(a, b) {
  if (!a || !a.length) return b ? b.slice() : [];
  if (!b || !b.length) return a.slice();
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].t < b[j].t)) out.push(a[i++]);
    else if (i >= a.length || b[j].t < a[i].t) out.push(b[j++]);
    else {
      out.push(b[j++]);
      i++;
    }
  }
  return out;
}

// Extend a timeframe series with finer candles that are at or after its last
// bucket. This is how the in-progress candle gets built: the feed returns
// completed candles, the finer series fills in the rest.
export function extendWith(series, finer, tf) {
  if (!finer || !finer.length) return series ? series.slice() : [];
  if (!series || !series.length) return aggregateTf(finer, tf);
  const out = series.slice(0, -1);
  const last = { ...series[series.length - 1] };
  out.push(last);
  let cur = last;
  for (const f of finer) {
    const b = bucketOf(tf, f.t);
    if (b < last.t) continue;
    if (b === cur.t) {
      if (f.h > cur.h) cur.h = f.h;
      if (f.l < cur.l) cur.l = f.l;
      cur.c = f.c;
    } else if (b > cur.t) {
      cur = { t: b, o: f.o, h: f.h, l: f.l, c: f.c, v: f.v || 0 };
      out.push(cur);
    }
  }
  return out;
}

// Turn UTC-midnight daily candles into New-York-close daily candles as well as
// that feed allows (the Sunday stub is folded into Monday). Used only for
// history older than what the hourly series covers.
export function utcDaysToServerDays(utcDays) {
  return aggregate(
    utcDays.map((c) => ({ ...c, t: utcDayRepresentative(c.t) })),
    (t) => bucketOf('D1', t),
  );
}

// Exact days built from hourly candles replace the approximate older ones from
// the point where hourly coverage is complete.
export function stitchDays(olderDays, exactDays) {
  if (!exactDays.length) return olderDays.slice();
  // The first hourly-derived day may be cut off at the start of the history.
  const exact = exactDays.length > 1 ? exactDays.slice(1) : exactDays;
  const from = exact[0].t;
  return olderDays.filter((c) => c.t < from).concat(exact);
}

export function trimTo(series, max) {
  return series.length > max ? series.slice(series.length - max) : series;
}
