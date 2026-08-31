# W5 — Alerts that actually fire (and admit when they can't)

Branch `w5/alerts` off `main` at 42d9268 (v1.6.0). Everything below was
measured against the static build served locally on :4666 and driven in a
real Chromium tab; the machine clock runs ~2s behind true (bracketed in
earlier streams off HTTP Date headers), so every "Xs ago" figure here is
local-clock arithmetic and every on-chain time in an alert record is labeled
as the SOURCE'S claim, never as a chain read this app performed.

## What shipped

Six live rule types, all evaluated client-side in the visitor's browser and
persisted in localStorage (`rom-nova.live-alerts.v1`):

| rule | source it rides | cadence aimed at |
|---|---|---|
| new launch matches filters (launchpad, min-liq, worst triage verdict, pool/graduation) | launch feed | 5s |
| watched token graduates | launch feed | 5s |
| token price crosses a level (above/below) | live token detail | 60s per mint |
| token liquidity falls to a floor | live token detail | 60s per mint |
| scanner token crosses a signal band | scanner trending list | 20s |
| watched wallet has new fills | wallet profile (chain RPC) | 4 min per wallet |

Delivery: inbox on /alerts + unread badge in the top bar on every page +
bottom-left toasts labeled LIVE ALERT (the simulator's toasts stay
bottom-right, labeled SIMULATED) + the system Notification API, permission
requested only from an explicit button — never on load — with the
denied/unsupported states rendered instead of hidden.

## How evaluation piggybacks the existing polls

The monitor (one loop per browser — a localStorage heartbeat lease keeps a
second Nova tab idle and saying "another tab is monitoring") fetches only
through seams that already rate-gate themselves for the pages' benefit:

- `/api/tokens` — 30s list cache + in-flight dedup (`source.ts`); the
  monitor asks every 20s, so at most it forces the same one fetch per 30s an
  open scanner already forces.
- `/api/launches` — the feed module refuses to poll its vendors faster than
  its measured ceilings (3s primary / 3s gems / 6s sweep) no matter how often
  it is called; the monitor asks every 5s where the launches page asks every
  1.5s.
- `/api/tokens/[mint]` — 20s detail cache; the monitor rotates at most 2 due
  mints per 10s tick, 60s per-mint gate, so N token rules degrade to a slower
  measured cadence instead of a burst.
- `/api/wallets/[addr]/profile` — 45s cache; 1 due wallet per tick, 4-minute
  per-wallet gate. A full read is up to ~400 RPC calls, so this is roughly
  an order of magnitude lighter than one open wallet page (45s cache → ~530
  req/min); the form says so before the rule is created.

No new provider endpoints, no new polling loops against vendors — when the
corresponding page is open the monitor's requests are answered from cache.

## The honesty machinery (the part Cielo/Photon don't attempt)

- **NOT EVALUATED ≠ no alert.** A skipped pass writes `lastSkipReason` and
  does not advance `lastEvaluatedAt`; the page renders a NOT EVALUATED chip
  with the verbatim reason (source down, simulator answered, feed stale, no
  scored rows, no price published). Verified live with a syntactically valid
  nonexistent mint: the chip carried the chain's own answer ("no system
  account exists at this address…").
- **Live rules never read simulated data.** A pass where the simulator
  answered (demo:true) is a skip, stated as such. There are no example
  alerts; the inbox empty-state says so.
- **Every alert records the measurement and three clocks, separated:**
  `firedAt` (evaluation clock, always known), `dataAsOf` (the payload's own
  claim), `eventAt` only when a source actually claimed an on-chain moment —
  block time for wallet fills, pool-creation/graduation time for launches,
  labeled "source claim (jupiter)" — and "on-chain time: not known" is
  printed for score/price crossings, which have no chain timestamp.
- **Crossings found late say so.** A threshold found true after a gap
  > max(2.5× cadence, 45s) carries "found after a Ns evaluation gap — the
  moment it happened was not observed". A condition already true at arming
  fires once with "already true at the first evaluation … the moment it
  crossed was never observed" (verified live: TROLL at $0.04629 vs $0.0001).
- **Rules cannot catch events that predate them.** Arming consumes the
  backfill (launch rows on screen, wallet fills in the read window — the
  wallet watermark lives in the BLOCK clock so local skew cannot move it);
  a watched token that had already graduated fires once with "already
  graduated when this rule was first evaluated — not caught live".
- **Coverage is displayed, not promised.** Per rule: last evaluated, armed
  at, achieved cadence = median gap of the last 20 real passes (needs ≥3),
  against the stated target. Session-level: per-source health chips and a
  coverage-gap ledger ("1:15:09 PM → 1:15:38 PM · tab hidden — monitoring
  paused"), with open gaps shown as open.
- **The client-side boundary is the page's second sentence**, not a
  footnote: no backend, evaluation only while a Nova tab is open, close the
  browser and nothing is watching. Background watch is an explicit opt-in
  toggle whose label says the browser throttles hidden tabs to ~1 pass/min;
  while hidden without it, the header shows "paused — tab hidden" and a gap
  opens.
- **Notification arithmetic is kept**: "N handed to the OS, M refused —
  handed over is not proof one was seen; the inbox below is the record."
  (121 refused in the test session, where the embedded pane denies
  permission — counted, not hidden.)
- **Bursts are capped and the overflow is stated**: at most 8 launch fires
  (6 fills) per pass per rule, then one summary event saying exactly how
  many more matched.

## Live verification (session of 2026-08-31, static build on :4666)

- "any launch" rule: armed by consuming a 136-key backfill, then fired on
  real pump.fun/met-dbc launches for several minutes (19-pass eval ring),
  including two graduations caught live (Basecat, AMC — "graduated on
  met-dbc, liquidity $1.2K, triage UNVERIFIED (9/9 checks ran)").
- Rows without a liquidity figure matched a filterless rule with
  "liquidity not yet measured" printed — an unmeasured value never
  satisfies a numeric filter and never renders as a number.
- Leader lease observed working: with two tabs open the second showed
  "another tab is monitoring" and evaluated nothing.
- Hidden-tab pause, gap open→close on resume, and the background-watch
  header state all observed in the tab.

## Electron

No shell-specific code. The shell serves the same static export over app://
with sandboxed Chromium; the web Notification API rides into the Windows
notification center and Electron grants permission without a prompt, so the
enable button simply confirms "granted" there. Not re-verified in a packaged
shell this stream — the claim is Chromium behavior plus the shell adding
nothing but a frame (desktop/main.js), and the code handles every
permission state either way.

## Tests

`tests/live-alerts.test.ts` — 35 cases: arming/backfill, duplicate
suppression (launch keys, fill signatures, crossing re-arm), threshold
crossed while stale (gap note), rule created after event, unmeasured
liquidity vs measured zero, unscored rows, unpriced fills, block-clock
watermark, cadence median, and the NOT EVALUATED chip states. Full suite
503 green; `npm run build:static` clean; eslint clean.
