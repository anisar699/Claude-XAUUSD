// Usage: node tools/research/events.mjs <repo root> <data folder from sr-backtest.mjs --fetch>
// Research for the 1.6 alerts: do sweeps and break-and-retests at the
// multi-timeframe areas lead to a move in the expected direction more often
// than the same events at random bands?
//
// Areas are rebuilt every 24 hours from the hourly history known by then (as
// the app builds them). Each real area gets a random twin: same width, same
// side of price, near edge in the same 0.5 ATR distance band. Events are found
// on closed candles of the event timeframe with the app's rules:
//   sweep   wick beyond the area by the break buffer, close back on the side
//           it came from. Success: price then moves 1 hourly ATR away from
//           the close (the reversal) before it trades 0.25 ATR beyond the wick.
//   retest  a candle closes through the area (break), price moves at least the
//           re-arm distance away, then within 48 hours comes back to within
//           the "near" distance. Success: price moves 1 ATR away in the new
//           direction before a candle closes back through the area.
// Outcomes are looked for within 16 candles (M15) or 12 (H1).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, dir] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(repo, p)).href);
const bt = await imp('tools/sr-backtest.mjs');
const { atr } = await imp('app/src/main/assets/www/js/core/indicators.js');
const { analyse } = await imp('app/src/main/assets/www/js/core/model.js');
const { alertDistances } = await imp('app/src/main/assets/www/js/core/alerts.js');

const h1 = bt.load(dir, 'H1');
const days = bt.load(dir, 'D1');
const A1 = atr(h1, 14);
let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// Areas known at each daily refresh: [{ t, atr, areas: [{lo, hi}], twins: [...] }]
function refreshes() {
  const out = [];
  for (let i = 500; i < h1.length; i += 24) {
    const now = h1[i].t + 3600;
    const a = analyse({ H1: h1.slice(0, i + 1), D1U: days.filter((d) => d.t + 86400 <= now) }, { now, tfs: ['H1', 'H4', 'D1', 'W1'] });
    const p = h1[i].c;
    const A = A1[i];
    const real = a.conf.filter((z) => z.strength >= 3 && !z.reference && !z.approx && Math.abs(z.price - p) <= 6 * A);
    const twins = real.map((z) => {
      const w = z.hi - z.lo;
      if (p >= z.lo && p <= z.hi) {
        const lo = p - rnd() * w;
        return { lo, hi: lo + w };
      }
      const above = z.lo > p;
      const d = above ? z.lo - p : p - z.hi;
      const d2 = (Math.floor(d / (0.5 * A)) + rnd()) * 0.5 * A;
      const lo = above ? p + d2 : p - d2 - w;
      return { lo, hi: lo + w };
    });
    out.push({ t: now, atr: A, real: real.map((z) => ({ lo: z.lo, hi: z.hi })), twins });
  }
  return out;
}

const side = (z, x, buf) => (x < z.lo - buf ? 'above' : x > z.hi + buf ? 'below' : null);

function study(c, horizon, sets) {
  const res = {};
  for (const kind of ['real', 'twins']) res[kind] = { sweep: { n: 0, ok: 0 }, retest: { n: 0, ok: 0 } };
  let r = 0;
  for (let s = 0; s < sets.length; s++) {
    const from = sets[s].t;
    const to = s + 1 < sets.length ? sets[s + 1].t : Infinity;
    const A = sets[s].atr;
    const { near, rearm, buffer } = alertDistances({ distance: 'auto' }, A);
    while (r < c.length && c[r].t < from) r++;
    for (const kind of ['real', 'twins']) {
      for (const z of sets[s][kind]) {
        let cs = r > 0 ? side(z, c[r - 1].c, buffer) : null;
        let broken = null; // { at, newSide, armed }
        for (let i = r; i < c.length && c[i].t < to && i + horizon < c.length; i++) {
          const b = c[i];
          const out = b.t;
          // sweep
          if (cs === 'above' && b.h >= z.hi + buffer && b.c <= z.hi) {
            res[kind].sweep.n++;
            if (outcome(c, i, horizon, b.c - A, b.h + 0.25 * A, 'down')) res[kind].sweep.ok++;
          } else if (cs === 'below' && b.l <= z.lo - buffer && b.c >= z.lo) {
            res[kind].sweep.n++;
            if (outcome(c, i, horizon, b.c + A, b.l - 0.25 * A, 'up')) res[kind].sweep.ok++;
          }
          const ns = side(z, b.c, buffer);
          // retest bookkeeping
          if (broken) {
            if (out - broken.at > 48 * 3600 || (ns && ns !== broken.newSide)) broken = null;
            else {
              const gap = broken.newSide === 'below' ? b.l - z.hi : z.lo - b.h;
              if (gap >= rearm) broken.armed = true;
              else if (broken.armed && gap <= near) {
                res[kind].retest.n++;
                const up = broken.newSide === 'below';
                if (retestOutcome(c, i, horizon, z, buffer, A, up)) res[kind].retest.ok++;
                broken = null;
              }
            }
          }
          if (ns && cs && ns !== cs) broken = { at: out, newSide: ns, armed: false };
          if (ns) cs = ns;
        }
      }
    }
  }
  return res;
}

// Does price reach `target` before `stop` in the next `h` candles?
function outcome(c, i, h, target, stop, dir) {
  for (let j = i + 1; j <= i + h; j++) {
    const hitT = dir === 'down' ? c[j].l <= target : c[j].h >= target;
    const hitS = dir === 'down' ? c[j].h >= stop : c[j].l <= stop;
    if (hitS) return false;
    if (hitT) return true;
  }
  return false;
}

function retestOutcome(c, i, h, z, buf, A, up) {
  const ref = up ? z.hi : z.lo;
  for (let j = i + 1; j <= i + h; j++) {
    if (up ? c[j].c < z.lo - buf : c[j].c > z.hi + buf) return false;
    if (up ? c[j].h >= ref + A : c[j].l <= ref - A) return true;
  }
  return false;
}

const sets = refreshes();
const pc = (x) => (x.n ? ((100 * x.ok) / x.n).toFixed(0) + '%' : '-');
for (const [tf, h] of [['H1', 12], ['M15', 16]]) {
  const c = tf === 'H1' ? h1 : bt.load(dir, 'M15');
  const firstT = c[0].t;
  const res = study(c, h, sets.filter((s) => s.t >= firstT));
  console.log(`${tf}  sweeps: real ${pc(res.real.sweep)} of ${res.real.sweep.n}, random ${pc(res.twins.sweep)} of ${res.twins.sweep.n}   retests: real ${pc(res.real.retest)} of ${res.real.retest.n}, random ${pc(res.twins.retest)} of ${res.twins.retest.n}`);
}
