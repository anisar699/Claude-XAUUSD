// Cross-timeframe confluence: pool every level from every source, then group
// the ones that sit at nearly the same price. A group fed by several
// timeframes is a stronger area than any single line.

import { clusterByPrice, strengthOf } from './sr.js';

// How much each source counts. Set from a walk-forward test of each source on
// its own against random lines (2 years of hourly gold, scored on the next
// 48 hours; README has the numbers). H1 swing zones and the R1/S1 pivots
// marked later turning points best; D1 and W1 swing zones, R3/S3 pivots and
// the previous month's high and low did worse than random lines at that
// scale, so they count little or not at all. Round numbers did slightly
// better than random.
export const TF_WEIGHT = { M5: 1, M15: 1.5, M30: 2, H1: 4, H4: 3, D1: 1.5, W1: 1 };
export const PIVOT_WEIGHT = { PP: 1.5, R1: 3, S1: 3, R2: 2, S2: 2 }; // R3/S3 left out
const PREV_WEIGHT = { D: 1.5, W: 2, M: 1 };
const ROUND_WEIGHT = { 1000: 3, 100: 2.5, 50: 2 };

// The raw feeds each source is built from (see store.js). A level is only as
// current as these: when one fails or falls behind, the levels built on it
// must not raise alerts. M1 fills in the candles since each feed's last fetch.
export const FEEDS_OF_TF = {
  M5: ['M5', 'M1'],
  M15: ['M15', 'M1'],
  M30: ['M30', 'M1'],
  H1: ['H1', 'M1'],
  H4: ['H1', 'M1'],
  D1: ['H1', 'D1U', 'M1'],
  W1: ['H1', 'D1U', 'M1'],
};
// Daily pivots come from days built from hourly candles; weekly and monthly
// ones also reach back into the feed's own daily candles.
const FEEDS_OF_PERIOD = { D: ['H1'], W: ['H1', 'D1U'], M: ['H1', 'D1U'] };

export function buildLevelPool({ zonesByTf, key, price, span }) {
  const pool = [];
  for (const [tf, zones] of Object.entries(zonesByTf)) {
    for (const z of zones) {
      pool.push({
        price: z.price,
        w: TF_WEIGHT[tf] * (0.4 + 0.6 * z.ratio),
        tag: tf,
        group: 'zone',
        tf,
        feeds: FEEDS_OF_TF[tf] || [],
      });
    }
  }
  for (const [id, k] of Object.entries(key || {})) {
    const extra = { period: id, approx: !!k.approx, feeds: FEEDS_OF_PERIOD[id] || [] };
    if (k.pivots) {
      for (const [name, value] of Object.entries(k.pivots)) {
        if (!PIVOT_WEIGHT[name]) continue;
        pool.push({
          price: value,
          w: PIVOT_WEIGHT[name],
          tag: `${k.short}-${name}`,
          group: 'pivot',
          ...extra,
        });
      }
    }
    if (k.prev) {
      pool.push({ price: k.prev.h, w: PREV_WEIGHT[id], tag: `P${k.short}H`, group: 'prev', ...extra });
      pool.push({ price: k.prev.l, w: PREV_WEIGHT[id], tag: `P${k.short}L`, group: 'prev', ...extra });
    }
  }
  if (price && span) {
    const from = Math.ceil((price - span) / 50) * 50;
    for (let r = from; r <= price + span; r += 50) {
      const w = r % 1000 === 0 ? ROUND_WEIGHT[1000] : r % 100 === 0 ? ROUND_WEIGHT[100] : ROUND_WEIGHT[50];
      pool.push({ price: r, w, tag: String(r), group: 'round', feeds: [] });
    }
  }
  return pool;
}

// halfWidth: draw each area as its centre +- this much (never wider than the
// spread of its levels). Leave it out to span all of them.
//
// Each area also says what it rests on:
//   reference  only round numbers: a price to watch, not a level the data made
//   approx     includes a pivot or high / low from an estimated period
//   tfs        timeframes whose swing zones are in it
//   feeds      raw feeds every contributor depends on
// Strength is a ranking within the current pool, not evidence: with few
// sources loaded (a cold start) even a lone round number ranks first.
export function confluence(pool, tol, halfWidth) {
  if (!pool.length) return [];
  const clusters = clusterByPrice(pool, tol, 60);
  const max = Math.max(...clusters.map((c) => c.score));
  return clusters
    .map((c) => {
      const tags = [];
      const tfs = [];
      const feeds = [];
      for (const m of c.members.slice().sort((a, b) => b.w - a.w)) {
        if (!tags.includes(m.tag)) tags.push(m.tag);
        if (m.tf && !tfs.includes(m.tf)) tfs.push(m.tf);
        for (const f of m.feeds || []) if (!feeds.includes(f)) feeds.push(f);
      }
      const ratio = c.score / max;
      const narrow = halfWidth > 0;
      return {
        price: c.price,
        lo: narrow ? Math.max(c.lo, c.price - halfWidth) : c.lo,
        hi: narrow ? Math.min(c.hi, c.price + halfWidth) : c.hi,
        score: c.score,
        ratio,
        strength: strengthOf(ratio),
        tags,
        sources: tags.length,
        reference: c.members.every((m) => m.group === 'round'),
        approx: c.members.some((m) => m.approx),
        tfs,
        feeds,
      };
    })
    .sort((a, b) => b.price - a.price);
}

// The nearest meaningful areas above and below price for the dashboard.
export function nearestAreas(zones, price, count = 3, minRatio = 0.18) {
  const strong = zones.filter((z) => z.ratio >= minRatio || z.sources >= 2);
  const above = strong.filter((z) => z.lo > price).sort((a, b) => a.lo - b.lo).slice(0, count);
  const below = strong.filter((z) => z.hi < price).sort((a, b) => b.hi - a.hi).slice(0, count);
  const at = strong.filter((z) => z.lo <= price && z.hi >= price);
  return { above, below, at };
}
