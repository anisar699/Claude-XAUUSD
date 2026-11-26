// Saved trade plans and the trade journal, in localStorage (shared by the app
// screen and the background monitor). "Clear saved data" does not touch them.
//
// Plans are written by the app; the monitor only records when a plan's entry
// was reached, under its own key, so the two pages never overwrite each
// other's changes. An edited plan is saved as a new plan (a new id), so it
// never inherits the old one's "entry reached" record or arming.
//
// Saves report what happened: { ok: true } or { ok: false, reason } with
// reason 'storage' (the phone refused the write) or 'full' (the limit is
// reached). Nothing is ever dropped to make room.

const PLANS = 'xau.plans.v1';
const HITS = 'xau.plans.hits.v1';
const JOURNAL = 'xau.journal.v1';
export const MAX_PLANS = 50;
export const MAX_TRADES = 2000;

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const newId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const pos = (v) => Number.isFinite(v) && v > 0;
const optPos = (v) => v == null || (typeof v === 'number' && (Number.isNaN(v) || v > 0));

const isPlan = (p) => p && typeof p.id === 'string' && (p.dir === 'long' || p.dir === 'short') && pos(p.entry) && pos(p.sl);

// Why a trade cannot be saved, or null. Entry is required; stop, target,
// exit and lots are optional but must be positive when given.
export function tradeProblem(t) {
  if (!t || (t.dir !== 'long' && t.dir !== 'short')) return 'Choose buy or sell.';
  if (!pos(t.entry)) return 'Enter the entry price.';
  if (!Number.isFinite(t.t)) return 'Enter when the trade was opened.';
  for (const [k, label] of [['sl', 'stop loss'], ['tp', 'target'], ['exit', 'exit price'], ['lots', 'lots']]) {
    if (!optPos(t[k])) return `The ${label} must be a positive number, or left empty.`;
  }
  if (t.lots != null && !Number.isNaN(t.lots) && t.lots > 1000) return 'Lots must be 1000 or less.';
  if (t.contract != null && !pos(t.contract)) return 'The contract size must be positive.';
  return null;
}

const isTrade = (t) => t && typeof t.id === 'string' && !tradeProblem(t);

export function readPlans() {
  const list = read(PLANS, []);
  return Array.isArray(list) ? list.filter(isPlan) : [];
}

// replaces: the id of the plan this one revises (it and its hit are removed
// once the new one is safely stored).
export function savePlan(plan, replaces = null) {
  if (!isPlan(plan)) return { ok: false, reason: 'invalid' };
  const others = readPlans().filter((p) => p.id !== plan.id && p.id !== replaces);
  if (others.length >= MAX_PLANS) return { ok: false, reason: 'full' };
  if (!write(PLANS, [plan, ...others])) return { ok: false, reason: 'storage' };
  if (replaces) clearHit(replaces);
  return { ok: true };
}

export function deletePlan(id) {
  const ok = write(PLANS, readPlans().filter((p) => p.id !== id));
  clearHit(id);
  return ok;
}

// id -> time (s) the monitor saw price reach the plan's entry.
export function readHits() {
  const h = read(HITS, {});
  return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
}

// True only when the hit is stored.
export function markHit(id, t) {
  const hits = readHits();
  if (hits[id]) return false;
  hits[id] = t;
  return write(HITS, hits);
}

function clearHit(id) {
  const hits = readHits();
  if (!(id in hits)) return;
  delete hits[id];
  write(HITS, hits);
}

export function readTrades() {
  const list = read(JOURNAL, []);
  return Array.isArray(list) ? list.filter(isTrade).sort((a, b) => b.t - a.t) : [];
}

export function saveTrade(trade) {
  if (tradeProblem(trade)) return { ok: false, reason: 'invalid' };
  const others = readTrades().filter((t) => t.id !== trade.id);
  if (others.length >= MAX_TRADES) return { ok: false, reason: 'full' };
  const list = [...others, trade].sort((a, b) => b.t - a.t);
  return write(JOURNAL, list) ? { ok: true } : { ok: false, reason: 'storage' };
}

export function deleteTrade(id) {
  return write(JOURNAL, readTrades().filter((t) => t.id !== id));
}

// Trades saved before 1.6.1 did not record the contract size (ounces per
// lot) they were made with. Give them the size set now, once, so changing
// the setting later never rewrites their money results.
export function stampContracts(contract) {
  const list = read(JOURNAL, []);
  if (!Array.isArray(list) || !list.some((t) => t && t.contract == null)) return true;
  return write(
    JOURNAL,
    list.map((t) => (t && t.contract == null ? { ...t, contract } : t)),
  );
}
