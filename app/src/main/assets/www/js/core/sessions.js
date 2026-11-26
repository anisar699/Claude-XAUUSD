// Trading sessions: where each one is, its high and low, and its opening
// range. Hours are local to each centre and follow its daylight saving:
//   Asia      Tokyo 09:00-18:00 (no daylight saving; 00:00-09:00 UTC)
//   London    08:00-17:00 London time
//   New York  08:00-17:00 New York time
// Pure: candles in, numbers out.

import { nyOffsetSec } from './time.js';

const HOUR = 3600;
const DAY = 86400;

// UK summer time: last Sunday of March 01:00 UTC to last Sunday of October 01:00 UTC.
function lastSundayUtc(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay()) / 1000;
}

export function londonOffsetSec(t) {
  const y = new Date(t * 1000).getUTCFullYear();
  const start = lastSundayUtc(y, 2) + HOUR;
  const end = lastSundayUtc(y, 9) + HOUR;
  return t >= start && t < end ? HOUR : 0;
}

const OFFSET = {
  tokyo: () => 9 * HOUR,
  london: londonOffsetSec,
  ny: nyOffsetSec,
};

export const SESSIONS = [
  { id: 'asia', name: 'Asia', short: 'ASIA', tz: 'tokyo', open: 9, close: 18 },
  { id: 'london', name: 'London', short: 'LDN', tz: 'london', open: 8, close: 17 },
  { id: 'ny', name: 'New York', short: 'NY', tz: 'ny', open: 8, close: 17 },
];

// Minutes at the start of a session that make its opening range.
export const OPENING_RANGE_MIN = 30;

// The session's window on the local calendar day that contains UTC time `t`
// (local midnight-based), as UTC [start, end).
function windowOnLocalDay(s, t) {
  const off = OFFSET[s.tz](t);
  const localDay = Math.floor((t + off) / DAY) * DAY;
  // The offset at the session's own open, not at `t` (a clock change can
  // fall in between).
  const startGuess = localDay + s.open * HOUR - off;
  const offOpen = OFFSET[s.tz](startGuess);
  const start = localDay + s.open * HOUR - offOpen;
  return { start, end: start + (s.close - s.open) * HOUR, localDow: new Date(localDay * 1000).getUTCDay() };
}

// The session's latest window that has started by `t`, skipping local
// weekends. { start, end, active }.
export function latestWindow(s, t) {
  for (let back = 0; back < 8; back++) {
    const w = windowOnLocalDay(s, t - back * DAY);
    if (w.localDow === 0 || w.localDow === 6) continue;
    if (w.start <= t) return { start: w.start, end: w.end, active: t < w.end };
  }
  return null;
}

// The next window that starts after `t`.
export function nextWindow(s, t) {
  for (let ahead = 0; ahead < 8; ahead++) {
    const w = windowOnLocalDay(s, t + ahead * DAY);
    if (w.localDow === 0 || w.localDow === 6) continue;
    if (w.start > t) return { start: w.start, end: w.end };
  }
  return null;
}

function rangeOf(candles, from, to) {
  let h = -Infinity;
  let l = Infinity;
  let n = 0;
  for (const c of candles) {
    if (c.t < from || c.t >= to) continue;
    if (c.h > h) h = c.h;
    if (c.l < l) l = c.l;
    n++;
  }
  return n ? { h, l, n } : null;
}

// Every session's latest window with its high, low and opening range.
// `seriesList` holds candle series finest first (for example M1, M5, M15);
// each session uses the finest one that reaches back to its start, so a
// Monday morning still gets Friday's New York session from 5-minute candles.
// `covered` is false when none does and the numbers are partial. Also the
// sessions active at `t`.
export function sessionStats(seriesList, t) {
  const list = (Array.isArray(seriesList[0]) || !seriesList.length ? seriesList : [seriesList]).filter((x) => x && x.length);
  const out = SESSIONS.map((s) => {
    const w = latestWindow(s, t);
    if (!w) return { ...s, window: null };
    const candles = list.find((x) => x[0].t <= w.start) || list[list.length - 1] || [];
    const to = Math.min(w.end, t);
    const range = rangeOf(candles, w.start, to);
    const opening = t >= w.start + OPENING_RANGE_MIN * 60 ? rangeOf(candles, w.start, w.start + OPENING_RANGE_MIN * 60) : null;
    return {
      ...s,
      window: w,
      next: w.active ? null : nextWindow(s, t),
      high: range ? range.h : null,
      low: range ? range.l : null,
      covered: !!candles.length && candles[0].t <= w.start,
      opening: opening ? { high: opening.h, low: opening.l } : null,
    };
  });
  const active = out.filter((s) => s.window && s.window.active).map((s) => s.name);
  return { sessions: out, active, overlap: active.length > 1 };
}
