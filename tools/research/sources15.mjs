// Usage: node tools/research/sources15.mjs <repo root> <data folder from sr-backtest.mjs --fetch>
// Research: each source of levels on its own, on the 15-minute chart (next 16 h),
// January-November 2026, every 16 hours (non-overlapping).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, dir] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(repo, p)).href);
const bt = await imp('tools/sr-backtest.mjs');
const { atr } = await imp('app/src/main/assets/www/js/core/indicators.js');
const { analyse } = await imp('app/src/main/assets/www/js/core/model.js');
const { aggregateTf } = await imp('app/src/main/assets/www/js/core/candles.js');
const { bucketOf } = await imp('app/src/main/assets/www/js/core/time.js');

const h1 = bt.load(dir, 'H1');
const days = bt.load(dir, 'D1');
const m15 = bt.load(dir, 'M15');
const A = atr(m15, 14);
const H = 64;
const idx = [];
for (let i = 600; i + H + bt.SWING_K < m15.length; i += H) idx.push(i);
const cut = Math.floor(idx.length * bt.TUNE_SHARE);
const pt = (p, a) => ({ price: p, lo: p - 0.1 * a, hi: p + 0.1 * a });
const SRC = ['zones M15', 'zones M30', 'zones H1', 'zones H4', 'zones D1', 'pivot PP', 'pivot R1/S1', 'pivot R2/S2', 'pivot R3/S3', 'prev day H/L', 'prev week H/L', 'today H/L so far', 'Asia session H/L', 'round $10', 'round $50', 'round $100'];
const T = Object.fromEntries(SRC.map((s) => [s, { tune: bt.tally(), check: bt.tally() }]));
idx.forEach((i, k) => {
  const a = A[i];
  const now = m15[i].t + 900;
  const raw = { H1: h1.filter((x) => x.t + 3600 <= now), D1U: days.filter((d) => d.t + 86400 <= now), M15: m15.slice(Math.max(0, i - 1499), i + 1) };
  raw.M30 = aggregateTf(raw.M15, 'M30');
  const an = analyse(raw, { now, tfs: ['M15', 'M30', 'H1', 'H4', 'D1'] });
  const p = m15[i].c;
  const lv = {};
  for (const tf of ['M15', 'M30', 'H1', 'H4', 'D1']) lv[`zones ${tf}`] = an.zones[tf].map((z) => pt(z.price, a));
  const piv = (ns) => ['D', 'W', 'M'].flatMap((id) => (an.key[id].pivots ? ns.map((n) => an.key[id].pivots[n]) : [])).map((x) => pt(x, a));
  lv['pivot PP'] = piv(['PP']);
  lv['pivot R1/S1'] = piv(['R1', 'S1']);
  lv['pivot R2/S2'] = piv(['R2', 'S2']);
  lv['pivot R3/S3'] = piv(['R3', 'S3']);
  lv['prev day H/L'] = an.key.D.prev ? [pt(an.key.D.prev.h, a), pt(an.key.D.prev.l, a)] : [];
  lv['prev week H/L'] = an.key.W.prev ? [pt(an.key.W.prev.h, a), pt(an.key.W.prev.l, a)] : [];
  // today so far (New York close day) and the Asia session (00:00-07:00 UTC) of today
  const dayStart = bucketOf('D1', m15[i].t);
  let th = -Infinity, tl = Infinity, ah = -Infinity, al = Infinity;
  const asiaFrom = Math.floor(m15[i].t / 86400) * 86400;
  for (let j = i; j >= 0 && m15[j].t >= Math.min(dayStart, asiaFrom); j--) {
    const x = m15[j];
    if (x.t >= dayStart) { th = Math.max(th, x.h); tl = Math.min(tl, x.l); }
    if (x.t >= asiaFrom && x.t < asiaFrom + 7 * 3600) { ah = Math.max(ah, x.h); al = Math.min(al, x.l); }
  }
  lv['today H/L so far'] = th > -Infinity ? [pt(th, a), pt(tl, a)] : [];
  lv['Asia session H/L'] = ah > -Infinity && m15[i].t >= asiaFrom + 7 * 3600 ? [pt(ah, a), pt(al, a)] : [];
  const rounds = (step) => { const o = []; for (let r = Math.ceil((p - 6 * a) / step) * step; r <= p + 6 * a; r += step) o.push(pt(r, a)); return o; };
  lv['round $10'] = rounds(10);
  lv['round $50'] = rounds(50);
  lv['round $100'] = rounds(100);
  for (const s of SRC) { bt.setSeed(7 + k); bt.score(T[s][k < cut ? 'tune' : 'check'], m15, i, H, a, lv[s]); }
});
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
const sg = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(0) : '-');
console.log(`M15 test points: ${idx.length} (tune ${cut}, check ${idx.length - cut})`);
console.log('source'.padEnd(18), '| part  | lvl  | turn  rnd  lift | capture  rnd  lift | reached');
for (const s of SRC) for (const part of ['tune', 'check']) {
  const x = bt.summarise(T[s][part]);
  console.log((part === 'tune' ? s : '').padEnd(18), '|', part.padEnd(5), '|', x.levels.toFixed(1).padStart(4), '|', f0(x.turn).padStart(4), f0(x.turnRandom).padStart(4), sg(x.turn - x.turnRandom).padStart(5), '|', f0(x.capture).padStart(7), f0(x.captureRandom).padStart(4), sg(x.capture - x.captureRandom).padStart(5), '|', String(x.reached).padStart(6));
}
