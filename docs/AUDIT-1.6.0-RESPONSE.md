# Response to the 1.6.0 developer audit (version 1.6.1)

Audit: "XAUUSD Levels 1.6.0", with findings V16-01 to V16-13 and risks R16-01 to R16-06.

Each finding was checked against the 1.6.0 code before anything changed. All
thirteen defects are real and fixed in 1.6.1. Five of the six risks are
addressed; R16-01 (the signing key) is unchanged, by the owner's earlier
decision.

**Tests:**
- 97 JavaScript tests pass; 11 new ones cover the audit's probes, in
  `tests/audit-1.6.test.mjs`.
- 5 Kotlin tests pass.
- The interface findings were rechecked in Chromium with mocked feeds.
- The Android-only items were checked on the Android 11 emulator (see below).

| # | What changed in 1.6.1 | Checked by |
|---|---|---|
| V16-01 Area shift makes a close break | The side earlier closes were on is now judged against the area where it is now, using the last closed candles (the monitor passes four). A remembered side is used only if the area has not moved. Sweeps use the same base. | test: level moving across equal closes gives no break; a real close-through gives one |
| V16-02 Edited plan keeps old hit and arming | An edit is saved as a new plan (new id) that replaces the old one, and the old hit is removed. The monitor's arming is keyed by id, so the edited plan starts unarmed and unreached. | test; UI flow |
| V16-03 Storage failures | Saves return `{ ok, reason }`. On failure the draft or form stays and a message says what happened; no success is shown. `markHit` returns true only when the hit was stored, and the monitor also remembers notified plans in memory, so a failed write cannot repeat the alert. | test; browser (a journal save with the quota exceeded keeps the form and shows the message) |
| V16-04 Contract size rewrites old P/L | Each trade (and plan) stores its contract size. Results and the CSV use the trade's own size (the CSV has a new `oz_per_lot` column). Trades from 1.6.0 got the size set at upgrade, once. | test |
| V16-05 Negative volume accepted | `tradeProblem` checks every field: entry required and positive; stop, target, exit and lots optional but positive; lots at most 1000. The form shows the reason. Bad stored records are not loaded. | test; browser (-0.1 lots refused) |
| V16-06 Session prefers stale M1 | A session uses the finest series that covers its window from start to now. If M1 lags, it uses M5 or M15. If none covers the window, `covered` is false and the screen says "partial". | test: lagging M1, current M5 gives the M5 high |
| V16-07 CSV share truncated at 500,000 characters | The journal is shared as a whole file (`cache/exports`), through a small `ExportProvider` with a temporary read permission, instead of as text. | emulator: share sheet opened with the file |
| V16-08 Only the newest 100 trades reachable | "Show 100 older" pages through the whole journal, with "Showing the newest N of M". | browser: the oldest of 101 opens |
| V16-09 Live line after the quote goes stale | On every tick the app checks whether the price is still live. When it changes, the chart (line and legend), the lists and the widget update, with no new quote needed. | browser: after 2 minutes with no quotes the line and legend are gone and the header says Last |
| V16-10 Saved plan status not refreshed | The saved-plans card is redrawn when hits change: on price and data updates, and on the `storage` event the monitor's write raises. Fields are left alone. | browser |
| V16-11 Level rows not keyboard-operable, focus lost | Enter and Space open the planner on a focused level. The lists keep focus on the same level (by price) when they are rebuilt. | browser: Enter and Space work; focus kept across quote updates |
| V16-12 Incomplete week gives exact pivots | Weeks and months mark their first period partial when the daily history starts after that period's first trading day. Its pivots are then estimated and not alerted on. | test: the four-day week is an estimate |
| V16-13 Equal highs/lows read as a downtrend | Swings within 0.05 ATR of each other are equal (EH, EL). Trend is up or down only on real higher or lower swings; equal or mixed swings are a range. | test |
| R16-01 Signing key | Unchanged, by the owner's decision (see the 1.4.0 response). | – |
| R16-02 Widget stays "Live" | The widget says "Live" only while its snapshot is under 2 minutes old. Each update sets a redraw for just after that, and there is a 30-minute fallback, so when updates stop it changes to "Last <time>" by itself. A change between live and not live is sent at once. | emulator |
| R16-03 Event candles not checked | Candle-close breaks and sweeps use the candle timeframe only when its newest closed candle is current, has no missing data, and comes from working feeds. Otherwise those two checks wait. | code review |
| R16-04 CSV formulas | Text cells that start with = + - @, a tab or a return get an apostrophe in front. Numbers stay numbers. | test |
| R16-05 Plan price basis and quote side | A buy entry is watched on the ask and a sell on the bid. Each plan stores the broker offset it was saved with. The card shows which side is watched and warns if the offset has changed since. The notification says "Entry touched … no order was placed". | test |
| R16-06 Silent removal at the limits | At 50 plans or 2,000 trades, a new save is refused with a message; editing still works. From 90% full the journal warns. Nothing is deleted on its own. | test |

## Not changed

- **Signing key (R16-01):** kept, as the owner decided.
- **TalkBack:** the keyboard and focus fix was checked with a keyboard in
  Chromium, but not with TalkBack on a device.
