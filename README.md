# XAUUSD Levels

An Android app that shows support and resistance for spot gold (XAU/USD)
across several timeframes, with a live price.

It is an analysis aid. It does not give buy or sell signals and is not
financial advice.

## What it shows

- **Overview**: live price, the nearest multi-timeframe support and resistance
  areas above and below price, trend per timeframe, and the day's range.
- **Levels**: zones for each timeframe (M5, M15, M30, H1, H4, D1, W1), the
  multi-timeframe areas, and daily / weekly / monthly pivot points with the
  previous period's high, low and close.
- **Chart**: candles with the levels drawn on them.
- **Trades**: plan a trade from a level and save it with an alert at its
  entry; a trade journal with your own statistics.
- **Settings**: alerts, your broker (price offset, day boundary), timeframes,
  refresh rate, data source, data status.
- **Home-screen widget**: price, change and the nearest resistance and
  support, updated while the app or background monitoring runs.

## Tools for trading (1.6)

- **Trade planner**: tap any level on Overview or Levels. A long at support
  enters at the area's top edge with the stop below it (a quarter of the
  hourly ATR plus the spread beyond the area); a short at resistance the
  other way round. Targets are the near edges of the next areas, each with
  its reward-to-risk. From your balance and risk per trade it works out the
  lot size (rounded down, 100 oz per lot unless you change it). A saved plan
  sends a notification when the price touches its entry: the ask for a buy,
  the bid for a sell (with background monitoring on). It is a price alert;
  no order is placed. Editing a plan saves it as a new one. Up to 50 plans;
  a full list refuses new ones rather than dropping old ones.
- **Trade journal**: log the trades you take (from a plan or by hand): entry,
  stop, target, exit, lots, setup, timeframe, notes; the session is filled in
  from the time. Each trade keeps the contract size it was logged with.
  Statistics: win rate, average R (expectancy), profit and loss, profit
  factor, by setup, session and direction. Share it as a CSV file (the
  whole journal; text that a spreadsheet could read as a formula is
  prefixed with an apostrophe). Up to 2,000 trades, all reachable with
  "Show older"; a full journal refuses new trades rather than dropping old
  ones.
- **Sessions**: Asia (Tokyo 09:00-18:00), London and New York (08:00-17:00
  local, with their own daylight saving): current session, each one's high
  and low and its 30-minute opening range; also as chart lines.
- **Market structure**: per timeframe, the last swing high (HH / LH / EH for
  equal within 0.05 ATR) and low (HL / LL / EL) and the latest break of
  structure (BOS), or change of character
  (CHoCH) when it broke against the one before; in the trend table, the
  Levels screen and as chart lines.
- **Your broker**: a price offset (type your broker's bid and tap "Match my
  broker") so every level, candle and alert reads in your broker's prices, and
  the day boundary: 17:00 New York (GMT+2/+3 servers, the default) or 00:00 UTC
  (GMT+0 servers such as Exness).
- **More alerts**: breaks confirmed on a 15-minute or 1-hour candle close
  instead of the live price; **break and retest** (an approach, within 48
  hours, to an area price broke, from the new side); **liquidity sweeps** (a
  candle wicks beyond an area and closes back).

Sweeps and retests were measured before release (`tools/research/events.mjs`,
two years of hourly and ten months of 15-minute data): at the
multi-timeframe areas they were followed by a 1 ATR move in the expected
direction as often as the same events at matched random bands (hourly
sweeps 44% vs 44%, retests 59% vs 61%; 15-minute sweeps 34% vs 33%, retests
41% vs 40%). They describe what price is doing at a level; they are not a
signal on their own, and the app says so.

## Alerts

Settings > Alerts > Start background monitoring. A notification is sent when
price:

- comes **near** a multi-timeframe area it had been away from, or
- moves **through** an area to the other side (judged on the live price, not
  on a candle close).

You choose the minimum rank of area and the distance that counts as near.
Nothing fires on first sight of a level, and only a move of the price (not a
level being recalculated) can raise an alert. All alerts pause while the
market is closed, while the live price is not live (see below), and while the
minute candles stop updating. Beyond that each area is judged on its own
inputs: it waits while a timeframe it comes from is still loading its history
(a cold start), is out of date or has missing candles, or while a feed it is
built from has a problem. Areas from other timeframes keep alerting. An area
made only of a round number does not alert unless you switch that on, and
pivots from an estimated period never do. An alert that follows a pause says
so.

Monitoring is a foreground service (`MonitorService.kt`) that runs the same
analysis as the app in a WebView with no screen, so alerts always agree with
the levels shown. While it is on there is a permanent notification. The page
sends a heartbeat on every check; Settings shows what it is doing (checking
levels, loading history, paused and why). If the heartbeat stops for 90
seconds the page is rebuilt, and after three failed rebuilds monitoring stops
and says so instead of showing "On". It keeps the phone awake only while the
market is open, with a 10-minute wake lease that heartbeats renew; while the
market is closed the phone can sleep and an alarm wakes monitoring at the
reopening (Android may deliver it a few minutes late). While the market is
open a check-up alarm runs every 15 minutes. If Android has killed the app
while monitoring was on, either alarm starts it again. It does not restart by
itself after a reboot or an app update, and Android can still pause it when
the phone sits idle for a long time; setting
the app's battery use to Unrestricted helps. Settings warns when notifications,
or just the "Level alerts" category, are switched off.

### When data counts as current

- **Live price**: received in the last 90 seconds (measured on a clock that
  changing the phone's time does not affect), its own timestamp moved in the
  last 2 minutes, at most 90 seconds old and not more than 15 seconds in the
  future by the price server's clock (from its Date header, so a wrong phone
  clock does not matter), and the market is open. A quote older than the one
  already held is ignored. Otherwise the app shows the latest candle price:
  the one from whichever candle feed was updated most recently.
- **Candles**: each feed is tracked on its own, and only feeds the enabled
  timeframes need are fetched. A failed or empty answer is an error for that
  feed, shown until it recovers, and retried after 30 s, doubling to at most 5
  minutes. A timeframe whose candles stop before the newest observation's
  period is marked out of date. Every request is numbered; an answer is merged
  into the candles as they are when it arrives, and a slow older request never
  overwrites what a newer one brought.
- **Closed candles only**: zones are found on closed candles; the forming one
  is shown on the chart but cannot make or remove a zone.
- **Missing data**: a gap the market traded through (not a weekend, the daily
  break or a holiday) is marked on the candles after it and on the H4 / day
  candles built from them. A swing next to such a hole is not counted. Daily
  candles built from hourly data are used only from the first day the hourly
  history fully covers; older days rebuilt from UTC daily candles are marked
  estimated, and pivots from an estimated period are labelled and never alerted
  on.
- **Rate limits**: when a provider answers 429 (or 503 with Retry-After),
  nothing is sent to it, from any page of the app, until the wait it asked for
  is over; without Retry-After the wait starts at 30-60 s and doubles. Failed
  quote and minute-candle requests also back off.
- Malformed candles and quotes (duplicate times, impossible highs and lows,
  crossed prices, missing timestamps) are dropped before use, including from
  saved data.
- Twelve Data requests from the app and the monitor share one budget (7 a
  minute, 780 a day) so the free plan is not exceeded; the native proxy also
  allows at most 8 a minute across both.

### The chart

Candles are the candle feed's own (Dukascopy or Twelve Data bid). The live
Swissquote price is drawn as a separate dashed "Live" line and never written
into a candle, so the chart shows only highs and lows the analysis also saw.
With no candles for a timeframe or feed (yet), the chart is cleared rather than
left showing another one's.

## How levels are calculated

- **Zones**: swing highs and lows are grouped when they sit within a fraction
  of ATR of each other. A zone scores higher for more touches, more recent
  touches, sharper reversals, and having acted as both support and
  resistance; it scores lower when price has chopped through it repeatedly.
  Each zone is drawn as a narrow band (centre +- 0.1 ATR on M5 to H4, less on
  D1 and W1), centred on the densest swing price on M5 to H4.
- **Pivots**: classic floor pivots (PP, R1 to R3, S1 to S3).
- **Multi-timeframe areas**: zones from every enabled timeframe, pivots,
  previous highs and lows, and round numbers are pooled; levels at nearly the
  same price form one area, weighted towards higher timeframes, drawn as its
  centre +- 0.1 hourly ATR.
- **Candles**: H4, D1, W1 and monthly candles are built from hourly data on
  New York close (17:00 New York) boundaries, the convention most MT4/MT5
  brokers use, so they should match a broker chart closely.

The code is in `app/src/main/assets/www/js/core/`.

### How well the levels work

`tools/sr-backtest.mjs` tests the zones walk-forward: at each test point the
engine sees only past candles, and its zones are scored on the next 6 hours
(M5) to 6 weeks (W1). Settings were chosen on the first 60% of the history and
checked on the last 40%.

**Corrected results, 22 November 2026.** The 1.4.0 developer audit (F08)
showed that the earlier control made the levels look better than they are: it
placed random lines anywhere within 6 ATR, while real levels sit nearer price.
Since 1.5 each real zone is compared with random twins on the same side of
price, with the same width and at the same distance (0.5 ATR bands); real and
random are scored on the same test points; everything scored stays inside the
window; equal highs count once; and a touch must trade inside the band. The +-
is the standard error across 8 time blocks.

Points above matched random bands, Dukascopy history to 20 Nov 2026
(tune / check):

| | Turned at the zone, when reached | Turning points marked beforehand |
|---|---|---|
| M5 zones (3 months) | +1.0 / +1.2 (+-1) | +0.6 / +0.4 (+-1) |
| M15 zones (10 months) | -0.1 / -0.2 (+-2) | +0.6 / +1.5 (+-1) |
| H1 zones (2 years) | -0.6 / +1.8 (+-1) | +0.4 / +2.7 (+-1 / 2) |
| H4 zones (2 years) | -1.4 / +2.7 (+-2) | -2.1 / +0.8 (+-2 / 3) |
| D1 zones (9 years) | +0.3 / +0.5 (+-1) | +7.2 / +3.7 (+-4 / 3) |
| Multi-TF areas, hourly chart | +1.6 / +0.9 (+-1) | **+5.4 / +4.6 (+-1)** |

What this means:

- Single-timeframe zones are at best a few points better than random bands at
  the same distance, often within noise. The multi-timeframe areas (what the
  Overview and the alerts use) are the one result clearly above noise in both
  parts: they mark about 5 points more of the later turning points than random
  bands placed the same way.
- Price reaching a level turns there about as often as at a random band
  (reaction: 37% real vs 37% random on H1). Treat levels as places to watch,
  not as signals; strength is a ranking, not a probability.
- W1 (and partly D1) cannot be judged this way: with the turning point's wing
  required inside a 6-week window, there are almost none to score.
- Against the old control the same zones showed +2 to +14 points; those older
  numbers below are kept as history, not as a claim. No setting was re-tuned
  on the corrected test yet; that is the next step before any change to the
  scores.

<details><summary>Earlier results (old control, overstated)</summary>

Version 1.2 against 1.1, on the checked part (points above random lines
placed anywhere within 6 ATR):

| | M5 | M15 | H1 | H4 |
|---|---|---|---|---|
| Zone width, x ATR (1.1 → 1.2) | 0.71 → 0.13 | 0.57 → 0.12 | 0.39 → 0.11 | 0.27 → 0.08 |
| Turned at the zone, when reached | -1 → +3 | -1 → +2 | +4 → +4 | +1 → +2 |
| Turning points marked beforehand | +3 → +6 | +4 → +5 | +6 → +7 | +6 → +6 |

Multi-timeframe areas (1.4), same old control, tune / check: turning points
marked +11 / +14 (H1-W1 timeframes), +13 / +18 (app default timeframes).

</details>

### Multi-timeframe areas (1.4)

Each source of levels was scored on its own against random lines (old
control, see above), on the hourly chart (2 years, next 48 hours) and on the
15-minute chart (10 months, next 16 hours):

| Source | Hourly chart | 15-minute chart |
|---|---|---|
| H1 swing zones | best: marked +5/+8 more turning points | neutral |
| M15 swing zones | – | +4/+5 |
| Pivot R1/S1 | slightly better | mixed |
| Round $50 / $100 | slightly better | price turned there more often (+2 to +14) |
| D1 and W1 swing zones | **worse** than random lines | neutral |
| Pivot R3/S3, previous month high/low | **worse** than random lines | worse / – |
| Previous day high/low, Asia session high/low | – | **worse** than random lines |
| Volume-profile peaks, ATR zigzag swings | no better than random | – |

The area weights follow these results (`TF_WEIGHT` etc. in
`js/core/confluence.js`): H1 zones and R1/S1 pivots count most, round
numbers more than before, D1/W1 zones and the previous month's high/low
little, R3/S3 pivots not at all. Under the corrected test the weighted areas
still beat the 1.1-style areas (turning points marked +5.4 / +4.6 against
+3.1 / +4.1), but by less than the old test said; the weights have not been
re-derived with the matched control yet.

Tried and not adopted, because they did not beat the then-current version on
both parts of the history: weighting swings by volume or by rejection-wick
length, volume-profile levels, ATR zigzag swings, a level's past
reversal/break record, a trend filter, $10 round numbers, dropping the
previous day's high/low, other area widths and centres. A model of which
reached level price turns at found no usable signal.

```sh
NODE_USE_ENV_PROXY=1 node tools/sr-backtest.mjs --fetch data   # history from Dukascopy
node tools/sr-backtest.mjs data            # zones per timeframe, 1.1 vs current
node tools/sr-backtest.mjs data areas      # multi-timeframe areas
node tools/sr-backtest.mjs data strength   # strength bars vs outcome
node tools/research/sources.mjs . data     # each source alone, hourly chart
node tools/research/sources15.mjs . data   # each source alone, 15-minute chart
node tools/research/features2.mjs . data   # level properties vs outcome
node tools/research/events.mjs . data      # sweeps and retests vs random bands
```

## Data sources

| Data | Source | Notes |
|---|---|---|
| Candles | Dukascopy chart feed | Spot XAU/USD bid, no key. This is the unofficial feed behind Dukascopy's own chart widgets: it can change or stop without notice, and is for personal use. |
| Candles (backup) | Twelve Data | Optional. Needs your own free API key, entered in Settings. Not tested against the live API (no key was available during development). |
| Live price | Swissquote public quotes | Bid / ask, no key. |

Spot gold trades from Sunday 18:00 to Friday 17:00 New York time. Outside
those hours the app still opens and shows the levels, but the price does not
move.

## Install

Copy the APK to an Android phone (Android 8.0 or newer) and open it. Android
will ask you to allow installing from that source.

## Build

Needs JDK 17 or newer and the Android SDK (platform 35, build-tools 35).

```sh
echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

Builds are signed with the key in `keystore/` (see `keystore/README.md`).

## Develop

The UI is plain HTML, CSS and JavaScript in `app/src/main/assets/www`, shown
in a WebView. The Android shell (`MainActivity.kt`, `AppWebClient.kt`,
`ApiProxy.kt`) serves those files and forwards data requests to the feeds.

```sh
npm test                    # unit tests: analysis, store, monitor, scoring rules (Node 22+)
node tools/dev-server.mjs   # run the UI in a desktop browser: http://127.0.0.1:8765
node tools/live-check.mjs   # print the analysis for the live market
LIVE_TESTS=1 ./gradlew testDebugUnitTest   # native proxy against the real feeds
```

Charts use [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0).
