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
- **Settings**: alerts, timeframes, refresh rate, data source, data status.

## Alerts

Settings > Alerts > Start background monitoring. A notification is sent when
price:

- comes **near** a multi-timeframe area it had been away from, or
- moves **through** an area to the other side (judged on the live price, not
  on a candle close).

You choose the minimum strength of area and the distance that counts as near.
Nothing fires on first sight of a level, and only a move of the price (not a
level being recalculated) can raise an alert. Alerts pause while the market is
closed, while the live price is not live (see below), and while any candle
feed has a problem or a timeframe is out of date. An alert that follows such a
pause says so.

Monitoring is a foreground service (`MonitorService.kt`) that runs the same
analysis as the app in a WebView with no screen, so alerts always agree with
the levels shown. While it is on there is a permanent notification. It keeps
the phone awake only while the market is open; while it is closed the phone
can sleep and an alarm wakes monitoring at the reopening (Android may deliver
it a few minutes late). It does not restart by itself after a reboot, and
Android can still pause it when the phone sits idle for a long time; setting
the app's battery use to Unrestricted helps. Settings warns when notifications,
or just the "Level alerts" category, are switched off.

### When data counts as current

- **Live price**: received in the last 90 seconds (measured on a clock that
  changing the phone's time does not affect), its own timestamp moved in the
  last 2 minutes and is within 10 minutes of the phone's clock, and the market
  is open. Otherwise the app shows the last candle close.
- **Candles**: each feed is tracked on its own. A failed or empty answer is an
  error for that feed, shown until it recovers, and retried after 30 s,
  doubling to at most 5 minutes. A timeframe whose candles stop before the
  newest candle's period is marked out of date.
- Malformed candles and quotes (duplicate times, impossible highs and lows,
  crossed prices, missing timestamps) are dropped before use, including from
  saved data.
- Twelve Data requests from the app and the monitor share one budget (7 a
  minute, 780 a day) so the free plan is not exceeded.

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
(M5) to 6 weeks (W1). The scores are compared with random lines of the same
count and width, and settings were chosen on the first 60% of the history and
checked on the last 40%.

Version 1.2 against 1.1, on the checked part (points above random lines):

| | M5 | M15 | H1 | H4 |
|---|---|---|---|---|
| Zone width, x ATR (1.1 → 1.2) | 0.71 → 0.13 | 0.57 → 0.12 | 0.39 → 0.11 | 0.27 → 0.08 |
| Turned at the zone, when reached | -1 → +3 | -1 → +2 | +4 → +4 | +1 → +2 |
| Turning points marked beforehand | +3 → +6 | +4 → +5 | +6 → +7 | +6 → +6 |

D1 and W1 kept their settings (the new ones did worse there) and are only
drawn narrower. What the test also shows:

- Levels mark where price turns somewhat better than random lines, but price
  reaching a level turns there only a few points more often than at a random
  line. Treat levels as places to watch, not as signals.
- The strength bars measure how much history backs a level. They did not
  predict which levels price turned at, and neither did touches, age or
  distance from price.

### Multi-timeframe areas (1.4)

Each source of levels was scored on its own against random lines, on the
hourly chart (2 years, next 48 hours) and on the 15-minute chart (10 months,
next 16 hours):

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

The area weights now follow these results (`TF_WEIGHT` etc. in
`js/core/confluence.js`): H1 zones and R1/S1 pivots count most, round
numbers more than before, D1/W1 zones and the previous month's high/low
little, R3/S3 pivots not at all. Before, the D1 and W1 zones counted most.

Areas, points above random lines (tune / check):

| | 1.3 | 1.4 |
|---|---|---|
| Hourly chart, H1-W1 timeframes, turning points marked | +6 / +7 | **+11 / +14** |
| Hourly chart, app default timeframes, turning points marked | +11 / +13 | **+13 / +18** |
| Hourly chart, price turned at a reached area | +0 / +2 | +2 / +3 |
| 15-minute chart, turning points marked | +5 / +5 | +5 / +5 |

On the newest week (14-20 Nov 2026, not used for any choice) the 15-minute
results were within noise of each other (about 5 independent test points).

Tried and not adopted, because they did not beat the current version on
both parts of the history: weighting swings by volume or by rejection-wick
length, volume-profile levels, ATR zigzag swings, a level's past
reversal/break record, a trend filter (+2 to +3 points at best), $10 round
numbers, dropping the previous day's high/low, other area widths and
centres. A model of which reached level price turns at found no usable
signal, so strength is still not a probability.

```sh
NODE_USE_ENV_PROXY=1 node tools/sr-backtest.mjs --fetch data   # history from Dukascopy
node tools/sr-backtest.mjs data            # zones per timeframe, 1.1 vs current
node tools/sr-backtest.mjs data areas      # multi-timeframe areas
node tools/sr-backtest.mjs data strength   # strength bars vs outcome
node tools/research/sources.mjs . data     # each source alone, hourly chart
node tools/research/sources15.mjs . data   # each source alone, 15-minute chart
node tools/research/features2.mjs . data   # level properties vs outcome
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
npm test                    # unit tests for the analysis code (Node 22+)
node tools/dev-server.mjs   # run the UI in a desktop browser: http://127.0.0.1:8765
node tools/live-check.mjs   # print the analysis for the live market
LIVE_TESTS=1 ./gradlew testDebugUnitTest   # native proxy against the real feeds
```

Charts use [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0).
