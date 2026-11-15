// Regression tests for the data store, from the 1.2.0 audit (F02-F06, R03).
import test from 'node:test';
import assert from 'node:assert/strict';

// The store expects a browser: give it storage and a document.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.document = { hidden: false, addEventListener() {} };

const { store } = await import('../app/src/main/assets/www/js/store.js');
const { PROVIDERS, takeTwelveSlot } = await import('../app/src/main/assets/www/js/data/providers.js');

const prov = PROVIDERS.dukascopy;
const realCandles = prov.candles;
const realNow = Date.now;
const OPEN = Date.parse('2026-11-12T12:00:00Z'); // a Thursday, market open
const setNow = (ms) => (Date.now = () => ms);
const sec = () => Math.floor(Date.now() / 1000);
const STEP = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, D1: 86400 };
const series = (tf, n = 30) => {
  const end = Math.floor((sec() - STEP[tf]) / STEP[tf]) * STEP[tf];
  return Array.from({ length: n }, (_, i) => ({ t: end - (n - 1 - i) * STEP[tf], o: 4000, h: 4002, l: 3998, c: 4001, v: 0 }));
};
const settle = () => new Promise((r) => setTimeout(r, 20));

function reset() {
  store._resetData(true); // starts a sync; let it fail quietly first
  store._generation++;
  store.status.syncing = false;
  store.feedErrors = {};
  store.feedFails = {};
  store.feedRetryAt = {};
  store._updateErrors();
  store._lastSyncTry = sec();
  store.status.lastSync = sec();
  store._lastM1Try = 0;
  store._lastQuoteTry = Infinity; // no quote requests in these tests
}

test.after(() => {
  prov.candles = realCandles;
  Date.now = realNow;
});

test('an old quote is never live, even when it just arrived (F02)', () => {
  setNow(OPEN);
  const m = performance.now();
  store.quote = { bid: 4000, ask: 4000.3, t: sec() - 86400, at: sec(), mono: m, changedMono: m };
  assert.equal(store.priceIsLive(), false, 'a day-old quote');
  store.quote = { ...store.quote, t: sec() - 5 };
  assert.equal(store.priceIsLive(), true, 'a current quote');
  store.quote = { ...store.quote, mono: m - 100000 };
  assert.equal(store.priceIsLive(), false, 'received too long ago (monotonic clock)');
  store.quote = { ...store.quote, mono: m, changedMono: m - 200000 };
  assert.equal(store.priceIsLive(), false, 'the feed has stopped moving');
  store.quote = null;
});

test('empty feed answers are errors and are retried (F04)', async () => {
  setNow(OPEN);
  reset();
  let calls = 0;
  prov.candles = async () => {
    calls++;
    return [];
  };
  await store.sync();
  assert.equal(store.status.lastData, 0);
  assert.match(store.status.error, /no candles returned/);
  const before = calls;
  setNow(OPEN + 31000);
  store._tick();
  await settle();
  assert.ok(calls > before, 'retried after 30 s');
});

test('a failed first M1 fetch is retried while the others load (F05)', async () => {
  setNow(OPEN);
  reset();
  let failM1 = true;
  prov.candles = async (tf) => {
    if (tf === 'M1' && failM1) throw new Error('HTTP 503');
    return series(tf);
  };
  await store.sync();
  assert.equal(store.raw.M1.length, 0);
  failM1 = false;
  setNow(OPEN + 31000);
  store._tick();
  await settle();
  assert.ok(store.raw.M1.length > 0, 'M1 recovered');
  assert.equal(store.feedErrors.M1, undefined);
});

test('one feed recovering does not hide another feed failing (F06)', async () => {
  setNow(OPEN);
  reset();
  prov.candles = async (tf) => {
    if (tf === 'H1') throw new Error('HTTP 503');
    return series(tf);
  };
  await store.sync();
  assert.equal(store.status.error, 'H1: HTTP 503');
  await store._pollM1();
  assert.equal(store.status.error, 'H1: HTTP 503', 'still reported after a good M1 poll');
  assert.ok(store.feedRetryAt.H1 > 0, 'and H1 is still due a retry');
});

test('retries back off: 30 s, then 60 s, then 120 s', async () => {
  setNow(OPEN);
  reset();
  prov.candles = async () => {
    throw new Error('HTTP 503');
  };
  const gaps = [];
  for (let k = 0; k < 3; k++) {
    await store.sync(['H1']);
    gaps.push(store.feedRetryAt.H1 - sec());
    setNow(store.feedRetryAt.H1 * 1000);
  }
  assert.deepEqual(gaps, [30, 60, 120]);
});

test('the Twelve Data budget is shared and waits for a free slot (R03)', async () => {
  mem.delete('xau.twelve.budget.v1');
  let t = Date.parse('2026-11-12T12:00:00Z');
  const waits = [];
  const now = () => t;
  const wait = async (ms) => {
    waits.push(ms);
    t += ms;
  };
  for (let i = 0; i < 7; i++) await takeTwelveSlot(now, wait);
  assert.equal(waits.length, 0, 'seven in a minute go straight through');
  await takeTwelveSlot(now, wait); // an eighth, as if from the other page
  assert.equal(waits.length, 1, 'the eighth waits');
  assert.ok(waits[0] >= 59000 && waits[0] <= 61000);
  const b = JSON.parse(mem.get('xau.twelve.budget.v1'));
  assert.equal(b.count, 8);
  b.count = 780;
  mem.set('xau.twelve.budget.v1', JSON.stringify(b));
  await assert.rejects(() => takeTwelveSlot(now, wait), /daily limit/);
});
