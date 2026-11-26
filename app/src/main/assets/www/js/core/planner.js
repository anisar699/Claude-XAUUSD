// Trade planning from a level, position size, and journal results. Pure.
//
// A plan from an area: a long at support enters at the area's top edge with
// the stop below its bottom edge, a short at resistance the other way round.
// The stop sits a buffer beyond the area (a quarter of the hourly ATR plus
// the spread), so the area itself, not a wick into it, has to fail. Targets
// are the near edges of the next areas in the trade's direction.

export const STOP_BUFFER_ATR = 0.25;
export const MAX_TARGETS = 3;

export function planFromArea(area, { price, areas, atr, spread = 0, dir }) {
  const d = dir || (area.lo > price ? 'short' : 'long');
  const buffer = STOP_BUFFER_ATR * (atr || 0) + spread;
  const entry = d === 'long' ? area.hi : area.lo;
  const sl = d === 'long' ? area.lo - buffer : area.hi + buffer;
  const minGap = 0.5 * Math.abs(entry - sl);
  const ahead = (areas || [])
    .filter((z) => z !== area && !z.reference && (d === 'long' ? z.lo > entry + minGap : z.hi < entry - minGap))
    .sort((a, b) => (d === 'long' ? a.lo - b.lo : b.hi - a.hi))
    .slice(0, MAX_TARGETS)
    .map((z) => (d === 'long' ? z.lo : z.hi));
  return { dir: d, entry: round2(entry), sl: round2(sl), tps: ahead.map(round2), level: round2(area.price) };
}

const round2 = (x) => Math.round(x * 100) / 100;

// Lots for a stop distance: risk money / (stop distance x ounces per lot),
// rounded down to the lot step so the risk never exceeds the limit.
export function positionSize({ balance, riskPct, entry, sl, contract = 100, step = 0.01 }) {
  const dist = Math.abs(entry - sl);
  const riskMoney = (balance * riskPct) / 100;
  if (!(dist > 0) || !(contract > 0) || !(riskMoney > 0)) return { lots: 0, riskMoney, actualRisk: 0, dist };
  const raw = riskMoney / (dist * contract);
  const lots = Math.floor(raw / step + 1e-9) * step;
  return { lots: round2(lots), riskMoney, actualRisk: lots * dist * contract, dist, tooSmall: lots < step };
}

// Reward-to-risk of each target, and the money at a given size.
export function planNumbers(plan, { lots = 0, contract = 100 } = {}) {
  const sign = plan.dir === 'long' ? 1 : -1;
  const risk = Math.abs(plan.entry - plan.sl);
  return {
    risk,
    valid: risk > 0 && (plan.dir === 'long' ? plan.sl < plan.entry : plan.sl > plan.entry),
    targets: (plan.tps || []).filter(Number.isFinite).map((tp) => ({
      price: tp,
      rr: risk > 0 ? (sign * (tp - plan.entry)) / risk : NaN,
      money: sign * (tp - plan.entry) * lots * contract,
    })),
  };
}

// Has price reached a waiting plan's entry? A long fills when price comes
// down to its entry, a short when price rises to it.
export function entryReached(plan, price) {
  return plan.dir === 'long' ? price <= plan.entry : price >= plan.entry;
}

// ---- journal -------------------------------------------------------------------

// A closed trade's result: R multiple (when it had a stop) and money.
export function tradeResult(t, contract = 100) {
  const sign = t.dir === 'long' ? 1 : -1;
  const move = sign * (t.exit - t.entry);
  const risk = Number.isFinite(t.sl) ? Math.abs(t.entry - t.sl) : NaN;
  return {
    r: risk > 0 ? move / risk : null,
    pnl: move * (t.lots || 0) * contract,
    win: move > 0,
  };
}

function summary(list, contract) {
  const res = list.map((t) => tradeResult(t, contract));
  const n = res.length;
  const wins = res.filter((r) => r.win).length;
  const rs = res.map((r) => r.r).filter((r) => r != null);
  const gains = res.filter((r) => r.pnl > 0).reduce((a, r) => a + r.pnl, 0);
  const losses = -res.filter((r) => r.pnl < 0).reduce((a, r) => a + r.pnl, 0);
  return {
    n,
    wins,
    winRate: n ? wins / n : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    totalR: rs.reduce((a, b) => a + b, 0),
    pnl: res.reduce((a, r) => a + r.pnl, 0),
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : null,
  };
}

// Stats over closed trades (those with an exit), overall and by setup,
// session and direction.
export function journalStats(trades, contract = 100) {
  const closed = trades.filter((t) => Number.isFinite(t.exit));
  const by = (key) => {
    const groups = {};
    for (const t of closed) {
      const k = t[key] || '–';
      if (!groups[k]) groups[k] = [];
      groups[k].push(t);
    }
    return Object.entries(groups)
      .map(([k, list]) => ({ key: k, ...summary(list, contract) }))
      .sort((a, b) => b.n - a.n);
  };
  return { all: summary(closed, contract), open: trades.length - closed.length, bySetup: by('setup'), bySession: by('session'), byDir: by('dir') };
}

// Trades as CSV, for a spreadsheet.
export function journalCsv(trades, contract = 100) {
  const head = ['opened_utc', 'direction', 'entry', 'stop', 'target', 'exit', 'lots', 'setup', 'timeframe', 'session', 'r', 'pnl', 'notes'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = trades.map((t) => {
    const r = Number.isFinite(t.exit) ? tradeResult(t, contract) : { r: null, pnl: null };
    return [new Date(t.t * 1000).toISOString().slice(0, 16).replace('T', ' '), t.dir, t.entry, t.sl, t.tp, t.exit, t.lots, t.setup, t.tf, t.session, r.r == null ? '' : r.r.toFixed(2), r.pnl == null ? '' : r.pnl.toFixed(2), t.notes]
      .map(cell)
      .join(',');
  });
  return [head.join(','), ...rows].join('\n');
}
