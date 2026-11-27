// The level record on the phone: runs core/levelrec.js on the app's own
// candles, from the app screen and from the background monitor, and keeps
// its rows. On Android the rows go to a file in the app's storage (through
// the bridge, see LevelLog.kt), which grows by about 4 MB a year; in a
// browser they go to localStorage, trimmed to the newest rows. The record's
// working state (the levels being followed) is small and lives in
// localStorage.
//
// Both pages may run it. Each call reads the state, does its steps, writes
// the rows and then the state in one go (JavaScript of all the app's pages
// runs on one thread), so the second page finds the steps done. If the
// state cannot be saved after the rows were, the steps run again and the
// rows are written twice; the report counts each once.

import { analyse, buildSeries, closedOnly, latestObservation } from '../core/model.js';
import { LEVEL_CSV_HEADER, createRecord, levelRowCsv, runRecord } from '../core/levelrec.js';
import { levelSummaryCsv, parseLevelCsv } from '../core/levelreport.js';

const STATE_KEY = 'xau.levels.state.v1';
const LOG_KEY = 'xau.levels.log.v1';
const LOG_MAX = 1500000; // characters kept in the browser fallback

const nowSec = () => Math.floor(Date.now() / 1000);
const clockMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export function nativeLog() {
  if (typeof window === 'undefined') return null;
  const b = window.AndroidApp || window.AndroidMonitor;
  return b && b.levelLogAppend ? b : null;
}

export function readLevelState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    return s && s.v === 1 && Array.isArray(s.open) && Number.isFinite(s.at) ? s : null;
  } catch {
    return null;
  }
}

function saveState(rec) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

function appendLog(lines, b) {
  if (!lines.length) return true;
  const text = lines.join('\n') + '\n';
  if (b) {
    try {
      return !!b.levelLogAppend(LEVEL_CSV_HEADER, text);
    } catch {
      return false;
    }
  }
  try {
    let cur = (localStorage.getItem(LOG_KEY) || '') + text;
    if (cur.length > LOG_MAX) {
      cur = cur.slice(cur.length - LOG_MAX);
      cur = cur.slice(cur.indexOf('\n') + 1);
    }
    localStorage.setItem(LOG_KEY, cur);
    return true;
  } catch {
    return false;
  }
}

// The record's rows as CSV text (with or without the header line).
export function readLevelLog(b = nativeLog()) {
  if (b) {
    try {
      return String(b.levelLogRead() || '');
    } catch {
      return '';
    }
  }
  try {
    return localStorage.getItem(LOG_KEY) || '';
  } catch {
    return '';
  }
}

// Throw the record away and start a new one now.
export function clearLevelRecord(now = nowSec(), b = nativeLog()) {
  if (b) {
    try {
      if (!b.levelLogClear()) return false;
    } catch {
      return false;
    }
  } else {
    try {
      localStorage.removeItem(LOG_KEY);
    } catch {
      /* ignore */
    }
  }
  resetRunner();
  return saveState(createRecord(now));
}

// The feeds' candles closed by T, as the app held them then: each feed cut
// at its last candle that ended by T.
const FEED_SEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, D1U: 86400 };
export function cutRaw(raw, T) {
  const out = {};
  for (const [k, s] of Object.entries(raw || {})) {
    const sec = FEED_SEC[k];
    if (!sec || !s) continue;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (s[m].t + sec <= T) lo = m + 1;
      else hi = m;
    }
    out[k] = lo === s.length ? s : s.slice(0, lo);
  }
  return out;
}

// In-memory pacing for this page.
let lastTry = 0;
let lastKey = '';
let more = false;
let pausedUntil = 0;
let problem = null;

// Why the record is not running, or null.
export const levelRecProblem = () => problem;

function resetRunner() {
  lastTry = 0;
  lastKey = '';
  more = false;
  pausedUntil = 0;
  problem = null;
}

// Bring the record up to date from the store's candles. Cheap when there is
// nothing new; otherwise works for about `budgetMs` and goes on at the next
// call (`more`). Returns the record's state, or null when it did not run.
export function recordLevels(store, { now = nowSec(), budgetMs = 120, b = nativeLog() } = {}) {
  if (now < pausedUntil) return null;
  if (!more && now - lastTry < 20) return null;
  // While a sync is filling in the feeds, an older step would see some
  // feeds updated and others not.
  if (store.status && store.status.syncing) return null;
  lastTry = now;
  const raw = store.raw;
  const m1 = raw.M1 || [];
  const m15 = raw.M15 || [];
  let rec = readLevelState();
  if (!rec) {
    rec = createRecord(now);
    if (!saveState(rec)) return fail(now, 'The level record cannot be saved: storage is full or switched off.');
  }
  // Nothing new since the last look: no candle has closed since the last
  // step, or the candles have not changed.
  const key = `${rec.at}:${m1.length && m1[m1.length - 1].t}:${m1.length && m1[m1.length - 1].asOf}:${m15.length && m15[m15.length - 1].t}:${m15.length}`;
  if (!more && (Math.floor(now / 900) * 900 <= rec.at || key === lastKey)) return rec;
  lastKey = key;
  more = false;
  const obs = latestObservation(raw, now);
  if (!obs) return rec;
  const t0 = clockMs();
  const s = store.settings;
  let res;
  try {
    const candles = closedOnly(buildSeries(raw).M15, 'M15', obs.at);
    res = runRecord(rec, {
      candles,
      knownTo: obs.at,
      now,
      analyseAt: (T) => analyse(cutRaw(raw, T), { now: T, tfs: s.tfs, offset: s.brokerOffset }),
      stop: () => clockMs() - t0 > budgetMs,
    });
  } catch (e) {
    console.error(e);
    return fail(now, `The level record stopped on an error: ${e.message || e}`);
  }
  // Rows first: if they cannot be written, nothing is saved and the same
  // steps run again later.
  if (!appendLog(res.rows.map(levelRowCsv), b)) return fail(now, 'The level record cannot write its file.');
  if (!saveState(rec)) return fail(now, 'The level record cannot be saved: storage is full or switched off.');
  problem = null;
  more = res.more;
  return rec;
}

function fail(now, message) {
  problem = message;
  pausedUntil = now + 600;
  return null;
}

// The two report files: the summary and every row.
export function levelReport(now = nowSec(), b = nativeLog()) {
  const text = readLevelLog(b);
  const rows = parseLevelCsv(text);
  const rec = readLevelState() || {};
  const summary = levelSummaryCsv(rows, { now, since: rec.since, at: rec.at, gaps: rec.gaps });
  const events = text.startsWith('level_id,') ? text : `${LEVEL_CSV_HEADER}\n${text}`;
  return { summary, events, header: LEVEL_CSV_HEADER, rows: rows.length };
}
