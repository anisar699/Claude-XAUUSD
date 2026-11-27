// The level record (1.7.0): how each recorded level is scored, its random
// twins, the steps run late, the CSV files, and the driver on the phone.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const LR = await import('../app/src/main/assets/www/js/core/levelrec.js');
const { parseLevelCsv, levelSummaryCsv, SUMMARY_HEADER } = await import('../app/src/main/assets/www/js/core/levelreport.js');
const D = await import('../app/src/main/assets/www/js/data/levelrec.js');
const { marketStatus } = await import('../app/src/main/assets/www/js/core/time.js');

const utc = (...a) => Date.UTC(...a) / 1000;
const T0 = utc(2026, 10, 24, 10); // Tuesday 10:00 UTC, market open
const bar = (i, o, h, l, c) => ({ t: T0 + i * 900, o, h, l, c });
// price 4000, ATR 10: the break buffer is 1, a hold needs 10.
const support = { price: 3990.5, lo: 3990, hi: 3991, strength: 4, tags: ['H1', 'D-S1'], tfs: ['H1'], reference: false, approx: false };
const resistance = { price: 4009.5, lo: 4009, hi: 4010, strength: 3, tags: ['M15'], tfs: ['M15'], reference: false, approx: false };

let nextSeq = 0;
function recordWith(areas) {
  const rec = LR.createRecord(T0);
  rec.seq = nextSeq;
  nextSeq += 10;
  LR.snapshotRecord(rec, { T: T0, areas, price: 4000, atr: 10, tol: 3.5, ready: ['M15', 'H1'], offset: 0 });
  return rec;
}
// Feed candles one by one; the real level's rows only.
function feed(rec, bars) {
  const rows = [];
  for (const b of bars) rows.push(...LR.advanceRecord(rec, b));
  return rows.filter((r) => r.kind === 'real');
}

test('a support that holds, then is tested again', () => {
  const rec = recordWith([support]);
  assert.equal(rec.open.filter((l) => l.kind === 'real').length, 1);
  // The test candle's high reaches the target, but it may have come before
  // the low: only its close counts.
  let rows = feed(rec, [bar(0, 3995, 4005, 3990.5, 3995)]);
  assert.deepEqual(rows, []);
  rows = feed(rec, [bar(1, 3995, 4001.2, 3994, 4000)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'test');
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].result, 'held');
  assert.equal(rows[0].at, T0);
  assert.equal(rows[0].mins, 30);
  assert.ok(rows[0].move >= 1);
  assert.equal(rows[0].session, 'London', '10:00 UTC in November');
  // Back down to it: test 2, which breaks.
  rows = feed(rec, [bar(2, 4000, 4000, 3995, 3996), bar(3, 3996, 3996, 3987, 3988)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].result, 'broke');
});

test('a close a few cents through is not a break; a wick through and back is a sweep', () => {
  const rec = recordWith([support]);
  // Low 3988.5 is a buffer (1) below the area, close 3990.2 back inside.
  let rows = feed(rec, [bar(0, 3995, 3995, 3988.5, 3990.2)]);
  assert.deepEqual(rows, []);
  // Close 3989.5: below the area but within the buffer.
  rows = feed(rec, [bar(1, 3990.2, 3991, 3989.2, 3989.5)]);
  assert.deepEqual(rows, []);
  rows = feed(rec, [bar(2, 3990, 4002, 3990, 4001)]);
  assert.equal(rows[0].result, 'held');
  assert.equal(rows[0].swept, true);
  assert.ok(rows[0].against >= 0.15);
});

test('after a break: reclaimed, retest held, retest failed, no retest', () => {
  const brk = bar(0, 3995, 3995, 3987.5, 3988); // closes 2 below the area
  // Closed back above before going 0.5 ATR below: a false break.
  let rec = recordWith([support]);
  let rows = feed(rec, [brk, bar(1, 3988, 3993, 3987, 3992.5)]);
  assert.deepEqual(rows.map((r) => `${r.event}:${r.result}`), ['test:broke', 'after break:reclaimed']);
  assert.equal(rec.open.filter((l) => l.kind === 'real').length, 0, 'closed after its follow-up');

  // 0.5 ATR below, back into the area, then 1 ATR below it.
  rec = recordWith([support]);
  rows = feed(rec, [brk, bar(1, 3988, 3988, 3984, 3986), bar(2, 3986, 3990.2, 3985, 3989), bar(3, 3989, 3989, 3979.5, 3981)]);
  assert.deepEqual(rows.map((r) => r.result), ['broke', 'retest held']);
  assert.ok(rows[1].move >= 1);

  rec = recordWith([support]);
  rows = feed(rec, [brk, bar(1, 3988, 3988, 3984, 3986), bar(2, 3986, 3990.2, 3985, 3989), bar(3, 3989, 3993, 3988, 3992.5)]);
  assert.deepEqual(rows.map((r) => r.result), ['broke', 'retest failed']);

  rec = recordWith([support]);
  const away = [];
  for (let i = 1; i <= LR.LEVEL_REC.BREAK_CANDLES; i++) away.push(bar(i, 3980, 3982, 3978, 3980));
  rows = feed(rec, [brk, ...away]);
  assert.deepEqual(rows.map((r) => r.result), ['broke', 'no retest']);
  assert.equal(rows[1].mins, LR.LEVEL_REC.BREAK_CANDLES * 15);
});

test('a resistance is scored as the mirror image', () => {
  const rec = recordWith([resistance]);
  let rows = feed(rec, [bar(0, 4005, 4009.5, 4004, 4008)]);
  assert.deepEqual(rows, []);
  rows = feed(rec, [bar(1, 4008, 4008.5, 3998.9, 3999.5)]);
  assert.equal(rows[0].result, 'held');
  assert.equal(rows[0].side, 'R');
  const rec2 = recordWith([resistance]);
  rows = feed(rec2, [bar(0, 4005, 4012, 4004, 4011.5)]);
  assert.equal(rows[0].result, 'broke');
});

test('random twins: same side, same width, same distance band, gone when their level is', () => {
  const rec = recordWith([support, resistance]);
  for (const real of rec.open.filter((l) => l.kind === 'real')) {
    const twins = rec.open.filter((l) => l.twin === real.id);
    assert.equal(twins.length, LR.LEVEL_REC.TWINS);
    for (const z of twins) {
      assert.equal(z.side, real.side);
      assert.ok(Math.abs(z.hi - z.lo - (real.hi - real.lo)) < 1e-9);
      assert.equal(Math.floor(z.dist / 0.5), Math.floor(real.dist / 0.5), 'same 0.5 ATR band');
      assert.deepEqual(z.tfs, real.tfs);
      assert.equal(z.side === 'S' ? z.hi < 4000 : z.lo > 4000, true);
    }
  }
  // The support is no longer shown: it is dropped (reported as not reached),
  // and so are its twins; the resistance and its twins stay.
  const rows = LR.snapshotRecord(rec, { T: T0 + 900, areas: [resistance], price: 4000, atr: 10, tol: 3.5, ready: ['M15', 'H1'], offset: 0 });
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.event}:${r.result}`), ['real:not reached:removed']);
  const kept = rec.open.filter((l) => l.kind === 'real')[0].id;
  assert.deepEqual(rec.open.map((l) => l.id).sort(), [kept, `${kept}r1`, `${kept}r2`]);
  assert.equal(rec.open[0].mid, 4009.5);
});

test('which areas are recorded', () => {
  const inside = { ...support, lo: 3999, hi: 4001, price: 4000 };
  const far = { ...support, lo: 3920, hi: 3921, price: 3920.5 }; // 7.9 ATR away
  const notReady = { ...resistance, tfs: ['H4'], tags: ['H4'] };
  const rec = recordWith([inside, far, notReady, support]);
  assert.deepEqual(rec.open.filter((l) => l.kind === 'real').map((l) => l.mid), [3990.5]);
  // Shown again a little moved: the same level, with its sources as shown now.
  LR.snapshotRecord(rec, { T: T0 + 900, areas: [{ ...support, price: 3991, lo: 3990.5, hi: 3991.5, strength: 5, tags: ['H1', 'H4'] }], price: 4000, atr: 10, tol: 3.5, ready: ['H1'], offset: 0 });
  const real = rec.open.filter((l) => l.kind === 'real');
  assert.equal(real.length, 1);
  assert.equal(real[0].str, 5);
  assert.equal(real[0].lo, 3990, 'its position stays where it was recorded');
  assert.equal(rec.count.levels, 1);
});

test('the broker offset: recorded in feed prices, reported in the broker prices', () => {
  const rec = LR.createRecord(T0);
  const off = 2.5;
  LR.snapshotRecord(rec, { T: T0, areas: [{ ...support, price: 3993, lo: 3992.5, hi: 3993.5 }], price: 4002.5, atr: 10, tol: 3.5, ready: ['H1'], offset: off });
  const L = rec.open[0];
  assert.equal(L.lo, 3990);
  const rows = feed(rec, [bar(0, 3995, 3995, 3990.5, 3995), bar(1, 3995, 4001.2, 3994, 4000)]);
  assert.equal(rows[0].lo, 3992.5);
  assert.match(LR.levelRowCsv(rows[0]), /,3993\.00,3992\.50,3993\.50,1\.00,2\.50,/);
});

// ---- steps run late ----------------------------------------------------------

function series(from, n, price = 4000) {
  const out = [];
  for (let t = from; out.length < n; t += 900) if (marketStatus(t).open) out.push({ t, o: price, h: price + 0.5, l: price - 0.5, c: price });
  return out;
}

test('a late step sees only the candles closed by its own time', () => {
  const rec = LR.createRecord(T0);
  const candles = series(T0, 12);
  const seen = [];
  const res = LR.runRecord(rec, {
    candles,
    knownTo: candles[candles.length - 1].t + 900,
    now: candles[candles.length - 1].t + 900,
    analyseAt: (T) => {
      seen.push(T);
      return null;
    },
  });
  assert.equal(res.more, false);
  assert.deepEqual(seen, candles.map((c) => c.t + 900));
  assert.equal(rec.at, candles[11].t + 900);
  // The candles of a feed cut at T: none that ended after T.
  const raw = { M1: series(T0, 600).map((c, i) => ({ ...c, t: T0 + i * 60 })), H1: series(T0 - 86400, 40).map((c, i) => ({ ...c, t: T0 - 86400 + i * 3600 })) };
  const cut = D.cutRaw(raw, T0 + 3600);
  assert.ok(cut.M1.every((c) => c.t + 60 <= T0 + 3600));
  assert.equal(cut.M1.length, 60);
  assert.ok(cut.H1.every((c) => c.t + 3600 <= T0 + 3600));
});

test('a stretch the record could not see: tests in progress end as "data missing"', () => {
  const rec = recordWith([support]);
  feed(rec, [bar(0, 3995, 3995, 3990.5, 3995)]); // test in progress
  rec.at = T0 + 900;
  // The next candle is three open-market hours later.
  const later = series(T0 + 4 * 3600, 4, 4000);
  const res = LR.runRecord(rec, { candles: later, knownTo: later[3].t + 900, now: later[3].t + 900, analyseAt: () => null });
  const real = res.rows.filter((r) => r.kind === 'real');
  assert.deepEqual(real.map((r) => r.result), ['data missing']);
  assert.deepEqual(rec.gaps, [[T0 + 900, T0 + 4 * 3600]]);
  // The weekend is not a hole.
  const fri = utc(2026, 10, 20, 21, 45);
  const rec2 = LR.createRecord(fri);
  rec2.at = fri + 900; // Friday 22:00, the close
  const mon = series(utc(2026, 10, 22, 23), 2);
  LR.runRecord(rec2, { candles: mon, knownTo: mon[1].t + 900, now: mon[1].t + 900, analyseAt: () => null });
  assert.deepEqual(rec2.gaps, []);
});

test('more than 7 days behind: the older stretch is not recorded', () => {
  const rec = LR.createRecord(T0 - 10 * 86400);
  const candles = series(T0 - 86400, 8);
  const now = candles[7].t + 900;
  LR.runRecord(rec, { candles, knownTo: now, now, analyseAt: () => null });
  assert.equal(rec.gaps.length, 1);
  assert.equal(rec.gaps[0][0], T0 - 10 * 86400);
  assert.equal(rec.at, now);
});

test('a step that ran out of time goes on at the next call', () => {
  const rec = LR.createRecord(T0);
  const candles = series(T0, 10);
  let calls = 0;
  const res = LR.runRecord(rec, { candles, knownTo: candles[9].t + 900, now: candles[9].t + 900, analyseAt: () => null, stop: () => ++calls > 2 });
  assert.equal(res.more, true);
  assert.equal(rec.at, candles[3].t, 'at least one step, then it stops when told');
});

// ---- the CSV files -------------------------------------------------------------

function sampleRows() {
  const rows = [];
  const add = (areas, bars) => {
    const rec = recordWith(areas);
    for (const b of bars) rows.push(...LR.advanceRecord(rec, b));
  };
  add([support], [bar(0, 3995, 3995, 3990.5, 3995), bar(1, 3995, 4001.2, 3994, 4000)]);
  add([support], [bar(0, 3995, 3995, 3987.5, 3988), bar(1, 3988, 3993, 3987, 3992.5)]);
  add([resistance], [bar(0, 4005, 4009.5, 4004, 4008), bar(1, 4008, 4008.5, 3998.9, 3999.5)]);
  return rows;
}

test('the events CSV: one column per header field, no stray commas or formulas', () => {
  const rows = sampleRows();
  const cols = LR.LEVEL_CSV_HEADER.split(',').length;
  for (const r of rows) {
    const line = LR.levelRowCsv(r);
    assert.equal(line.split(',').length, cols, line);
    for (const cell of line.split(',')) assert.doesNotMatch(cell, /^[=+@]/);
  }
  const odd = LR.levelRowCsv({ ...rows[0], tags: ['=HYPERLINK("x")', 'a,b'], session: '-cmd' });
  assert.equal(odd.split(',').length, cols);
  assert.doesNotMatch(odd, /[="]/);
});

test('the summary: each kind of level next to its random twins, rows written twice counted once', () => {
  const rows = sampleRows();
  const text = [LR.LEVEL_CSV_HEADER, ...rows.map(LR.levelRowCsv)].join('\n');
  const parsed = parseLevelCsv(text + '\n' + rows.map(LR.levelRowCsv).join('\n'));
  assert.equal(parsed.length, rows.length);
  const csv = levelSummaryCsv(parsed, { now: T0 + 86400, since: T0, at: T0 + 3600, gaps: [] });
  const lines = csv.split('\n');
  const head = lines.indexOf(SUMMARY_HEADER.join(','));
  assert.ok(head > 0);
  const table = lines.slice(head + 1, lines.indexOf('', head));
  const all = table.find((l) => l.startsWith('All,')).split(',');
  const col = (name) => all[SUMMARY_HEADER.indexOf(name)];
  assert.equal(col('levels'), '3');
  assert.equal(col('tests'), '3');
  assert.equal(col('held_pct'), '66.7');
  assert.equal(col('breaks'), '1');
  assert.equal(col('reclaimed_pct'), '100.0');
  assert.ok(Number(col('random_tests')) >= 0);
  for (const l of table) assert.equal(l.split(',').length, SUMMARY_HEADER.length, l);
  assert.ok(table.some((l) => l.startsWith('Timeframe,H1,')));
  assert.ok(table.some((l) => l.startsWith('Source,Pivot,')));
  assert.ok(csv.includes('How to read it'));
});

// ---- on the phone --------------------------------------------------------------

// Hourly and 15-minute candles that swing, so the app finds areas.
function market(endT, hours) {
  const H1 = [];
  const M15 = [];
  const wave = (t) => 4000 + 25 * Math.sin(t / 20000) + 8 * Math.sin(t / 3100);
  for (let t = endT - hours * 3600; t < endT; t += 900) {
    if (!marketStatus(t).open) continue;
    const a = wave(t);
    const b = wave(t + 900);
    M15.push({ t, o: a, h: Math.max(a, b) + 0.6, l: Math.min(a, b) - 0.6, c: b });
  }
  for (const c of M15) {
    const h = c.t - (c.t % 3600);
    const last = H1[H1.length - 1];
    if (!last || last.t !== h) H1.push({ t: h, o: c.o, h: c.h, l: c.l, c: c.c });
    else {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
    }
  }
  return { M1: [], M5: [], M15: M15.slice(-1500), M30: [], H1, D1U: [] };
}

test('recordLevels on the phone: catches up, writes rows then state, and repeats nothing', () => {
  mem.clear();
  const end = utc(2026, 10, 26, 12); // Thursday noon
  const raw = market(end, 24 * 40);
  const store = { raw, settings: { tfs: ['M15', 'H1', 'H4'], brokerOffset: 0 }, status: { syncing: false } };
  const written = [];
  const bridge = { levelLogAppend: (h, t) => (written.push([h, t]), true), levelLogRead: () => written.map((w) => w[1]).join(''), levelLogClear: () => true };
  // A record started two days ago.
  D.clearLevelRecord(end - 2 * 86400, bridge);
  const start = D.readLevelState();
  assert.equal(start.at, end - 2 * 86400);
  const rec = D.recordLevels(store, { now: end + 60, budgetMs: 1e9, b: bridge });
  assert.equal(rec.at, end);
  assert.ok(rec.count.levels > 0, 'levels recorded');
  assert.ok(written.length > 0 && written[0][0] === LR.LEVEL_CSV_HEADER);
  const saved = D.readLevelState();
  assert.equal(saved.at, end);
  // Nothing new: nothing written.
  const n = written.length;
  D.recordLevels(store, { now: end + 120, budgetMs: 1e9, b: bridge });
  assert.equal(written.length, n);
  // The report reads the record back.
  const r = D.levelReport(end + 300, bridge);
  assert.ok(r.rows > 0);
  assert.ok(r.events.startsWith('level_id,'));
  assert.match(r.summary, /^XAUUSD Levels: level record summary/);
});

test('recordLevels: when the rows cannot be written, the state stays and the steps run again', () => {
  mem.clear();
  const end = utc(2026, 10, 26, 12);
  const raw = market(end, 24 * 40);
  const store = { raw, settings: { tfs: ['M15', 'H1'], brokerOffset: 0 }, status: { syncing: false } };
  let ok = false;
  const bridge = { levelLogAppend: () => ok, levelLogRead: () => '', levelLogClear: () => true };
  D.clearLevelRecord(end - 86400, bridge);
  assert.equal(D.recordLevels(store, { now: end + 60, budgetMs: 1e9, b: bridge }), null);
  assert.equal(D.readLevelState().at, end - 86400, 'not moved on');
  assert.match(D.levelRecProblem(), /cannot write/);
  // While a sync is running it waits.
  ok = true;
  D.clearLevelRecord(end - 86400, bridge);
  store.status.syncing = true;
  assert.equal(D.recordLevels(store, { now: end + 60, budgetMs: 1e9, b: bridge }), null);
  store.status.syncing = false;
  assert.equal(D.recordLevels(store, { now: end + 60, budgetMs: 1e9, b: bridge }).at, end);
});
