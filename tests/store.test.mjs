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
  store._cooldown = {};
  store._cooldownHits = {};
  store._m1Fails = 0;
  store._quoteFails = 0;
  store._quoteRetryAt = 0;
  store.clockOffset = null;
}

const realFetch = globalThis.fetch;
test.after(() => {
  prov.candles = realCandles;
  Date.now = realNow;
  globalThis.fetch = realFetch;
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

// ---- 1.4.0 developer audit (F03, F04, F05, F07) ------------------------------

test('a late minute poll cannot undo a newer sync (F03, P08)', async () => {
  setNow(OPEN);
  reset();
  const base = series('M1', 30);
  store.raw.M1 = base.map((c) => ({ ...c }));
  const last = base[base.length - 1];
  // The poll starts first and is answered last, with the old close.
  let release;
  const held = new Promise((r) => (release = r));
  prov.candles = async (tf, limit) => {
    if (tf === 'M1' && limit === 10) {
      await held;
      return base.slice(-10).map((c) => ({ ...c }));
    }
    if (tf === 'M1') {
      // The newer sync: corrects the last close and adds a minute.
      const fresh = base.slice(-20).map((c) => ({ ...c }));
      fresh[fresh.length - 1] = { ...fresh[fresh.length - 1], h: 4012, c: 4010 };
      fresh.push({ ...last, t: last.t + 60, h: 4012, c: 4011 });
      return fresh;
    }
    return series(tf);
  };
  const poll = store._pollM1();
  await store.sync();
  release();
  await poll;
  const m1 = store.raw.M1;
  const at = (t) => m1.find((c) => c.t === t);
  assert.equal(at(last.t).c, 4010, 'the correction survives');
  assert.ok(at(last.t + 60), 'the added minute survives');
  // And after a reload from the saved copy.
  store._saveCache();
  store.raw.M1 = [];
  store._loadCache();
  assert.equal(store.raw.M1.find((c) => c.t === last.t).c, 4010);
  assert.ok(store.raw.M1.find((c) => c.t === last.t + 60));
});

test('a 429 holds every request to that provider until its Retry-After (F05, P07)', async () => {
  setNow(OPEN);
  reset();
  store.raw.M1 = series('M1', 30);
  let calls = 0;
  prov.candles = async () => {
    calls++;
    const e = new Error('HTTP 429');
    e.status = 429;
    e.retryAfter = 120;
    throw e;
  };
  await store._pollM1();
  assert.equal(calls, 1);
  assert.equal(store.cooldownLeft('dukascopy'), 120);
  // Polls, retries and a manual refresh inside the 120 s send nothing.
  for (const dt of [15, 30, 60, 119]) {
    setNow(OPEN + dt * 1000);
    store._tick();
    await settle();
  }
  await store.sync();
  assert.equal(calls, 1, 'nothing sent during the cooldown');
  assert.match(store.feedErrors.H1, /asked to slow down/);
  setNow(OPEN + 121000);
  prov.candles = async (tf) => {
    calls++;
    return series(tf);
  };
  store._tick();
  await settle();
  assert.ok(calls > 1, 'requests resume after it');
});

test('without Retry-After a rate limit waits 60 s, then longer', async () => {
  setNow(OPEN);
  reset();
  store.raw.M1 = series('M1', 30);
  prov.candles = async () => {
    const e = new Error('HTTP 429');
    e.status = 429;
    e.retryAfter = null;
    throw e;
  };
  await store._pollM1();
  assert.equal(store.cooldownLeft('dukascopy'), 60);
  setNow(OPEN + 61000);
  await store._pollM1();
  assert.equal(store.cooldownLeft('dukascopy'), 120);
});

function quoteReply(tsMs, serverMs) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'X-Upstream-Date' ? new Date(serverMs).toUTCString() : null) },
    text: async () => JSON.stringify([{ ts: tsMs, spreadProfilePrices: [{ spreadProfile: 'prime', bid: 4000, ask: 4000.3 }] }]),
  };
}

test('quote age is judged by the server clock; old, future and late quotes are not live (F04, P03)', async () => {
  setNow(OPEN);
  reset();
  const ask = async (tsMs, serverMs) => {
    globalThis.fetch = async () => quoteReply(tsMs, serverMs);
    await store._pollQuote();
  };
  store.quote = null;
  await ask(OPEN - 9 * 60000, OPEN);
  assert.equal(store.priceIsLive(), false, 'nine minutes old on first receipt');
  store.quote = null;
  await ask(OPEN + 9 * 60000, OPEN);
  assert.equal(store.priceIsLive(), false, 'nine minutes in the future');
  store.quote = null;
  await ask(OPEN - 2000, OPEN);
  assert.equal(store.priceIsLive(), true, 'a current quote');
  // The phone clock is ten minutes fast: the server says the quote is current.
  setNow(OPEN + 600000);
  store.quote = null;
  await ask(OPEN - 1000, OPEN);
  assert.equal(Math.round(store.clockOffset), -600);
  assert.equal(store.priceIsLive(), true, 'not fooled by the phone clock');
  // An older quote arriving after a newer one is ignored.
  const t = store.quote.t;
  await ask(OPEN - 30000, OPEN);
  assert.equal(store.quote.t, t);
});

test('failed quote requests back off and honour Retry-After', async () => {
  setNow(OPEN);
  reset();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: (h) => (h === 'Retry-After' ? '90' : null) }, text: async () => 'slow down' };
  };
  await store._pollQuote();
  assert.equal(calls, 1);
  setNow(OPEN + 60000);
  await store._pollQuote();
  assert.equal(calls, 1, 'still waiting');
  setNow(OPEN + 91000);
  await store._pollQuote();
  assert.equal(calls, 2);
});

test('a feed for a timeframe that is off is neither fetched nor reported (F07)', async () => {
  setNow(OPEN);
  reset();
  const asked = [];
  prov.candles = async (tf) => {
    asked.push(tf);
    if (tf === 'M5') throw new Error('HTTP 503');
    return series(tf);
  };
  assert.ok(!store.settings.tfs.includes('M5'));
  await store.sync();
  assert.ok(!asked.includes('M5'), 'M5 is off, so its feed is not asked');
  assert.deepEqual(store.status.errors, []);
  // Switching M5 on fetches it straight away; now its failure is reported.
  const before = store.settings.tfs;
  store.setSettings({ tfs: ['M5', ...before] });
  await settle();
  assert.ok(asked.includes('M5'));
  assert.match(store.status.error, /^M5: HTTP 503/);
  store.setSettings({ tfs: before });
  assert.deepEqual(store.status.errors, [], 'off again, no longer reported');
});
