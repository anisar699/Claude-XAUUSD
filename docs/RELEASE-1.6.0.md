# XAUUSD Levels 1.6.0

New tools for planning and reviewing trades, chosen by the owner from the
suggestion list (items 2, 4, 6, 7, 8, 9, 11, 12 and 14).

| # | Feature | Where |
|---|---|---|
| 2 | **Trade planner.** Tap a level and the app fills in a plan: a long at support enters at the area's top edge, a short at resistance at its bottom edge. The stop sits beyond the area by a quarter of the hourly ATR plus the spread. Targets are the next areas, each with its R:R and money. The lot size comes from your balance and risk %, rounded down. A saved plan notifies you when price reaches its entry. | Overview / Levels → Trades |
| 4 | **Trade journal and statistics.** Log trades from a plan or by hand. The app shows win rate, average R, P/L and profit factor, overall and by setup, session and direction. Share the journal as CSV. | Trades |
| 6 | **Break and retest alerts.** Price comes back within 48 hours, from the new side, to an area it broke. | Settings › Alerts |
| 7 | **Candle-close breaks.** A break counts when a 15-minute or 1-hour candle closes beyond the area, instead of on the live price. | Settings › Alerts |
| 8 | **Liquidity sweep alerts.** A candle wicks beyond an area and closes back on the side it came from. | Settings › Alerts |
| 9 | **Sessions.** Asia, London and New York, each in its own local time with its daylight saving: the session now, highs and lows, and the 30-minute opening ranges. | Overview, Chart layer "Sessions" |
| 11 | **Market structure.** HH/LH, HL/LL, and the latest BOS or CHoCH on each timeframe. | Overview trend table, Levels, Chart layer "Structure" |
| 12 | **Your broker.** A price offset (match your broker's bid with one tap) and the day boundary: 17:00 New York, or 00:00 UTC for GMT+0 servers such as Exness. | Settings › Your broker |
| 14 | **Home-screen widget.** Price, change, and the nearest R and S. It updates while the app or background monitoring runs. | Long-press the home screen › Widgets |

## Measured before release

Sweeps and retests were tested on Dukascopy history up to 20 Nov 2026 with
`tools/research/events.mjs`. The areas were rebuilt daily, as the app does,
and each one was compared with a random band at the same distance and of the
same width.

| Event | Followed by a 1 ATR move the expected way |
|---|---|
| Hourly sweeps | 44% at areas, 44% at random bands (≈2,200 each) |
| Hourly retests | 59% vs 61% (≈430 each) |
| 15-minute sweeps | 34% vs 33% (≈1,350 each) |
| 15-minute retests | 41% vs 40% (≈490 each) |

They are no better at the app's levels than at random ones. They tell you
what price is doing; they are not a signal on their own. The app's Settings
say so next to the switches.

## Checks

- **Unit tests:** 85 JavaScript and 5 Kotlin tests pass. The new ones cover
  sessions (including DST), market structure, the UTC day boundary, the
  broker offset, planner maths, position sizing, journal statistics and CSV,
  the three new alert kinds, plan entry alerts in the monitor, and the widget
  snapshot.
- **Browser on live data (Thursday 26 Nov):** planned a trade from a level,
  saved it, logged two trades, read the statistics, changed the offset and
  the day boundary, and turned on the chart layers. There were no page errors.
- **Earlier checks:** the chart, offline, weekend and Twelve Data checks were
  rerun.
- **Lint:** no errors.

## Not covered

- **Exchange holidays:** these are still not in the market calendar.
- **Home-screen widget:** it has no data source of its own and shows the last
  values until the app or monitoring runs again.
- **Lot size:** the calculation uses the contract size you set. Check your
  broker's minimum lot, minimum stop distance and margin.
