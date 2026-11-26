// The background monitor page end to end, with a mock Android bridge
// (1.4.0 developer audit, P05 and P12).
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.document = { hidden: false, addEventListener() {} };
const sent = { status: [], alert: [], beat: [] };
globalThis.window = {
  AndroidMonitor: {
    status: (t) => sent.status.push(t),
    alert: (title, body, key) => sent.alert.push({ title, body, key }),
    heartbeat: (k) => sent.beat.push(k),
    marketState() {},
  },
};

const realNow = Date.now;
let now = Date.parse('2026-11-12T12:00:30Z'); // Thursday, market open
Date.now = () => now;
const sec = () => Math.floor(now / 1000);

// Candle feed: never answers unless a test says otherwise, so the page sees
// only what the test puts in the store.
const { PROVIDERS } = await import('../app/src/main/assets/www/js/data/providers.js');
PROVIDERS.dukascopy.candles = () => new Promise(() => {});
// Quote feed through fetch: bid set by the test, stamped one second ago.
let bid = 3994;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: (h) => (h === 'X-Upstream-Date' ? new Date(now).toUTCString() : null) },
  text: async () => JSON.stringify([{ ts: now - 1000, spreadProfilePrices: [{ spreadProfile: 'prime', bid, ask: bid + 0.3 }] }]),
});

const { store } = await import('../app/src/main/assets/www/js/store.js');
const { marketStatus } = await import('../app/src/main/assets/www/js/core/time.js');
await import('../app/src/main/assets/www/js/monitor.js');

const settle = () => new Promise((r) => setTimeout(r, 20));
async function quoteAt(price, dt = 10) {
  now += dt * 1000;
  bid = price;
  store._lastQuoteTry = 0;
  window.__monitorTick();
  await settle();
}

test.after(() => {
  Date.now = realNow;
});

test('one minute candle: the monitor warms up and sends no alert (P05)', async () => {
  store.raw.M1 = [{ t: sec() - 30, o: 3994, h: 3994.5, l: 3993.5, c: 3994, v: 0, asOf: sec() }];
  store._recompute();
  await quoteAt(3990);
  await quoteAt(3999); // within a dollar of the 4,000 round number
  assert.equal(sent.alert.length, 0);
  assert.equal(sent.beat.at(-1), 'warmup');
  assert.match(sent.status.at(-1), /Loading history/);
});

test('with hourly history ready, an H1 area alerts although M15 failed (P12)', async () => {
  // 700 open-market hours of wavy prices ending at the current hour.
  const hours = [];
  for (let t = Math.floor(sec() / 3600) * 3600 - 3600; hours.length < 700; t -= 3600) if (marketStatus(t).open) hours.unshift(t);
  store.raw.H1 = hours.map((t, i) => {
    const mid = 3995 + 3 * Math.sin(i / 3) + 1.5 * Math.sin(i / 7.3);
    return { t, o: mid - 0.4, h: mid + 1, l: mid - 1, c: mid + 0.4, v: 0 };
  });
  // Minute candles from the last hourly candle up to now.
  const m1 = [];
  for (let t = hours.at(-1); t <= sec() - 60; t += 60) m1.push({ t, o: 3995, h: 3995.2, l: 3994.8, c: 3995, v: 0 });
  m1[m1.length - 1].asOf = sec();
  store.raw.M1 = m1;
  store.feedErrors = { M15: 'HTTP 503' };
  store._updateErrors();
  store._recompute();
  const a = store.analysis;
  assert.ok(a.ready.includes('H1'));
  const target = a.conf.find((z) => z.tfs.includes('H1') && z.strength >= 3 && !z.approx && z.feeds.every((f) => f !== 'M15'));
  assert.ok(target, 'a strong H1 area');
  sent.alert.length = 0;
  // Start well below it, then come within reach.
  await quoteAt(target.lo - 8);
  assert.equal(sent.beat.at(-1), 'running');
  await quoteAt(target.lo - 0.2);
  assert.ok(sent.alert.length >= 1, 'an approach alert');
  assert.ok(sent.alert.some((x) => x.body.includes('H1')));
  assert.match(sent.status.at(-1), /M15[^·]* not ready/, "the status says which timeframes wait");
});

test('a saved plan notifies once when price reaches its entry', async () => {
  const { savePlan, readHits } = await import('../app/src/main/assets/www/js/data/trades.js');
  savePlan({ id: 'p1', created: sec(), dir: 'long', entry: 3990, sl: 3985, tps: [4000], lots: 0.1 });
  sent.alert.length = 0;
  await quoteAt(3994); // above the entry: armed
  assert.equal(sent.alert.length, 0);
  await quoteAt(3989.5);
  const hit = sent.alert.find((x) => x.title === 'Plan entry reached: BUY 3990.00');
  assert.ok(hit, 'entry alert sent');
  assert.match(hit.body, /SL 3985.00 · TP 4000.00 \(2.0R\) · 0.1 lots/);
  assert.ok(readHits().p1);
  const n = sent.alert.length;
  await quoteAt(3995);
  await quoteAt(3989);
  assert.equal(sent.alert.filter((x) => x.title.startsWith('Plan entry')).length, 1, 'only once');
  assert.ok(sent.alert.length >= n);
});
