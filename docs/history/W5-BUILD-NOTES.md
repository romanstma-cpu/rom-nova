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

## Round 2 — closing the blind critic's fail list

Round 1 was FAIL (narrow): the per-alert honesty machinery passed with
outside verification (a launch alert 2.2s after on-chain pool creation with
`eventAt` matching the chain to the second; a SOL crossing bracketed to the
cent against crypto.com candles), but three scale seams did not hold. All
nine keyless-fixable items are closed below. Every fix landed on a merge of
main at 91d700b (W4's UI/perf work).

**D1 HIGH — launch dedupe collapsed at the 400-key cap.** Insertion-order
eviction against a feed that keeps rows for 30 minutes: on a busy afternoon
keys churned faster than rows expired, so evicted keys' rows re-matched and
re-fired in a rolling loop (41 proven duplicates in 5 minutes; p50 fired-row
age 176s). Fixed on the axis that actually matters — a key is safe to forget
when its ROW IS GONE, not when the key is old. `SEEN_CAP` raised to 1,000
(above the feed's own 400-row × 2-event ceiling, so a live row's key can
never be squeezed out) and `pruneSeen` evicts only keys absent from the
current feed, and only above the cap — the "only above the cap" bound being
what stops a post-reload rebuild from forgetting hundreds of rows that are
about to be re-listed. Measured: the old code fires **2,164 alerts for 600
launches**; the new code fires exactly 600, and re-evaluating the whole
standing feed fires nothing.

**D2 HIGH — the inbox silently destroyed the record it calls "the record".**
200 events, oldest-first eviction, so launch spam churned the whole history
in ~4 minutes and took an externally-verified SOL crossing with it. Eviction
is now by CENSUS: the rule holding the most events loses its oldest,
repeatedly, so a rule with one precious alert is only touched once every
other rule is cut to the same depth. What was taken is counted per rule in a
new `dropped` map and printed in the inbox ("History truncated: 47 older
alerts dropped … 47 from 'any launch'"), and the unread badge renders `N+`
rather than saturating silently at a number that looks exact.

**D3 MEDIUM — a paused hidden tab starved a visible one.** The lease was
renewed at the top of every tick and the paused check came after, so a hidden
tab held the lock for minutes while evaluating nothing and a visible tab sat
idle saying "another tab is monitoring". The decision is now made first and
extracted as `watchDecision`, where `holdLease === !paused`; a paused tab
releases instead of renewing, so handoff is immediate.

**D4 MEDIUM — wallet alerts stamped `dataAsOf: now` over a 45s cache.**
`Sourced.builtAt` is now stamped at assembly, preserved across cache hits,
carried through `handleWalletProfile`, and used as the alert's `dataAsOf`.
The reading is dated when the chain was read, not when the alert fired.

**D5 MEDIUM — a PDA rule showed WATCHING forever.** The wallet pass now reads
`profile.identity.profilable` and skips with the identity's own sentence
("this address cannot have fills of its own — …"), so a rule that can never
fire shows NOT EVALUATED instead of a clean-looking silence.

**D6 LOW — post-reload "another tab is monitoring" with no other tab.** Three
changes: the status line branches on `paused` first, a `pagehide` handler
hands the lease back on unload, and `LOCK_STALE_MS` drops from 45s to 25s
(2.5 ticks) to bound the ghost window when unload events do not run — which,
measured in the review harness, they sometimes do not. The non-leader line
also stopped overclaiming: it now says "another tab holds the monitor lease"
(a fact about the lock) rather than asserting that monitoring is happening.

**D7 LOW — graduation rows labeled `eventAt` "pool-creation time".** The
field is re-dated at graduation, so the timestamp was right and the claim
name was wrong. Launch alerts now label by the row's own event.

**D8 LOW — wallet-flavored skip reason on a mint rule.** `mintSkipReason`
prefixes the chain's own wording with "no token exists at this mint address
on Solana, so there is nothing to price", keeping the source's sentence.

**D9 INFO — unreachable printed cadence.** `LAUNCHES_EVERY_MS` was 5s against
a 10s tick, so the page printed a target no healthy monitor could ever meet.
It is now the tick itself; live, the rule reads "cadence ~11s (target ~10s)".
Nothing is lost — the feed module rate-gates its own vendors regardless.

### Round-2 live verification (static build on :4666, live vendors)
- One "any launch" rule, ~2.5 minutes, 15 evaluation passes, 167 tracked
  keys: **85 alerts, 85 unique, 0 duplicates.**
- 8 graduations in that window, each labeled "the graduation time jupiter
  published"; pool rows kept "the pool-creation time jupiter published".
- Truncation marker, `2+` badge floor, paused-tab status, and the closed
  coverage gap all rendered as designed in the tab.

### Tests that pin these seams (`tests/live-alerts-scale.test.ts`)
Each was checked against the OLD code and observed to fail:
- "keeps every key whose row is still in the feed, past the old 400 cap" —
  fails at 2,164 fires vs 600 under insertion-order eviction.
- "does not let a paused tab starve a visible one across repeated ticks" —
  fails when `holdLease` is unconditional.
- Plus: absent-key eviction order, never-prune-below-cap, reload survival,
  pool→graduation still allowed through, census eviction protecting the
  quiet rule, drop-count accumulation, end-to-end persisted spam, lease
  handoff/expiry/ownership, takeover-window bounds, the `dataAsOf` stamp,
  and both skip-reason wordings.

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
watermark, cadence median, and the NOT EVALUATED chip states.

`tests/live-alerts-scale.test.ts` — 23 cases covering the seams round 1
found by running the thing for forty minutes: cap eviction under a
synthetic high-velocity feed, inbox census eviction, two-tab lease
dynamics, and the `dataAsOf` stamp. See the round-2 section above.

Full suite 543 green; `npx tsc --noEmit` clean; `npm run build:static`
clean; eslint clean.
