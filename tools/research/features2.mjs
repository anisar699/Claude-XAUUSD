// Usage: node tools/research/features2.mjs <repo root> <data folder from sr-backtest.mjs --fetch>
// Research: which properties of a level go with price turning there?
// For every zone (current engine) that price reaches in the next H candles,
// record candidate features and whether a turning point formed within 0.3 ATR.
// Then: per-feature tables (tune vs check) and a logistic model trained on
// tune, scored on check (AUC). Writes rows.json for later steps.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, dir] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(repo, p)).href);
const bt = await imp('tools/sr-backtest.mjs');
const { aggregateTf } = await imp('app/src/main/assets/www/js/core/candles.js');
const { atr, ema } = await imp('app/src/main/assets/www/js/core/indicators.js');
const { computeZones } = await imp('app/src/main/assets/www/js/core/sr.js');

const S = { M5: bt.load(dir, 'M5'), M15: bt.load(dir, 'M15'), H1: bt.load(dir, 'H1') };
S.H4 = aggregateTf(S.H1, 'H4');
const HTF = { M5: 'H1', M15: 'H1', H1: 'H4', H4: null };
const LOOK = { M5: 576, M15: 480, H1: 480, H4: 360 };
const NEW_FROM = Date.parse('2026-11-14T00:00:00Z') / 1000; // data unseen by earlier tuning

// Volume profile over the lookback: each candle's volume spread evenly over
// its range, in bins of `bin` dollars. Returns density at a price relative to
// the median non-empty bin.
function volumeAt(c, from, to, price, bin) {
  const hist = new Map();
  for (let i = from; i <= to; i++) {
    const x = c[i];
    if (!(x.v > 0)) continue;
    const a = Math.floor(x.l / bin);
    const b = Math.floor(x.h / bin);
    const share = x.v / (b - a + 1);
    for (let k = a; k <= b; k++) hist.set(k, (hist.get(k) || 0) + share);
  }
  if (!hist.size) return 1;
  const vals = [...hist.values()].sort((p, q) => p - q);
  const med = vals[vals.length >> 1] || 1;
  const k = Math.floor(price / bin);
  const around = ((hist.get(k - 1) || 0) + (hist.get(k) || 0) + (hist.get(k + 1) || 0)) / 3;
  return around / med;
}

// History of the level: past episodes where price came within 0.3 ATR of it.
// An episode ends in a reversal (price moved 1 ATR back) or a break (a close
// 0.3 ATR beyond). Returns counts.
function respect(c, from, to, m, A) {
  let rev = 0;
  let brk = 0;
  let wicks = 0;
  let i = from;
  while (i <= to) {
    const x = c[i];
    if (x.l <= m + 0.3 * A && x.h >= m - 0.3 * A) {
      const prev = c[i - 1] ? c[i - 1].c : x.o;
      const fromAbove = prev > m;
      // wick through the level, close back on the original side
      if (fromAbove ? x.l < m && x.c > m : x.h > m && x.c < m) wicks++;
      let j = i;
      let outcome = null;
      for (; j <= to && j < i + 30; j++) {
        const y = c[j];
        if (fromAbove ? y.c < m - 0.3 * A : y.c > m + 0.3 * A) {
          outcome = 'brk';
          break;
        }
        if (fromAbove ? y.h >= m + A : y.l <= m - A) {
          outcome = 'rev';
          break;
        }
      }
      if (outcome === 'rev') rev++;
      if (outcome === 'brk') brk++;
      i = j + 1;
    } else i++;
  }
  return { rev, brk, wicks };
}

const rows = [];
for (const tf of ['M5', 'M15', 'H1', 'H4']) {
  const c = S[tf];
  const { warm, H } = bt.PLAN[tf];
  const A = atr(c, 14);
  const closes = c.map((x) => x.c);
  const e50 = ema(closes, 50);
  const idx = [];
  for (let i = warm; i + H + bt.SWING_K < c.length; i += H) idx.push(i);
  const cut = Math.floor(idx.length * bt.TUNE_SHARE);
  const htfSeries = HTF[tf] ? S[HTF[tf]] : null;
  let hj = 0;
  idx.forEach((i, k) => {
    const a = A[i];
    const p = c[i].c;
    const t = c[i].t;
    const part = t >= NEW_FROM ? 'new' : k < cut ? 'tune' : 'check';
    const zones = computeZones(c.slice(0, i + 1), tf);
    const tps = bt.turningPoints(c, i, H, a);
    let htfZones = [];
    if (htfSeries) {
      while (hj + 1 < htfSeries.length && htfSeries[hj + 1].t <= t) hj++;
      htfZones = computeZones(htfSeries.slice(0, hj), HTF[tf]); // closed higher-TF candles only
    }
    const slope = e50[i] != null && e50[i - 10] != null ? (e50[i] - e50[i - 10]) / a : 0;
    const from = Math.max(1, i - LOOK[tf] + 1);
    for (const z of zones) {
      const m = z.price;
      if (Math.abs(m - p) > bt.BAND * a) continue;
      if (!bt.reached(c, i, H, m, a)) continue;
      const hit = tps.some((x) => Math.abs(x - m) <= bt.NEAR * a);
      const role = m > p ? 'R' : 'S';
      const r = respect(c, from, i, m, a);
      const near50 = Math.abs(m - Math.round(m / 50) * 50) / a;
      const near10 = Math.abs(m - Math.round(m / 10) * 10) / a;
      const htfNear = htfZones.length ? Math.min(...htfZones.map((h) => Math.abs(h.price - m))) / a : 99;
      // trend agreement: support while rising, resistance while falling
      const withTrend = (role === 'S' && slope > 0.2) || (role === 'R' && slope < -0.2) ? 1 : (role === 'S' && slope < -0.2) || (role === 'R' && slope > 0.2) ? -1 : 0;
      rows.push({
        tf, part, hit: hit ? 1 : 0,
        strength: z.strength, touches: z.touches, majors: z.majors, crossings: z.crossings,
        both: z.highs && z.lows ? 1 : 0,
        age: (t - z.lastT) / (c[1].t - c[0].t),
        dist: Math.abs(m - p) / a,
        rev: r.rev, brk: r.brk, wicks: r.wicks,
        respect: (r.rev + 1) / (r.rev + r.brk + 2),
        vol: volumeAt(c, from, i, m, 0.1 * a),
        near50, near10, htfNear, withTrend,
      });
    }
  });
}
writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows));

// ---- univariate tables ----------------------------------------------------------
const base = (rs) => (rs.length ? ((100 * rs.filter((r) => r.hit).length) / rs.length).toFixed(0) : '-');
console.log(`rows: ${rows.length}  tune ${rows.filter((r) => r.part === 'tune').length}  check ${rows.filter((r) => r.part === 'check').length}  new ${rows.filter((r) => r.part === 'new').length}`);
console.log(`turn rate overall: tune ${base(rows.filter((r) => r.part === 'tune'))}%  check ${base(rows.filter((r) => r.part === 'check'))}%  new ${base(rows.filter((r) => r.part === 'new'))}%`);
function table(name, keyFn) {
  const g = {};
  for (const r of rows) {
    const k = keyFn(r);
    (g[k] ||= { tune: [], check: [], new: [] })[r.part].push(r);
  }
  console.log(`\n${name}`);
  for (const k of Object.keys(g).sort()) {
    const e = g[k];
    console.log(`  ${String(k).padEnd(14)} tune ${base(e.tune).padStart(3)}% of ${String(e.tune.length).padStart(4)}   check ${base(e.check).padStart(3)}% of ${String(e.check.length).padStart(4)}   new ${base(e.new).padStart(3)}% of ${e.new.length}`);
  }
}
const b = (x, edges) => {
  for (const e of edges) if (x <= e) return `a<=${e}`;
  return `b>${edges[edges.length - 1]}`;
};
table('past reversals at the level (rev)', (r) => Math.min(r.rev, 4));
table('past breaks of the level (brk)', (r) => Math.min(r.brk, 4));
table('respect = (rev+1)/(rev+brk+2)', (r) => b(r.respect, [0.34, 0.5, 0.67]));
table('rejection wicks', (r) => Math.min(r.wicks, 4));
table('volume density vs median', (r) => b(r.vol, [0.5, 1, 1.5, 2.5]));
table('distance to $50 level (ATR)', (r) => b(r.near50, [0.3, 1, 3]));
table('distance to $10 level (ATR)', (r) => b(r.near10, [0.1, 0.3]));
table('higher-TF zone within (ATR)', (r) => b(r.htfNear, [0.3, 1, 3]));
table('trend agreement', (r) => r.withTrend);
table('distance from price (ATR)', (r) => b(r.dist, [1, 2, 3, 4]));
table('strength bars', (r) => r.strength);
