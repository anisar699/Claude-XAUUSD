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
- **Settings**: timeframes, refresh rate, data source, data status.

## How levels are calculated

- **Zones**: swing highs and lows are grouped when they sit within a fraction
  of ATR of each other. A zone scores higher for more touches, more recent
  touches, sharper reversals, and having acted as both support and
  resistance; it scores lower when price has chopped through it repeatedly.
- **Pivots**: classic floor pivots (PP, R1 to R3, S1 to S3).
- **Multi-timeframe areas**: zones from every enabled timeframe, pivots,
  previous highs and lows, and round numbers are pooled; levels at nearly the
  same price form one area, weighted towards higher timeframes.
- **Candles**: H4, D1, W1 and monthly candles are built from hourly data on
  New York close (17:00 New York) boundaries, the convention most MT4/MT5
  brokers use, so they should match a broker chart closely.

The code is in `app/src/main/assets/www/js/core/`.

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
in a WebView. The Android shell (`MainActivity.kt`, `ApiProxy.kt`) serves
those files and forwards data requests to the feeds.

```sh
npm test                    # unit tests for the analysis code (Node 22+)
node tools/dev-server.mjs   # run the UI in a desktop browser: http://127.0.0.1:8765
node tools/live-check.mjs   # print the analysis for the live market
LIVE_TESTS=1 ./gradlew testDebugUnitTest   # native proxy against the real feeds
```

Charts use [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0).
