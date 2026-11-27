# XAUUSD Levels 1.7.0

## Level record

The owner asked for a record of every level the app shows: which timeframe
it came from, how price reacted (rejected or not), how often it was
retested, whether retests failed or confirmed, and a report to download for
their own analysis of which timeframes' levels work. Their choices: record
from the day of install (no back-filled history), CSV report only (no
in-app statistics screen), definitions left to the developer.

**Where:** Settings › Level record. It shows since when the record runs, up
to which candle, how many levels, tests and breaks, and any stretch that
could not be recorded. "Download report (CSV)" shares two files through the
Android share sheet (Drive, Gmail, Sheets…); "Start over" deletes the
record after a second tap.

**The two files:**

- `xauusd-level-summary.csv`: one line per group. The groups are all levels
  and each timeframe, source (swing zone, pivot, previous high/low, round
  number), strength, side, session and test number. Each line has levels
  recorded and reached, tests, held / broke / unresolved / swept %, the
  average move, and after breaks reclaimed / retest held / retest failed /
  no retest %. Next to them are the same numbers for random levels, and the
  difference with a rough 95% margin. Definitions are at the bottom.
- `xauusd-level-events.csv`: every event, one row each.

**Definitions** (15-minute candles, hourly ATR "A" when the level was
recorded; see README › Level record):

| Result | Meaning |
|---|---|
| test | a candle trades into the area |
| held | price then moves 1 A away before a candle closes through the area by the break buffer (0.1 A, at least $0.30); on the test candle only its close counts |
| broke | that close comes first |
| swept | a wick went through and the candle closed back |
| reclaimed | after a break, a close back before price went 0.5 A beyond (false break) |
| retest held | went 0.5 A beyond, came back to the area, then 1 A away the break's way |
| retest failed | after coming back, closed back through |
| no retest | did not come back within 48 trading hours |

**Fair comparison.** Each level gets two random twins: same side, width and
distance from price, shown exactly while the level is, scored by the same
rules. Without them a "30% held" means nothing: the rules themselves decide
much of the rate (a 1 A move one way against a small close the other way).

**No look-ahead.** A level is recorded when it is first shown, before price
reaches it. Steps run late (after the app was closed) rebuild the areas
from the candles closed at that time only.

## Measured on past data

Run over the 60 days of Dukascopy history to 13 Nov 2026 as if the app had
been open throughout (`tools/research/levelrec.mjs`), the app's levels held
about as often as their random twins: 29.8% of 698 tests against 30.2% of
1,303 (difference −0.4 points, margin ±4.2). After a break, retests held
16.7% against 15.9%. No timeframe, source or strength was clearly better
than its twins in that stretch (for example H4 +4.4 ± 10.7 points,
strength 5 +4.8 ± 10.7). The phone's own record, kept from install, shows
whether that changes.

## Other changes

- The 15-minute feed is always loaded now (the record scores on it), also
  when the M15 timeframe is switched off.
- Settings: version 1.7.0.

## Checks

- **Unit tests:** 112 JavaScript tests pass (15 new in
  `tests/levelrec.test.mjs`: holds, breaks, sweeps, each follow-up after a
  break, the mirror image for resistance, the twins, the broker offset,
  steps run late seeing only closed candles, holes in the data, the 7-day
  limit, the CSV columns and the summary, and the driver writing rows before
  its state). Kotlin unit tests pass; lint reports no errors.
- **Browser (mocked feeds):** a record started a day earlier caught up, the
  Settings card showed it, the report downloaded as two files, and "Start
  over" deleted it only on the second tap. No page errors.
