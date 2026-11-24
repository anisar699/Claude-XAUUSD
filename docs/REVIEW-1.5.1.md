# Review of 1.5.0 and fixes in 1.5.1

24 November 2026. A full review of the code, run against the live market.

## How it was checked

- Every source file read: the analysis core, data store, monitor page,
  screens, and the Android shell (activity, service, alarm receiver, proxy).
- A 10-minute live session in Chromium (Tuesday 20:50–21:00 UTC, market
  open) ran the app and the monitor page side by side, sampling their state
  every 20 seconds. The result:
  - no page errors and no failed requests;
  - the price stayed live, with quotes 3–5 s old;
  - no timeframe went out of date;
  - the monitor reported "running" throughout.
- Weekend, Sunday reopening, daily break and reopening, and old hourly data
  were simulated; none was wrongly marked out of date or holed.
- The earlier browser scenarios were rerun: offline cold start, saved data
  while offline, weekend clock, Twelve Data (mocked) and back to Dukascopy.
  All passed.
- `tools/live-check.mjs` was run on live data. Candle buckets (H4, D1, W1,
  month) fall on the New York close, including around the DST change.
- One full analysis takes about 15 ms on a desktop.
- 71 JavaScript tests, 5 Kotlin tests and lint (0 errors) pass.
- On the Android 11 emulator, 1.5.1 installed over 1.5.0, ran on live data,
  and the monitor was killed and revived (below).

## Fixed

| Problem | Effect | Fix |
|---|---|---|
| The monitor's alarm only woke a running service | If Android killed the app while monitoring was on, the reopening alarm did nothing and alerts stayed off. With the market open there was no alarm at all. On the emulator, Android's own restart of the killed service was cancelled ("Stopping service due to app idle"). | The user's choice to monitor is saved. While the market is open, a check-up alarm runs every 15 minutes. An alarm that finds the service gone starts it again (exact alarms may start a foreground service from the background). Stop, and a monitor that kept failing, clear the choice. Checked on the emulator with the process and service gone: the alarm started the app "for broadcast MonitorAlarmReceiver", and monitoring came back in the foreground. After Stop, it stayed off. |
| Pivot table did not mark estimated periods | The table showed daily, weekly or monthly pivots from a period the history only partly covers as if exact. The list of areas already said so. | The column header gets a * and a note: estimated, not used for alerts. |
| Unused code | – | Removed an unused export (`TF_NAME`) and store method (`quoteAge`), and a stale duplicate comment. |

## Checked and fine

- **Candle close and Live line:** on the chart, the newest candle's close can
  differ from the Live line by a dollar or so. Dukascopy's minute candles
  include only completed minutes, and since 1.5.0 the live quote is not
  written into candles. The minute data is at most about 75 seconds old,
  well inside the 7-minute limit for alerts.

## Known limits, unchanged

- **Exchange holidays** are not in the market calendar. On an early close or
  a holiday (Thanksgiving, Christmas) the header still says "Market open".
  The price is then not live, and alerts pause as "No live price".
- **Monitoring and restarts:** monitoring does not restart after a reboot or
  an app update. Android can still delay it when the phone is idle;
  Unrestricted battery use helps.
