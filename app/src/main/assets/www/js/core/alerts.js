// Level alerts on the multi-timeframe areas. Pure: the caller supplies the
// current price, the areas and the latest closed candles, and gets back the
// alerts to show.
//
// Kinds:
//   approach - price comes within a set distance of an area it was away from
//   break    - price moves clean through an area to the other side; judged on
//              the live price, or (breakOn 'close') only when a candle of
//              candleTf closes beyond it, which filters out wicks
//   retest   - an approach to an area price broke through in the last 48
//              hours, from the new side: broken resistance tested as support
//              or the other way round
//   sweep    - a closed candle of candleTf wicks beyond an area and closes
//              back on the side it came from: a possible stop hunt

const APPROACH_COOLDOWN_SEC = 600;
const BREAK_COOLDOWN_SEC = 300;
// Longer than this since the previous check (market closed, feed down, phone
// asleep) and an alert says so: the move happened while nobody was watching.
const GAP_SEC = 600;

// roundOnly: also alert on areas made only of round numbers. Off by default:
// such an area is a reference price, not a level the candles made.
export const ALERT_DEFAULTS = {
  approach: true,
  breaks: true,
  retests: true,
  sweeps: true,
  breakOn: 'live', // 'live' or 'close'
  candleTf: 'M15', // candles for close-confirmed breaks and sweeps: 'M15' or 'H1'
  minStrength: 3,
  distance: 'auto',
  roundOnly: false,
};
const RETEST_WINDOW_SEC = 48 * 3600;

// Which areas may raise alerts right now, and why the others may not.
//   ready       timeframes with enough closed, current history (model.js)
//   badFeeds    raw feeds that failed or stopped updating
// An area is held back when it is only round numbers (unless opted in),
// rests on an estimated pivot, or needs a timeframe that is not ready or a
// feed that is not working. Each area is judged on its own inputs, so one
// broken feed pauses only the levels built from it.
export function gateAreas(areas, { ready, badFeeds, prefs }) {
  const p = { ...ALERT_DEFAULTS, ...prefs };
  const readySet = new Set(ready);
  const bad = new Set(badFeeds);
  const allowed = [];
  const held = [];
  for (const a of areas) {
    let why = null;
    if (a.reference && !p.roundOnly) why = 'round number only';
    else if (a.approx) why = 'estimated pivot';
    else if (a.tfs && a.tfs.some((tf) => !readySet.has(tf))) why = 'history not ready';
    else if (a.feeds && a.feeds.some((f) => bad.has(f))) why = 'feed problem';
    if (why) held.push({ area: a, why });
    else allowed.push(a);
  }
  return { allowed, held };
}

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

// candles: the latest closed candles of prefs.candleTf, oldest first (the
// last one is used); candleSec: their length. Without them, close-confirmed
// breaks and sweeps are simply not checked.
export function evaluateAlerts(state, { now, price, areas, tol, atrH1, prefs, candles = [], candleSec = 900 }) {
  const p = { ...ALERT_DEFAULTS, ...prefs };
  const { near, rearm, buffer } = alertDistances(p, atrH1);
  const out = [];
  const next = [];
  const used = new Set();
  const since = state.lastAt != null && now - state.lastAt > GAP_SEC ? state.lastAt : null;
  const bar = candles.length ? candles[candles.length - 1] : null;

  for (const area of areas) {
    if (area.strength < p.minStrength) continue;
    // Round-number-only areas are opt-in; callers normally filter with
    // gateAreas first, this keeps the default safe on its own.
    if (area.reference && !p.roundOnly) continue;

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
      next.push({
        price: area.price,
        side,
        armed: side !== null && dist >= rearm,
        lastApproach: -Infinity,
        lastBreak: -Infinity,
        lastSweep: -Infinity,
        seenAt: now,
        brokenAt: null,
        brokenSide: null,
        candleT: bar ? bar.t : null,
        candleSide: bar ? clearSide(area, bar.c, buffer) : null,
      });
      continue;
    }
    used.add(entry);
    entry.price = area.price;
    // Areas are recalculated as candles form and can shift a little. Judge
    // the previous price against the area as it is now, so only a move of the
    // price, not of the level, can raise an alert.
    const last = state.lastPrice;
    const prevSide = last == null ? side : clearSide(area, last, buffer);
    const broke = (dir, extra) => {
      entry.lastBreak = now;
      entry.brokenAt = now;
      // The side the area is on after the break: through resistance upwards
      // leaves it below price.
      entry.brokenSide = dir === 'up' ? 'below' : 'above';
      if (p.breaks) out.push({ kind: 'break', direction: dir, area, price, since, ...extra });
    };

    if (side && entry.side && side !== entry.side) {
      // Price was clearly on one side and is now clearly on the other.
      if (p.breakOn !== 'close' && prevSide !== side && now - entry.lastBreak >= BREAK_COOLDOWN_SEC) {
        broke(side === 'below' ? 'up' : 'down');
      }
      entry.side = side;
      entry.armed = false;
    } else if (side && !entry.side) {
      entry.side = side;
    }

    // A candle that closed since the last check (and after this area was
    // first seen): close-confirmed break and sweep.
    if (bar && bar.t !== entry.candleT) {
      entry.candleT = bar.t;
      if (bar.t + candleSec > entry.seenAt) {
        const cs = clearSide(area, bar.c, buffer);
        if (p.breakOn === 'close' && cs && entry.candleSide && cs !== entry.candleSide && now - entry.lastBreak >= BREAK_COOLDOWN_SEC) {
          broke(cs === 'below' ? 'up' : 'down', { close: bar.c, candleSec });
        }
        if (p.sweeps && now - entry.lastSweep >= BREAK_COOLDOWN_SEC) {
          if (entry.candleSide === 'above' && bar.h >= area.hi + buffer && bar.c <= area.hi) {
            entry.lastSweep = now;
            out.push({ kind: 'sweep', direction: 'up', area, price, wick: bar.h, close: bar.c, candleSec, since });
          } else if (entry.candleSide === 'below' && bar.l <= area.lo - buffer && bar.c >= area.lo) {
            entry.lastSweep = now;
            out.push({ kind: 'sweep', direction: 'down', area, price, wick: bar.l, close: bar.c, candleSec, since });
          }
        }
        if (cs) entry.candleSide = cs;
      }
    }

    if (entry.side) {
      const gap = (x) => Math.max(0, entry.side === 'above' ? area.lo - x : x - area.hi);
      const dist = gap(price);
      if (dist >= rearm) entry.armed = true;
      else if (dist <= near && entry.armed) {
        entry.armed = false;
        const priceMoved = last == null || gap(last) > near;
        const retest = p.retests && entry.brokenAt != null && now - entry.brokenAt <= RETEST_WINDOW_SEC && entry.side === entry.brokenSide;
        if (priceMoved && (retest || p.approach) && now - entry.lastApproach >= APPROACH_COOLDOWN_SEC) {
          entry.lastApproach = now;
          const role = entry.side === 'above' ? 'resistance' : 'support';
          out.push({ kind: retest ? 'retest' : 'approach', role, area, price, distance: dist, since });
          if (retest) entry.brokenAt = null;
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
  const strength = a.area.reference ? 'round number' : `rank ${a.area.strength}/5`;
  const tf = a.candleSec ? (a.candleSec >= 3600 ? 'H1' : 'M15') : '';
  const lvl = f2(a.area.price);
  if (a.kind === 'approach' || a.kind === 'retest') {
    const where = a.distance <= 0 ? 'at the level' : `${f2(a.distance)} away`;
    if (a.kind === 'retest') {
      const was = a.role === 'support' ? 'resistance' : 'support';
      return {
        key: `retest:${a.role}:${Math.round(a.area.price)}`,
        title: `Retest of ${lvl}: broken ${was}, now ${a.role}`,
        body: `Price ${f2(a.price)} · ${where} · ${tags} · ${strength}${gapNote(a)}`,
      };
    }
    return {
      key: `approach:${a.role}:${Math.round(a.area.price)}`,
      title: `Near ${a.role} ${lvl}`,
      body: `Price ${f2(a.price)} · ${where} · ${tags} · ${strength}${gapNote(a)}`,
    };
  }
  if (a.kind === 'sweep') {
    const up = a.direction === 'up';
    return {
      key: `sweep:${a.direction}:${Math.round(a.area.price)}`,
      title: `Sweep ${up ? 'above' : 'below'} ${lvl}`,
      body: `${tf} wick to ${f2(a.wick)}, closed ${f2(a.close)} back ${up ? 'below' : 'above'} · possible stop hunt · ${tags} · ${strength}${gapNote(a)}`,
    };
  }
  const up = a.direction === 'up';
  if (a.close != null) {
    return {
      key: `break:${a.direction}:${Math.round(a.area.price)}`,
      title: `${tf} closed ${up ? 'above' : 'below'} ${lvl}`,
      body: `Close ${f2(a.close)} · broke ${up ? 'resistance' : 'support'} · price ${f2(a.price)} · ${tags} · ${strength}${gapNote(a)}`,
    };
  }
  return {
    key: `break:${a.direction}:${Math.round(a.area.price)}`,
    title: `Price ${up ? 'above' : 'below'} ${lvl}`,
    body: `Price ${f2(a.price)} · moved through ${up ? 'resistance' : 'support'} · ${tags} · ${strength}${gapNote(a)}`,
  };
}
