# Response to the XAUUSD Levels 1.2.0 audit

Fixed in 1.3.0 (versionCode 4). Each finding was first reproduced against the
1.2.0 source, then fixed and covered by a test that fails on 1.2.0.

| ID | Finding | Status | Fix | Test |
|---|---|---|---|---|
| F01 | Source contains the usable signing key | **Open, owner's decision** | See below | – |
| F02 | Old upstream quote marked Live | Fixed | Live needs: received < 90 s ago on a monotonic clock, feed timestamp moved < 2 min ago and within 10 min of the phone clock, market open | `store.test.mjs` |
| F03 | Fresh M1 hides stale higher-timeframe levels | Fixed | `analysis.stale` lists timeframes whose candles stop before the newest period; the monitor pauses alerts for them and for any feed error; banner and Settings show them | `store.test.mjs`, browser |
| F04 | Empty answers counted as success | Fixed | Empty answer is a feed error | `store.test.mjs` |
| F05 | Failed first M1 not retried | Fixed | Per-feed retry: 30 s doubling to 5 min, independent of other feeds | `store.test.mjs` |
| F06 | M1 poll erases other feeds' errors | Fixed | Per-feed errors; a feed clears only its own | `store.test.mjs` |
| F07 | Delayed M1 overwrites newer coarse close | Fixed | Fetched candles carry `asOf`; a finer candle moves a coarse close only if it ends after that | `core.test.mjs` |
| F08 | Duplicate / impossible candles accepted | Fixed | `cleanCandles`: integer times in range, finite positive prices, OHLC invariants, later duplicate wins; also applied to saved data | `providers.test.mjs` |
| F09 | Quote parsing not validated | Fixed | Numbers normalised, finite, not crossed, spread < 2%, timestamp required | `providers.test.mjs` |
| F10 | Live candle high/low shrink | Fixed | Chart keeps a live candle that accumulates extremes per period | browser (real chart library) |
| F11 | Older candle corrections ignored | Fixed | Redraw from the first changed candle, keeping the visible range | browser |
| F12 | Legend not following live candle | Fixed | Legend reads the live candle and refreshes on every quote | browser |
| F13 | Price updates drop keyboard focus | Fixed | Levels tab strip built once and updated in place | browser |
| F14 | Twelve Data text says 2 min, polls 4 | Fixed | Text says 4 minutes | source |
| R01 | Alert channel blocking not shown | Fixed | Settings warns when the "Level alerts" channel is off and links to it | browser (mock bridge) |
| R02 | Wake lock held while market closed | Fixed | Released while closed; exact alarm (`setExactAndAllowWhileIdle`) at the reopening re-acquires it | emulator: `dumpsys power`, `dumpsys alarm` |
| R03 | App + monitor exceed Twelve Data quota | Fixed | One budget in shared storage: 7/min, 780/day | `store.test.mjs` |
| R04 | Zoom disabled | Mitigated, unchanged | System font size applies to the WebView (checked at 130% on the emulator); the header now wraps at large sizes. Pinch zoom stays off so it does not fight the chart gestures | emulator |
| R05 | Alerts after long gaps unlabelled | Fixed | Alerts after more than 10 min without a check say "moved while alerts were paused (last check HH:MM)" | `alerts.test.mjs` |

Hardening notes from the report:

1. Twelve Data key field is now a password field. Storage unchanged
   (app-private, backups off).
2. Proxy answers are always `text/plain` with `nosniff`; only `/`,
   `/index.html` and `/monitor.html` can load as documents.
3. An answer over 4 MB is now an error (502), not a cut-off success.
4. Flat prices give RSI 50.
5. H4/D1/W1 bucket ends follow the server clock across daylight saving.
6. targetSdk 34: unchanged, documented.
7. A dead WebView renderer is rebuilt (screen recreated, monitor page
   reloaded) instead of crashing the app.
8. Basis between Swissquote and Dukascopy: about $0.3 at the last close,
   against an alert distance of about $2.3 (auto). Not studied further.

Also found while verifying on the emulator and fixed: the market-reopen alarm
was inexact (Android allowed delivery up to 11 hours late), and a wake-up
alarm during a closed market kept the wake lock held.

Provenance: 1.3.0 was built after committing, so the APK's embedded revision
matches the source (the 1.2.0 APK named the commit before its own).

## F01: signing key

The key in `keystore/` signs every build so updates install over each
other. It is also in the public GitHub repository, so it is already public:
removing it from future archives would not undo that. A real fix needs a new
private key that only the owner holds, plus one of:

- **Key rotation** (APK Signature Scheme v3): phones on Android 9+ take the
  update normally; Android 8.x needs one uninstall and reinstall.
- **Plain new key**: every phone needs one uninstall and reinstall (settings
  and saved candles are lost).

Where the private key is kept (it must not be in the repository) is the
owner's choice, so this is left open.

## Not covered

Not tested on a physical phone, during an open market, with a real Twelve
Data key, or for battery drain over hours. The emulator was Android 11.
