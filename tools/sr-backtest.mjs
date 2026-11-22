// Walk-forward test of the support/resistance zones.
//
// At each test point the engine sees only candles closed by then; its zones
// are scored on the next H candles, which it has not seen:
//
//   turn precision  of the zones price reached, the share where a real turning
//                   point (a swing extreme followed by a 1.5 ATR move) formed
//                   within 0.3 ATR of the zone centre
//   capture         of the real turning points, the share within 0.3 ATR of
//                   some zone marked beforehand
//   reaction        of the zones price touched, the share where price moved
//                   1 ATR back before a candle closed through them
//
// Each is compared with random bands scored by the same rules, because some
// lines "work" by chance. Only zones within 6 ATR of price take part.
//
// Scoring rules since 1.5 (after the 1.4.0 developer audit, F08):
//  - Real and random levels are scored on the same test points: a point with
//    no zone within 6 ATR counts for neither.
//  - The main control ("matched") gives each real zone random twins on the
//    same side of price, with the same width and with their near edge in the
//    same 0.5 ATR distance band. The older control ("uniform": anywhere within
//    6 ATR) is still reported, for comparison with earlier results.
//  - Everything scored stays inside the H candles after the test point: a
//    turning point needs its whole right-hand wing and its 1.5 ATR move there.
//  - Equal highs (or lows) next to each other are one turning point.
//  - A touch is a candle that trades inside the band; a candle that jumps past
//    it without trading there is a "jump", not a touch.
//  - Lifts are also worked out per block of consecutive test points (8 per
//    part); the +- is the standard error across those blocks.
//
// The test points are split by time: settings are chosen on the first 60%
// ("tune") and checked on the last 40% ("check"); the test point just before
// the split is left out, so no scored candle is shared between the parts.
//
//   node tools/sr-backtest.mjs --fetch <dir>      download history (Dukascopy)
//   node tools/sr-backtest.mjs <dir> [variants]   run; variants: comma list or "all"
//
// Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aggregateTf, markGaps, utcDaysToServerDays } from '../app/src/main/assets/www/js/core/candles.js';
import { atr } from '../app/src/main/assets/www/js/core/indicators.js';
import { computeZones, ZONES_V1 } from '../app/src/main/assets/www/js/core/sr.js';
import { analyse } from '../app/src/main/assets/www/js/core/model.js';

export const BAND = 6;
export const NEAR = 0.3;
const REVERSAL = 1.0;
export const SWING_K = 5;
const SWING_MOVE = 1.5;
const TRIALS = 30;
export const TUNE_SHARE = 0.6;

// ---- data ---------------------------------------------------------------------

const FILES = { M5: ['5MIN', 20], M15: ['15MIN', 20], H1: ['1HOUR', 12], D1: ['1DAY', 3] };

async function fetchHistory(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [tf, [interval, pages]] of Object.entries(FILES)) {
    const rows = new Map();
    let before = Date.now() + 60000;
    for (let p = 0; p < pages; p++) {
      const q = new URLSearchParams({ path: 'chart/json3', instrument: 'XAU/USD', offer_side: 'B', interval, splits: 'true', stocks: 'true', limit: '1000', time_direction: 'P', timestamp: String(before), jsonp: 'cb' });
      const res = await fetch('https://freeserv.dukascopy.com/2.0/index.php?' + q, {
        headers: { Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index', 'User-Agent': 'Mozilla/5.0' },
      });
      const text = await res.text();
      const data = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
      if (!data.length) break;
      for (const r of data) rows.set(r[0] / 1000, r);
      before = Math.min(...data.map((r) => r[0]));
    }
    const out = [...rows.values()].sort((a, b) => a[0] - b[0]).map((r) => `${r[0] / 1000},${r[1]},${r[2]},${r[3]},${r[4]},${r[5] || 0}`);
    writeFileSync(path.join(dir, `${tf.toLowerCase()}.csv`), out.join('\n'));
    console.log(`${tf}: ${out.length} candles`);
  }
}

export function load(dir, tf) {
  return readFileSync(path.join(dir, `${tf.toLowerCase()}.csv`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      const [t, o, h, lo, c, v] = l.split(',').map(Number);
      return { t, o, h, l: lo, c, v: v || 0 };
    });
}

// ---- scoring ------------------------------------------------------------------

export const BIN = 0.5; // ATR: distance bands for the matched control
export const BLOCKS = 8;

let seed = 7;
export const setSeed = (x) => (seed = x);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// Turning points in the H candles after test point i. The right-hand wing and
// the confirming move must both lie inside that window; a flat top or bottom
// counts once.
export function turningPoints(c, i, H, A) {
  const out = [];
  const end = Math.min(c.length - 1, i + H);
  for (let k = Math.max(i + 1, SWING_K); k + SWING_K <= end; k++) {
    let hi = true;
    let lo = true;
    for (let d = 1; d <= SWING_K; d++) {
      if (c[k - d].h >= c[k].h || c[k + d].h > c[k].h) hi = false;
      if (c[k - d].l <= c[k].l || c[k + d].l < c[k].l) lo = false;
    }
    const after = c.slice(k + 1, Math.min(k + 13, end + 1));
    if (hi && after.some((x) => x.l <= c[k].h - SWING_MOVE * A)) out.push(c[k].h);
    if (lo && after.some((x) => x.h >= c[k].l + SWING_MOVE * A)) out.push(c[k].l);
  }
  return [...new Set(out.map((x) => Math.round(x * 100) / 100))];
}

export function reached(c, i, H, m, A) {
  const end = Math.min(c.length - 1, i + H);
  for (let j = i + 1; j <= end; j++) if (c[j].l <= m + NEAR * A && c[j].h >= m - NEAR * A) return true;
  return false;
}

// 'held', 'broke', 'jump' (price went past without trading in the band) or
// null (not touched, or undecided within the window).
export function reaction(c, i, H, A, lo, hi) {
  const p = c[i].c;
  if (p >= lo && p <= hi) return null;
  const res = lo > p;
  const mid = (lo + hi) / 2;
  const end = Math.min(c.length - 1, i + H);
  let touch = -1;
  for (let j = i + 1; j <= end; j++) {
    const x = c[j];
    if (x.l <= hi && x.h >= lo) {
      touch = j;
      break;
    }
    if (res ? x.l > hi : x.h < lo) return 'jump';
  }
  if (touch < 0) return null;
  for (let j = touch; j <= end; j++) {
    if (res ? c[j].c > hi : c[j].c < lo) return 'broke';
    if (j > touch && (res ? c[j].l <= mid - REVERSAL * A : c[j].h >= mid + REVERSAL * A)) return 'held';
  }
  return null;
}

// A random twin of zone z for price p: same side, same width, near edge in
// the same 0.5 ATR distance band. A zone around price gets a twin around price.
export function matchedBand(z, p, A) {
  const w = z.hi - z.lo;
  if (p >= z.lo && p <= z.hi) {
    const lo = p - rnd() * w;
    return { m: lo + w / 2, lo, hi: lo + w };
  }
  const above = z.lo > p;
  const d = above ? z.lo - p : p - z.hi;
  const band = Math.floor(d / (BIN * A));
  const d2 = (band + rnd()) * BIN * A;
  const lo = above ? p + d2 : p - d2 - w;
  return { m: lo + w / 2, lo, hi: lo + w };
}

function uniformBand(z, p, A) {
  const m = p + (rnd() * 2 - 1) * BAND * A;
  const half = (z.hi - z.lo) / 2;
  return { m, lo: m - half, hi: m + half };
}

const acc = () => ({ reach: 0, hit: 0, tps: 0, cap: 0, react: 0, held: 0, jump: 0 });

function addInto(t, r) {
  for (const k of Object.keys(r)) t[k] += r[k];
}

export function tally() {
  return { windows: 0, empty: 0, n: 0, lv: 0, w: 0, real: acc(), matched: acc(), uniform: acc(), byS: {}, log: [] };
}

// Score bands (each {m, lo, hi, s?}) on the window after test point i.
function scoreBands(into, c, i, H, A, bands, tps, weight, byS) {
  for (const b of bands) {
    if (reached(c, i, H, b.m, A)) {
      into.reach += weight;
      const hit = tps.some((x) => Math.abs(x - b.m) <= NEAR * A);
      if (hit) into.hit += weight;
      if (byS && b.s) {
        const e = (byS[b.s] ||= { reach: 0, hit: 0 });
        e.reach++;
        if (hit) e.hit++;
      }
    }
    const r = reaction(c, i, H, A, b.lo, b.hi);
    if (r === 'jump') into.jump += weight;
    else if (r) {
      into.react += weight;
      if (r === 'held') into.held += weight;
    }
  }
  into.tps += tps.length * weight;
  for (const x of tps) if (bands.some((b) => Math.abs(b.m - x) <= NEAR * A)) into.cap += weight;
}

export function score(T, c, i, H, A, zones) {
  T.windows++;
  const p = c[i].c;
  const near = zones.filter((z) => Math.abs(z.price - p) <= BAND * A);
  if (!near.length) {
    T.empty++;
    return;
  }
  T.n++;
  T.lv += near.length;
  for (const z of near) T.w += (z.hi - z.lo) / A;
  const tps = turningPoints(c, i, H, A);
  const row = { real: acc(), matched: acc(), uniform: acc() };
  scoreBands(row.real, c, i, H, A, near.map((z) => ({ m: z.price, lo: z.lo, hi: z.hi, s: z.strength })), tps, 1, T.byS);
  for (let k = 0; k < TRIALS; k++) {
    scoreBands(row.matched, c, i, H, A, near.map((z) => matchedBand(z, p, A)), tps, 1 / TRIALS);
    scoreBands(row.uniform, c, i, H, A, near.map((z) => uniformBand(z, p, A)), tps, 1 / TRIALS);
  }
  for (const k of ['real', 'matched', 'uniform']) addInto(T[k], row[k]);
  T.log.push(row);
}

// ---- variants -------------------------------------------------------------------

// 'v1' is the engine as it was in version 1.1; 'current' is what the app runs now.
export const VARIANTS = {
  v1: ZONES_V1,
  current: {},
};

export const PLAN = { M5: { warm: 600, H: 72 }, M15: { warm: 500, H: 64 }, H1: { warm: 500, H: 48 }, H4: { warm: 380, H: 24 }, D1: { warm: 320, H: 10 }, W1: { warm: 170, H: 6 } };

export function run(dir, names, opts = {}) {
  // Holes in the feed are marked as the app marks them, so swings next to one
  // are skipped here too.
  const series = { M5: markGaps(load(dir, 'M5'), 300), M15: markGaps(load(dir, 'M15'), 900), H1: markGaps(load(dir, 'H1'), 3600) };
  series.H4 = aggregateTf(series.H1, 'H4', 3600);
  // The feed's daily candles roll at UTC midnight; rebuild them on New York
  // close days the way the app does for history older than its hourly data.
  series.D1 = utcDaysToServerDays(load(dir, 'D1'));
  series.W1 = aggregateTf(series.D1, 'W1');
  const results = {};
  for (const tf of opts.tfs || Object.keys(PLAN)) {
    const c = series[tf];
    const { warm, H } = PLAN[tf];
    const A = atr(c, 14);
    const idx = [];
    for (let i = warm; i + H + SWING_K < c.length; i += H) idx.push(i);
    const cut = Math.floor(idx.length * TUNE_SHARE);
    results[tf] = { tests: idx.length, cutT: c[idx[cut]].t };
    for (const name of names) {
      const v = opts.variants?.[name] || VARIANTS[name];
      // A variant may hold per-timeframe overrides: { ...shared, byTf: { D1: {...} } }
      const variant = { ...v, ...(v.byTf?.[tf] || {}) };
      const parts = { tune: tally(), check: tally() };
      idx.forEach((i, k) => {
        if (k === cut - 1) return; // the gap between the parts
        seed = 7 + k; // same random lines for every variant at a test point
        score(k < cut ? parts.tune : parts.check, c, i, H, A[i], computeZones(c.slice(0, i + 1), tf, variant));
      });
      results[tf][name] = parts;
    }
  }
  return results;
}

// Multi-timeframe areas (the Overview list and the alerts), scored on the
// hourly chart. Built from H1, H4, D1 and W1 zones plus pivots and round
// numbers; M15/M30 zones are left out because their history is too short.
export function runAreas(dir) {
  const h1 = load(dir, 'H1');
  const days = load(dir, 'D1');
  const A = atr(h1, 14);
  const H = PLAN.H1.H;
  const idx = [];
  for (let i = PLAN.H1.warm; i + H + SWING_K < h1.length; i += H) idx.push(i);
  const cut = Math.floor(idx.length * TUNE_SHARE);
  const setups = {
    'v1 zones, wide areas': { zoneOptions: ZONES_V1, areaHalfWidthAtr: 0 },
    'current, wide areas': { areaHalfWidthAtr: 0 },
    current: {},
  };
  const out = { tests: idx.length, cutT: h1[idx[cut]].t };
  for (const [name, setup] of Object.entries(setups)) {
    const parts = { tune: tally(), check: tally() };
    idx.forEach((i, k) => {
      if (k === cut - 1) return; // the gap between the parts
      const now = h1[i].t + 3600;
      const raw = { H1: h1.slice(0, i + 1), D1U: days.filter((d) => d.t + 86400 <= now) };
      const a = analyse(raw, { now, tfs: ['H1', 'H4', 'D1', 'W1'], ...setup });
      const shown = a.conf.filter((z) => z.ratio >= 0.18 || z.sources >= 2);
      seed = 7 + k;
      score(k < cut ? parts.tune : parts.check, h1, i, H, A[i], shown);
    });
    out[name] = parts;
  }
  return out;
}

const pc = (a, b) => (b ? (100 * a) / b : NaN);
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
const sg = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) : '-');

// Standard error of a lift across blocks of consecutive test points.
function blockSE(log, metric) {
  const B = Math.min(BLOCKS, log.length);
  if (B < 2) return NaN;
  const lifts = [];
  for (let b = 0; b < B; b++) {
    const rows = log.slice(Math.round((b * log.length) / B), Math.round(((b + 1) * log.length) / B));
    const r = acc();
    const m = acc();
    for (const row of rows) {
      addInto(r, row.real);
      addInto(m, row.matched);
    }
    const lift = metric(r) - metric(m);
    if (Number.isFinite(lift)) lifts.push(lift);
  }
  if (lifts.length < 2) return NaN;
  const mean = lifts.reduce((a, b) => a + b, 0) / lifts.length;
  const sd = Math.sqrt(lifts.reduce((a, b) => a + (b - mean) ** 2, 0) / (lifts.length - 1));
  return sd / Math.sqrt(lifts.length);
}

const turnOf = (x) => pc(x.hit, x.reach);
const captureOf = (x) => pc(x.cap, x.tps);
const reactionOf = (x) => pc(x.held, x.react);

// turnRandom / captureRandom / reactionRandom are the matched control.
export function summarise(t) {
  return {
    tests: t.n,
    empty: t.empty,
    levels: t.n ? t.lv / t.n : 0,
    width: t.lv ? t.w / t.lv : 0,
    turn: turnOf(t.real),
    turnRandom: turnOf(t.matched),
    turnUniform: turnOf(t.uniform),
    turnSE: blockSE(t.log, turnOf),
    capture: captureOf(t.real),
    captureRandom: captureOf(t.matched),
    captureUniform: captureOf(t.uniform),
    captureSE: blockSE(t.log, captureOf),
    reaction: reactionOf(t.real),
    reactionRandom: reactionOf(t.matched),
    jumps: t.real.jump,
    reached: t.real.reach,
  };
}

function print(results, names) {
  for (const [tf, r] of Object.entries(results)) {
    names = names || Object.keys(r).filter((k) => r[k].tune);
    console.log(`\n=== ${tf}  ${r.tests} test points, tune/check split at ${new Date(r.cutT * 1000).toISOString().slice(0, 10)}`);
    console.log('variant'.padEnd(20), 'part  ', ' pts', 'lvl', ' width', '| turn  mtch  lift +-se   unif', '| capture mtch  lift +-se   unif', '| react mtch');
    for (const name of names) {
      for (const part of ['tune', 'check']) {
        const s = summarise(r[name][part]);
        console.log(
          (part === 'tune' ? name : '').padEnd(20),
          part.padEnd(6),
          String(s.tests).padStart(4),
          s.levels.toFixed(1).padStart(4),
          s.width.toFixed(2).padStart(5),
          '|',
          f0(s.turn).padStart(4),
          f0(s.turnRandom).padStart(5),
          sg(s.turn - s.turnRandom).padStart(5),
          f0(s.turnSE).padStart(3),
          sg(s.turn - s.turnUniform).padStart(6),
          '|',
          f0(s.capture).padStart(5),
          f0(s.captureRandom).padStart(5),
          sg(s.capture - s.captureRandom).padStart(5),
          f0(s.captureSE).padStart(3),
          sg(s.capture - s.captureUniform).padStart(6),
          '|',
          f0(s.reaction).padStart(5),
          f0(s.reactionRandom).padStart(4),
        );
      }
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('sr-backtest.mjs')) {
  const args = process.argv.slice(2);
  if (args[0] === '--fetch') await fetchHistory(args[1]);
  else if (args[1] === 'areas') print({ 'Multi-TF areas (H1)': runAreas(args[0]) });
  else if (args[1] === 'strength') {
    // Do stronger zones work better? Turn precision by strength bars, all test points.
    const r = run(args[0], ['current']);
    for (const [tf, x] of Object.entries(r)) {
      const by = {};
      for (const part of ['tune', 'check']) for (const [k, v] of Object.entries(x.current[part].byS)) {
        by[k] ||= { reach: 0, hit: 0 };
        by[k].reach += v.reach;
        by[k].hit += v.hit;
      }
      console.log(tf.padEnd(4), Object.entries(by).map(([k, v]) => `${k} bars: ${f0(pc(v.hit, v.reach))}% of ${v.reach}`).join('   '));
    }
  } else {
    const names = !args[1] || args[1] === 'all' ? Object.keys(VARIANTS) : args[1].split(',');
    const results = run(args[0], names);
    print(results, names);
  }
}
