// Saved trade plans and the trade journal, in localStorage (shared by the app
// screen and the background monitor). "Clear saved data" does not touch them.
//
// Plans are written by the app; the monitor only records when a plan's entry
// was reached, under its own key, so the two pages never overwrite each
// other's changes.

const PLANS = 'xau.plans.v1';
const HITS = 'xau.plans.hits.v1';
const JOURNAL = 'xau.journal.v1';
const MAX_PLANS = 50;
const MAX_TRADES = 2000;

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

const isPlan = (p) => p && typeof p.id === 'string' && (p.dir === 'long' || p.dir === 'short') && Number.isFinite(p.entry) && Number.isFinite(p.sl);
const isTrade = (t) => t && typeof t.id === 'string' && (t.dir === 'long' || t.dir === 'short') && Number.isFinite(t.entry) && Number.isFinite(t.t);

export function readPlans() {
  const list = read(PLANS, []);
  return Array.isArray(list) ? list.filter(isPlan) : [];
}

export function savePlan(plan) {
  const list = readPlans().filter((p) => p.id !== plan.id);
  list.unshift(plan);
  return write(PLANS, list.slice(0, MAX_PLANS));
}

export function deletePlan(id) {
  write(PLANS, readPlans().filter((p) => p.id !== id));
  const hits = readHits();
  delete hits[id];
  write(HITS, hits);
}

// id -> time (s) the monitor saw price reach the plan's entry.
export function readHits() {
  const h = read(HITS, {});
  return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
}

export function markHit(id, t) {
  const hits = readHits();
  if (hits[id]) return false;
  hits[id] = t;
  write(HITS, hits);
  return true;
}

export function readTrades() {
  const list = read(JOURNAL, []);
  return Array.isArray(list) ? list.filter(isTrade).sort((a, b) => b.t - a.t) : [];
}

export function saveTrade(trade) {
  const list = readTrades().filter((t) => t.id !== trade.id);
  list.push(trade);
  list.sort((a, b) => b.t - a.t);
  return write(JOURNAL, list.slice(0, MAX_TRADES));
}

export function deleteTrade(id) {
  write(JOURNAL, readTrades().filter((t) => t.id !== id));
}
