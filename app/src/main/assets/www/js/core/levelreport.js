// The level record's summary: from the record's rows (the events CSV), how
// often each kind of level held, broke and was retested, next to the same
// numbers for its random twins. Pure: CSV text in, CSV text out.

import { LEVEL_CSV_HEADER } from './levelrec.js';

const COLS = LEVEL_CSV_HEADER.split(',');

// Rows of the events CSV as objects. A row written twice (a step repeated
// after a failed save) counts once.
export function parseLevelCsv(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('level_id,')) continue;
    const f = line.split(',');
    if (f.length !== COLS.length) continue;
    const r = {};
    COLS.forEach((k, i) => (r[k] = f[i]));
    const key = `${r.level_id}|${r.event}|${r.test_no}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

const TFS = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
const list = (s) => (s ? s.split(' ').filter(Boolean) : []);

// [group, value, test, perLevel]: perLevel says whether "levels" and
// "reached" mean anything for the group (not for groups of events).
function groups(rows) {
  const out = [['All', 'All levels', () => true, true]];
  for (const tf of TFS) out.push(['Timeframe', tf, (r) => list(r.timeframes).includes(tf), true]);
  out.push(['Timeframe', 'No swing zone', (r) => !list(r.timeframes).length, true]);
  out.push(['Source', 'Swing zone', (r) => list(r.timeframes).length > 0, true]);
  out.push(['Source', 'Pivot', (r) => list(r.sources).some((s) => /^[DWM]-/.test(s)), true]);
  out.push(['Source', 'Previous high/low', (r) => list(r.sources).some((s) => /^P[DWM][HL]$/.test(s)), true]);
  out.push(['Source', 'Round number', (r) => list(r.sources).some((s) => /^\d+$/.test(s)), true]);
  out.push(['Source', 'Round number only', (r) => r.round_only === 'yes', true]);
  for (let s = 5; s >= 1; s--) out.push(['Strength', String(s), (r) => r.strength === String(s), true]);
  out.push(['Side', 'Support', (r) => r.side === 'support', true]);
  out.push(['Side', 'Resistance', (r) => r.side === 'resistance', true]);
  const sessions = [...new Set(rows.filter((r) => r.event !== 'not reached').map((r) => r.session || 'Between sessions'))].sort();
  for (const s of sessions) out.push(['Session', s, (r) => r.event !== 'not reached' && (r.session || 'Between sessions') === s, false]);
  out.push(['Test', '1st test', (r) => r.test_no === '1', false]);
  out.push(['Test', '2nd test', (r) => r.test_no === '2', false]);
  out.push(['Test', '3rd or later', (r) => Number(r.test_no) >= 3, false]);
  return out;
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '');
const mean = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '');

function stats(rows) {
  const tests = rows.filter((r) => r.event === 'test' && r.result !== 'data missing');
  const breaks = rows.filter((r) => r.event === 'after break' && r.result !== 'data missing');
  const n = (list, result) => list.filter((r) => r.result === result).length;
  return {
    tests: tests.length,
    held: n(tests, 'held'),
    broke: n(tests, 'broke'),
    unresolved: n(tests, 'unresolved'),
    swept: tests.filter((r) => r.swept === 'yes').length,
    move: mean(tests.map((r) => Number(r.move_atr)).filter(Number.isFinite)),
    breaks: breaks.length,
    reclaimed: n(breaks, 'reclaimed'),
    retestHeld: n(breaks, 'retest held'),
    retestFailed: n(breaks, 'retest failed'),
    noRetest: n(breaks, 'no retest'),
  };
}

export const SUMMARY_HEADER = [
  'group',
  'value',
  'levels',
  'reached_pct',
  'tests',
  'held_pct',
  'broke_pct',
  'unresolved_pct',
  'swept_pct',
  'avg_move_atr',
  'random_tests',
  'random_held_pct',
  'held_vs_random_pts',
  'margin_95_pts',
  'breaks',
  'reclaimed_pct',
  'retest_held_pct',
  'retest_failed_pct',
  'no_retest_pct',
  'random_breaks',
  'random_retest_held_pct',
  'retest_held_vs_random_pts',
];

// Difference of two shares in points and a rough 95% margin for it (tests
// of the same level are not independent, so the real margin is wider).
function diff(k1, n1, k2, n2) {
  if (!n1 || !n2) return ['', ''];
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const m = 1.96 * Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [(100 * (p1 - p2)).toFixed(1), (100 * m).toFixed(1)];
}

const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const utc = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

export const DEFINITIONS = [
  ['test', 'A 15-minute candle traded into the level from the side price came from.'],
  ['held', 'After the test, price moved 1 hourly ATR away from the level before a 15-minute candle closed through it (by 0.1 ATR, at least $0.30). On the test candle itself only its close counts.'],
  ['broke', 'A 15-minute candle closed through the level first.'],
  ['unresolved', 'Neither within 24 trading hours.'],
  ['swept', 'During the test a wick went through the level and the candle closed back on the level\'s side.'],
  ['avg_move_atr', 'How far price went away from the level in the expected direction during the test, in hourly ATR.'],
  ['reclaimed', 'After a break, a candle closed back through the level before price had gone 0.5 ATR beyond it (a false break).'],
  ['retest held', 'After a break, price went 0.5 ATR beyond, came back to the level, then moved 1 ATR away in the break direction before a candle closed back through it (support became resistance or the reverse).'],
  ['retest failed', 'After coming back, a candle closed back through the level first.'],
  ['no retest', 'Price went 0.5 ATR beyond and did not come back within 48 trading hours.'],
  ['random', 'Each level has two random twins: same side, same width, same distance from price, shown only while the level was. They are scored by the same rules. A level kind is useful only where it beats its twins by more than the margin.'],
  ['margin_95_pts', 'Rough 95% margin of the difference. Tests of the same level are related, so treat it as the least the difference must exceed.'],
  ['levels / reached', 'Levels recorded, and the share that price reached at least once. Blank for groups of events (session, test number).'],
];

// The summary CSV. meta: { now, since, at, gaps: [[from, to]] } from the
// record's state.
export function levelSummaryCsv(rows, meta = {}) {
  const real = rows.filter((r) => r.type === 'real');
  const rand = rows.filter((r) => r.type === 'random');
  const lines = [];
  lines.push('XAUUSD Levels: level record summary');
  if (meta.now) lines.push(`Made (UTC),${utc(meta.now)}`);
  if (meta.since) lines.push(`Recorded from (UTC),${utc(meta.since)}`);
  if (meta.at) lines.push(`Recorded up to (UTC),${utc(meta.at)}`);
  const gaps = meta.gaps || [];
  const hours = gaps.reduce((a, g) => a + (g[1] - g[0]) / 3600, 0);
  lines.push(`Not recorded,${gaps.length ? `${gaps.length} stretch${gaps.length > 1 ? 'es' : ''} of ${Math.round(hours)} hours in all (app closed over 7 days or data missing)` : 'none'}`);
  lines.push(`Rows in the record,${rows.length}`);
  lines.push('');
  lines.push(SUMMARY_HEADER.join(','));
  for (const [group, value, test, perLevel] of groups(real)) {
    const R = real.filter(test);
    if (!R.length) continue;
    const Q = rand.filter(test);
    const s = stats(R);
    const z = stats(Q);
    const ids = new Set(R.map((r) => r.level_id));
    const reached = new Set(R.filter((r) => r.event === 'test').map((r) => r.level_id));
    const [dHeld, mHeld] = diff(s.held, s.tests, z.held, z.tests);
    const [dRetest] = diff(s.retestHeld, s.breaks, z.retestHeld, z.breaks);
    lines.push(
      [
        q(group),
        q(value),
        perLevel ? ids.size : '',
        perLevel ? pct(reached.size, ids.size) : '',
        s.tests,
        pct(s.held, s.tests),
        pct(s.broke, s.tests),
        pct(s.unresolved, s.tests),
        pct(s.swept, s.tests),
        s.move,
        z.tests,
        pct(z.held, z.tests),
        dHeld,
        mHeld,
        s.breaks,
        pct(s.reclaimed, s.breaks),
        pct(s.retestHeld, s.breaks),
        pct(s.retestFailed, s.breaks),
        pct(s.noRetest, s.breaks),
        z.breaks,
        pct(z.retestHeld, z.breaks),
        dRetest,
      ].join(','),
    );
  }
  lines.push('');
  lines.push('How to read it');
  for (const [k, v] of DEFINITIONS) lines.push(`${q(k)},${q(v)}`);
  return lines.join('\n') + '\n';
}
