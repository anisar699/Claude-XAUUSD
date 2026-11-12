// Pulls live data through the dev server and prints what the app would show.
// A quick sanity check of the analysis against the real market.
//   node tools/dev-server.mjs &   then   node tools/live-check.mjs [port]

import { PROVIDERS, parseSwissquote } from '../app/src/main/assets/www/js/data/providers.js';
import { analyse } from '../app/src/main/assets/www/js/core/model.js';
import { nearestAreas } from '../app/src/main/assets/www/js/core/confluence.js';
import { distanceTo, roleOf } from '../app/src/main/assets/www/js/core/sr.js';
import { mergeSeries } from '../app/src/main/assets/www/js/core/candles.js';

const base = `http://127.0.0.1:${process.argv[2] || 8765}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).startsWith('/') ? base + url : url, opts);

const p = PROVIDERS.dukascopy;
const raw = {};
for (const tf of ['M1', 'M5', 'M15', 'M30']) raw[tf] = await p.candles(tf, 1000);
for (const [key, tf, pages] of [['H1', 'H1', 3], ['D1U', 'D1', 2]]) {
  let s = await p.candles(tf, 1000);
  for (let i = 1; i < pages; i++) s = mergeSeries(await p.candles(tf, 1000, s[0].t), s);
  raw[key] = s;
}
const quote = parseSwissquote(await (await fetch('/api/proxy?u=' + encodeURIComponent('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD'))).text());

const now = Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const f = (x) => x.toFixed(2);
const tfs = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
const a = analyse(raw, { now, tfs });

console.log(`now ${iso(now)} UTC   quote bid ${f(quote.bid)} ask ${f(quote.ask)}   last M1 close ${f(a.lastPrice)} @ ${iso(a.lastT)}`);
for (const k of Object.keys(raw)) console.log(`raw ${k}: ${raw[k].length} candles ${iso(raw[k][0].t)} .. ${iso(raw[k].at(-1).t)}`);
for (const tf of ['H1', 'H4', 'D1', 'W1', 'MN']) {
  const s = a.series[tf];
  console.log(`${tf}: ${s.length} candles; last 3: ` + s.slice(-3).map((c) => `[${iso(c.t)} O${f(c.o)} H${f(c.h)} L${f(c.l)} C${f(c.c)}]`).join(' '));
}
console.log(`ATR H1 ${f(a.atrH1)}  ATR D1 ${f(a.atrD1)}  confluence tol ${f(a.tol)}  prev close ${f(a.prevClose)}`);
for (const tf of tfs) {
  const t = a.trend[tf];
  console.log(`\n${tf}  trend ${t.bias}  RSI ${t.rsi.toFixed(1)}  ATR ${f(t.atr)}  EMA50 ${t.ema50 ? f(t.ema50) : '-'}  EMA200 ${t.ema200 ? f(t.ema200) : '-'}`);
  for (const z of a.zones[tf]) {
    console.log(`   ${roleOf(z, a.lastPrice).padEnd(10)} ${f(z.price)}  [${f(z.lo)}-${f(z.hi)}]  ${'*'.repeat(z.strength).padEnd(5)} touches ${String(z.touches).padStart(2)} (H${z.highs}/L${z.lows}, major ${z.majors}) cross ${z.crossings}  dist ${f(distanceTo(z, a.lastPrice))}  last ${iso(z.lastT)}`);
  }
}
console.log('\nKey levels');
for (const k of Object.values(a.key)) {
  console.log(`  ${k.name}: prev H ${f(k.prev.h)} L ${f(k.prev.l)} C ${f(k.prev.c)} (${iso(k.prev.t)})  ` + Object.entries(k.pivots).map(([n, v]) => `${n} ${f(v)}`).join('  '));
}
console.log(`\nConfluence (${a.conf.length} areas), nearest:`);
const near = nearestAreas(a.conf, a.lastPrice, 5);
for (const z of near.above.slice().reverse()) console.log(`   R ${f(z.price)} [${f(z.lo)}-${f(z.hi)}] ${'*'.repeat(z.strength).padEnd(5)} +${f(z.lo - a.lastPrice)}  ${z.tags.join(', ')}`);
for (const z of near.at) console.log(`   = ${f(z.price)} [${f(z.lo)}-${f(z.hi)}] ${'*'.repeat(z.strength).padEnd(5)} at price  ${z.tags.join(', ')}`);
console.log(`   --- price ${f(a.lastPrice)} ---`);
for (const z of near.below) console.log(`   S ${f(z.price)} [${f(z.lo)}-${f(z.hi)}] ${'*'.repeat(z.strength).padEnd(5)} ${f(z.hi - a.lastPrice)}  ${z.tags.join(', ')}`);
