# Response to the 1.4.0 developer audit (version 1.5.0)

Audit: "XAUUSD Levels 1.4.0 — Android and support/resistance audit",
22 November 2026, findings F01-F12. Each finding was checked against the 1.4.0
source before anything was changed. All twelve describe real behaviour.
F02-F12 are fixed in 1.5.0. F01 was left unchanged on the owner's decision.

Tests: 70 JavaScript tests (`npm test`; 23 new ones cover the audit's probes)
and 5 Kotlin unit tests (`./gradlew testDebugUnitTest`; 3 new). The three
chart probes were repeated in Chromium with mocked feeds.

| # | Verdict | What changed in 1.5.0 | Test |
|---|---|---|---|
| F01 Signing key | Confirmed | Nothing. The owner decided to keep the current key: the developer who received the source is on the owner's team. | – |
| F02 Forming and incomplete bars | Confirmed (P01, P02) | Zones come from closed candles only (`closedOnly` in `model.js`). Feed holes are marked (`markGaps`, `unexpectedGap` in `time.js`), and weekends, the daily break and holiday closures are told apart from real holes. Swings whose window contains a hole, or a period the history starts partway into, are skipped (`findSwings`). H4 and day candles inherit the marks, and the analysis lists timeframes with a hole among their newest candles (`gaps`). | `audit-1.4.test.mjs`: forming candle, hole vs closure, missing hour |
| F03 Delayed poll overwrites newer history | Confirmed (P08) | Every candle request is numbered. Answers are merged into the series as it is when they arrive (`_commit`), and on shared candles the newer request wins. A slow old poll can no longer drop a correction or a newer candle. The minute poll refetches any stretch it missed. | `store.test.mjs`: late poll after a newer sync, in memory and after reload |
| F04 Old or future quote accepted | Confirmed (P03, P06) | Quote age is measured against the server's clock (the feed's Date header, passed on by the proxy as X-Upstream-Date). The limits are 90 s old and 15 s in the future; the old ±10-minute window is gone. A quote older than the one held is ignored. Without a live quote, the price is the latest candle observation from any feed (`latestObservation`), not the first non-empty timeframe. | `store.test.mjs`: 9 min old, 9 min future, phone clock 10 min fast, out of order; `audit-1.4.test.mjs`: stale M1 vs newer H1 |
| F05 429 and cooldowns | Confirmed (P07) | The native proxy (`ApiProxy.Gate`, shared by the app screen and the monitor) honours Retry-After (seconds or a date) for each host. It sends nothing to that host until the wait is over; without Retry-After the wait is 30 s, doubling to 10 min. It passes Retry-After to the page and allows Twelve Data at most 8 requests a minute across both pages. In the page, every candle request goes through `_candles`, which keeps a per-provider cooldown that minute polls, retries and manual refresh all respect. Failed quote and minute polls back off. | `ApiProxyTest`: Retry-After parsing, per-host hold, Twelve Data limit; `store.test.mjs`: 429 holds polls, retries and refresh; quote back-off |
| F06 Round-number area alerting during warmup | Confirmed (P05) | A timeframe counts as ready only with enough closed history (`READY_MIN`) and current data. Areas carry `reference` (round numbers only), `approx` (an estimated pivot), `tfs` and `feeds`. `gateAreas` holds an area back until its inputs are ready. Round-number-only areas alert only if switched on in Settings. During warmup the monitor says it is loading history and sends nothing. The lists show such an area as "round number", without strength bars. | `audit-1.4.test.mjs`; `monitor.test.mjs`: one M1 candle, quotes 3994 → 3999, no alert, heartbeat "warmup" |
| F07 One feed failure pauses everything | Confirmed (P12) | Feeds for timeframes that are switched off are no longer fetched or reported. Alerts are gated per area on its own timeframes and feeds; only the minute candles and the live price (inputs of every area) pause all alerts. The status lists the timeframes that wait. | `store.test.mjs`: M5 off; `audit-1.4.test.mjs`; `monitor.test.mjs`: M15 failing, an H1 area still alerts |
| F08 Backtest controls | Confirmed (P09, P10) | The main control is now matched random bands: same side, width and 0.5 ATR distance band. Real and random levels are scored on the same windows, labels stay inside the horizon, equal highs and lows count once, and a touch must overlap the band (a gap past it is a "jump"). The candle at the tune/check split is left out. Uncertainty comes from time blocks. Corrected results are in the README, dated; the old ones are kept as history and marked as overstated. | `backtest.test.mjs`: one test per rule |
| F09 Chart keeps old bars | Confirmed (P11) | With no candles for the timeframe or feed, the chart clears candles, EMAs, level lines, the live line, hover and legend. | Chromium: cached 4H, then cleared offline → 0 bars; provider switch while loading → 0 bars |
| F10 Service "On" without a working loop | Confirmed (source) | The monitor page sends a heartbeat (running / warmup / paused) on its checks. If none arrives for 90 s, the page is rebuilt; after three rebuilds the service posts "alerts stopped" and stops. The wake lock is a 10-minute lease that heartbeats renew. Settings shows the service's real state. | Emulator: state reported as running / paused |
| F11 Partial days feed pivots | Confirmed (P04) | Days built from hourly candles replace the older days only from the first fully covered day. Days rebuilt from UTC daily candles are marked `approx`. Pivots from an estimated, partial or holed period are flagged, labelled "estimated pivot" and never alerted on. | `core.test.mjs`, `audit-1.4.test.mjs` |
| F12 Quote ticks change candles | Confirmed (P13) | The chart no longer writes the Swissquote price into candles. The live price is a separate dashed "Live" line, the legend names both sources, and the live line is kept on the price scale. | Chromium: provider high 4,003.19 stays while the Live line shows 4,007 |

## Corrected backtest (F08), 22 November 2026

Points above matched random bands, check part (tune part in the README):

- Single-timeframe zones: M5 +1.2 turn / +0.4 capture; M15 −0.2 / +1.5;
  H1 +1.8 / +2.7; H4 +2.7 / +0.8. Each is within about two standard errors.
- Multi-timeframe areas (Overview and alerts): +0.9 turn / +4.6 capture,
  ±1. The capture lift is +5.4 in the tune part, so it holds in both.
- Against the old uniform control, the same zones showed +2 to +14.

The edge is smaller than earlier versions claimed. Most of it is in the
multi-timeframe areas, and reached levels do not turn more often than random
bands. Nothing in the S/R scoring was re-tuned on the corrected test.

## Not done, and why

- **F01**: kept on the owner's instruction.
- **F03 / F05, one shared data repository for both pages**: the screen and
  the monitor still each fetch for themselves. What they share is the native
  proxy's per-host cooldown and Twelve Data limit, so together they cannot
  exceed a provider's limit. Each page's merge is ordered. Their saved candle
  copies still overwrite each other (last writer wins; both hold valid data).
- **F08, replaying the final alert logic** with timed quote and candle
  inputs: not built. Re-deriving the area weights with the matched control
  is the next research step.
- **F10, on-device failure cases**: script-load failure, device idle,
  process restart and Android 13-16 behaviour were not tested on hardware.
- **F11, broker-specific alignment** (for example Exness H4/D1 boundaries):
  not verified. The app uses the New York close convention.
