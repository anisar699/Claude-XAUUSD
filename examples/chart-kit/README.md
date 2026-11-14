# Chart kit

A minimal, working version of the chart used in XAUUSD Levels: a live
candlestick chart in an Android app, with horizontal levels drawn on it.
Copy it into another app and build from there.

## How it works

```
chart.js (in a WebView)  ->  /api/proxy  ->  ApiProxy.kt  ->  Dukascopy feed
```

- **Drawing**: [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)
  v5.3.0, bundled in `web/vendor/`. It is a JavaScript library that draws on a
  canvas. It is not the TradingView widget: you give it the candles, so you can
  also compute and draw your own levels.
- **Data**: Dukascopy's chart feed returns spot bid candles with no API key,
  up to 1000 per request.
- **Proxy**: the page cannot call the feed itself, because the feed needs a
  `Referer` header that a web page may not set and sends no CORS headers. So
  the page calls its own `/api/proxy?u=<url>` route, and the native side makes
  the real request.
- **Forming candle**: the feed mostly returns finished candles. The one still
  forming is built from a finer interval every 15 seconds and folded into the
  last bar.

## Files

| File | Purpose |
|---|---|
| `web/chart.js` | Fetches candles, draws the chart, keeps it live. Exposes `ChartKit`. |
| `web/index.html` | Demo page: interval buttons, OHLC readout, two example levels. |
| `web/vendor/` | The chart library and its licence. |
| `android/ApiProxy.kt` | Makes the feed request with the right headers. Allow-list of hosts. |
| `android/ChartWebView.kt` | Serves the page from app assets and answers `/api/proxy`. |
| `dev-server.mjs` | Runs the same thing in a desktop browser. |

## Try it in a browser

```sh
node dev-server.mjs        # Node 18+, then open http://127.0.0.1:8770
```

## Add it to an Android app

1. Copy the contents of `web/` to `app/src/main/assets/www/`.
2. Copy the two Kotlin files into the app and change the `package` line.
3. Add the permission to `AndroidManifest.xml`:

   ```xml
   <uses-permission android:name="android.permission.INTERNET" />
   ```

4. Put a WebView where the chart should be and attach it:

   ```kotlin
   val web = WebView(this)
   ChartWebView.attach(web)
   setContentView(web)          // or add it to any layout

   override fun onResume() { super.onResume(); web.onResume() }
   override fun onPause() { web.onPause(); super.onPause() }
   ```

   In Jetpack Compose: `AndroidView(factory = { WebView(it).also(ChartWebView::attach) })`.

No Gradle dependencies are needed. Minimum Android version is 5.0 (API 21);
the page needs a reasonably current Android System WebView (Chrome 80+).

## Using `ChartKit`

```js
const kit = ChartKit.init(document.getElementById('chart'), {
  instrument: 'XAU/USD',   // any Dukascopy instrument, e.g. 'EUR/USD'
  interval: '1h',          // 1m 5m 15m 30m 1h 4h 1d
  precision: 2,            // price decimals (5 for most FX pairs)
  onBars: (bars) => {},    // candles after each load: [{time, open, high, low, close}]
  onError: (e) => {},
});

kit.setInterval('15m');
kit.addLevel(3950, { title: 'S', color: '#26a69a' });               // solid line
kit.addLevel(4000, { title: 'R', color: '#ef5350', dashed: true });
kit.clearLevels();
kit.bars();        // current candles, time in UTC seconds
kit.chart;         // the Lightweight Charts objects, for anything else
kit.series;
```

To pass values in from native code, call into the page:
`web.evaluateJavascript("kit.addLevel(3950, {title: 'S'})", null)`.

## Other platforms

The web part is the same everywhere; only the proxy changes.

- **iOS (WKWebView)**: serve the files and answer `/api/proxy` with a
  `WKURLSchemeHandler`.
- **Flutter / React Native**: use the platform WebView, or fetch the candles
  natively (same URL and `Referer` header as `ApiProxy.kt`) and hand them to
  the page.
- **Web site**: run the proxy on your server, as `dev-server.mjs` does.

## What has and has not been tested

- The web part was run in headless Chromium against the live feed: every
  interval loads 1000 candles and draws.
- The forming-candle update was checked with synthetic one-minute candles,
  because the market was closed at the time. The same approach runs live in
  XAUUSD Levels.
- The Kotlin files compile, and are the same code as the XAUUSD Levels app
  with the app-specific parts removed. This kit has not been run on a phone
  as a separate app.

## Limits to know about

- **The feed is unofficial.** It is the endpoint behind Dukascopy's own chart
  widgets. It can change or stop without notice, and its data is for personal
  use. For a published or commercial app, use a licensed data provider and
  keep the rest of this kit as it is: only `feedUrl` and `parseFeed` in
  `chart.js` and the host list in `ApiProxy.kt` need to change.
- **4h and 1d candles start on UTC boundaries**, which differs from most
  MT4/MT5 brokers (they roll at 17:00 New York). To match a broker chart,
  build those candles from 1h data: see `js/core/time.js` and
  `js/core/candles.js` in the main app.
- **Lightweight Charts requires attribution.** Its licence asks that the
  TradingView logo link stays visible on the chart, or that you credit it in
  your app. See `web/vendor/lightweight-charts.LICENSE.txt`.
- The support and resistance calculation is not in this kit. It is in
  `app/src/main/assets/www/js/core/sr.js` of the main app.
