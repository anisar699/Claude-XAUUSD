// Level alerts on the multi-timeframe areas. Pure: the caller supplies the
// current price and areas and gets back the alerts to show.
//
// Two kinds:
//   approach - price comes within a set distance of an area it was away from
//   break    - price moves clean through an area to the other side
//
// Both are judged on the live price, not on a candle close, so a break alert
// means "price is through the level now", not "a candle closed beyond it".

const APPROACH_COOLDOWN_SEC = 600;
const BREAK_COOLDOWN_SEC = 300;
// Longer than this since the previous check (market closed, feed down, phone
// asleep) and an alert says so: the move happened while nobody was watching.
const GAP_SEC = 600;

export const ALERT_DEFAULTS = { approach: true, breaks: true, minStrength: 3, distance: 'auto' };

export function createAlertState() {
  return { tracked: [], lastPrice: null, lastAt: null };
}

// Distances all scale with the hourly ATR so they stay sensible as volatility
// changes. `distance` can instead be a fixed number of dollars.
export function alertDistances(prefs, atrH1) {
  const atr = atrH1 > 0 ? atrH1 : 10;
  const near = prefs.distance === 'auto' ? Math.max(0.5, 0.15 * atr) : Number(prefs.distance);
  return {
    near,
    rearm: Math.max(2 * near, 0.5 * atr), // how far price must retreat before the next approach alert
    buffer: Math.max(0.3, 0.1 * atr), // how far beyond the area counts as a break
  };
}

// Which side of price the area is on: 'above' (acting as resistance), 'below'
// (support), or null while price is inside it or within the break buffer.
function clearSide(area, price, buffer) {
  if (price < area.lo - buffer) return 'above';
  if (price > area.hi + buffer) return 'below';
  return null;
}

export function evaluateAlerts(state, { now, price, areas, tol, atrH1, prefs }) {
  const p = { ...ALERT_DEFAULTS, ...prefs };
  const { near, rearm, buffer } = alertDistances(p, atrH1);
  const out = [];
  const next = [];
  const used = new Set();
  const since = state.lastAt != null && now - state.lastAt > GAP_SEC ? state.lastAt : null;

  for (const area of areas) {
    if (area.strength < p.minStrength) continue;

    // Areas are recalculated as candles form; carry state over to the area
    // that sits where a tracked one did.
    let entry = null;
    let best = tol;
    for (const t of state.tracked) {
      if (used.has(t)) continue;
      const d = Math.abs(t.price - area.price);
      if (d <= best) {
        best = d;
        entry = t;
      }
    }

    const side = clearSide(area, price, buffer);
    if (!entry) {
      // First sight of this area: remember where price is, never alert.
      const dist = side === 'above' ? area.lo - price : side === 'below' ? price - area.hi : 0;
      next.push({ price: area.price, side, armed: side !== null && dist >= rearm, lastApproach: -Infinity, lastBreak: -Infinity });
      continue;
    }
    used.add(entry);
    entry.price = area.price;
    // Areas are recalculated as candles form and can shift a little. Judge
    // the previous price against the area as it is now, so only a move of the
    // price, not of the level, can raise an alert.
    const last = state.lastPrice;
    const prevSide = last == null ? side : clearSide(area, last, buffer);

    if (side && entry.side && side !== entry.side) {
      // Price was clearly on one side and is now clearly on the other.
      if (prevSide !== side && p.breaks && now - entry.lastBreak >= BREAK_COOLDOWN_SEC) {
        entry.lastBreak = now;
        out.push({ kind: 'break', direction: side === 'below' ? 'up' : 'down', area, price, since });
      }
      entry.side = side;
      entry.armed = false;
    } else if (side && !entry.side) {
      entry.side = side;
    }

    if (entry.side) {
      const gap = (x) => Math.max(0, entry.side === 'above' ? area.lo - x : x - area.hi);
      const dist = gap(price);
      if (dist >= rearm) entry.armed = true;
      else if (dist <= near && entry.armed) {
        entry.armed = false;
        const priceMoved = last == null || gap(last) > near;
        if (priceMoved && p.approach && now - entry.lastApproach >= APPROACH_COOLDOWN_SEC) {
          entry.lastApproach = now;
          out.push({ kind: 'approach', role: entry.side === 'above' ? 'resistance' : 'support', area, price, distance: dist, since });
        }
      }
    }
    next.push(entry);
  }

  state.tracked = next;
  state.lastPrice = price;
  state.lastAt = now;
  return out;
}

const f2 = (x) => x.toFixed(2);
const two = (n) => String(n).padStart(2, '0');

function gapNote(a) {
  if (a.since == null) return '';
  const d = new Date(a.since * 1000);
  return ` · moved while alerts were paused (last check ${two(d.getHours())}:${two(d.getMinutes())})`;
}

// Notification text for one alert.
export function describeAlert(a) {
  const tags = a.area.tags.slice(0, 4).join(', ');
  const strength = `strength ${a.area.strength}/5`;
  if (a.kind === 'approach') {
    const where = a.distance <= 0 ? 'at the level' : `${f2(a.distance)} away`;
    return {
      key: `approach:${a.role}:${Math.round(a.area.price)}`,
      title: `Near ${a.role} ${f2(a.area.price)}`,
      body: `Price ${f2(a.price)} · ${where} · ${tags} · ${strength}${gapNote(a)}`,
    };
  }
  const up = a.direction === 'up';
  return {
    key: `break:${a.direction}:${Math.round(a.area.price)}`,
    title: `Price ${up ? 'above' : 'below'} ${f2(a.area.price)}`,
    body: `Price ${f2(a.price)} · moved through ${up ? 'resistance' : 'support'} · ${tags} · ${strength}${gapNote(a)}`,
  };
}
