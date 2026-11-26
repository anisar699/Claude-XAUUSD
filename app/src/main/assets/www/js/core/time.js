// Time helpers. All timestamps are UTC epoch seconds unless noted.
//
// Most MT4/MT5 brokers run "New York close" charts: server time is New York
// time + 7h, so the daily candle rolls at 17:00 New York and there is no
// Sunday candle. H4/D1/W1/MN buckets here follow that convention by default
// so candles and levels line up with a broker chart. Brokers whose server
// runs on UTC (GMT+0, for example Exness) roll the day at 00:00 UTC: pick
// that with setServerTime('utc'). Their short Sunday-evening session is
// folded into Monday, as the New York close convention does.

const HOUR = 3600;
const DAY = 86400;

function nthSundayUtcSec(year, month, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return Date.UTC(year, month, firstSunday + 7 * (n - 1)) / 1000;
}

// US daylight saving: second Sunday of March 02:00 EST to first Sunday of
// November 02:00 EDT.
export function nyOffsetSec(t) {
  const year = new Date(t * 1000).getUTCFullYear();
  const start = nthSundayUtcSec(year, 2, 2) + 7 * HOUR;
  const end = nthSundayUtcSec(year, 10, 1) + 6 * HOUR;
  return t >= start && t < end ? -4 * HOUR : -5 * HOUR;
}

// 'ny': day rolls at 17:00 New York (server = New York + 7h).
// 'utc': day rolls at 00:00 UTC (server = UTC).
let SERVER_MODE = 'ny';

export function setServerTime(mode) {
  SERVER_MODE = mode === 'utc' ? 'utc' : 'ny';
}

export function serverTimeMode() {
  return SERVER_MODE;
}

export function serverOffsetSec(t) {
  return SERVER_MODE === 'utc' ? 0 : nyOffsetSec(t) + 7 * HOUR;
}

export const TF = {
  M1: { key: 'M1', sec: 60, label: '1m' },
  M5: { key: 'M5', sec: 300, label: '5m' },
  M15: { key: 'M15', sec: 900, label: '15m' },
  M30: { key: 'M30', sec: 1800, label: '30m' },
  H1: { key: 'H1', sec: 3600, label: '1h' },
  H4: { key: 'H4', sec: 14400, label: '4h' },
  D1: { key: 'D1', sec: 86400, label: 'Daily' },
  W1: { key: 'W1', sec: 604800, label: 'Weekly' },
  MN: { key: 'MN', sec: 2592000, label: 'Monthly' },
};

export const ANALYSIS_TFS = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

function fixedBucket(sec) {
  return (t) => Math.floor(t / sec) * sec;
}

function h4Bucket(t) {
  const off = serverOffsetSec(t);
  return Math.floor((t + off) / (4 * HOUR)) * 4 * HOUR - off;
}

// On a UTC server the market opens on Sunday evening; that stub belongs to
// Monday's day and week, as it does on a New York close server.
function sundayFold(days) {
  return SERVER_MODE === 'utc' && (days + 4) % 7 === 0 ? days + 1 : days;
}

function dayBucket(t) {
  const off = serverOffsetSec(t);
  return sundayFold(Math.floor((t + off) / DAY)) * DAY - off;
}

function weekBucket(t) {
  const off = serverOffsetSec(t);
  const days = sundayFold(Math.floor((t + off) / DAY));
  const dow = (days + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  const monday = days - ((dow + 6) % 7);
  return monday * DAY - off;
}

// Server-clock midnight on the 1st, as a UTC instant. The offset is the one in
// force at that midnight, not at `t`, so a month that contains a daylight
// saving switch still maps to a single bucket.
function serverMonthStart(year, month) {
  const wall = Date.UTC(year, month, 1) / 1000;
  return wall - serverOffsetSec(wall - 3 * HOUR);
}

function monthBucket(t) {
  const d = new Date((t + serverOffsetSec(t)) * 1000);
  return serverMonthStart(d.getUTCFullYear(), d.getUTCMonth());
}

const BUCKETS = {
  M1: fixedBucket(60),
  M5: fixedBucket(300),
  M15: fixedBucket(900),
  M30: fixedBucket(1800),
  H1: fixedBucket(3600),
  H4: h4Bucket,
  D1: dayBucket,
  W1: weekBucket,
  MN: monthBucket,
};

export function bucketOf(tf, t) {
  return BUCKETS[tf](t);
}

// End (exclusive) of the bucket that starts at `start`.
export function bucketEnd(tf, start) {
  if (tf === 'MN') {
    const d = new Date((start + serverOffsetSec(start)) * 1000);
    return serverMonthStart(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
  if (tf === 'H4' || tf === 'D1' || tf === 'W1') {
    // The server clock follows New York daylight saving, so a bucket can be
    // an hour shorter or longer than nominal in UTC.
    return BUCKETS[tf](start + TF[tf].sec + 2 * HOUR);
  }
  return start + TF[tf].sec;
}

// A daily candle from a UTC-midnight feed covers [t, t+24h) UTC. Pick the
// moment inside it that decides which New-York-close day it belongs to:
// the Sunday stub (the first hour or two of the week) belongs to Monday.
export function utcDayRepresentative(t) {
  const dow = new Date(t * 1000).getUTCDay();
  return t + (dow === 0 ? 23 : 12) * HOUR;
}

// Spot gold trades Sunday 18:00 to Friday 17:00 New York time, with a daily
// break from 17:00 to 18:00.
export function marketStatus(t) {
  const ny = t + nyOffsetSec(t);
  const d = new Date(ny * 1000);
  const dow = d.getUTCDay();
  const secOfDay = d.getUTCHours() * HOUR + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  const dayStart = ny - secOfDay;
  const open18 = 18 * HOUR;
  const close17 = 17 * HOUR;

  let open;
  let nextNy;
  if (dow === 6) {
    open = false;
    nextNy = dayStart + DAY + open18;
  } else if (dow === 0) {
    open = secOfDay >= open18;
    nextNy = open ? dayStart + DAY + close17 : dayStart + open18;
  } else if (dow === 5) {
    open = secOfDay < close17;
    nextNy = open ? dayStart + close17 : dayStart + 2 * DAY + open18;
  } else {
    open = secOfDay < close17 || secOfDay >= open18;
    if (secOfDay < close17) nextNy = dayStart + close17;
    else if (secOfDay < open18) nextNy = dayStart + open18;
    else nextNy = dayStart + DAY + close17;
  }
  // Convert the New York wall-clock moment back to UTC with the offset in
  // force at that moment (a daylight-saving switch falls on a weekend).
  const guess = nextNy - nyOffsetSec(t);
  return { open, nextChange: nextNy - nyOffsetSec(guess) };
}

// A feed may open up to this late after a market closure (its session can
// start a little after ours) without that counting as missing data.
const LATE_OPEN_SEC = 3600;

// Is the stretch between two consecutive candles (starts `prevT` and `nextT`,
// each `step` seconds long) missing data the market actually traded?
//
// Expected gaps: the daily break, weekends, and holidays. Holidays are not in
// marketStatus, but they always end at a closure: the market closes early,
// or stays shut for the day, and reopens at the usual time. So a gap is
// expected when the market was closed shortly before `nextT`; open-market
// candles missing before that closure are an early close. A gap with no
// closure just before `nextT` is a hole in the feed.
export function unexpectedGap(prevT, nextT, step) {
  if (nextT - prevT <= step) return false;
  for (let s = nextT - step; s >= prevT + step; s -= step) {
    const m = marketStatus(s);
    if (!m.open) return nextT - m.nextChange > LATE_OPEN_SEC;
    if (nextT - s > LATE_OPEN_SEC + step) return true;
  }
  return true;
}

// The first moment at or after `t`, on a `step` grid, when the market is open.
// Used to tell whether a history starts partway into a candle period.
export function firstOpenSlot(t, step, until) {
  for (let s = t; s < until; s += step) if (marketStatus(s).open) return s;
  return null;
}
