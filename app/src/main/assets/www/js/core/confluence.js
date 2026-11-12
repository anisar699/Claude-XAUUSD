// Cross-timeframe confluence: pool every level from every source, then group
// the ones that sit at nearly the same price. A group fed by several
// timeframes is a stronger area than any single line.

import { clusterByPrice, strengthOf } from './sr.js';

const TF_WEIGHT = { M5: 1, M15: 1.5, M30: 2, H1: 3, H4: 4, D1: 5, W1: 6 };
const PIVOT_WEIGHT = { PP: 2.5, R1: 2.5, S1: 2.5, R2: 2, S2: 2, R3: 1.5, S3: 1.5 };
const PERIOD_FACTOR = { D: 1, W: 1.4, M: 1.8 };
const PREV_WEIGHT = { D: 3, W: 4, M: 5 };

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
      });
    }
  }
  for (const [id, k] of Object.entries(key || {})) {
    if (k.pivots) {
      for (const [name, value] of Object.entries(k.pivots)) {
        pool.push({
          price: value,
          w: PIVOT_WEIGHT[name] * PERIOD_FACTOR[id],
          tag: `${k.short}-${name}`,
          group: 'pivot',
        });
      }
    }
    if (k.prev) {
      pool.push({ price: k.prev.h, w: PREV_WEIGHT[id], tag: `P${k.short}H`, group: 'prev' });
      pool.push({ price: k.prev.l, w: PREV_WEIGHT[id], tag: `P${k.short}L`, group: 'prev' });
    }
  }
  if (price && span) {
    const from = Math.ceil((price - span) / 50) * 50;
    for (let r = from; r <= price + span; r += 50) {
      const w = r % 1000 === 0 ? 3.5 : r % 100 === 0 ? 2 : 1;
      pool.push({ price: r, w, tag: String(r), group: 'round' });
    }
  }
  return pool;
}

export function confluence(pool, tol) {
  if (!pool.length) return [];
  const clusters = clusterByPrice(pool, tol, 60);
  const max = Math.max(...clusters.map((c) => c.score));
  return clusters
    .map((c) => {
      const tags = [];
      for (const m of c.members.slice().sort((a, b) => b.w - a.w)) {
        if (!tags.includes(m.tag)) tags.push(m.tag);
      }
      const ratio = c.score / max;
      return {
        price: c.price,
        lo: c.lo,
        hi: c.hi,
        score: c.score,
        ratio,
        strength: strengthOf(ratio),
        tags,
        sources: tags.length,
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
