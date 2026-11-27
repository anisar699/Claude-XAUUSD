// Usage: node tools/research/levelrec.mjs <repo root> <data folder from sr-backtest.mjs --fetch> [days]
// The level record (1.7) run over stored history, as if the app had been open
// the whole time: every closed 15-minute candle is a step, the areas are
// rebuilt from the candles closed by then (with the app's own feed sizes:
// 3,600 hourly, 1,500 15- and 30-minute candles), and the levels are scored
// by core/levelrec.js. Writes level-events-<days>.csv and
// level-summary-<days>.csv to the data folder and prints the main rows.
// M30 candles are built from the 15-minute history; there are no minute
// candles, so the newest price is the last 15-minute close.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repo, dir, daysArg] = process.argv.slice(2);
const days = Number(daysArg || 60);
const imp = (p) => import(pathToFileURL(path.join(repo, p)).href);
const bt = await imp('tools/sr-backtest.mjs');
const { analyse } = await imp('app/src/main/assets/www/js/core/model.js');
const { aggregateTf } = await imp('app/src/main/assets/www/js/core/candles.js');
const LR = await imp('app/src/main/assets/www/js/core/levelrec.js');
const { levelSummaryCsv, parseLevelCsv, SUMMARY_HEADER } = await imp('app/src/main/assets/www/js/core/levelreport.js');

const m15 = bt.load(dir, 'M15');
const all = {
  H1: bt.load(dir, 'H1'),
  M15: m15,
  M30: aggregateTf(m15, 'M30', 900).map(({ t, o, h, l, c }) => ({ t, o, h, l, c })),
  D1U: bt.load(dir, 'D1'),
};
const SEC = { H1: 3600, M15: 900, M30: 1800, D1U: 86400 };
const KEEP = { H1: 3600, M15: 1500, M30: 1500, D1U: 2600 };
const tfs = ['M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

// Candles that ended by T, at most as many as the app keeps.
function upTo(s, T, sec, keep) {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (s[m].t + sec <= T) lo = m + 1;
    else hi = m;
  }
  return s.slice(Math.max(0, lo - keep), lo);
}
const rawAt = (T) => Object.fromEntries(Object.entries(all).map(([k, s]) => [k, upTo(s, T, SEC[k], KEEP[k])]));

const end = m15[m15.length - 1].t + 900;
const start = end - days * 86400;
const rec = LR.createRecord(start);
const t0 = Date.now();
let steps = 0;
const res = LR.runRecord(rec, {
  candles: m15.filter((c) => c.t >= start),
  knownTo: end,
  now: end,
  maxBehind: (days + 1) * 86400,
  analyseAt: (T) => {
    steps++;
    return analyse(rawAt(T), { now: T, tfs });
  },
});
const events = [LR.LEVEL_CSV_HEADER, ...res.rows.map(LR.levelRowCsv)].join('\n') + '\n';
const summary = levelSummaryCsv(parseLevelCsv(events), { now: end, since: rec.since, at: rec.at, gaps: rec.gaps });
writeFileSync(path.join(dir, `level-events-${days}.csv`), events);
writeFileSync(path.join(dir, `level-summary-${days}.csv`), summary);
console.log(`${days} days to ${new Date(end * 1000).toISOString().slice(0, 10)}: ${steps} steps in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${rec.count.levels} levels, ${res.rows.length} rows`);
const want = ['group', 'value', 'levels', 'tests', 'held_pct', 'random_held_pct', 'held_vs_random_pts', 'margin_95_pts', 'breaks', 'retest_held_pct', 'random_retest_held_pct'];
const idx = want.map((k) => SUMMARY_HEADER.indexOf(k));
console.log(want.join('\t'));
for (const line of summary.split('\n')) {
  if (!/^(All|Timeframe|Source|Strength),/.test(line)) continue;
  const f = line.split(',');
  console.log(idx.map((i) => f[i]).join('\t'));
}
