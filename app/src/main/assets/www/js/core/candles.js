// Candle series helpers. A candle is {t, o, h, l, c, v} with t in UTC epoch
// seconds; every series is sorted ascending by t.
//
// Flags a candle may carry (all optional, absent = false):
//   gap      data the market traded is missing just before or inside it
//            (a hole in the feed, not a weekend, daily break or holiday)
//   partial  the history starts partway into its period, so its open, high
//            and low may be wrong
//   approx   rebuilt from a UTC-midnight daily candle, so its New York-close
//            boundaries are approximate
//   asOf     the last candle of a fetch: when it was fetched (see extendWith)

import { bucketEnd, bucketOf, firstOpenSlot, unexpectedGap, utcDayRepresentative } from './time.js';

// Copy of a feed series with `gap` set on each candle that follows a hole.
// `step` is the feed's candle length in seconds; holes shorter than
// `minMissing` seconds are ignored (a minute or two of minute candles barely
// changes an hour's high and low).
export function markGaps(series, step, minMissing = step) {
  const out = new Array(series.length);
  for (let i = 0; i < series.length; i++) {
    const c = series[i];
    const gap = i > 0 && c.t - series[i - 1].t - step >= minMissing && unexpectedGap(series[i - 1].t, c.t, step);
    out[i] = gap || c.gap ? { ...c, gap: true } : c;
  }
  return out;
}

// Group candles into buckets. Flags carry over: a bucket built from a candle
// with a gap or an approximate day has the same flag. With `step` (the input
// candle length) and `tf`, the first bucket is marked partial when the input
// starts after that bucket's first trading moment.
export function aggregate(candles, bucketFn, step, tf) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = bucketFn(c.t);
    if (!cur || cur.t !== b) {
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
      if (c.gap) cur.gap = true;
      if (c.approx) cur.approx = true;
      if (c.partial) cur.partial = true;
      out.push(cur);
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v || 0;
      if (c.gap) cur.gap = true;
      if (c.approx) cur.approx = true;
    }
  }
  if (out.length && step && tf) {
    const first = out[0];
    const open = firstOpenSlot(first.t, step, bucketEnd(tf, first.t));
    if (open != null && candles[0].t > open) first.partial = true;
  }
  return out;
}

export function aggregateTf(candles, tf, step) {
  return aggregate(candles, (t) => bucketOf(tf, t), step, tf);
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
//
// The series' last candle may carry `asOf`: the time it was fetched. A finer
// candle in the same bucket only moves its close when it ends after that
// moment; without `asOf` the candle counts as complete. Highs and lows are
// always merged (any traded price inside the bucket is real).
export function extendWith(series, finer, tf, finerSec = 60) {
  if (!finer || !finer.length) return series ? series.slice() : [];
  if (!series || !series.length) return aggregateTf(finer, tf, finerSec);
  // The finer candles must reach back to the end of the series. If they start
  // later (for example an old saved series next to fresh minute candles),
  // the candles in between are unknown and new ones built here would have the
  // wrong open, high and low.
  if (finer[0].t > bucketEnd(tf, series[series.length - 1].t)) return series.slice();
  const out = series.slice(0, -1);
  const last = { ...series[series.length - 1] };
  out.push(last);
  const knownTo = last.asOf != null ? last.asOf : bucketEnd(tf, last.t);
  let cur = last;
  for (const f of finer) {
    const b = bucketOf(tf, f.t);
    if (b < last.t) continue;
    if (b === cur.t) {
      if (f.h > cur.h) cur.h = f.h;
      if (f.l < cur.l) cur.l = f.l;
      if (cur !== last || f.t + finerSec > knownTo) cur.c = f.c;
      // A hole in the finer candles inside this bucket. For the feed's own
      // last candle only a hole after what the feed already covered counts.
      if (f.gap && (cur !== last || f.t >= knownTo)) cur.gap = true;
    } else if (b > cur.t) {
      cur = { t: b, o: f.o, h: f.h, l: f.l, c: f.c, v: f.v || 0 };
      if (f.gap) cur.gap = true;
      out.push(cur);
    }
  }
  return out;
}

// Turn UTC-midnight daily candles into New-York-close daily candles as well as
// that feed allows (the Sunday stub is folded into Monday). Used only for
// history older than what the hourly series covers.
//
// Relabelling a UTC day cannot recover the real New York-close high, low and
// close, so these days are marked `approx`.
export function utcDaysToServerDays(utcDays) {
  return aggregate(
    utcDays.map((c) => ({ ...c, t: utcDayRepresentative(c.t), approx: true })),
    (t) => bucketOf('D1', t),
  );
}

// Exact days built from hourly candles replace the approximate older ones from
// the first day the hourly history fully covers. A day the hourly history
// starts partway into is dropped; if no hourly day is complete yet (a cold
// start with an hour or two of data), the approximate days stay as they are.
export function stitchDays(olderDays, exactDays) {
  const start = exactDays.findIndex((d) => !d.partial);
  if (start < 0) return olderDays.slice();
  const exact = exactDays.slice(start);
  const from = exact[0].t;
  return olderDays.filter((c) => c.t < from).concat(exact);
}

export function trimTo(series, max) {
  return series.length > max ? series.slice(series.length - max) : series;
}
