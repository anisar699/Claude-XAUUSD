// Usage: node tools/research/sources.mjs <repo root> <data folder from sr-backtest.mjs --fetch>
// Research: how good is each source of levels on its own?
// At each H1 test point (2 years, every 48 hours) build the levels each source
// would offer and score them on the next 48 hours against random lines of the
// same count (tools/sr-backtest.mjs scoring).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, dir] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(repo, p)).href);
const bt = await imp('tools/sr-backtest.mjs');
const { atr } = await imp('app/src/main/assets/www/js/core/indicators.js');
const { analyse } = await imp('app/src/main/assets/www/js/core/model.js');

const h1 = bt.load(dir, 'H1');
const days = bt.load(dir, 'D1');
const A = atr(h1, 14);
const { warm, H } = bt.PLAN.H1;
const NEW_FROM = Date.parse('2026-11-14T00:00:00Z') / 1000;

// Volume profile peaks over the last n hourly candles: local maxima of a
// smoothed volume-by-price histogram (bin 0.1 ATR), strongest first.
function volumeNodes(c, i, n, a, count = 8) {
  const bin = 0.1 * a;
  const hist = new Map();
  for (let k = Math.max(0, i - n + 1); k <= i; k++) {
    const x = c[k];
    if (!(x.v > 0)) continue;
    const lo = Math.floor(x.l / bin);
    const hi = Math.floor(x.h / bin);
    for (let b = lo; b <= hi; b++) hist.set(b, (hist.get(b) || 0) + x.v / (hi - lo + 1));
  }
  const keys = [...hist.keys()].sort((p, q) => p - q);
  const sm = new Map();
  for (const k of keys) {
    let s = 0;
    for (let d = -3; d <= 3; d++) s += (hist.get(k + d) || 0) * (4 - Math.abs(d));
    sm.set(k, s);
  }
  const peaks = [];
  for (const k of keys) {
    const v = sm.get(k);
    let isPeak = true;
    for (let d = -5; d <= 5 && isPeak; d++) if (d && (sm.get(k + d) || 0) > v) isPeak = false;
    if (isPeak) peaks.push({ price: (k + 0.5) * bin, v });
  }
  return peaks.sort((p, q) => q.v - p.v).slice(0, count).map((p) => p.price);
}

// ATR zigzag: a swing is confirmed once price moves `mult` ATR against it.
function zigzag(c, i, n, a, mult) {
  const out = [];
  let dir = 0;
  let ext = c[Math.max(0, i - n + 1)];
  let extP = ext.h;
  let extL = ext.l;
  for (let k = Math.max(0, i - n + 1); k <= i; k++) {
    const x = c[k];
    if (dir >= 0) {
      if (x.h > extP) extP = x.h;
      if (extP - x.l >= mult * a) {
        if (dir === 1 || dir === 0) out.push(extP);
        dir = -1;
        extL = x.l;
      }
    }
    if (dir <= 0) {
      if (x.l < extL) extL = x.l;
      if (x.h - extL >= mult * a) {
        if (dir === -1 || dir === 0) out.push(extL);
        dir = 1;
        extP = x.h;
      }
    }
  }
  return out;
}

const pt = (p, a) => ({ price: p, lo: p - 0.1 * a, hi: p + 0.1 * a });
const SOURCES = [
  'zones H1', 'zones H4', 'zones D1', 'zones W1',
  'pivot PP', 'pivot R1/S1', 'pivot R2/S2', 'pivot R3/S3',
  'prev day H/L', 'prev week H/L', 'prev month H/L',
  'round $50', 'round $100',
  'volume nodes', 'zigzag 2 ATR', 'zigzag 4 ATR',
  'areas (current)',
];
const T = Object.fromEntries(SOURCES.map((s) => [s, { tune: bt.tally(), check: bt.tally(), new: bt.tally() }]));
const idx = [];
for (let i = warm; i + H + bt.SWING_K < h1.length; i += H) idx.push(i);
const cut = Math.floor(idx.length * bt.TUNE_SHARE);

idx.forEach((i, k) => {
  const a = A[i];
  const now = h1[i].t + 3600;
  const part = h1[i].t >= NEW_FROM ? 'new' : k < cut ? 'tune' : 'check';
  const an = analyse({ H1: h1.slice(0, i + 1), D1U: days.filter((d) => d.t + 86400 <= now) }, { now, tfs: ['H1', 'H4', 'D1', 'W1'] });
  const p = h1[i].c;
  const lv = {};
  for (const tf of ['H1', 'H4', 'D1', 'W1']) lv[`zones ${tf}`] = an.zones[tf].map((z) => pt(z.price, a));
  const piv = (names) => ['D', 'W', 'M'].flatMap((id) => (an.key[id].pivots ? names.map((n) => an.key[id].pivots[n]) : [])).map((x) => pt(x, a));
  lv['pivot PP'] = piv(['PP']);
  lv['pivot R1/S1'] = piv(['R1', 'S1']);
  lv['pivot R2/S2'] = piv(['R2', 'S2']);
  lv['pivot R3/S3'] = piv(['R3', 'S3']);
  const prev = (id) => (an.key[id].prev ? [pt(an.key[id].prev.h, a), pt(an.key[id].prev.l, a)] : []);
  lv['prev day H/L'] = prev('D');
  lv['prev week H/L'] = prev('W');
  lv['prev month H/L'] = prev('M');
  const rounds = (step) => {
    const out = [];
    for (let r = Math.ceil((p - 6 * a) / step) * step; r <= p + 6 * a; r += step) out.push(pt(r, a));
    return out;
  };
  lv['round $50'] = rounds(50);
  lv['round $100'] = rounds(100);
  lv['volume nodes'] = volumeNodes(h1, i, 480, a).map((x) => pt(x, a));
  lv['zigzag 2 ATR'] = zigzag(h1, i, 480, a, 2).map((x) => pt(x, a));
  lv['zigzag 4 ATR'] = zigzag(h1, i, 480, a, 4).map((x) => pt(x, a));
  lv['areas (current)'] = an.conf.filter((z) => z.ratio >= 0.18 || z.sources >= 2).map((z) => pt(z.price, a));
  for (const s of SOURCES) {
    bt.setSeed(7 + k);
    bt.score(T[s][part], h1, i, H, a, lv[s]);
  }
});

const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
const sg = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(0) : '-');
console.log(`H1 test points: ${idx.length} (tune ${cut}, check ${idx.length - cut}, of which new week ${idx.filter((i) => h1[i].t >= NEW_FROM).length})`);
console.log('source'.padEnd(17), '| part  | lvl  | turn  rnd  lift | capture  rnd  lift | reached');
for (const s of SOURCES) {
  for (const part of ['tune', 'check']) {
    const x = bt.summarise(T[s][part]);
    console.log(
      (part === 'tune' ? s : '').padEnd(17), '|', part.padEnd(5), '|', x.levels.toFixed(1).padStart(4), '|',
      f0(x.turn).padStart(4), f0(x.turnRandom).padStart(4), sg(x.turn - x.turnRandom).padStart(5), '|',
      f0(x.capture).padStart(7), f0(x.captureRandom).padStart(4), sg(x.capture - x.captureRandom).padStart(5), '|', String(x.reached).padStart(6),
    );
  }
}
