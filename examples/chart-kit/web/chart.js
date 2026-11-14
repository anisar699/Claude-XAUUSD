// Minimal live candlestick chart.
//
//   candles : Dukascopy chart feed (spot bid, no API key)
//   drawing : TradingView Lightweight Charts v5 (vendor/, Apache 2.0)
//
// The page never calls Dukascopy directly. It calls its own /api/proxy route,
// which the host app answers (android/ApiProxy.kt, or dev-server.mjs in a
// desktop browser). That is needed because the feed wants a Referer header a
// web page is not allowed to set, and sends no CORS headers.
//
// Public API:  ChartKit.init(element, options)  ->  { setInterval, addLevel, clearLevels, bars }

(function () {
  'use strict';

  const LC = window.LightweightCharts;

  // `duka` is the feed's name for the interval, `sec` its length, and `finer`
  // the smaller interval used to build the candle that is still forming.
  const INTERVALS = {
    '1m': { duka: '1MIN', sec: 60, finer: '1m' },
    '5m': { duka: '5MIN', sec: 300, finer: '1m' },
    '15m': { duka: '15MIN', sec: 900, finer: '1m' },
    '30m': { duka: '30MIN', sec: 1800, finer: '1m' },
    '1h': { duka: '1HOUR', sec: 3600, finer: '1m' },
    '4h': { duka: '4HOUR', sec: 14400, finer: '5m' }, // candles start 00:00, 04:00 ... UTC
    '1d': { duka: '1DAY', sec: 86400, finer: '15m' }, // candles start 00:00 UTC
  };

  const DEFAULTS = {
    instrument: 'XAU/USD', // any Dukascopy instrument, e.g. 'EUR/USD'
    interval: '1h',
    history: 1000, // candles per load; the feed's maximum per request
    pollMs: 15000, // how often the forming candle is refreshed
    precision: 2, // decimals on the price axis (5 for most FX pairs)
    up: '#26a69a',
    down: '#ef5350',
    onBars: null, // called with the bar array after every load
    onError: (e) => console.error(e),
  };

  function feedUrl(instrument, duka, limit, beforeMs) {
    const q = new URLSearchParams({
      path: 'chart/json3',
      instrument,
      offer_side: 'B', // B = bid (what MT4/MT5 charts show), A = ask
      interval: duka,
      splits: 'true',
      stocks: 'true',
      limit: String(limit),
      time_direction: 'P', // candles before `timestamp`
      timestamp: String(beforeMs),
      jsonp: 'cb',
    });
    return 'https://freeserv.dukascopy.com/2.0/index.php?' + q.toString();
  }

  // Response is JSONP, newest first:  cb([[timeMs, open, high, low, close, volume], ...]);
  function parseFeed(text) {
    const a = text.indexOf('(');
    const b = text.lastIndexOf(')');
    if (a < 0 || b <= a) throw new Error('Unexpected feed response');
    return JSON.parse(text.slice(a + 1, b))
      .map((r) => ({ time: Math.round(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4] }))
      .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
      .sort((x, y) => x.time - y.time);
  }

  async function fetchCandles(instrument, key, limit) {
    const url = feedUrl(instrument, INTERVALS[key].duka, limit, Date.now() + 60000);
    const res = await fetch('/api/proxy?u=' + encodeURIComponent(url), { cache: 'no-store' });
    if (!res.ok) throw new Error('Feed request failed: HTTP ' + res.status);
    return parseFeed(await res.text());
  }

  // The library draws timestamps as UTC. Shift them so the axis shows the
  // viewer's local time.
  function toChartTime(t) {
    return t - new Date(t * 1000).getTimezoneOffset() * 60;
  }
  const toChartBar = (b) => ({ ...b, time: toChartTime(b.time) });

  function init(element, options) {
    const opt = { ...DEFAULTS, ...options };
    let interval = opt.interval;
    let bars = []; // UTC seconds
    let generation = 0; // bumps on every interval change; stale responses are dropped
    let timer = null;
    let levels = [];

    const chart = LC.createChart(element, {
      autoSize: true,
      layout: { background: { type: 'solid', color: '#131722' }, textColor: '#898781', fontSize: 11 },
      grid: { vertLines: { color: '#1c2231' }, horzLines: { color: '#1c2231' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: LC.CrosshairMode.Normal },
      localization: { priceFormatter: (p) => p.toFixed(opt.precision) },
    });
    const series = chart.addSeries(LC.CandlestickSeries, {
      upColor: opt.up,
      downColor: opt.down,
      wickUpColor: opt.up,
      wickDownColor: opt.down,
      borderVisible: false,
      priceFormat: { type: 'price', precision: opt.precision, minMove: Math.pow(10, -opt.precision) },
    });

    async function load() {
      const gen = ++generation;
      clearTimeout(timer);
      try {
        const fresh = await fetchCandles(opt.instrument, interval, opt.history);
        if (gen !== generation) return;
        bars = fresh;
        series.setData(bars.map(toChartBar));
        const n = bars.length;
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 6 });
        if (opt.onBars) opt.onBars(bars);
        await refresh(gen);
      } catch (e) {
        opt.onError(e);
      }
      if (gen === generation) timer = setTimeout(tick, opt.pollMs);
    }

    // The feed mostly returns finished candles. The candle that is still
    // forming is built from a finer interval and folded into the last bar.
    async function refresh(gen) {
      if (!bars.length) return;
      const iv = INTERVALS[interval];
      const need = Math.ceil(iv.sec / INTERVALS[iv.finer].sec) + 2;
      const finer = await fetchCandles(opt.instrument, iv.finer, Math.min(1000, need));
      if (gen !== generation) return;
      let last = bars[bars.length - 1];
      for (const f of finer) {
        const bucket = Math.floor(f.time / iv.sec) * iv.sec;
        if (bucket < last.time) continue;
        if (bucket === last.time) {
          last.high = Math.max(last.high, f.high);
          last.low = Math.min(last.low, f.low);
          last.close = f.close;
        } else {
          last = { time: bucket, open: f.open, high: f.high, low: f.low, close: f.close };
          bars.push(last);
        }
        series.update(toChartBar(last));
      }
    }

    async function tick() {
      const gen = generation;
      if (!document.hidden) {
        try {
          await refresh(gen);
        } catch (e) {
          opt.onError(e);
        }
      }
      if (gen === generation) timer = setTimeout(tick, opt.pollMs);
    }

    // Coming back from the background: reload rather than patch a long gap.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load();
    });

    load();

    return {
      chart,
      series,
      bars: () => bars,
      setInterval(key) {
        if (!INTERVALS[key]) throw new Error('Unknown interval ' + key);
        interval = key;
        return load();
      },
      // A horizontal line, e.g. support or resistance.
      //   addLevel(3950, { title: 'S', color: '#26a69a' })
      addLevel(price, o) {
        const line = series.createPriceLine({
          price,
          color: (o && o.color) || '#3987e5',
          lineWidth: (o && o.width) || 1,
          lineStyle: o && o.dashed ? LC.LineStyle.Dashed : LC.LineStyle.Solid,
          axisLabelVisible: true,
          title: (o && o.title) || '',
        });
        levels.push(line);
        return line;
      },
      clearLevels() {
        for (const l of levels) series.removePriceLine(l);
        levels = [];
      },
    };
  }

  window.ChartKit = { init, INTERVALS };
})();
