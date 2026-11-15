import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanCandles, dukaUrl, parseDuka, parseSwissquote, parseTwelve, proxied, twelveUrl } from '../app/src/main/assets/www/js/data/providers.js';

test('Dukascopy URL and JSONP parsing', () => {
  const url = new URL(dukaUrl('H1', 1000, 1794468113000));
  assert.equal(url.hostname, 'freeserv.dukascopy.com');
  assert.equal(url.searchParams.get('instrument'), 'XAU/USD');
  assert.equal(url.searchParams.get('interval'), '1HOUR');
  assert.equal(url.searchParams.get('offer_side'), 'B');
  assert.equal(url.searchParams.get('timestamp'), '1794468113000');

  // Newest first, as the feed returns it.
  const text = 'cb([[1794463200000,3979.407000,3980.750000,3962.245000,3965.600000,3.238320],[1794459600000,3975.208000,3982.911000,3969.525000,3979.407000,3.408560]]);';
  const c = parseDuka(text);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { t: 1794459600, o: 3975.208, h: 3982.911, l: 3969.525, c: 3979.407, v: 3.40856 });
  assert.ok(c[0].t < c[1].t);
  assert.throws(() => parseDuka('<html>blocked</html>'));
  assert.deepEqual(parseDuka('cb([]);'), []);
});

test('Twelve Data URL and parsing', () => {
  const url = new URL(twelveUrl('M15', 9000, 'abc'));
  assert.equal(url.searchParams.get('symbol'), 'XAU/USD');
  assert.equal(url.searchParams.get('interval'), '15min');
  assert.equal(url.searchParams.get('outputsize'), '5000');
  assert.equal(url.searchParams.get('timezone'), 'UTC');

  const ok = JSON.stringify({
    meta: { symbol: 'XAU/USD', interval: '1h' },
    values: [
      { datetime: '2026-11-12 06:00:00', open: '3979.4', high: '3980.7', low: '3962.2', close: '3965.6' },
      { datetime: '2026-11-12 05:00:00', open: '3975.2', high: '3982.9', low: '3969.5', close: '3979.4' },
    ],
    status: 'ok',
  });
  const c = parseTwelve(ok);
  assert.deepEqual(c.map((x) => x.t), [Date.UTC(2026, 10, 12, 5) / 1000, Date.UTC(2026, 10, 12, 6) / 1000]);
  assert.equal(c[1].c, 3965.6);

  const daily = parseTwelve(JSON.stringify({ values: [{ datetime: '2026-11-11', open: '1', high: '2', low: '0.5', close: '1.5' }], status: 'ok' }));
  assert.equal(daily[0].t, Date.UTC(2026, 10, 11) / 1000);

  assert.throws(() => parseTwelve(JSON.stringify({ code: 401, message: 'Invalid API key', status: 'error' })), /Invalid API key/);
});

test('Swissquote quote parsing', () => {
  const text = JSON.stringify([
    { topo: { platform: 'A' }, spreadProfilePrices: [{ spreadProfile: 'premium', bid: 3959.646, ask: 3960.304 }, { spreadProfile: 'prime', bid: 3959.656, ask: 3960.294 }], ts: 1794468561115 },
    { topo: { platform: 'B' }, spreadProfilePrices: [{ spreadProfile: 'prime', bid: 3959.7, ask: 3960.2 }], ts: 1794468561900 },
  ]);
  assert.deepEqual(parseSwissquote(text), { bid: 3959.7, ask: 3960.2, t: 1794468562 });
  assert.throws(() => parseSwissquote('[]'));
});

test('malformed candles are dropped, duplicates keep the later row (audit F08)', () => {
  const c = parseDuka('cb([[1794463200000,4000,4005,3995,4001,1],[1794463200000,4001,4006,3996,4002,1],[1794466800000,4000,3990,4010,4050,1]]);');
  assert.equal(c.length, 1);
  assert.equal(c[0].c, 4002);
  const t = 1794463200;
  const ok = { t, o: 2, h: 3, l: 1, c: 2 };
  assert.deepEqual(cleanCandles([ok, { ...ok, t: t + 0.5 }, { ...ok, t: 12 }, { ...ok, h: 1.5 }, { ...ok, l: 2.5 }, { ...ok, o: Infinity }, { ...ok, c: '2' }, null]), [ok]);
});

test('malformed quotes are rejected (audit F09)', () => {
  const q = (p, ts = 1794468561115) => JSON.stringify([{ spreadProfilePrices: [{ spreadProfile: 'prime', ...p }], ts }]);
  assert.throws(() => parseSwissquote(q({ bid: 1e400, ask: 4000 })));
  assert.throws(() => parseSwissquote(q({ bid: 4001, ask: 4000 })), undefined, 'crossed');
  assert.throws(() => parseSwissquote(q({ bid: 3000, ask: 4000 })), undefined, 'absurd spread');
  assert.throws(() => parseSwissquote(JSON.stringify([{ spreadProfilePrices: [{ spreadProfile: 'prime', bid: 4000, ask: 4000.5 }] }])), undefined, 'no timestamp');
  assert.deepEqual(parseSwissquote(q({ bid: '4000.1', ask: '4000.4' })), { bid: 4000.1, ask: 4000.4, t: 1794468561 }, 'numeric strings become numbers');
});

test('requests go through the app proxy', () => {
  assert.equal(proxied('https://a.b/c?d=e&f=g'), '/api/proxy?u=https%3A%2F%2Fa.b%2Fc%3Fd%3De%26f%3Dg');
});
