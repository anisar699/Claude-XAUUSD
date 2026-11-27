// Level record: what price did at each level the app showed, kept from the
// day the app is installed, for a downloadable report (Settings, "Level
// record"). Pure: candles and areas in, rows out. Storage and the driver that
// feeds it from the app's data are in data/levelrec.js.
//
// Steps. Every closed 15-minute candle is one step:
//   1. every level being followed is scored on that candle;
//   2. the areas are worked out again from the candles closed by the end of
//      that candle (the caller does this, so a step run late, after the app
//      was closed, sees what the app would have shown at the time);
//   3. levels no longer shown are dropped and new ones are recorded.
//
// Which levels. An area is recorded the first time it is shown with price
// outside it and its near edge within 6 hourly ATR, built only from
// timeframes that were ready. It is followed while the app keeps showing an
// area there (overlapping it, or with its centre within the area tolerance).
// A level no longer shown before price reaches it is dropped ("removed").
// While it waits for price, its sources and strength follow what the app
// shows, so each test is reported with the level as it looked when price
// arrived; its position stays where it was recorded.
//
// Random twins. Each recorded level gets two random bands: same side of
// price, same width, near edge in the same 0.5 ATR distance band, and the
// level's sources for grouping. A twin waits only while its level is shown,
// and is scored by the same rules. Price turns at random lines too, so the
// report compares each kind of level with its own twins.
//
// Scoring, on 15-minute candles, in hourly ATR (A) at the time the level was
// recorded. "Closes below" means by the break buffer the alerts use (0.1 A,
// at least $0.30), so a close a few cents through a narrow area is not a
// break. For a support (a resistance is the mirror image):
//   test        a candle trades into the area from above
//   held        price then reaches 1 A above the area before any candle
//               closes below it (on the test candle itself only its close
//               counts: its high may have come before its low)
//   broke       a candle closes below the area first
//   unresolved  neither within 96 candles (24 trading hours)
//   swept       during the test a wick went a buffer below the area and the
//               candle closed back above its bottom
//   move        how far price went above the area during the test (A)
//   against     how far it went below the area (A)
// After a hold the level waits for its next test. After a break it is
// followed until one of these, then closed:
//   reclaimed      a candle closes back above the area before price has gone
//                  0.5 A below it (a false break)
//   retest held    price went 0.5 A below, came back into the area, then
//                  reached 1 A below it before a candle closed above it
//                  (the support became resistance)
//   retest failed  after coming back, a candle closed above the area first
//   no retest      price went 0.5 A below and did not come back within 192
//                  candles (48 trading hours)
//   unresolved     none of these within 192 candles, or within 96 candles of
//                  the retest
// Counting candles, not clock time, leaves out weekends and the daily break.

import { sessionsAt } from './sessions.js';
import { unexpectedGap } from './time.js';

export const LEVEL_REC = {
  STEP: 900, // seconds: one step per closed 15-minute candle
  MAX_DIST_ATR: 6,
  HOLD_ATR: 1,
  BUFFER_ATR: 0.1, // a close this far beyond the area (at least $0.30) is a break, as in the alerts
  AWAY_ATR: 0.5,
  TEST_CANDLES: 96,
  BREAK_CANDLES: 192,
  WAIT_CANDLES: 960, // a level still waiting after 10 trading days is closed
  TWINS: 2,
  BIN_ATR: 0.5,
};
const C = LEVEL_REC;

export function createRecord(t) {
  const at = Math.floor(t / C.STEP) * C.STEP;
  return { v: 1, since: at, at, seq: 0, seed: (at % 2147483646) + 1, open: [], gaps: [], count: { levels: 0, tests: 0, breaks: 0 } };
}

// A deterministic random number in [0, 1) from the record's own seed.
function rnd(rec) {
  rec.seed = (rec.seed * 1664525 + 1013904223) % 4294967296;
  return rec.seed / 4294967296;
}

// One set of rules serves both sides: a resistance is scored as a support in
// negated prices. near = the edge price comes from, far = the other one.
function frame(L) {
  return L.side === 'S' ? { near: L.hi, far: L.lo } : { near: -L.lo, far: -L.hi };
}
function view(c, side) {
  return side === 'S' ? c : { t: c.t, o: -c.o, h: -c.l, l: -c.h, c: -c.c, gap: c.gap };
}

const r2 = (x) => Math.round(x * 100) / 100;
const buffer = (A) => Math.max(0.3, C.BUFFER_ATR * A);

function row(L, ev) {
  return {
    id: L.id,
    kind: L.kind,
    twin: L.twin || '',
    t0: L.t0,
    side: L.side,
    lo: L.lo + L.off,
    hi: L.hi + L.off,
    mid: L.mid + L.off,
    off: L.off,
    str: L.str,
    tfs: L.tfs.slice(),
    tags: L.tags.slice(),
    ref: L.ref,
    est: L.est,
    dist: L.dist,
    atr: L.atr,
    session: ev.at != null ? sessionsAt(ev.at).join(' + ') : '',
    ...ev,
  };
}

function testRow(L, result) {
  const e = L.ev;
  return row(L, {
    event: 'test',
    n: L.tests,
    at: e.at,
    result,
    swept: e.swept,
    move: r2(e.move),
    against: r2(e.against),
    mins: (e.k + 1) * 15,
    gap: e.gap,
  });
}

function breakRow(L, result) {
  const e = L.ev;
  return row(L, {
    event: 'after break',
    n: L.tests,
    at: e.at,
    result,
    swept: null,
    move: r2(e.move),
    against: r2(e.against),
    mins: e.k * 15,
    gap: e.gap,
  });
}

// Score one level on one candle. Returns true when the level is finished.
function step(L, raw, rows) {
  const { near, far } = frame(L);
  const c = view(raw, L.side);
  const A = L.atr;
  const B = buffer(A);

  if (L.phase === 'wait') {
    L.k++;
    if (c.l > near) {
      if (L.k < C.WAIT_CANDLES) return false;
      if (L.kind === 'real' && !L.tests) rows.push(row(L, { event: 'not reached', n: 0, at: null, result: 'expired' }));
      return true;
    }
    L.tests++;
    L.phase = 'test';
    L.ev = { at: raw.t, k: 0, swept: false, move: 0, against: 0, gap: !!raw.gap };
    return testCandle(L, c, raw, near, far, A, rows, true);
  }

  const e = L.ev;
  if (raw.gap) e.gap = true;

  if (L.phase === 'test') {
    e.k++;
    return testCandle(L, c, raw, near, far, A, rows, false);
  }

  // After a break: price is below the area (in the support frame).
  e.k++;
  e.move = Math.max(e.move, (far - c.l) / A);
  e.against = Math.max(e.against, (c.h - near) / A);
  const done = (result) => {
    rows.push(breakRow(L, result));
    return true;
  };

  if (L.phase === 'broken') {
    if (!e.armed) {
      if (c.c > near + B) return done('reclaimed');
      if (c.l <= far - C.AWAY_ATR * A) e.armed = true;
      else if (e.k >= C.BREAK_CANDLES) return done('unresolved');
      return false;
    }
    if (c.h >= far) {
      // Back in the area: the retest. On this candle only its close counts.
      L.phase = 'retest';
      e.rk = 0;
      if (c.c > near + B) return done('retest failed');
      if (c.c <= far - C.HOLD_ATR * A) return done('retest held');
      return false;
    }
    return e.k >= C.BREAK_CANDLES ? done('no retest') : false;
  }

  // retest: a low comes before the close, so the hold is checked first.
  e.rk++;
  if (c.l <= far - C.HOLD_ATR * A) return done('retest held');
  if (c.c > near + B) return done('retest failed');
  return e.rk >= C.TEST_CANDLES ? done('unresolved') : false;
}

function testCandle(L, c, raw, near, far, A, rows, first) {
  const e = L.ev;
  const up = first ? c.c : c.h;
  e.move = Math.max(e.move, (up - near) / A);
  e.against = Math.max(e.against, (far - c.l) / A);
  const B = buffer(A);
  if (c.l <= far - B && c.c >= far) e.swept = true;
  const endT = raw.t + C.STEP;
  if (up >= near + C.HOLD_ATR * A) {
    rows.push(testRow(L, 'held'));
    L.phase = 'wait';
    L.k = 0;
    L.ev = null;
    return false;
  }
  if (c.c < far - B) {
    rows.push(testRow(L, 'broke'));
    L.phase = 'broken';
    L.ev = { at: endT, k: 0, armed: false, move: (far - c.c) / A, against: 0, gap: false };
    return false;
  }
  if (e.k + 1 >= C.TEST_CANDLES) {
    rows.push(testRow(L, 'unresolved'));
    return true;
  }
  return false;
}

// Score every followed level on one closed 15-minute candle (feed prices).
export function advanceRecord(rec, candle) {
  const rows = [];
  rec.open = rec.open.filter((L) => !step(L, candle, rows));
  count(rec, rows);
  return rows;
}

function count(rec, rows) {
  for (const r of rows) {
    if (r.kind !== 'real') continue;
    if (r.event === 'test') rec.count.tests++;
    else if (r.event === 'after break') rec.count.breaks++;
  }
}

const PROPS = (z) => ({ str: z.strength, tags: z.tags.slice(), tfs: z.tfs.slice(), ref: !!z.reference, est: !!z.approx });

// The areas shown at time T (the analysis' areas, in the broker's prices
// made with `offset`): follow the levels still shown, drop the others while
// they wait, record new ones. price, atr, tol and ready are the analysis'
// lastPrice, atrH1, tol and ready.
export function snapshotRecord(rec, { T, areas, price, atr, tol, ready, offset = 0 }) {
  const rows = [];
  if (!(atr > 0) || !Number.isFinite(price)) return rows;
  const p = price - offset;
  const shown = areas.map((z) => ({ z, lo: z.lo - offset, hi: z.hi - offset, mid: z.price - offset }));
  const same = (L, a) => (a.lo <= L.hi && a.hi >= L.lo) || Math.abs(a.mid - L.mid) <= tol;
  const used = new Set();

  const reals = new Map();
  for (const L of rec.open) {
    if (L.kind !== 'real') continue;
    reals.set(L.id, L);
    let best = null;
    for (const a of shown) {
      if (!same(L, a)) continue;
      used.add(a);
      if (!best || Math.abs(a.mid - L.mid) < Math.abs(best.mid - L.mid)) best = a;
    }
    if (!best) continue;
    L.seen = T;
    if (L.phase === 'wait') Object.assign(L, PROPS(best.z));
  }

  rec.open = rec.open.filter((L) => {
    if (L.phase !== 'wait') return true;
    if (L.kind === 'real') {
      if (L.seen === T) return true;
      if (!L.tests) rows.push(row(L, { event: 'not reached', n: 0, at: null, result: 'removed' }));
      return false;
    }
    const real = reals.get(L.twin);
    if (!real || real.seen !== T) return false;
    Object.assign(L, { str: real.str, tags: real.tags.slice(), tfs: real.tfs.slice(), ref: real.ref, est: real.est });
    return true;
  });

  for (const a of shown) {
    if (used.has(a)) continue;
    const side = a.hi < p ? 'S' : a.lo > p ? 'R' : null;
    if (!side) continue;
    const dist = side === 'S' ? p - a.hi : a.lo - p;
    if (dist > C.MAX_DIST_ATR * atr) continue;
    if (!a.z.tfs.every((tf) => ready.includes(tf))) continue;
    if (rec.open.some((L) => L.kind === 'real' && same(L, a))) continue;
    const L = {
      id: `L${++rec.seq}`,
      kind: 'real',
      t0: T,
      side,
      lo: a.lo,
      hi: a.hi,
      mid: a.mid,
      off: offset,
      atr,
      dist: r2(dist / atr),
      ...PROPS(a.z),
      phase: 'wait',
      k: 0,
      tests: 0,
      seen: T,
    };
    rec.open.push(L);
    rec.count.levels++;
    const w = a.hi - a.lo;
    const band = Math.floor(dist / (C.BIN_ATR * atr));
    for (let i = 1; i <= C.TWINS; i++) {
      const d = (band + rnd(rec)) * C.BIN_ATR * atr;
      const lo = side === 'S' ? p - d - w : p + d;
      rec.open.push({ ...L, ...PROPS(a.z), id: `${L.id}r${i}`, kind: 'random', twin: L.id, lo, hi: lo + w, mid: lo + w / 2, dist: r2(d / atr) });
    }
  }
  return rows;
}

// Stop following everything: the data needed to score the next candles is
// missing (the app was closed for too long, or the feed has a hole). Tests
// and breaks in progress are reported as "data missing"; waiting levels are
// dropped (they are recorded again if still shown).
export function dropRecord(rec, from, to) {
  const rows = [];
  for (const L of rec.open) {
    if (L.phase === 'test') rows.push(testRow(L, 'data missing'));
    else if (L.phase === 'broken' || L.phase === 'retest') rows.push(breakRow(L, 'data missing'));
  }
  rec.open = [];
  const last = rec.gaps[rec.gaps.length - 1];
  if (last && last[1] >= from) last[1] = Math.max(last[1], to);
  else if (to > from) rec.gaps.push([from, to]);
  if (rec.gaps.length > 200) rec.gaps = rec.gaps.slice(-200);
  return rows;
}

// Bring the record up to date. candles: closed 15-minute candles in feed
// prices, known complete up to `knownTo`; analyseAt(T): the analysis from
// candles closed by T (or null); maxBehind: how far back a late step may go
// (older stretches are not recorded); stop(): true when this call has used
// its time. Returns the new rows and whether there is more to do.
export function runRecord(rec, { candles, knownTo, now, analyseAt, maxBehind = 7 * 86400, stop = () => false }) {
  const rows = [];
  const limit = Math.floor((now - maxBehind) / C.STEP) * C.STEP;
  if (rec.at < limit) {
    rows.push(...dropRecord(rec, rec.at, limit));
    rec.at = limit;
  }
  let i = lowerBound(candles, rec.at);
  if (i >= candles.length || candles[i].t + C.STEP > knownTo) return { rows, more: false };
  // Candles missing between the last step and the next candle: the market
  // traded, but the feed has nothing (or the history no longer reaches back).
  if (candles[i].t > rec.at && unexpectedGap(rec.at - C.STEP, candles[i].t, C.STEP)) {
    rows.push(...dropRecord(rec, rec.at, candles[i].t));
  }
  let more = false;
  for (let done = 0; i < candles.length; i++, done++) {
    const c = candles[i];
    const T = c.t + C.STEP;
    if (T > knownTo) break;
    if (done && stop()) {
      more = true;
      break;
    }
    rows.push(...advanceRecord(rec, c));
    const a = analyseAt(T);
    if (a) {
      rows.push(...snapshotRecord(rec, { T, areas: a.conf, price: a.lastPrice, atr: a.atrH1, tol: a.tol, ready: a.ready, offset: a.offset || 0 }));
    }
    rec.at = T;
  }
  return { rows, more };
}

// First index with candles[i].t >= t.
function lowerBound(candles, t) {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---- CSV ----------------------------------------------------------------------

export const LEVEL_CSV_HEADER = [
  'level_id',
  'type',
  'twin_of',
  'recorded_utc',
  'side',
  'level',
  'low',
  'high',
  'width',
  'broker_offset',
  'strength',
  'timeframes',
  'sources',
  'round_only',
  'estimated',
  'distance_atr',
  'atr_h1',
  'event',
  'test_no',
  'event_utc',
  'session',
  'result',
  'swept',
  'move_atr',
  'against_atr',
  'trading_minutes',
  'data_gap',
].join(',');

const utc = (t) => (t == null ? '' : new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' '));
const yn = (v) => (v == null ? '' : v ? 'yes' : 'no');
// Only letters, digits, spaces and a few signs reach the file: no commas,
// quotes or leading formula characters.
const txt = (s) => String(s).replace(/[^A-Za-z0-9 .+\/_-]/g, ' ').replace(/^[-+=@ ]+/, '');

export function levelRowCsv(r) {
  return [
    r.id,
    r.kind,
    r.twin,
    utc(r.t0),
    r.side === 'S' ? 'support' : 'resistance',
    r.mid.toFixed(2),
    r.lo.toFixed(2),
    r.hi.toFixed(2),
    (r.hi - r.lo).toFixed(2),
    r.off.toFixed(2),
    r.str,
    txt(r.tfs.join(' ')),
    txt(r.tags.join(' ')),
    yn(r.ref),
    yn(r.est),
    r.dist.toFixed(2),
    r.atr.toFixed(2),
    r.event,
    r.n,
    utc(r.at),
    txt(r.session),
    r.result,
    yn(r.swept),
    r.move == null ? '' : r.move.toFixed(2),
    r.against == null ? '' : r.against.toFixed(2),
    r.mins == null ? '' : r.mins,
    yn(r.gap),
  ].join(',');
}
