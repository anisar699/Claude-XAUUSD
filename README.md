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
Nothing fires on first sight of a level, and alerts pause while the market is
closed or the price feed is stale.

Monitoring is a foreground service (`MonitorService.kt`) that runs the same
analysis as the app in a WebView with no screen, so alerts always agree with
the levels shown. While it is on there is a permanent notification, battery
use is higher, and it does not restart by itself after a reboot. Android can
still pause it when the phone sits idle for a long time; setting the app's
battery use to Unrestricted helps.

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

```sh
NODE_USE_ENV_PROXY=1 node tools/sr-backtest.mjs --fetch data   # history from Dukascopy
node tools/sr-backtest.mjs data            # zones per timeframe, 1.1 vs current
node tools/sr-backtest.mjs data areas      # multi-timeframe areas
node tools/sr-backtest.mjs data strength   # strength bars vs outcome
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
