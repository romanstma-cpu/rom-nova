# ROM Nova → reference grade

Live progress. Updated as work lands. Newest status at the top of each stream.

**Goal:** bring Nova to the level of a real wallet tracker / coin sniper — Axiom,
Photon, BullX, GMGN, Cielo, Nansen — judged by a blind critic against those
products, not by the builder's own account of the work.

---

## The one boundary, stated up front

Nova **does not execute trades** and this campaign will not add it. No private
keys, no signing, no order placement. `ENABLE_REAL_TRADING` stays hard off.

So against an execution product (Photon, BullX, Trojan) Nova cannot be "equal"
on the half that submits transactions, and no amount of work here changes that.
Where it *can* reach or beat them is **detection, triage, evidence and honesty**:
seeing the launch, reading the cap table, knowing who is buying, and saying
plainly how confident it is. Those are the streams below.

Claiming otherwise would be the exact failure the site's no-fake-profit rule
exists to prevent.

---

## Method

Each stream runs builder → **blind critic** → loop.

The critic is a separate agent that sees **only the artifact** — the diff, the
running app, screenshots — never the builder's reasoning or self-assessment. It
researches the reference products itself and scores against them. A stream is
not done until the critic says it matches or beats the reference.

Parallel builders work in isolated git worktrees; I merge and re-verify.

---

## Streams

| # | Stream | Reference to beat | State |
|---|---|---|---|
| W1 | Real wallet tracking | GMGN wallet page, Cielo, Nansen Profiler | ✅ **PASS** — round 4 confirmed all five defects closed, no regressions |
| W2 | Launch / sniper feed | Photon New Pairs, Axiom Pulse | ✅ **PASS** — round 4 confirmed the last defect closed |
| W3 | Token deep-dive | Photon token page, GMGN, DexScreener | ✅ **PASS** — first stream to clear blind review |
| W4 | UI/UX + performance craft | Axiom & Photon density and latency | ✅ **PASS round 1** — merged, post-PASS list closed same hour |
| W5 | Alerts that actually fire | Cielo alerts, Photon alerts | ✅ **shipped** — copy verified true from round 8; nine review rounds |
| — | **Blind critic on the MERGED 1.4.0 build** | all of the above | ❌ FAIL · 5 fixed, rest routed |

## Round 3 dispatched — both confirmation critics in flight (2026-08-31)

Two blind critics are running in parallel against main (`388ee22` + the
gradSeenAt fix), each in its own worktree on its own port so neither can
review the other's build by accident:

- **W1 round 3** (port 4611): re-verify the five failed items live — the
  Raydium Authority V4 refused as a PDA, no pools or burn address in
  movers/Buyers, honest burn-address copy, 0.0016 cbBTC rendering, the
  provenance line — plus an independent re-derivation of one wallet's PnL
  from raw chain data to prove no regression in the arithmetic.
- **W2 confirmation** (port 4622): the one unreviewed fix — promoted rows
  fabricated negative graduation lags (−90.2s, −158.8s) before gradSeenAt.
  The critic watches live for a bonding→graduated promotion and checks the
  displayed lag is small and positive, falling back to source + tests +
  a synthetic merge-driver if no token graduates during the watch.

Both were killed once mid-run by a session rate limit and resumed with
context intact when it reset. On a double PASS: ship **1.6.0** (main is
ahead of the deployed 1.5.0 by the on-curve/movers work and gradSeenAt),
then unlock W4 and W5.

### W2 round 3 verdict: FAIL (narrow) — and the critic earned its keep

The headline fix is real, verified blind from a fresh build: **six live
promotions watched** (cleanest: $SITCOM), every graduation lag small and
positive, p50 settling 10s→4s against the ~4s vendor floor as real samples
accumulated (n=5→24), the stamp-once semantics confirmed in source at
`launches.ts:358`, backfilled graduations correctly excluded, no simulator
leakage, and the clock-skew hint proven CORRECT by the critic's own
independent bracket (machine 1.9–2.2s behind).

Then it failed the round anyway, correctly. A DOM watcher polling every 2s
found exactly one negative-seconds string on the whole page for the whole
watch: the **expanded detail panel** still computed raw
`firstSeenAt − poolCreatedAt` and rendered *"seen −116.7s after the source's
pool-creation time"* on a promoted row — the identical fabrication the header
statistic was cured of, relocated one click down. Reproduced live twice
(牛来 −116.7s, chimp −65.9s).

**Fixed same hour** (`abac406`): the sentence is now a single exported
function, `sightingLine` — graduation rows anchor on
`gradSeenAt ?? firstSeenAt`, the exact quantity `gradLagOf` feeds the header
stat — with a regression test pinning the live reproduction's numbers, plus
the tooltip sentence the critic's MINOR item asked for. Every display of
this quantity has now been wrong once; none of them can drift apart again
without a test failing. 463 tests, build clean. Full findings:
`W2-ROUND3-REPORT.md` (untracked).

### ✅ W2 round 4: PASS — the stream is done

The narrow confirm went further than asked. Beyond verifying `sightingLine`
is the only producer of the sentence (grep across src/: the string lives
only inside the function; one render call site) and that the regression test
pins the live repro's numbers against the real exported function, it proved
the `?? firstSeenAt` fallback CANNOT resurrect the negative: promotion is
the only merge path that re-dates `poolCreatedAt` past a curve-era
`firstSeenAt`, and that exact path is the one that stamps `gradSeenAt` —
and no persistence layer serializes launch rows, so the field can't be
silently dropped. It then drove the function itself with an adversarial
sweep — curve lifetimes 1s→2h crossed with grad lags 0–60s — and got zero
negative renders. 463/463 on an isolated worktree.

One honest residual it correctly declined to count: with the local clock
~2–3s behind, a genuinely fast graduation can still measure marginally
negative. That is the measurement itself, it matches the header statistic,
and `clockSkewHint` exists to flag exactly that. The fabricated
curve-lifetime-sized negative is gone. Report: `W2-ROUND4-REPORT.md`.

## LIVE SIGNALS + REAL-TIME DATA — the next build (started 2026-09-01)

LO's ask: "make the app have live signals and real time new data." Facts
established before a line was written:

- `/signals` and `/signal` read **only the simulator**. Live rows ARE scored
  (`scoreRows` → `liveSignal`), so the raw material exists; nobody
  materialises it as `Signal`s, and `signal_created` is emitted only by
  `demo/simulator.ts`.
- There is **no WebSocket anywhere** in `src/`. The SSE route is dropped
  from the static export; static mode subscribes to the demo store alone.
- Probed keyless from BOTH origins (`app://rom-nova`, `https://romapps.xyz`):
  **PumpPortal `subscribeNewToken` answers in ~200–290ms** (creation push;
  its trade streams need a key); **publicnode's RPC WebSocket answers
  `logsSubscribe`/`accountSubscribe` in ~270–355ms**; mainnet-beta's socket
  refuses, matching its HTTP 403.
- **Rates decide the design.** `logsSubscribe` on the pump.fun program is
  **567 notifications/s, 612 KB/s**; PumpSwap 109/s. A tab cannot drink
  that. Per-account: an exchange hot wallet 0.33/s at 0.4 KB/s; quiet
  accounts silent. So: creation push from PumpPortal, per-account
  subscriptions for watched wallets, curves and pools, never program-wide.

Two builders dispatched into worktrees from a commit that lands the shared
event bus (`src/lib/live/bus.ts` — real events join the same subscription
the demo store feeds, carrying `real` and `source`): **B1 live signals**
(engine/API/pages, the dashboard KPI, the SIMULATED labels the whole-build
review found missing) and **B2 real-time transport** (socket wrapper with
connection honesty, PumpPortal push into the launch feed with NO fabricated
`poolCreatedAt`, per-account RPC subscriptions that nudge the alert
monitor, `/status` LIVE SOCKETS block, and the health-log plumbing the
review found broken). Blind critic after.

### Killed by the session limit, resumed from the disk (2026-09-02)

Both builders died mid-turn at about 20:10 on 2026-09-01 when the session's
usage limit hit. Resumed this morning by message, each ordered to trust
`git status` over its own memory before touching a file, because a kill
lands anywhere — between an edit and its commit, or halfway through a file.
What the disk actually held at the moment of resume:

- **B1 (`live/signals`)** — one commit landed, `efd65da` "One definition
  each of 'smart money' and 'a whale'" (that is M1: the `>=70` / `>=65`
  split collapsed to one constant). Uncommitted on disk: edits to the
  signal page, `features.ts`, `live-features.ts`, `signals.ts`, `types.ts`,
  and two new files, `engine/flow-window.ts` with its test — the M2 work
  (the caption must say what was computed) in progress when the lights
  went out.
- **B2 (`live/transport`)** — **zero commits.** The whole socket layer
  existed only as uncommitted files: `live/socket.ts` and
  `alerts/cadence.ts` new, `api/launches.ts`, `client.ts` and `types.ts`
  modified. B2's last report described `observeLaunchPush()` as the thing
  it was about to write; whether it exists is for B2's audit to say, not
  for me to assume. It was told to run `tsc` first, since a half-written
  function shows up there before anywhere else.

Housekeeping while they audit: five worktrees left over from the W1–W5
rounds were clean and fully merged, so they and their branches are gone.
The sixth, a detached checkout at `7df5ff1`, held an eight-line eslint
ignore for the Electron build output written around 1.3.0 — main had since
landed the identical change under another hash, so it was superseded and
went too. The worktree list is back to main plus the two builders.

**LO, 2026-09-02: "stop critics just work on live."** So this build skips
the blind-critic loop. When both branches land: merge to main, the three
gates, ship 1.8.0, prove it on the site and in the installed app. B1 is
already moving — `0efa5b6` closed M2 by putting the flow window ON the
feature vector (`flowWindowMs`: 6h from the simulator, the slice of chain
actually read on live data, absent when nobody read), so the invalidation
copy and the snapshot caption read the same field and cannot drift again.

## 🚢 1.8.0 — live signals and real-time data, built, merged, shipping

Both builders died to the limit a second time mid-afternoon, so I finished
their remaining work by hand rather than respawn them. What the disk held:
B1 needed only its gates run and its last two pieces committed (the feed
core was already at `75c1623`; the handler wiring and its thirteen tests
landed as `a61ac09` + `09dd168`). B2 was one import line short of
compiling — `noteProviderCall` used in the chain reader, never imported —
and otherwise whole: the reconnecting socket wrapper, the PumpPortal
pusher, the per-account RPC planner, the alert cadence with its nudge, the
status/launches/alerts pages, and 23 transport tests, all uncommitted.
One line added, gates run, committed as `910d540`.

Merged both to main (one conflict, a shared import line, union taken).
650 tests, tsc clean, build clean on the merged tree — and then the first
smoke of the export crashed /signals, which is why smoke tests outrank
green gates: `handleAccuracy` now honestly returns `stats: null` on the
live path, and the accuracy strip read `.windowDays` off the null. B1 had
changed the API and never updated the page that renders it. Fixed the
strip to render the Track Record pointer, gave /signals the provenance
strip the API was already supplying, made the dashboard KPI say which
universe it counted (H7), and put SIMULATED on the 72h flow chart and the
/flow page — the surfaces that stay synthetic (H5). `651d2d1`.

Second smoke, all real, all in the built export:

- **/signals: LIVE · JUPITER**, twelve scored trending tokens (Fartcoin
  STRONG POSITIVE 77 with a measured 382% volume dislocation), the
  coverage note that twelve tokens are not the chain, pass turnover, and
  the accuracy pointer instead of a fabricated history.
- **Launch feed: push connected, last frame under a second old, a token
  pushed this session, 1/1 curves watched** over the RPC socket, mint lag
  1.2s and push lag reported separately because they come down different
  pipes.
- **/status: the LIVE SOCKETS block** — connected-or-down with no third
  state, the subscription plan against its caps, and the measured
  program-wide rates (pump.fun 567/s, 612 KB/s) printed as the reason
  everything is per-account.
- Dashboard: ACTIONABLE SIGNALS · score ≥ 64 · live trending list;
  Highest Conviction wearing LIVE.

### 🚢 1.8.0 SHIPPED and proven, site and app (2026-09-02 ~4:25 PM)

- Tag `v1.8.0` → CI green in ~4 minutes. Installer SHA256
  `2408bfe7…53dc` matches GitHub's own digest, `SHA256SUMS.txt`, and the
  local hash of the downloaded file; `latest.yml` says 1.8.0, so every
  1.7.1 desktop will pull this on its next clean quit.
- Site: static export mirrored into rom-apps, both version strings bumped
  with the Edit tool, pushed. Live check: exactly two `1.8.0` on the page,
  zero stale `1.7.x`, `/nova/signals/` serving 200, and the download
  button's redirect resolves to the v1.8.0 asset.
- Desktop: installed the hash-verified build, and the app opened a titled
  window ("ROM Nova — Solana On-Chain Intelligence", four processes),
  reports 1.8.0.0, closed cleanly, and left a fresh localStorage leveldb
  write — the exact checks the headless regression taught us to run.
- One trap found during the proof, for the next release: this shell runs
  under MSIX file virtualization, so `$env:APPDATA` here is the Claude
  package's LocalCache mirror, not the real Roaming folder. The first
  storage check read the stale mirror and looked like a failure. Desktop
  proofs must check the explicit real path
  (`C:\Users\W\AppData\Roaming\ROM Nova`) — recorded in memory.

The ask was "make the app have live signals and real time new data."
Both halves are now true, shipped, and verifiable by anyone: open
/signals and the provenance strip names the vendor; open the launch feed
and the push chip counts frames as pump.fun mints them; open /status and
every socket is connected with a last-frame age or down with a reason.

## "I want to have an edge" → the wallet ledger (2026-09-02, afternoon)

LO: "I want to have an edge." Then: "Pick the very best one and do it,
combine 2 if necessary." Then, mid-build: "Then fix the app, it's too
cluttered, full of information and tools, make it more user friendly."

The honest position, stated to him first: no edge can be coded in; one can
be measured, and the app could not measure the one that matters most.
Every wallet read is a ~2-day window (the only keyless RPC that lists
signatures retains that much), nothing accumulated, so "is this wallet any
good" was answered from 48 hours forever and smart money stayed a
simulation. Picked: **the always-on recorder + wallet reputation**, one
feature, because every day it is not shipped is a day of history not
recorded.

**Built, by hand, no agents (the limit had killed them twice):**

- `src/lib/ledger/store.ts` — every fill the chain reader returns for a
  wallet marked RECORD, deduped by signature, with the read windows it was
  gathered over, in the browser's IndexedDB. The alert monitor re-reads
  recorded wallets on its cadence and socket nudges. Gaps stay gaps. Caps:
  4,000 fills/wallet, 40 wallets; eviction clips the covered window to the
  oldest fill kept so no verdict claims evidence it threw away.
- `src/lib/ledger/reputation.ts` — FIFO replay (the wallet page's own)
  over recorded trades; transfers/LP/unpriced excluded and counted; sells
  with no observed buy book nothing. **Refuses a verdict below 10 closed
  round trips over 7 observed days** and names what is missing. Above:
  win rate, profit factor, realized P&L, median hold/size, a score whose
  formula is printed on the page, SMART MONEY at 60+ with positive net.
- The token scorer reads it: `liveFeatures` asks the ledger about every
  flow mover; `smartMoney` leaves the unmeasured set only when ≥1 mover is
  known, and the provenance line says how many of how many. That field had
  been a placeholder zero on every live token since the scorer was written.
- Wallet page: Reputation panel + RECORD THIS WALLET; /status: Wallet
  Ledger block.
- 15 new tests; 665 total; tsc, build, lint clean.

**The declutter, same commit:** rail 19 links/4 headings → 6 primary
(Dashboard, Launch Feed, Scanner, Signals, Wallets, Alerts) + "more",
with the simulated desk grouped under SIMULATED on the rail itself.
Dashboard 7 KPI tiles → 3 (live SOL, live actionable signals, one
labelled simulated-market tile). The scanner, launch feed, alerts and
track-record explainers fold to one line + "how to read this",
remembered per page — every paragraph was earned by a review finding, so
they stay one click down rather than disappearing.

### 🚢 1.9.0 SHIPPED and proven, site and app (2026-09-02 ~5:10 PM)

Smoke of the export before tagging, all real: dashboard down to three
tiles (live SOL, one labelled simulated-market tile, live actionable
signals); the rail at six links with "more" opening the grouped rest; the
launch-feed explainer folded to 40px; and the ledger loop end to end —
RECORD on a live mover (an exchange hot wallet, 143k SOL) took 261 fills
on the click, all of them transfers and correctly excluded, the panel said
"insufficient — needs 10 more closed round trips, 5.9 more observed days",
/status listed it under Wallet Ledger, and after a reload it was still
recording with three reads, two of them the monitor's own. Persistence and
the auto re-read both proven before a byte was published.

Then: `c48a291` (ledger + declutter, 665 tests) → `635a52b` (1.9.0) →
tag → CI green in ~5 min. Installer SHA256 `2a3b1d54…277d` = GitHub
digest = SHA256SUMS = local; `latest.yml` 1.9.0. Site: 2×1.9.0, 0 stale,
wallet page 200, status page carries the ledger block, download button
redirects to the v1.9.0 asset. Desktop: installed the verified build,
titled window, four processes, 1.9.0.0, clean close, fresh leveldb write
at the REAL profile path (not the MSIX mirror).

What LO has now that he did not have this morning: an app that, for any
wallet he chooses, keeps the receipts — and will only call it smart money
once the receipts say so.

## 1.10.0 — close the loop (2026-09-02, evening)

LO: "start with 1, 2, and 3 together as one release." Built by hand,
committed as `4961250`:

- **The launch record.** The feed triages every mint in ~130ms and nothing
  ever checked whether AVOID / CAUTION / UNVERIFIED predicted anything.
  `src/lib/launch-record` listens to the feed's own merge, writes every row
  down with its verdict (settled when the risk read lands or after 90s),
  keeps the first price inside two minutes as "at first sight", notes a
  graduation the feed itself sees as a free outcome, and an hour and a day
  later asks Jupiter one batched question per hundred mints: listed, price,
  liquidity, graduated. The track page gains a LAUNCH RECORD: by verdict,
  by deployer history (first / repeat / serial), by launchpad — graduation
  rate, survival with $1,000+ liquidity, median return — each refused below
  thirty resolved per bucket. Resolves from the monitor's tick on every
  page; a closed laptop expires a horizon. IndexedDB, 20,000 cap, 14 days.
- **Record all.** One button on the movers list marks every wallet moving
  right now RECORD, up to the cap, and each row shows REC or its grade.
- **Alert on fills.** One press on a recorded wallet arms a `wallet_fills`
  rule (`ensureWalletFillsRule` — re-enables rather than duplicates).

Smoke in the export: 72 launches recorded in half a minute (10 unverified /
8 caution / 54 avoid; 13 first-mint / 19 repeat / 36 serial), every rate
honestly "0 of 30 resolved". RECORD ALL 25 took all 25; within three
minutes one of them had 380 fills and 6 round trips. RECORD → IndexedDB
25→26, survived reload, ALERTING chip rendered off the alerts store.

**Two findings from the smoke, both fixed before tagging.** (1) Recording
25 wallets at the alert cadence ate the public RPC budget — a wallet read
is up to ~400 calls against ~2,400/min — and the wallet page itself got
429s. Recorded-only wallets now re-read every 10 minutes
(`LEDGER_EVERY_MS`); the ledger needs days of history, not minutes of
freshness, and the two-day retention window loses nothing at that pace.
(2) A wallet recorded in the 1.9.0 smoke was missing from the store —
traced to the preview server restart resetting the browser pane's
storage, not to the app: a fresh RECORD persisted, survived a reload, and
25 others sat in the same database. Noted in memory as a verification
trap: never assume the pane's IndexedDB survives a `preview_start`.

677 tests, tsc clean, build clean, lint clean.

### 🚢 1.10.0 SHIPPED and proven, site and app (2026-09-02 ~6:05 PM)

`c33d6bb` (cadence fix) → `3d707c8` (1.10.0) → tag → CI green in ~5 min.
Installer SHA256 `f1314580…dc5a` = GitHub digest = SHA256SUMS = local;
`latest.yml` 1.10.0; the download button redirects to the v1.10.0 asset.
Site: 2×1.10.0, 0 stale, track page 200 and carrying LAUNCH RECORD,
wallets page 200. Desktop: installed the verified build, titled window,
four processes, 1.10.0.0, clean close, fresh leveldb write at the real
profile path.

Three releases in one day — 1.8.0 live signals and sockets, 1.9.0 the
ledger and the declutter, 1.10.0 the launch scorecard and the two buttons
that turn the ledger into action — and every one proven on the site and
in the installed app before being called shipped.

## 1.11.0 — launch forensics (2026-09-02, night)

LO: "add a feature that would make the app extremely useful for memecoin
traders." Picked the check every memecoin trader makes before buying and
pays GMGN or Axiom to see: who bought inside the creation transaction,
who sniped the first slots, what share of the supply that was, and
whether the deployer and those wallets are still holding. Nova's risk
model has carried `bundlerPct` and `sniperPct` since day one and could
never measure either — no keyless vendor publishes them.

`src/lib/providers/launch-forensics.ts` reads them off the chain, on
demand, per token: the mint's own signatures paged back to its creation
(five pages, deeper refused), the first 48 bodies, the supply summed from
the creation's post balances (measured, not assumed), the fee payer as
deployer, other on-curve owners inside the create as bundled, the
creation slot and the next three as sniped, PDAs never counted. It goes
through the wallet reader's shared RPC limiter (new `rpcCall` export)
because a second reader with its own copy would spend the same 2,400
requests twice. The scorer reads it through `LiveSources.forensics`:
bundled and sniped leave the unmeasured set, dev-sold becomes a
measurement, and a finished read invalidates the detail cache so the
next poll re-scores. The token page's new panel auto-runs on mints under
a day old.

**First live read, on a one-minute-old pump.fun mint:** 464 signatures
back to creation, 48 bodies, 25 slots, supply 1,000,000,000 measured;
BUNDLED 0.0%, SNIPED 21.3% across seven creation-slot wallets and four
in the next slots, dev bought 3.5%; 61 RPC calls in 16.9s.

**Two findings from that read, both fixed before tagging.** (1) The
first attempt at forty seconds old found NO signatures — publicnode's
account index lags a brand-new mint by a minute or two (empty at 40s,
462 at three minutes) — and "re-read" returned the same answer because
refusals were cached ten minutes. Now refusals cache thirty seconds and
the panel retries four times at fifteen-second intervals, saying it is
waiting for the index. (2) Every current-balance lookup failed:
publicnode refuses `getTokenAccountsByOwner` outright — "Indexed
requests require a personal token", HTTP 403 — a fact no probe had hit
before — and so is `getTokenAccountBalance`, which the second attempt
found gated the same way. What is not gated is `getMultipleAccounts`
with parsed encoding: the launch transactions already name each buyer's
token account, so one batched call now reads all of them at once, a null
entry meaning the account was closed after selling out. Twelve lookups
became one request, and the column says whose account it is reading.
(Refined by probe: ten accounts per call answer, eleven are blocked —
chunks of eight.)

### 🚢 1.11.0 SHIPPED and proven, site and app (2026-09-03 ~12:00 PM)

One detour first: the overnight build began referencing a chunk that was
never written — every page half-dead, all-demo chip, empty feeds — traced
to a corrupted node_modules (next's compiled edge-runtime had lost its
index.js). `npm ci` repaired it; the pre-ship check now includes walking
every chunk's references against the files on disk (36 chunks, 0 missing).

Second live proof, on a mint SECONDS old from the launch feed: creation
transaction read, supply measured at 1,000,000,000, dev bought 0.36% and
still holds all of it, sold 0%, balance read 1 of 1 via the batched call,
no bundle, no snipers — 3 RPC calls in 0.3s. Together with yesterday's
21.3%-sniped read, both shapes of the answer are proven in the export.

Then the flow: `bacb7cb` (forensics) → `ae5b0dd` (1.11.0) → tag → CI
green. Installer SHA256 `998d3712…41cb` = digest = SUMS; `latest.yml`
1.11.0; site 2×1.11.0, 0 stale; installed app titled window, 1.11.0.0,
clean close, fresh storage write at the real profile path.

The pitch, for LO: open any token page and press READ THE LAUNCH — or
just open a fresh mint, where it runs itself. BUNDLED, SNIPED, DEV
BOUGHT/SOLD, and who is still in, measured from the chain in your own
browser, fed straight into the score. The readout GMGN charges for,
keyless, with the receipts printed underneath.

## 1.12.0 — Whale Radar: the autonomous scanner (2026-09-03, night)

LO sent a three-part spec: autonomous whale detection, PNL scoring,
signals, Socket.io push, a worker on Render with Supabase, Helius keys
to come. Most of it Nova already had in-browser (ledger, scoring,
alerts); the genuinely new plane was AUTONOMY — something that watches
while the machine is off and finds wallets by itself. Built as
`worker/` in the repo plus a /radar page, nothing existing replaced.

Two probes decided the architecture before a line of worker code:

- PumpPortal's trade subscriptions are pay-gated, re-confirmed verbatim
  ("only available when connecting with an API key funded with at least
  0.02 SOL") — the 1.8.0 comment was right. Creations stay keyless.
- publicnode's WebSocket serves `logsSubscribe` on the WHOLE pump.fun
  program keylessly: ~220 notifications/s, ~284 KB/s, and the anchor
  TradeEvent decodes clean at ~34 trades/s (disc bddb7fd34ee661ee, then
  mint/sol/token/isBuy/user/timestamp/reserves). ONE subscription sees
  every bonding-curve trade by every wallet, so discovery and
  journaling are filters, not subscription budgets.

The worker: PumpPortal creations + the program firehose → whale gate
(10+ SOL inside 10 min of a seen launch) → track → journal every fill →
average-cost ledger that refuses sells whose buys it never observed
(`unmeasured_sells` is a column, not a guess) → score shrunk by sample
size until six settled sells → signal when a 70+ wallet buys again,
scored on what it had BEFORE the buy. Supabase batched behind the
filter; boot rehydrates by replaying the journal so Render restarts
cost coverage, not memory. Optional HELIUS_API_KEY follows top wallets
off-curve (structurally tested, awaiting a live key — /health says so).
DRY_RUN=1 runs the whole live pipeline with an in-memory store.

In the app: /radar (More live) connects to the operator's own worker
URL, browser-stored; signals, leaderboard with settled/unmeasured,
discoveries, journal, launch ticker; radar signals join the live toast
bus. socket.io-client is the app's only new dependency.

**Smoked live in DRY_RUN, real streams, lowered gates:** 10 whales in
the first 90s (one 85 SOL snipe 3s post-launch), a sniper's buy and
4-part exit journaled fill by fill, top wallet scored 83 on 5 settled
sells at 100% win rate — held under 70 earlier at 4 settles by the
shrink, exactly as designed. First signal at +4 min: a discovered
wallet flipped its snipe, scored 50, bought 2.93 SOL of "Marques
Baldee", gate fired on the walking-in score with the name from the
worker's own launch record. By minute 7: 110 launches, 11,965 trades
seen, 25 whales, 127 fills, 6 signals; the rpc stream survived a
mid-run drop (reconnected in 1.8s). Verified in BOTH the dev build and
the static export, snapshot-on-connect included. 50 new tests (737
total) pin the decoder against the probed layout, the ledger's
refusals, both gates, and the pipeline end to end.

### 🚢 1.12.0 SHIPPED and proven (2026-09-03 ~8:45 PM)

`cf66e0d` (radar) → `6cc266c` (1.12.0) → tag → CI green. Installer
SHA256 `8804ea2d…0c93` = GitHub digest = SHA256SUMS; latest.yml 1.12.0;
chunk check 38/0 missing; site `306754d` live with 2×1.12.0, 0 stale,
/nova/radar/ 200. Installed app: 1.12.0.0, titled window, 4 procs,
clean close to 0, leveldb LOG freshly rotated at the real profile path
(8:41:50 PM; LOG.old preserves the 1.11.0 noon proof).

Still LO's to do, keys never through me: create the Supabase project
and run worker/supabase/schema.sql; deploy the Render blueprint and
paste SUPABASE_URL + SUPABASE_SERVICE_KEY (and optionally
HELIUS_API_KEY) into Render's dashboard; paste the service URL into
/radar. Render's free plan sleeps after ~15 idle minutes — starter
plan or a free /health pinger makes it truly 24/7, and the README
says so instead of pretending otherwise.

## 1.13.0 — the radar moves IN (2026-09-03, later that night)

LO, on reading the 1.12.0 setup steps: "no, this needs to be
implemented into ROM Nova, i want ROM Nova to have these features."
Right — the worker was the architecturally pure answer and the wrong
product answer. No accounts, no blueprints: ARM THE RADAR on /radar
and the app itself hunts.

The engine moved, not copied: worker/src's pure pipeline now lives at
src/lib/radar/engine/ (decode, score, classify, state, the socket, the
two stream adapters) and the worker imports it from there — one
implementation, two drivers, the worker demoted to an optional 24/7
extension at the bottom of the page. decode.js dropped Buffer for
Uint8Array+DataView so the same bytes parse in a browser tab and under
Node; the 50 existing engine tests passed unchanged against the
rewrite.

In-app organs: journal.ts (IndexedDB `rom-nova-radar`, ledger-style —
memory truth, disk copy, signature dedupe, caps, longest-idle
eviction), hunter.ts (arm/disarm with persisted intent, gates with a
5/10/20 SOL threshold knob, effects fanned to journal + rings + the
live bus, UI flushed at most 2×/s so 220 notifications/s never becomes
220 renders/s), RadarArm riding the shell so an armed radar hunts on
every page and every app open. Scores are never stored: the journal
replays through the engine at start. radar_signal joined the loud
toast kinds; discoveries stay feed-only. Whale Radar took the seventh
primary rail slot — the one page that acts instead of ranking.

The program-firehose rule in rpc-ws.ts stands untouched and the hunter
documents why it is the exception: that module pays bandwidth to
extract per-account events; the hunter decodes every frame it pays
for. Cost printed beside the chip (367–450 KB/s measured during the
smoke), hunting an explicit switch.

**Smoked in the shipping export:** armed → both streams up with the
rate in the chip; threshold knob restarted the pipeline live; three
whales discovered in-app (8.4/5.9/6.0 SOL sniping one launch 3s in),
13 fills journaled, one flip caught mid-exit; then a page reload —
"resumed with 3 tracked wallets and 13 journaled fills from this
browser's own record (indexeddb)", hunting auto-resumed with NO click,
and the leaderboard rebuilt from replayed evidence alone (top sniper
67, 100% win, +9.02 SOL, 4 settled — the shrink still holding it under
the 70 gate). The 8788 tab's mystery bounce to /nova/ turned out to be
the browser pane restoring a discarded tab to its opening URL —
environmental; it accidentally proved shell-level resume on a
non-radar page. 747 tests (the ship commit and the first version of
this entry said 757 — my arithmetic, not the suite; corrected here);
ten new pin the journal (dedupe, caps, eviction, and the replay
contract: journaled evidence recomputes the exact score direct
application produced).

### 🚢 1.13.0 SHIPPED and proven (2026-09-03 ~9:25 PM)

`402a87b` (the move + hunter) → `febe1d7` (1.13.0) → tag → CI green.
Installer SHA256 `6cb1d8cf…87c4` = GitHub digest = SHA256SUMS;
latest.yml 1.13.0; chunks 39/0 missing; site `fe6fe8c` live with
2×1.13.0, 0 stale, /nova/radar/ 200 carrying ARM THE RADAR, and the
Nova card now leads with the radar. Desktop: 1.13.0.0, titled window,
4 procs → clean close to 0, leveldb LOG rotated at launch at the real
profile path, and the app://rom-nova IndexedDB origin present — where
the desktop journal lives.

## 1.14.0 — the Helius key gets a home in the app (2026-09-03, last of the night)

LO: "how do i add the helius key". The only home it had was the worker
he never deployed — wrong answer twice over. Now: a card on /radar,
same contract as the AI key on settings — pasted by the visitor,
stored in that browser alone, sent to helius-rpc.com and nowhere else.
With it the hunter follows its top-20 scored wallets' trades on every
venue, the leg the program firehose loses when a token graduates off
the curve.

helius.js moved worker→engine (one implementation, both drivers named
in its header). `setHeliusKey` applies live: only the Helius leg
restarts; the firehose and journal never notice. The snapshot carries
keySet/active/connected/following/txFetches/txErrors/offCurveFills;
the card prints them and says plainly what a rejected key looks like.
Settings' security posture stopped claiming no key ever reaches a
browser — the two the visitor pastes themselves are named. The
off-curve read path itself is still structurally-tested-only until a
real key runs it, and the card says to watch the error count.

Export smoke: an all-zeros UUID through the real field armed the leg
live without disturbing the pipeline (which resumed 49 wallets / 571
fills mid-smoke — the armed radar had been compounding on its own the
whole build), showed the honest not-connected state, removed cleanly.

**Release stumble, caught in-flight:** the feature commit's `git add`
listed the pre-move `worker/src/helius.js` path; git add aborts the
WHOLE add on a bad pathspec, so the commit carried only the rename and
tag v1.14.0 went out incomplete. Caught on the "1 file changed, 0
insertions" line; CI run cancelled, files committed (`f4ac075`, 6
files, 210 insertions), tag force-moved, new run triggered — the 1.5.0
maneuver. The desktop proof below greps the PACKAGED static files for
the Helius card, so provenance is proven from the artifact, not
assumed from the run. Lesson for the drill: after `git mv`, never
reuse the old path in an add list — and read the commit's stat line
before tagging, every time.

### 🚢 1.14.0 SHIPPED and proven (2026-09-03 ~9:50 PM)

`74685eb` (the mv-only stub) + `f4ac075` (the actual 6 files) +
`228cf39` (1.14.0) → tag force-moved to include f4ac075 → old CI run
confirmed CANCELLED, corrected run green. Installer SHA256
`e2502cbf…de78` = GitHub digest = SHA256SUMS; latest.yml 1.14.0;
chunks 39/0. Provenance proven from the ARTIFACT: the installed app's
packaged radar page contains "HELIUS OFF-CURVE COVERAGE", which only
exists in f4ac075. Site `5e0514c` live: 2×1.14.0, 0 stale, the card
on the live /nova/radar/. Desktop 1.14.0.0: titled window, 4 procs →
clean close to 0, leveldb LOG rotated at launch at the real profile
path. 747 tests throughout.

## 1.15.0 — the visual pass, app and site (2026-09-04, early morning)

LO: "improve rom nova and the website to look better and look amazing."
A design job, held to the same rules as a data job: no invented
number anywhere, every label intact, and nothing shipped unseen.

**Seeing it first.** The browser pane could not paint (window
minimized), so the offscreen Electron capture from the radar
screenshot became a general tool — scratchpad `shot.js`: any URL, any
viewport, optional scroll, optional arming, `img.isEmpty()` guard —
and every change below was judged against before/after frames it
produced from the built export and the local site.

**Nova (`ea85f91`, five files, +181/−21).** Atmosphere: two slow
aurora blobs (cyan/violet, a trace of pink) on a 52s transform-only
loop behind a vignette, on body pseudo-elements at z-index −1, so
every panel's backdrop blur now samples real colour and glass reads
as glass; off under reduced motion. Primitives: the primary button is
filled (brand gradient, dark text, glow) — ARM THE RADAR finally looks
like the action the page exists for; chips are pills; inputs get a
focus halo; panels a 10px radius and saturating blur; score bars a
sheen (Score sets background-color, not the shorthand, so the sheen
survives); toasts a cyan edge and glow; an accent focus ring for
keyboard users; the top bar wears the site's brand hairline and NOVA
in the cyan→violet gradient; the active rail link an accent bar and
glow. Radar: a sweep ring that only turns while hunting, a live dot
in the HUNTING chip, a size bar per discovery scaled to the largest in
view, concentric rings behind an empty signals panel while armed.
First frames read the aurora as too faint behind the glass; raised
once (0.075→0.115 / 0.085→0.13) and re-captured. 747 tests unchanged.

**Site (`a194b97`, then `0b86061` for versions).** Anchor nav (Nova ·
Trader · Downloads · Is this safe?) with a gradient underline; the duo
cards open with real frames in window chrome (the radar capture, the
Trader signals page); a by-the-numbers band — 11 whales in ten minutes,
7/7 strategies lost after fees, 0 keys, 1,478 tests — each with where
it came from, because the headline says trust the numbers; window
chrome on every screenshot; cyan and pink section glows for Nova and
Trader (clamped inside the section so a phone never scrolls sideways);
a redrawn social card rendered from an HTML comp with the radar
leaning into frame. **Pre-existing bug found in the frames and fixed:**
the platform note's `display:flex` outranked its `hidden` attribute,
so every Windows visitor saw an empty bordered bar above the downloads
table. The pane-side "horizontal overflow" alarm was the hidden pane's
zero-width viewport, not the page — the 1440px frames show none.

### 🚢 1.15.0 SHIPPED and proven (2026-09-04 ~4:30 AM)

`ea85f91` → `8d56c7d` (1.15.0) → tag → CI green; stat line read five
files before tagging. Installer SHA256 `095fe806…9890` = GitHub digest
= SHA256SUMS; latest.yml 1.15.0; chunks 39/0. Site `0b86061` with
2×1.15.0. Desktop 1.15.0.0: packaged CSS contains the aurora rules
(provenance from the artifact), titled window, 4 procs → clean close
to 0, leveldb LOG rotated at launch at the real profile path.

## 1.16.0 — cleaner and friendlier (2026-09-04, afternoon)

LO: "Make the UI and features inside rom nova cleaner and more user
friendly." Judged from frames of the built export, before and after,
the way the visual pass was.

**What was actually unfriendly.** The rail said Wallets and the page
said WHALE INTELLIGENCE; Scanner opened LIVE DISCOVERY SCANNER; Signals
opened SIGNAL TERMINAL; two links were called Radar and only one hunts.
The command palette still offered "Open Research Desk" and "Run
Backtest" while Launch Feed, Whale Radar and Track Record — the three
pages the app is now for — were not in it. The header printed the meme
index, the smart-money flow and the regime chip beside a price marked
LIVE, none of them labelled as the simulator's. Settings was titled
DATA PROVIDERS and led with eight vendors, seven of which a browser
cannot configure, while the Helius key lived three panels down the
radar page and the intro and explainers had no way back. The radar page
put two setup cards between the switch and the data. The folded
explainer clipped mid-sentence ("…gets tracked; every…"). Empty panels
said "—". Settings and Status hid behind "▸ more".

**What changed (twenty-five files, +680/−380).**
- `PageTitle`: every page's first line is the rail label plus a one-line
  lede (WALLETS · "Who is moving size right now, and the real record of
  any wallet you paste"). Fourteen pages retitled by a script that
  swapped the exact `<h1>` and added the import; nothing else touched.
- The rail exports its own lists; the palette is generated from them
  plus two real actions — Arm/Disarm the whale radar (state-aware) and
  Show the introduction again. Status and Settings pinned at the foot;
  "Token Radar" → "Tokens"; the data chip repeats in the rail only below
  `sm`, where the header has no room.
- Header: slot and the cross-checked SOL price only. Footer: one line.
- `Hint` takes a hand-written `summary` for the folded state; the radar
  has one, the other four keep the clamp until they get theirs.
- Radar: switch → signals/wallets → pipeline → one folded "Extend
  coverage" holding the Helius card (now `HeliusKeyCard`, shared) and
  the remote worker; opens itself when either is in use. Threshold
  reads "track wallets entering with ≥ 10 SOL". Empty panels say what
  fills them, in the state they are in.
- Settings: your keys (AI, Helius) → what this browser remembers
  (Introduction · Show it again / Explainers · Fold them all / Whale
  Radar journal · Forget it, two-click, with `forgetRadarJournal` that
  clears IndexedDB and restarts a running hunt from zero, reporting if
  the disk refused) → providers folded → security posture.
- First run: the three steps are now Launch Feed, Whale Radar, Track
  Record — the live loop — instead of 3D Network and Signals twice.
- Also: the shell's offline text was a setState-in-effect the linter
  had been flagging since before this pass; moved to the store seam.
- 748 tests (one new: the journal clear).

**Seen.** Disarmed radar: the switch is the first thing on the page and
the extension fold is one line. Armed for twenty seconds at 5 SOL: 10
launches, 724 trades, one whale caught 4s post-launch, its two fills
journaled, score 0 on 1 settled sell — the honest column doing its job.
Settings reads top to bottom as things a person can do. The palette
opens on "/" with "Arm the whale radar" in it. On a 375px phone the
drawer lists the seven, "more tools", Status, Settings and the data
chip, with no sideways scroll.

### 🚢 1.16.0 SHIPPED and proven (2026-09-04 ~2:35 PM)

`fc5bd69` (30 files) → `c678969` (1.16.0) → tag → CI green in ~5 min;
both stat lines read before tagging. Installer SHA256
`e8ffc2ea…4d5d` = GitHub digest = SHA256SUMS; latest.yml 1.16.0;
83,299,117 bytes; chunks 39/0; middleware tracked. Site `a673505`,
Pages built, live 3×1.16.0 / 0×1.15.0; live Nova CSS carries
`page-lede`, live /radar carries the fold. Desktop 1.16.0.0: packaged
CSS has `page-lede` + `fold-body`, packaged radar HTML has the fold,
titled window, 4 procs → 0 on close, leveldb LOG rotated 14:33 at the
real profile path. 748 tests.

**After the ship, on main only.** The design hook flagged the score
bar's `transition: width` (there since 1.0.0). Every fill — `Score`,
the signal and wallet factor bars, the token page's `Bar` — now sets
`transform: scaleX(fraction)` on a full-width div with a left origin, so
the grow-in runs on the compositor. Verified in a scanner frame: 79
fills most of the bar, 28 a sliver, colours intact. Rides out with the
next tag; the site's `/nova` copy stays at 1.16.0 until then.

## The worker is deployed (2026-09-04, evening)

LO ran the Supabase schema ("Success. No rows returned"), made the Helius
keys, pasted the browser key into Settings, and deployed the Blueprint on
Render himself. `https://rom-nova-radar.onrender.com/health` at 113s of
uptime: `dry_run:false`, db mode supabase with 33 launches / 1 wallet /
1 trade written and 0 dropped, PumpPortal + program-log streams connected
(28,460 frames, 36 MB in under two minutes), Helius enabled and connected,
first whale tracked. No key passed through this chat. Remaining on LO's
side: a free uptime monitor on /health (free Render services sleep after
15 idle minutes) and pasting the URL into the app's Remote worker card.

## 1.17.0 — the copy desk (2026-09-04, evening)

LO: "find how this could make the user a profitable crypto trader/copy
trader. add things that would make this app worth 100 million dollars
just because of how easy it is to make money." Answered honestly first —
no app makes money easy, and Nova's own research says so — then built
the narrow thing that actually separates a copy trader who survives from
one who does not: follow only wallets whose edge outlives the delay
between their buy and yours, hear the signal within seconds, size it so
no trade matters, and exit when they exit. Nova still executes nothing.

**The insight the engine already held.** Every pump.fun trade passes
through `RadarState.onTrade`, so the stream that produced a signal can
grade it — the token's price at the first trade one, five, fifteen and
sixty minutes later, against the signal's own fill price — and can hear
the signal wallet sell. No new source, no key: the same fills the score
trusts. `markPrice` runs on every trade of a watched mint before the whale
gate; `tick` marks horizons no trade will ever reach to the last trade
seen and flags them stale; `checkExit` sizes the sell by what the ledger
had the wallet holding and announces the first one. Signals are stamped
with `price_at_signal` and a `signal_key`, and both drivers can resume a
young signal after a restart (`registerSignal` with the resolved set).

**Copyability, the number nobody shows.** `score.js` now records the hold
time of every settled round trip (from the buy that opened it — a flat
position re-entering restarts the clock) and folds each five-minute grade
into a `followRets` ring. `walletRow` gains `median_hold_ms`,
`follow_ret_5m`, `follow_hit_rate` (at or above +10%, the curve's round
trip in fees) and `signals_graded`, null until measured. The leaderboard
ranks Follow 5m and Hold beside the score. The first armed frame showed
why: the ten tracked wallets held for 3s and 4s — fine records nobody
could copy.

**The desk.** `follows.ts` (localStorage): a plan (bankroll × risk, 0.5–5%),
follows with typed entries, closes with typed exits, a record — median,
hit rate, SOL at the reader's sizes — that only ever holds what they
typed. `pinMint` keeps a followed mint priced through disarm and re-arm.
Every signal row on /radar: the four grades and the peak, the wallet's
exit or "still holding · usually out in 4s", the plan size and a time
stop from the wallet's median hold, four trade-it-yourself links
(pump.fun, Jupiter, GMGN, DexScreener — a new tab, the reader's own
wallet) and an "I followed" form prefilled with the last trade seen.
Exits are loud: `radar_exit` toasts, and both radar events ride the
alerts permission to the OS (`deliverRadarNotification`).

**Worker.** Same effects fanned to Supabase (`patchSignal`, coalesced;
signals upsert on `signal_key`) and the socket (`signal_outcome`, `exit`,
ring patched so a late client sees graded signals in its snapshot);
hydrate replays seven days of grades and resumes signals. `db.js` probes
for the 1.17.0 columns at connect and every five minutes: until the
migration runs it writes base columns only, counts dropped grades, and
`/health` names the file. `migrations/002-copy-desk.sql`, folded into
`schema.sql` as ALTERs. Pushing main auto-deploys the worker on Render —
verified in a 50s dry run first (2,079 trades, streams up, schema
current in dry-run).

764 tests (radar-desk.test.ts new: follows store, plan, record, journal
patches; state: grading at every horizon, stale marks, resume, exits
sized and first-only, day-old watches dropped, pins; score: holds,
follower stats).

### 🚢 1.17.0 SHIPPED and proven (2026-09-04 ~3:50 PM)

`a319421` (19 files, +1922/−111) → `7ea0bf7` (1.17.0) → tag → CI green;
both stat lines read before tagging. Installer SHA256 `d97be57f…aa08` =
GitHub digest = SHA256SUMS; latest.yml 1.17.0; 83,306,474 bytes; chunks
39/0; middleware tracked. Site `68d0b45`, Pages built, live 3×1.17.0 /
0×1.16.0; live /nova/radar carries the copy desk and the follow form.
Desktop 1.17.0.0: packaged radar HTML has both, titled window, 4 procs → 0
on close, leveldb LOG at 15:45 at the real profile path. **Worker
auto-deployed from the push:** /health uptime reset to 28s with the new
`graded`/`exits` counts, 40 wallets rehydrated, LO's app still connected,
and `db.schema` reading "migration pending — run
worker/supabase/migrations/002-copy-desk.sql" exactly as designed. That
paste is the one step left on LO's side; grades and exits write the moment
the columns exist, no restart.

## 🔴 Whole-build blind review of 1.7.0: FAIL — seven HIGHs in the seams

The per-stream passes could not see between pages. The critic could.
**H1** one whale-flow reading rendered `—` on the scanner and `$0 — a quiet
window` on three other pages from the same batch (**fixed on main, at the
helper all four pages call**; the radar's seven other unmeasured columns and
the CSV export fixed with it). **H2** the scanner's dash gave one false
reason (fixed — names all three causes). **H3** `/status` rows for sqd,
solana-rpc-wallet and jupiter-holdings read "not asked yet" forever
because those adapters bypass `providerFetch` (→ B2). **H4** disabled
providers render `○ offline · 1ms · 0% · now` — three measurements nobody
took (→ B2). **H5** `/signals`, `/signal`, `/flow` and the dashboard's
Highest Conviction are 100% simulator with no marker (→ B1). **H6** one
synthetic event stream labelled SIMULATED in the toasts and unlabelled in
the activity feed (→ B2, via the bus). **H7** the dashboard KPI counts
simulator signals beside a live-scored table (→ B1). Nine MEDIUM and seven
LOW on the list for after. Its fair credit: the launch feed "measures its
own lag, separates mints from graduations, and detects its host's clock
error" — it bracketed that independently and the numbers reconciled.

## 🔴 The desktop app has been headless since 1.4.0 — found, fixed, 1.7.1

The most serious finding of the entire campaign, and no critic could have
seen it: **every desktop release from 1.4.0 to 1.7.0 launched without a
window.**

Chasing why the updated 1.7.0 install had an empty title: its main process
was alive with two Electron helpers, its only window handles were IME
plumbing, and its localStorage was last written **at the exact second the
OLD instance closed** — the new one had executed no page JS at all. The
shell diff between the last working version and 1.7.0 was five lines in
`main.js`: `require("./rpc-proxy")`. Reading the installed `app.asar`
header: **`rpc-proxy.js` is not in it.** electron-builder's `files` list
said `["main.js", "icon.ico"]` and nobody added the module main.js had
started requiring. MODULE_NOT_FOUND at load, before `whenReady` could
register a window — and before the auto-updater could start, so **a
headless install cannot update itself out of this.**

Why nine review rounds missed it: the critics reviewed the WEB build,
served from the same static export. The desktop shell shares that export
and nothing else, and nobody ever launched the installer. The Aug 29
download sitting in this machine's pending slot was 1.4.0 — the first
broken one. Had the app been quit cleanly that day, it would have been
dead since.

**Fixed:** `rpc-proxy.js` added to `files`; a test now reads `main.js`'s
local requires the way Node will and the bundle list the way
electron-builder will, transitively, and fails naming the file — verified
against the shipped package.json. The web build is unchanged.

**A detour on the way to the tag, worth recording:** the version bump was
written with `Set-Content -Encoding utf8`, which on PowerShell 5.1
prepends a UTF-8 BOM, and the first v1.7.1 tag carried it in the manifest
electron-builder reads. Three text-level checks said the committed file
was clean — PowerShell strips BOMs on read, so text checks lie. Only
`git cat-file blob` through cmd redirection showed EF BB BF. Node and npm
tolerate it; whether electron-builder 25 does was a guess, and a release
tag is not the place for one. CI cancelled at 1m47s, BOM stripped with an
explicit no-BOM encoder, tag force-moved to a byte-verified commit, rebuilt.

### 🚢 1.7.1 SHIPPED and proven on the desktop

Release verified three ways: `latest.yml` reads 1.7.1; the installer I
downloaded hashes to exactly the published `2d029217…ca144`;
`releases/latest` redirects to v1.7.1. Site live at 1.7.1, zero stale
strings.

Then the proof the campaign never had: installed 1.7.1 here (the manual
reinstall a headless build requires), read the `app.asar` header —
**`rpc-proxy.js` present** — and launched it. **One visible titled window,
"ROM Nova — Solana On-Chain Intelligence", four renderer processes**
(the headless build had three and only IME handles), and the storage log
written at 19:37:33, squarely inside the run, by page JS the headless
build never executed. Clean close, zero processes left, exe still 1.7.1.

One honest caveat: the window opened minimized behind a fullscreen game
on this machine, so the page was `hidden` and the alert monitor paused
rather than writing its lease — which is the app doing what round 3 of
W5 made it do. I did not pull focus to force the visible path; the
render proof does not need it.

**Anyone on desktop 1.4.0–1.7.0 needs one manual reinstall from the
download link. After that, auto-update works again** — verified end to
end on this machine: 1.1.1 pulled 1.7.0 in five seconds and installed it
on a clean quit; it was only 1.7.0 itself that could not run.

## Post-ship verification — "make sure it's live on site and app"

**Site:** v1.7.0 in both places, zero stale strings; `/nova/` and
`/nova/alerts/` render; the alert monitor took over a stale lease in 10s
and began evaluating; all six chart intervals present; production
resource timing shows the SOL reference, token search and **candles all
dispatched at 64–69ms with chart data landing at 379ms** — W4's parallel
hoist confirmed in production, not just on a local server.

**Installer:** the public `releases/latest` URL redirects to v1.7.0; I
downloaded it (79.3 MB) and hashed it — **SHA256 matches the release
digest exactly**; `latest.yml` reads 1.7.0.

**One defect found and fixed:** every nested route 404'd on its own RSC
prefetch payload — the export writes `alerts/__next.alerts/__PAGE__.txt`
(a directory) while the router requests `alerts/__next.alerts.__PAGE__.txt`
(a flat dotted file). A Next server routes over the difference; static
hosting cannot. Checked the impact before assuming: in-app clicks still
performed SOFT navigation (window survived, one navigation entry) via the
tree-payload fallback, so the cost was a wasted round trip per route and a
console full of 404s on a site whose pitch is not hiding things. Build
script now mirrors the 21 payloads to the dotted names (`87ea62b`); site
redeployed; a fresh load makes 35 same-origin requests with **zero
failures**. Predates 1.7.0 — every version had it.

**Desktop — a real finding.** The installed app was **1.1.1 from Aug 27**.
The updater had worked once (1.0 → 1.1.1), then on Aug 29 downloaded a
newer installer to its `pending/` slot — and it was never applied, because
electron-updater installs on a CLEAN quit and the app was evidently killed
or the machine shut down instead. So the local install had silently missed
four releases. Launched it: the updater fetched the feed and pulled 1.7.0
**within five seconds** (byte-exact against the release SHA256). Closed
the window cleanly: **1.1.1 → 1.7.0.0 installed four seconds later.** The
pipeline works end to end; the failure mode is a dirty exit, which the app
cannot prevent but could disclose — an "update ready, restart to apply"
line would have turned a silent four-release lag into a one-click fix.
Logged as the first item for whatever comes after this campaign.

A blind critic is now reviewing **the merged 1.7.0 as a whole** — the
last whole-build review was on 1.4.0 and failed on cross-page
contradictions no per-stream review could see. Five streams have since
merged; assume more exist.

## W5 round 9 — the last word, and it was a good one

Landed after 1.7.0 shipped. It changed nothing a user sees: the rendered
copy was verified true again (the /status note, the provenance line "12 of
12 movements carry no price, for several different reasons — each one
states its own beside the fill", the UNMEASURED entry, all checked against
a real chain read), and every regression held — 74 launch rows, zero
repeated mints, all twelve movements rendering OUT and never SELL.

It failed the guard once more, and named the failure exactly: **the scope
test had been fixed to the LETTER of round 8's wording rather than to what
it meant.** Six sweeping claims appended to a source file, guard clean.

- **The share proved proximity, not scope.** Two words back was the rule,
  so *"46% of wallets had movements with no quote leg"* passed — the
  percentage governing *wallets* while the claim swept *movements*. The
  protected sentence contains both nouns; moving the share one noun left
  is the drift its own history is made of. Now an allowlist of adjectives.
- **The vocabulary knew one phrasing.** "Movements lack a quote leg", "No
  movement had a quote leg", "All token movements are unpriced" — the ways
  a person actually writes it — all walked past a test named "nothing
  over-claims".
- 80 characters of intervening text was the ceiling, on a note that is a
  single 1,000-character string. The cap was measuring prettier's line
  width, not meaning.
- The exemption keyed on BASENAME, so `src/lib/wallet-profile.test.ts`
  could claim it by being named after the guard.
- The count vocabulary stopped at "eight" and ignored digits, while the
  reader emits six reason strings today.

All eight exploits replayed and caught, including the impostor-named file.
And the honesty note this half had been missing: **it matches phrasings,
not meanings** — a floor on vigilance, not a proof. The names changed to
match ("the known over-claims stay dead", "finds no known over-claim"),
because a guard that overstates its coverage is the bug it looks for.

570 tests, tsc clean, build clean. `0c8e441`, no release needed — test and
comments only.

## 🚢 1.7.0 SHIPPED — all five streams delivered (2026-09-01)

`w5/alerts` merged to main, tagged `v1.7.0` at `dc1d896`, CI published,
**SHA256 `9e613857…ae9b` verified against GitHub's own digest and
SHA256SUMS.txt**, `latest.yml` reads 1.7.0 (the update feed existing
installs pull from is live), site mirrored to romapps.xyz — both version
strings bumped, zero stale 1.6.0 strings, `/nova/` and `/nova/alerts/`
both serving the new build. 566 tests, tsc clean, build clean, middleware
verified tracked in the tag tree.

**The campaign scoreboard: W1 ✅ W2 ✅ W3 ✅ W4 ✅ W5 ✅.**

What shipped in this release: the alerts system (six rule types, one
monitor per browser, no new vendor traffic, no server) with the honesty
layer the server-side references do not attempt — achieved cadence beside
every rule, NOT EVALUATED chips carrying the verbatim reason, firedAt /
dataAsOf / on-chain time kept as three separate claims, coverage gaps
disclosed rather than papered over, and an inbox that evicts from the
noisiest rule and prints what it took. Plus W4's craft: first chart canvas
5.4s → ~0.5s with the caption stating the MEASURED interval, skeletons
that shimmer bars and never digits, CLS 0.000.

And a run of honesty repairs found by the critics themselves: a transfer
no longer announced as a sale, a rotation distinguished from a transfer
and an LP deposit from both, a sub-rent-floor SOL residue read by
direction, an identified address no longer called "unreachable", and no
surface claiming every unpriced movement lacked a quote leg — with a
regression guard that reads the copy the way a reader does rather than
the way prettier stored it.

**Nine review rounds on W5 alone.** Round 8 confirmed the rendered copy
true; rounds 7–9 were spent hardening the test that protects it, which is
the right place for the last mile of effort to go.

## W5 round 8: FAIL — the exemption is where a guard lives or dies

The normaliser held: four wrappings injected, four caught, each naming file
and pattern. **The rendered copy is true** — /status labels 46% as both the
measured no-quote-leg rate and a floor, the provenance line and tooltip
defer to each fill's own reason, and 68 live launch rows produced 68 mints
with zero repeats.

Then it took the guard apart on its exemption, which is fair and is where
these things actually fail:

- **The scope test accepted ANY nearby percentage.** It asked whether a
  digit-percent existed in the preceding sixty characters, never whether it
  scoped the claim — so *"although only 3% of wallets were sampled, every
  one of their token movements had no quote leg"* walked straight through.
  Sweeping, false, and the exact class the guard exists to catch.
- **One intervening word made a claim invisible.** The verb had to follow
  "movements" immediately, so of the three places the claim lives the guard
  watched ONE. A test named "holds across every file" held across one.
- **The exemption marker was self-serve** — the fixture cut ran on every
  scanned file, so any source file could exempt itself by pasting the
  comment. Greppable was true; enforced was not.
- The count check missed **"reason strings"** — the very phrase an earlier
  round de-quantified — because its alternation wanted "reasons".
- And a **live miscount**: types.ts said "Six states rather than a boolean"
  over a five-member union that enumerates five, four lines down.

### What the hardened guard deliberately does NOT do

Applied globally, the count check flags honest prose — "two measured
reasons" for a chart default, "the three states distinct: REVOKED, LIVE,
UNVERIFIED" — which enumerate themselves and cannot drift. **A guard that
cries wolf on correct copy teaches people to widen its exemptions**, and
claiming coverage it does not have is the failure under review. So counts
are policed near the pricing copy this guard is about, "reason strings"
everywhere because that phrasing has drifted twice on its own, and the
limit is stated in the test rather than implied by its name. Same
reasoning for singular: "every movement had no quote leg" is caught, while
the test name "refuses to price a movement with no quote leg" is not.

All five exploits replayed against the hardened guard and caught, every
injection restored byte-identically. 566 tests, tsc clean, build clean.

## W5 round 7: FAIL — the guard couldn't read the copy it guards

**The rendered surfaces are clean** — the critic read all 25 unpriced rows'
tooltips on a live wallet and every one stated its own reason; the
provenance line, the UNMEASURED tooltip and the /status note all true, no
closed lists, 46% correctly labelled at all four sites. Every regression
passed, including the settled rule freezing `lastAttemptAt` across 260s of
live ticks.

It failed the guard itself, for the third round running and sharper each
time. **The guard searched RAW source, and every long string here is
wrapped** — `"…" + "…"` across lines, JSDoc asterisks, runs of `//`. So it
only ever matched inside a fragment. Proved both ways: /status really does
render "movements had no quote leg", and the guard missed it purely
because prettier broke the line mid-phrase — one reflow from failing on
correct copy — while a flatly false claim wrapped across two comment lines
passed 27/27.

### The guard now reads what a reader reads

It normalises first: joins adjacent literals the way the runtime does,
strips comment furniture, collapses whitespace, then matches. **Its
normaliser is itself tested on all three wrappings**, because if that
cannot reconstruct a sentence, everything downstream is theatre.

It also learned the difference between a measurement and a claim. "46% of
token movements had no quote leg" is the measurement and must stay
sayable; the same phrase quantifying the whole unpriced set is the defect.
So the patterns are exempt when scoped by a measured share — and that
exemption, the guard's one soft spot, is tested in both directions rather
than trusted.

Three counts it immediately caught, all **de-quantified rather than
corrected**, because a number in prose about a growing list is a defect
with a delay: "refuses in three cases" (five), "six distinct reason
strings" (seven), "three distinguishable causes" (four).

The walk now covers `tests/` too — the previous guard could not read
itself while its own preamble closed a four-cause list. Exempt is one
explicitly marked, greppable region: the patterns, the normaliser's
documentation (which must quote the offending phrase to explain it), and
the strings proving they fire. Verified by injection — a false claim
wrapped across two comment lines now fails by file and pattern.

561 tests, tsc clean, build clean.

## W5 round 6: FAIL — and the guard had committed the same sin

The settled-rule clock and the mutation-verified regression test both
confirmed. Then item 1 failed again, three ways, all fair:

My fix had swapped one over-quantification for another — `/status` claimed
unpriced had **"four different reasons"** when the chain reader emits six
reason strings, which made its own closing promise ("each movement states
which of them applies") false for the two it never listed. **Every prose
enumeration of these causes has drifted out of date within a round of
being written**, because the code gains a reason whenever a new case is
told apart and a sentence is updated only when somebody notices. So the
enumerations are gone: the count is reported, and the fills carry their
own reasons, which they already did.

The **46% was also the wrong number in four places.** `wallet-chain.ts`
measured it as the NEITHER row — movements with no quote source at all —
and three downstream comments plus the /status note relabelled it the
UNPRICED rate. Both cannot hold once a rotation with a quote leg, a pool
deposit and a missing price bar are also unpriced: 46% is a FLOOR on
unpriced, not its rate, and nothing has measured the rate.

And the `types.ts` doc for the very field whose tooltip was corrected in
round 5 still carried the old claim — the "fixed where it was quoted"
shape, three rounds running.

### So the guard changed, not the list

The regression test I added in round 5 read **three files from a
hand-written array and passed while the banned phrase sat in a fourth** —
the guard committing the exact failure it existed to prevent. It now
WALKS `src/`, reads every `.ts`/`.tsx` that mentions the unpriced set, and
fails naming the file and the pattern. Verified by injecting the phrase
into `wallet-chain.ts`, the file the old array missed, and watching it
fail by name.

559 tests, tsc clean, build clean.

## W5 round 5: FAIL — one claim, fixed in one place, standing in three

Five of six confirmed, several by mutation rather than by reading: the
residue direction split verified end to end (outbound `transfer`, inbound
micro-buy `unknown`, fee-only inbound still `transfer`) with the critic
checking my reasoning in source before accepting it — `nativeQuoteLamports`
adds the fee back for the payer and nets only the wallet's OWN token
accounts, so the recipient's ATA rent really does survive in the residue.
The `valueUsd` seam test verified by deleting the line and watching it
fail. The settled mint's two clocks agreed with no attempt time anywhere
on screen. Launch dedupe: **157 unique keys, 0 duplicates** over 5.4
minutes.

It failed on the item I had fixed in exactly one place. "No quote leg
belonging to this wallet" was corrected in the provenance line and left
standing, verbatim, in the wallet page's UNMEASURED tooltip and in the
/status coverage note — both gated on the same counter — plus the type
comment behind them. False in all three for one reason: **a pool deposit
reaches the unpriced state BECAUSE its quote leg moved**, and a swap with
no SOL/USD bar had one all along.

Second time in two rounds that a fix landed one layer from where the
reader looks. So it is corrected on all four surfaces AND a test now
reads the three shipping ones and fails on the quantifying phrase —
verified by reintroducing the old wording. Nothing in the type system
connects a sentence in a tooltip to the counter it describes; only a test
can. The corrected sentence also gained round 4's own new case (a SOL
residue too small to tell a purchase from rent), which it had been
folding into "transfers and claims" — the exact assertion round 4 existed
to stop making.

Also closed: a settled rule's `lastAttemptAt` kept advancing every 60s
though the monitor had stopped asking. Nothing renders it, which is why
the critic filed it as an observation — but a stored value that is wrong
is a defect waiting for its first reader.

559 tests, tsc clean, build clean.

## W5 round 4: FAIL — a residue means opposite things by direction

Four of six confirmed closed, live: the permanent refusal reads verbatim
with no "unreachable"; rotations, pool pairs and genuine transfers all
label correctly with no self-contradiction; both surfaces share one
`movementLabel`; the key shed printed **"Browser storage ran out: 900
de-duplication keys were discarded"** after the critic forced the third
rung of the ladder; and the settled rule was proven to stop asking by
wrapping `window.fetch` — **437 app fetches over ~7 minutes, zero
carrying the mint**. Regressions clean: 77 launch events, zero true
duplicates.

The two it failed on were both mine. A sub-rent-floor SOL residue was
labelled `transfer` in BOTH directions, so an ordinary pump.fun buy —
0.002 SOL, below the floor — alerted as *"a transfer, not a trade:
nothing was paid or received for it"*, in the inbox, the toast and the OS
notification title. Its own reason said the opposite in the same breath:
"too small to SEPARATE from account rent" admits ambiguity; the label
beside it claimed certainty.

**Direction settles it with no new data.** `nativeQuoteLamports` already
adds the fee back for the payer and nets the wallet's own token-account
rent, so a residue on a tokens-OUT movement is the 2,039,280 lamports of
ATA rent a sender pays to open the RECIPIENT's account — rent-explainable,
and the dominant case (the critic pulled two off chain to check). A
residue on a tokens-IN movement is not rent-explainable at all, because
nothing about receiving tokens obliges this wallet to pay rent for anyone.
So inbound became `unknown` — whose sentence, written two rounds earlier,
had never once been reachable for a real fill.

Seeing this needed a pre-existing fixture made honest: the test factory
defaults to balances 0 → 0 **with** a 5,000-lamport fee, describing a
wallet that gained exactly what it spent. A real inbound transfer's
balance drops by the fee and the residue nets to zero, which is why the
46%-of-movements case still reads `transfer`.

The seam test also still missed one field — and it was the value field.
Deleting `valueUsd` from the monitor's mapping left 555 tests green
(optional, and the fixture carried none), and every priced alert would
then have announced "unpriced" for a fill the pipeline priced perfectly:
round 2's failure mode, one field over. Now pinned, verified by deleting
it and watching exactly one test fail.

Also closed: two clocks disagreeing about a settled mint (source line
"failing (8m ago)" beside a tooltip ticking "last attempt 15s ago", for a
rule that had stopped asking), and the wallet profile's claim that every
unpriced fill "had no quote leg" — untrue of rotations, pool movements
and no-SOL-bar swaps alike. The same four-into-one collapse, one layer up.

558 tests, tsc clean, build clean.

## W5 round 3: FAIL — the fix for the lie had a lie inside it

The transfer fix was confirmed live — **6 alerts, all WALLET OUT, all
"sent", zero "sold"**, against round 2's 14-of-14 wrong, with the critic
cross-checking a signature on chain (a `transferChecked` of 8.4M PUMP out,
SOL delta = fee only: a withdrawal). `dataAsOf`/`firedAt` ordering clean
across 200 alerts; the quota ladder forced live and observed stepping
181,150 → 119,878 → **72,829 bytes written**; dedupe still zero true
duplicates over 7.9 minutes.

Then it failed on what my own fix had over-reached into, which is the
right way to lose a round. `unpriced()` in `wallet-chain.ts` stamped
`classification: "transfer"` on FOUR different situations — a genuine
transfer, a token-for-token rotation, a pool deposit, an ambiguity.
Nothing surfaced the collapse while `classification` was a faint column
on two tables. The moment an alert SAID what it meant, it printed "a
transfer, not a trade: nothing was paid or received for it" directly
after the reason "token-for-token rotation — no single quote leg to price
against", contradicting itself inside one sentence.

**The union has had `rotate` and `lp` all along.** The reader was simply
never given them.

### All six closed (`6928be9`)

Rotations are `rotate`, same-direction pairs are `lp`, and the two
no-quote-leg cases stay `transfer` — including the SOL-below-rent-floor
one, which is 46% of real movements and where a tiny SOL delta is
evidence FOR a transfer, not against it. (I briefly labelled that
"unknown" and reverted it: it traded a true label for a hedge, and the
suite caught me.)

The alert and the wallet page had also grown SEPARATE answers to "what is
this movement called" — the page testing `priceUsd`, the alert testing
`classification` — so a real swap with no SOL/USD bar showed OUT on one
surface and "sold" on the other. Both now call one `movementLabel()`,
which answers "was it a trade" from the classification and leaves "what
was it worth" to the pricing, inferring neither from the other.

Also: the permanent refusal is returned verbatim instead of wrapped in
"token detail unreachable" (fixing `addressAnswer` one layer down was not
enough — the reader sees the outer string), and the rule stops re-asking
the chain every 60s for an answer that can never change; the last-resort
key shed is counted, persisted and printed, because a shed key is a row
that may alert twice; and the mapping that caused round 2's HIGH defect
is now a named function with **a test verified to fail when a field is
dropped** — it was an inline literal, so deleting a field from it had
broken nothing in 549 tests.

555 tests, tsc clean, build clean.

## W5 round 2: FAIL — a transfer was being sold

All nine round-1 defects verified closed, and the load numbers are now the
stream's strongest evidence: **456 launch alerts over 955s, 456 distinct
keys, zero duplicates**, spanning a mid-stream reload and a two-tab
handoff; 314 inbox evictions, **every one from the noisy rule**, with the
lone price-cross alert surviving and the banner naming what went. The
hidden tab released its own lease ~5s after going hidden and the visible
tab evaluated 15.5s later, against 2+ minutes in round 1.

Then it failed on a different instance of the same bar, and the finding
was the sharpest of the campaign: **14 of 14 wallet alerts asserted a
trade that did not happen.** `WALLET SELL · 5tzF…uAi9` — "sold" — for
movements `wallet-chain.ts` had already tagged `classification:
"transfer"`, which the wallet page prints as OUT under a comment saying
exactly why. The alert path DROPPED that field when mapping fills into
the evaluator, so the evaluator stamped a trade side it had no basis for,
into a headline, a toast and an OS notification title. The loudest
surface in the app making the one claim its own pipeline had already
refused, with the evidence sitting in the payload it discarded.

The critic's framing is worth keeping: Cielo's free tier caps at 120
alerts/hour and then halts silently, and its docs admit alerts can "drop
out altogether" under load. Nova fired 251 launch alerts in 484s — that
cap exhausted in under four minutes — while printing exactly what it
evicted and from which rule. Nova wins that comparison decisively, which
is precisely why the transfer bug was fatal: it handed back the one thing
Photon's wallet notifications also get wrong.

### All four closed same hour (`a9e9879`)

A transfer now reads as what it is (IN/OUT, "received"/"sent", and a
clause saying nothing was paid or received), while an unclassified fill
stays the trade it is labelled — absence of the field is not evidence of
a transfer. A program-derived address on a mint rule gets a permanent,
accurate refusal instead of "unreachable" (the branch was simply MISSING
from the answer list, so the chain's own identification was discarded;
the mapping is now a pure exported function with every kind pinned).
`firedAt` is read after each pass's fetch returns, so no record prints
data newer than the evaluation that produced it. And the quota fallback
now sheds dedupe keys — the actual bulk at ~53 bytes × 1000 × 60 rules —
because the old one halved events, failed, persisted nothing, and brought
the duplicate storm back through another door.

**The transfer test reproduces the critic's captured string verbatim and
was verified to FAIL against the old code** before the fix went in.
549 tests, tsc clean, build clean.

## W5 round 2 — nine closed, and the fix argued back

Branch `w5/alerts` at `a4ca6de` (merged main first — W4's chart/skeleton
work auto-merged clean — 543 tests, tsc and build clean), under blind
review. Live re-measurement of the headline defect: **85 alerts, 85
unique, zero duplicates** across 15 passes and 167 tracked keys, against
round 1's 41 duplicates in five minutes.

The reasoning is the good part. The dedupe defect was never the cap size,
it was the eviction **axis**: a key is safe to forget when its ROW is
gone, not when the key is old. So eviction now drops only keys absent
from the current feed, and only above the cap — which is also what stops
a post-reload rebuild from forgetting hundreds of rows about to be
re-listed. The builder **declined the watermark alternative I offered**,
with the right reason: a filter rule can legitimately match a row later
than first sighting (liquidity rising past the threshold), and a
watermark would silently suppress that. The reasoning lives in the code.

The inbox now evicts by census — the fattest rule loses its oldest,
repeatedly — so a rule holding one alert is untouched until every other
rule is cut to the same depth, with a truncation row naming what went
and from where. The lease bug was line ORDER (renew before the pause
decision), invisible to a test that only pokes the lock, so the decision
was extracted ahead of it; a non-leader tab now says another tab "holds
the monitor lease" — a fact about the lock — instead of asserting
monitoring is happening. `Sourced.builtAt` carries a profile's real build
time into `dataAsOf`. A wallet rule on a PDA refuses with the identity's
own sentence.

**Both critical tests were verified to FAIL against the old code** — the
old dedupe fires 2,164 alerts for 600 launches where the new one fires
exactly 600 — because a test that passes both ways is worthless.

## W5 round 1: FAIL — the honesty held; the scale seams didn't

The critic verified the machinery against the outside world and it all
held: a launch alert fired **2.2s after on-chain pool creation** with its
claimed event time matching the mint's oldest signature **to the second**;
a SOL price cross verified **to the cent** against independent candles; the
already-true rule refused to invent a crossing; the hidden-tab gap opened
and closed with real times; the wallet watermark claimed zero pre-arming
fills across a 399-signature baseline; adding five rules at once produced
no vendor burst. Its own sentence: the per-alert honesty "is better than
anything either reference product shows a user."

Then it failed the round where the unit tests don't reach: the 400-key
launch dedupe cap uses insertion-order eviction, and against a 30-minute
feed that produced **41 proven duplicate alerts in five minutes** — and
the duplicate flood then silently evicted the inbox's own verified
records, on a page that calls the inbox "the record". Plus a paused
hidden tab that keeps renewing the evaluation lease and starves the
visible tab, a dataAsOf stamped `now` over a 45s cache, a PDA
wallet-rule that watches forever for what can never fire, and four
smaller wording/label items. Nine (a)-items total, severity-ordered, all
keyless-fixable. The builder is back on them — first merging main (W4
landed since its base), then fixing with tests that reach the seams that
failed. Report: `W5-ROUND1-REPORT.md`.

## ✅ W4 round 1: PASS — the first stream to clear on its first review

The critic re-measured everything itself and could not break it: first
canvas with real 15m bars at 477/609/548ms cold (three runs, DOM
sentinels), skeleton DOM containing zero fabricated digits, every
interval's bar spacing payload-verified (1m = exactly 60s deltas ×360,
1h = exactly 3600s ×115), CLS 0.000 on the token page, and under a forced
total vendor outage the chart refused simulated bars for a real mint with
the full reason chain. It even confirmed the launch feed caught this
machine's slow clock. Regression sweep clean: Raydium authority still
refused, all 20 live flow movers pass the curve filter.

**Merged to main (`c6439b1`), and its five fixable notes closed same hour
(`ef9ae58`)**: a dead chart no longer wears the previous payload's live
chip; a two-bar chart says "too few to measure a granularity" instead of
going mute; watchlists banner their simulation at panel level; screener
placeholders read "any · e.g. 50000" so an empty field stops looking
filtered; an over-asking window button gets a shortfall sentence. One nit
stays open honestly: identical change figures across windows on a token
younger than the windows needs an age source the detail payload does not
carry. The reference gap that remains is structural: Axiom/Photon lead
with 1s/15s bars off streaming servers; Nova's floor is 1m because a 1s
tape on a 10s poll would be a liveness claim the poll cannot keep.

## W4 built — the chart got fast by measuring, not by claiming (2026-08-31)

Branch `w4/ui-craft` (d33711f, five commits, 485/485 tests, tsc clean),
now under blind review. The headline, DOM-sentinel-timed on the static
build: **token-page first chart canvas 5.4s → 0.49–1.26s** — candles
hoisted parallel to detail and served from datapi's sub-hour buckets,
probed live before any claim (1m/5m/15m all answer keylessly; the
ms-vs-seconds trap re-confirmed on the way).

The honest part: the chart caption states the interval **measured from
median bar spacing, never echoed from the request** — which exposed that
the old "hourly" caption was already false whenever the fallback served
4h bars. Finer-bar failures degrade to hourly with the reason in the
provenance note; a real GeckoTerminal throttle during the build exercised
that path live. Also: skeletons that shimmer bars and never digits, the
missing `.hint` CSS class four pages referenced, `/`-to-palette with
selection that scrolls into view, sticky headers on radar/screener.
Rejected with measurements in the notes: hoisting the hourly fetch (would
have pushed the verdict header toward ~4.5s), 1s buckets (a liveness
claim a 10s poll can't keep).

## W5 built — alerts that admit what they didn't see (2026-08-31)

Branch `w5/alerts` (dd9b5e3, 503/503 tests, build clean), now under blind
review. Six rule types: launch-filter match, watched-token graduation,
price cross, liquidity floor (a MEASURED zero fires; unmeasured never
does), signal-band cross, watched-wallet fills. One monitor loop per
browser via a localStorage heartbeat lease — a second tab idles and says
so — riding the app's existing self-gating fetch seams, no new vendor
polling classes.

The part the references don't attempt, because their alerts run on servers
and Nova's cannot: every rule wears its achieved cadence and a NOT
EVALUATED chip with the verbatim skip reason; every event separates
firedAt / dataAsOf / on-chain time (claimed only when a source supplied
it); a rule armed after a condition is already true says the crossing was
never observed instead of inventing one; hidden tabs disclose the pause;
gaps get a ledger. Verified live during the build: real pump.fun launches
fired within seconds of arming, two met-dbc graduations caught live.

## 🚢 1.6.0 SHIPPED — the campaign's core is clear (2026-08-31)

**W1 ✅ · W2 ✅ · W3 ✅ — every stream now holds a blind-review PASS.**

W1's round-4 critic verified all five fixes live with an ed25519 checker it
wrote itself (own base58 + RFC 8032 — not the app's): all 47 flow-table
addresses across three live tokens on-curve, burn address absent, a real
ATA rendered as a token account with a working owner link, the Raydium
authority still refused, 44 z's told the truth, symbols on every listed
position. 468/468 green. Two cosmetic leftovers (net-flat wallets
unreconciled in the flow caption; "USDCcash" text concatenation) fixed
before tagging.

Release: tag `v1.6.0` at `42d9268`, CI published, **SHA256
`7c11a113…f9c67` verified against GitHub's own digest and SHA256SUMS.txt**,
latest.yml reads 1.6.0 (the trader update feed is live), site copy
mirrored to romapps.xyz/nova/ with both version strings bumped.

W4 (UI/performance craft) and W5 (honest client-side alerts) builders
dispatched into their own worktrees the same hour. Blind critics follow
when they land.

## W1 round 3 — the arithmetic survived its second independent audit

The critic found a trader itself via Jupiter fee payers (184 txs / 51.1h),
extracted the fills with its own code, rebuilt the FIFO against crypto.com
hourly bars, and matched Nova figure for figure: movements 141=141, realized
$83.74 vs $83.70 (the gap is a still-forming final SOL bar), win rate
65%=65.2%, profit factor 1.85=1.85, the same two unmatched-sell mints. Its
sentence to keep: GMGN "silently prices transfers at pool price and
fabricates cost bases" — Nova refuses, and the refusal now reads as the
feature it is. Four of round 2's five items verified closed live, including
the Raydium authority refusal by pure curve math.

It failed the round on two findings, both correct:

1. **The token page's flow table never got the wallet filter** — 15 of 39
   rows on a live token were off-curve pool vaults sided BUY/SELL under a
   column headed "Wallet". Same defect class round 2 failed, one page from
   where it was fixed.
2. **The curve check created its own casualty**: it fired before the account
   read, and every ATA is off-curve by construction — so a trader's own
   token account was called "a pool authority, a vault, an escrow" and the
   purpose-built token-account branch was nearly dead code.

Plus three smaller ones: 44 z's confidently called a PDA (a typo is not a
PDA), sub-8-digit dust rendering "0", and un-symboled position rows.

### All five closed same hour (`a9b3cfa`)

The wallet filter moved into `summarise()` where the per-owner ledger is
folded, so every consumer gets it — people counts exclude pool sides, unit
totals keep the whole ledger (token flow is symmetric; removing one side of
every swap would change what netflow measures). `classifyAccount` now reads
first and lets the curve decide only what the read cannot name, with the
offline PDA refusal kept as the fetch fallback. Undecodable strings are
"invalid", not PDAs. Dust renders exponential. Symbols come from
`tokens/v2/search`, which takes a comma-separated batch (probed live: fifty
symbols, one request, cosmetic-only failure mode). **468 tests, build
clean.** A round-4 critic is confirming. Report: `W1-ROUND3-REPORT.md`.

The keyless-unfixable list stands unchanged and disclosed: entity labels
(every keyless source gated or attacker-controllable), lifetime PnL beyond
the ~2-day archival ceiling, ranked real-PnL leaderboards, 7/30-day
win-rate windows. Helius or Solscan Pro money buys them; nothing else does.

## W1 round 2 — reviewed, and the whole fail-list closed same day

The critic verified **ten of eleven** round-1 items genuinely fixed — and it
re-derived the PnL arithmetic independently from raw `getTransaction` data:
every figure reconciled **to the cent**, including the three-denominator page
($3.63 = −$1.4645 over 5 full closes + $5.09 over 45 partial exits, each
labelled). Its summary: *"the numbers this app does print are right."* It rated
the honesty surface as beating GMGN/Cielo — *"GMGN silently prices transfers at
pool price and fabricates cost bases."*

It failed the round on what was left, and the headline finding was sharp:

**The Raydium Authority V4 profiled as a trader** — *"win rate 50%, profit
factor 4.38"* — a pool's churn dressed as a person's skill, on the most famous
AMM address on Solana. It is system-owned with no data, so the ownership test
could not tell it from a wallet. And the flow lists still ranked **two AMM pools
and the burn address** under a column headed "Wallet" — the one round-1 charge
that had survived verbatim.

### The fix is pure math, and it closed both at once

A wallet is a public key someone can hold the private key FOR — its 32 bytes
must decompress to a point on ed25519. **PDAs are ground out until they fail
that exact test.** So `account-kind.ts` now carries RFC 8032 point
decompression (~40 lines of BigInt, no dependency, no RPC, no list to
maintain), verified against ground truth before wiring: the Raydium authority
**off-curve**, and four known real keypairs all **on-curve**.

The same free test now filters the movers list and the scanner's Buyers
tooltips. The burn address gets a named constant — the wallet page had claimed
it was *"never been funded or used"* one click after the movers list showed it
receiving $10.4K; a null `getAccountInfo` cannot establish "never used" for an
address that owns thousands of token accounts, and the copy now claims only
what the lookup measured.

Also closed from the list: 0.0016 cbBTC rendering as "0" tokens, the
"0 transactions over 0min" window nobody opened, the unlinked token-account
owner, and the "(measured)" chip under a SIMULATED banner.

460 tests. One catch found while testing: an empty string decodes to 32 zero
bytes, and the all-zeros key is mathematically ON the curve — the decoder
rejects bad lengths first.

## Merged-build review — the one nobody had done

It reviewed the live site *and* a local build and confirmed they behave
identically. It rated the reasoning layer as beating the commercial field —
signed factor contributions, the source-disagreement panel, `FILL WINDOW · NOT
LIFETIME`, the abstention gate, `/track` — *"no commercial tool ships epistemics
this good"*. Then it failed the data layer underneath, and it was right.

### Fixed by me on main

**The scanner was never sorted.** `handleTokens` had two exits and the live one
returned *above* the sort block — so the demo universe was ranked and Solana was
not. Measured on production: `75, 33, 86, 77, 82, 50, 64, 93, 60, 28, 45, 67`. A
**93 in eighth place**, under a caption reading "Ranked by the signal score",
beside a rank column, rank-change flashes and a freeze-ranking button. Four
pieces of UI decorating an order that never responded to them. It survived three
reviews because every existing test drove the demo store — the path that worked.
`tests/token-sort.test.ts` now guards it.

**`/status` gave every provider a clean bill of health before asking it
anything** — `requests === 0` produced `● ok / 0ms / 0% errors`, which is the
state of *every* provider on a cold load of the page you open to find out what's
working. "Not asked yet" is now its own state and the rates dash.

**`/track` announced `baseline +0.00%` with nothing resolved** — the guard
existed three lines below for every band and was missing for the baseline.

**Simulator toasts asserted dollar figures over live pages** — "SMART MONEY SELL
$436.1K … confidence 76%" for wallets that don't exist, floating over the launch
feed, while `/status` called smart-money SIMULATED and the wallet page called it
NOT COMPUTED. Three answers to one question. They carry a SIMULATED chip now.

**The first-run banner still said "nothing here is a live feed"** ten inches
above the footer I fixed this morning saying "most of what you see is live
Solana", with real token rows between them.

### The chart: the critic's finding was real, the diagnosis wasn't

It reported the chart dead everywhere via CORS. **I could not reproduce that** —
BONK's chart renders on production right now and GeckoTerminal returned 200 to
`romapps.xyz`. But the failure is real and the cause is worse than an outage:

**GeckoTerminal returns 429 with no `access-control-allow-origin` header at
all** (verified across five origins). A browser receiving no ACAO reports
`TypeError: Failed to fetch` — indistinguishable from a network failure. So under
throttle the app says "coingecko unavailable" and the nav chip keeps calling
candles live, because it tests the provider *name*, not whether it works.

The proposed replacement `datapi.jup.ag/v2/charts` has **perfect CORS on all
three runtimes** (`romapps.xyz`, `app://rom-nova`, `localhost`) — but returned
`{"candles":[]}` with the parameters quoted. Routed to W3 to measure rather than
swap on trust.

### Routed to the running builders

**W3:** `liquidityUsd: m.liquidity ?? 0` — the same field has two behaviours in
one file, and the launch-feed path already handles it correctly. A 1-minute-old
mint scored **−16.4 "Liquidity Quality: $0 pooled"** while Jupiter's API
reported $3,160 for it. **Every newly-minted token is depressed ~16 points by an
absence rendered as a confident zero** — on precisely the population a sniper
terminal exists for. Also: "WHALE 6H" is a ten-minute window, in the column
header, the field name and the invalidation copy alike.

**W2:** triage fails **45 of 74 rows (61%)**, against its own comment warning
that failing half the feed "would teach a reader to ignore the verdict inside an
hour". And pool accounts are offered as traders — the scanner's Buyers column
links to accounts `/whale` then refuses to profile, and `/whales` ranks the Pump
Fun AMM pool and the **burn address** as movers.

---

## W2 round 2 — and a correction I owe

**I relayed a bad premise and the builder caught it.** I passed on the critic's
"pump.fun `/coins` is keyless and 2.0s fresh, swap the graduation path to it" as
a free fix. It isn't: that endpoint **allowlists its own origin**, and `Origin`
is a header a page cannot set. From `app://rom-nova` it 403s. The 2.0s
measurement was a bare GET from Node — true, and useless to a browser.

I re-checked and confirmed the correction: no `access-control-allow-origin` on
any origin. Both the critic and I were wrong; the existing code comment was
right. **That's twice now a bare GET has produced a misleading CORS reading** —
once making a working API look dead, once making a dead route look usable.

The real fix was a vendor already in the stack. I verified it independently:
`POST datapi.jup.ag/v1/pools/gems` preflights **204** with correct ACAO and
POSTs **200** with a 64KB payload, from **both** `app://rom-nova` and
`https://romapps.xyz`.

| source | n | min | p50 | p90 |
|---|---|---|---|---|
| datapi gems.graduated | 11 | 1.0s | **3.0s** | 4.0s |
| geckoterminal new_pools | 14 | 11.0s | **40.0s** | 72.0s |

Gems led on all 6 graduations both saw, by a median of 50s. End to end:
**123.6s → 1–3s.**

### Three bugs it caught in its own work, by measuring

- `mergeLaunch`'s `Math.min` dating meant a mint that graduated kept its *curve*
  timestamp — a 3s feed reporting **1,478s**.
- `bondingCurve` is a percentage, not a fraction. Would have shipped 100× —
  caught rendering `3538%` against live data.
- Its own clock-skew hint had the **sign inverted**, printing "clock ahead" on a
  machine bracketed at 2.85s behind.

### The triage answer is better than the question

Asked to justify a 61% AVOID rate, it reproduced **70%** — then measured the
thing the check never sees: the creator rule fails **33% of new mints but only
3% of mints that went on to graduate.** It discriminates, so the thresholds
stayed on that evidence rather than being tuned to look friendlier. It also
*rejected* the cheap fix of excluding graduations structurally, because freshly
graduated pools have a **median liquidity of $0** — there, "low liquidity" is
real rather than an artifact. The base rate is now disclosed instead of hidden.

Its calibration comment was stale (median deployer 75 → **32**) and is now true.

**Clock note:** this machine is 2.850s behind and *drifting* — 2.39s → 2.787s →
2.850s across the session. Always the direction that flatters a latency claim.

### Round-2 review: 8 of 9 fixed, verified — then two small defects

The critic proved which build it was looking at by SHA256-matching the served
bytes against the worktree, ran an 8-minute session with 187 tracked arrivals,
and staged a **deliberate 79-second outage**. At 65s in: red `■` instead of the
pulsing dot, `last pass failed` instead of `+N`, `mint lag —`, and a banner
naming 65s / 17 attempts / `Failed to fetch`. Recovery in 10s. That closes
round 1's critical item properly.

**Graduation latency: p50 123.6s → 3.9s end-to-end, against a vendor floor of
4.0s.** It is *at* the floor — the remaining gap to Axiom is the vendor's own
indexing, not the app.

Both remaining defects are now **fixed on main**, and both were one condition
wide — and both contradicted something the page was already saying correctly one
cell away:

- **`near graduation` returned already-graduated tokens.** `mergeLaunch`
  preserves `bondingCurvePct` through graduation, so a graduated row kept a
  stale curve value and passed the `>= 0.8` test — while its own Curve cell read
  *"n/a — graduated, the curve is gone"*. Two of three matches in review were
  graduations. A sniper asking what is about to migrate got the one set they
  cannot act on.
- **The clock check watched the wrong pipeline.** Graduations cross zero FIRST —
  they arrive in seconds, so a 2.88s offset is a large fraction of the figure,
  while mints lag longer and stay positive. The UI printed **`grad lag -0s`** and
  warned about nothing. The critic's second pass settled the cause: across **215
  samples there were zero negative arrival lags at the vendors** — every row was
  older than the `Date` header on its own response, so the negatives on screen
  were this machine's skew and nothing else.

397 tests. `tests/launch-filters.test.ts` covers the case that hid the second
one: mints plausible while graduations are already negative.

---

## W3 round 3 — merged to main · 447 tests

All nine critic items plus the four merged-build additions are addressed. The
first blind critic on this round was killed by a rate limit before ruling; a
fresh one is running against the merged result.

### It found a defect in MY commit

The interrupted round-3 WIP I preserved and gate-verified (`bb60d49`) carried a
comment claiming `lpProviders` stayed unmeasured — **but nothing added it to the
set**, so a vendor zero produced the fabricated sentence *"a single provider
holds the pool — that party can withdraw it."* I checked typecheck, tests and
build on that commit; I did not check that its comment described behaviour that
existed. Lesson recorded.

### Highlights, with live measurements

- **The critical liquidity zero** ([A]): blast radius was **six readers**, not
  one — `exitDepthUsd` took the exit penalty to maximum *and* fired a
  high-severity flag, `regimeOf` inferred `low_liquidity`, and the abstention
  gate announced "$0 below the floor". A 3-second-old mint (`USWR`) with
  `liquidity: undefined` now stands the factors down; everything with a real
  pool still scores.
- **LP lock on PUMP: −6.3 → −1.0** (score 49→51). The false "pool can be
  withdrawn" sentence was in **four** places; the remaining gap to WATCH is
  measured 68% top-10 concentration — real, and left alone.
- **A second midpoint leak**: `REGIME_ADJUST` multiplied the whole mean, which
  is a constant added to every factor row — an evidence-free token scored 42.5
  in `risk_off`. Now scales the deviation, so 50 maps to 50 in every regime.
- **The chart mystery solved**: `datapi.jup.ag/v2/charts` wants
  **milliseconds** — and given seconds it returns **HTTP 200 with an empty
  array**, indistinguishable from "this token has no history". I verified:
  same call, seconds → 0 candles, milliseconds → 168 real bars. My earlier
  "params need work" conclusion was this trap. Adapter verified 7d→168 bars;
  GeckoTerminal stays primary.
- **Serial deployer: cap, not veto** — and the first threshold (1,000 mints)
  was rejected as an arbitrary cliff after it capped MAGA (4,681 / 4.3%) while
  clearing STACY (731 / 4.5%). Recalibrated to a 250-mint sample-size floor
  with the graduation rate doing the judging; **Orangutan (405 mints, 8.4%
  graduation) passes**, which is the row that proves it discriminates.
- **Custodial wrappers stay EXTREME RISK**, deliberately: any exemption is a
  list, and a mint allowlist is exactly what a scam impersonating USDC needs.
  The failure modes aren't symmetric — over-warning about Circle vs
  under-warning about something wearing its name.

### ✅ Round 3 verdict: PASS — the campaign's first

A fresh blind critic tested seven live pages (PUMP, TRUMP, Fartcoin, SKHY, USDC,
a **0.2-minute-old** mint from a 166-mint serial deployer, and a 4-minute-old
~100%-concentration token), verified `location.port` on every measurement, and
confirmed **all twelve failed items genuinely fixed — live and in source, none
cosmetic**.

The discrimination check it weighted heaviest: SKHY (live authorities, RugCheck
81) → **EXTREME RISK / 5** · fresh gambles → **NO TRADE** · TRUMP (82% insider
top-10) → **WEAK / 35** · PUMP → **NEUTRAL / 45** · Fartcoin (77.8% LP locked,
deep, old) → **WATCH / 60**. Verdicts track danger; nothing dangerous gets a
positive label; nothing safe and non-custodial gets flagged extreme.

Against the reference: **BEATS** on safety depth and honesty ("no commercial
tool does any of this" — the summing factor audit, printed source
disagreements, abstention, per-number provenance), **MATCHES** the standard
header/holders/socials/security surface, **LOSES** on chart granularity (hourly
vs 1s/1m — the one gap a memecoin trader feels daily, gated by GeckoTerminal's
throttle) and cold time-to-useful.

Both judged decisions accepted: the deployer cap discriminates on the
graduation *ratio* (166 mints/2.4% → −5.5 + NO TRADE; 495 mints/**53%** — the
pump.fun migration authority — → 0.0), and custodial wrappers stay EXTREME RISK.

### Post-PASS fixes, shipped to main same hour

- **The chart showed the other token's price on quote-side mints.** USDC's
  deepest pool is ETC/USDC; the OHLCV defaults to base, so its page charted a
  ~$7.90 series under a $0.9999 header. Verified live: `token=base` → 7.91,
  `token=quote` → 1.0013, same pool. `poolFor` now returns the side. Memecoins
  are essentially always base-side — which is why every memecoin charted
  correctly and the bug hid in the majors.
- **`no_pattern` archetype** — the fallback was `momentum_ignition`, a pattern
  claim by elimination, worn by a token bleeding −51%.
- **An invalidation line promising the unobservable** ("no smart-money
  confirmation within 24h" on a capability declared NEVER_AVAILABLE) is omitted
  when unmeasured — a condition nobody can watch doesn't belong on a watch list.
- **A backtest trade that exited before it entered.** Entries fill at
  `ts + entryDelayMin`; a signal on the final hourly step fills after the window
  closes and the end-of-run pass force-closed it ten minutes before its own
  entry. Wall-clock-dependent — reproduced on the previous commit with today's
  changes stashed, so it predates them all. Caught only because the gates
  happened to run at the right hour.

### The standing trap, generalised

"Most wrong on the largest tokens" appeared twice more this round — once at the
*opposite* end (newest tokens). The generalised shape: **a metric whose error
concentrates at one end of the age/size distribution**, and the defence is that
absence declarations must be asserted at the seam, not left to whichever
adapter remembers.

### Why a critic on the merged build

Every prior review looked at ONE stream in its own worktree. Eleven files were
touched by more than one stream and eight conflicts were resolved by hand —
**nobody has reviewed the result.** Cross-stream regressions are the one class no
existing review could have caught: a shared engine change breaking another
stream's assumption, a hand-resolved conflict dropping a line, two pages
disagreeing about the same field.

### Open, by stream

**W2 — the biggest measurable gap in the app.** Graduations arrive at p50
**123.6s** against Axiom's seconds. Free to fix: pump.fun's own `/coins` is
keyless and measured **2.0s fresh** where GeckoTerminal is 89s stale. Also: the
lag stat structurally excludes graduations, and three overclaims in copy
including a rate-limit headroom comment that measurement contradicts (150 calls
at 1/s → **93 × 429**).

**W3 — the same trap, a third time.** LP lock charges PUMP its largest single
penalty over **43 independent LP providers**, under a red line reading "the pool
can be withdrawn" that is simply false at that provider count. Round 2 demoted
the flag and left the penalty at maximum. Plus a vendor zero (`totalLpProviders:
0` on 30 of 30 fresh mints) that is the identical bug class to one already fixed
on a sibling field in the same panel.

**W1 — open but shipped.** Electron main-process RPC proxy for 30+ day wallet
age, factual labels (exchange/program identification, which Solscan publishes
free), and `/whales` discovery still simulated.

Wave 1 (W1–W3) is running in parallel, each in its own git worktree. Blind
critics are dispatched as each artifact lands.

### ⚠️ Interruption — all five agents killed by a session rate limit

Every builder and critic died at once mid-round. The critics had already
delivered their full verdicts, so nothing was lost there. The three builders were
killed mid-edit.

**Nothing was lost.** All WIP was committed, then verified by me directly:

| stream | state at kill | after repair |
|---|---|---|
| W1 | 24 files dirty, one step from its gates | **complete** — tsc clean, 267/267, build clean |
| W2 | 7 files dirty, critical item done | **green** — tsc clean, 233/233 |
| W3 | 5 files dirty, **4 tests failing** | **repaired by me** — 249/249, build clean |

W3's failures were the dangerous kind, so I fixed them myself rather than wait —
see its section below.

---

## W1 — Real wallet tracking

**Why this is first:** it is the only capability in Nova that is still entirely
**fake**. `/status` says so: *wallet activity — simulated*, *smart-money scoring
— simulated*. Every wallet name in the app ("Meridian Desk", "Tidewater
Capital") is invented, every PnL figure is measured against a synthetic
universe. For an app whose original name was WHALENOVA, that is the gap.

**Target:** paste any Solana address → real positions, realized and unrealized
PnL from actual fills, trade history, win rate, hold times, and what they are
buying right now. Keyless.

**Status:** ❌ **FAILED blind review — round 2 building**

Wallet tracking is now real: paste any Solana address and Nova reads it off the
chain, keyless. FIFO replay over fills recovered from `pre/postTokenBalances`,
priced at the hour each fill happened.

### The arithmetic is provably correct

The critic didn't take the numbers on trust — it wrote an **independent FIFO
replay** against raw `getTransaction` data and compared:

| figure | app | independent replay |
|---|---|---|
| realized PnL | −$4.24 | −$4.2359 |
| round trips | 4 | 4 |
| one round trip | $106.81 in, +$0.1810, 10.8h | identical |
| win rate | 25% | 25% |
| unmatched sell mints | 6 | 6 |

It specifically hunted for sells matched against phantom buys, transfers counted
as trades, fills priced at today's price, and double-counted positions. **Found
none.** It rated honest-absence and provenance as beating every commercial tool.

### The correction I owe you

I told you this needed a Helius key. **That was wrong for anything running in
Node**, and I got it wrong because my probe sent an `Origin` header on every
request. Re-measured, same address, same moment:

| endpoint | Origin sent | signatures | oldest |
|---|---|---|---|
| `api.mainnet-beta.solana.com` | **none (Node)** | **1000** | **33.76 days** |
| `api.mainnet-beta.solana.com` | `app://rom-nova` | 403 | — |
| `solana-rpc.publicnode.com` | any | 77 | 2.02 days |

`mainnet-beta` 403s browsers but answers Node fine. `HISTORY_RPC` is a hardcoded
constant, so **the server route discards ~17× the history it could have for
free** — and, more importantly, the **Electron shell has a Node main process**
(`desktop/main.js`, already importing `net`). The installer could proxy RPC
through it and give users 30+ days instead of 2, at no cost. That's now the top
item on W1's round 2.

The website build stays capped at ~2 days; **that** half genuinely needs a key.
Three runtimes, three honest depths.

### Other failures found

- **Portfolio value omits native SOL.** The Binance hot wallet renders
  **$162.20M** while holding 1,661,879 SOL ≈ $174.9M more — the page's largest
  number understated by 52%. The SOL price is already in the app header.
- **A token mint pasted as a wallet renders as a wallet** with a $520.8K
  portfolio and no warning. One `getAccountInfo` identifies it.
- Empty wallets render **`12/31/1969`**, and are told "first activity was 0.0
  days ago" when they have none.
- **"every movement priced" printed on wallets with zero movements** — the
  honest-absence rule failing in the one direction nobody guarded.
- Realized PnL (−$4.24) doesn't reconcile with the round-trips table beneath it
  (−$0.45). Both correct, different bases, nothing says so.
- 28.7s worst case against GMGN's 1–2s; 40+ console 429s.
- `/whales` is still fully simulated — with a caption above the fake rows reading
  "smart-money scores are **measured** … not asserted".

---

## W2 — Launch / sniper feed

**Target:** new pools and pump.fun graduations within seconds, each triaged on
arrival — LP locked, authorities, creator mint count, top-holder share — so the
feed is a filter and not a firehose.

**Status:** ❌ **FAILED blind review — round 2 building**

A `/launches` page: new mints, pools and graduations, triaged on arrival. Eight
checks, seven of which ship inside the listing response, so the verdict lands
501ms after the row appears.

### It beat the reference on the thing that matters most for safety

The critic singled out one decision as **"the single most correct decision in the
artifact"**: grading LP-lock and top-10 share as `n/a` for pre-graduation
bonding-curve tokens. **Every reference tool shows a green "LP burned 100%" on
pre-graduation pump.fun mints — and that reading is inverted.** The percentage is
the bonding curve, not a pool.

### The critical failure: it looks alive when it is dead

The critic killed every vendor fetch for 74 seconds. The feed froze at 122 rows,
the top row aged to 59s, and the UI kept showing a **pulsing live-dot, "feed lag
3.7s", and "+3 last pass"** still asserting arrivals. No banner, no stale badge.

The defence was built and never wired: `polledAt` is computed and rendered
nowhere. Photon greys out in this situation. A sniper watching a dead feed
concludes nothing is launching.

### Latency, measured independently rather than trusted

| | this feed (TRUE) | UI claimed | reference |
|---|---|---|---|
| new pools | p50 **6.6s**, p90 39.6s | "3.7s" | pump.fun's own board **2.0s**, Photon ~1s |
| graduations | p50 **123.6s** | not shown | Axiom: seconds |

Graduations lose by **~60×** — and that one is free to fix: pump.fun `/coins` is
keyless and measured 2.0s fresh, against GeckoTerminal's 89s staleness.

Pools losing ~3× is mostly a **source floor** — Jupiter polled at 1s still gives
p50 5.7s — so closing that needs a push transport, not a better poll.

### Two claims that didn't survive checking

- The builder's "2.3s of pool creation" was the *floor* stated as the median;
  measured p50 is 5.7s.
- "45 consecutive calls at 1/s returned zero 429s" — the critic's 150 calls at
  1/s returned **93 × 429**. The app is fine at its own 3s cadence (56/56 clean),
  but the comment states headroom that doesn't exist, and someone would raise the
  poll rate on the strength of it.

Both critics and I independently measured this machine's clock at **~2.3s behind**
— the direction that flatters a latency metric.

### Three findings that changed the design

- **LP-lock percentage is inverted on fresh launches.** 100% on 19 of 24 new
  mints, 0% on 5 — while PUMP ($41.9M liquidity) reads 0.04%. That figure is the
  bonding curve, not a pool. Graded `n/a` pre-graduation, as is top-holder share:
  on a curve, the top holder *is* the curve.
- **The median new pump.fun token comes from a deployer on their 75th mint**
  (n=47; 51% at 50+, 28% at 1,000+, max **155,516**). A 50-mint red flag would
  flag half the feed, so the threshold is calibrated at 1,000+, or 50+ with under
  5% ever reaching a pool.
- **There is no positive verdict.** RugCheck answers a 7-second-old mint in 130ms
  with an empty risk list and a score of 1 — because nothing has looked yet.
  `UNVERIFIED` is the ceiling, by design.

Push transports were investigated and rejected on measurement, not vibes:
public-RPC `logsSubscribe` costs **1,000–2,500 MB/hr** in a browser tab;
PumpPortal is cheap (~1 MB/hr) but pump.fun-only and carries no triage data, so
it would buy time-to-first-row without touching time-to-verdict.

---

## W3 — Token deep-dive

**Target:** the token page at Photon/GMGN depth — full holder table with labels,
dev history, bundle and sniper detection, security panel, a chart that is
actually usable.

**Status:** 🟡 **round 3 repaired by me after the interrupt — awaiting critic**

### The interrupted round left a hole in the dangerous direction

Round 3 died mid-edit with four tests failing. One of them mattered a great deal:
a vector with **cap table, insiders, bundlers and dev holdings all unknown scored
EXTREME POSITIVE.**

The cause is worth recording, because it is a trap that will recur. The
abstention gate counted *the share of all risk factors that could be assessed*.
Round 2 added three authority checks, taking that list from eight to eleven — so
clean authorities alone now cleared "more than half assessable" while nobody had
read the supply at all. **A ratio taken over a list that changes length is not a
threshold.**

I replaced it with a named family: `SUPPLY_RISK_KEYS` is *who holds this and who
made it*, and the authorities are deliberately excluded. "Nobody can inflate
this" is not evidence about who is already holding it, and the two must never
substitute for one another.

The family also excludes the two factors **nothing in this stack can ever
publish** (bundler/sniper share, dev selling) — because counting a
permanently-blind factor is exactly what broke the *original* rule, where every
token started one gap down and any second gap abstained.

Measured, on live trending mints:

| gate version | outcome |
|---|---|
| count of all risk factors | 12 of 12 NO TRADE — verdict carries no information |
| share of all risk factors | EXTREME POSITIVE on a blind cap table |
| named family, knowable only | **7 distinct verdicts across 12 rows, scores 27–93** |

Verified live: SKHY (risk 81) → **EXTREME RISK 27**, cbBTC → 42, HNT (71) → 64,
TRUMP (58) → WEAK 41, PUMP (1) → WATCH 55. CATE's **19,083-mint deployer** draws
−5.9 and a high-severity flag naming the count.

Two characteristics worth stating rather than discovering later:

- **cbBTC and USDC read EXTREME RISK, correctly.** Coinbase and Circle genuinely
  retain mint *and* freeze authority on their wrapped assets. The rule is right
  and fails safe; it is also harsh on legitimate custodial wrappers.
- **CATE stays POSITIVE at 74** despite the serial-deployer flag. A high-severity
  deployer warning penalises but does not veto — a judgment call the next critic
  should rule on.

Four tests were updated to the contracts that superseded them, not to green: the
veto now outranks abstention deliberately, dev *selling* split from dev
*holdings*, and the simulator's silence about deployer history became a declared
gap rather than a first-time-creator default.

### Round 2 verdict: all seven round-1 items genuinely fixed, then failed on new ones

### Round 2 verdict: all seven round-1 items genuinely fixed, then failed on new ones

The authority veto was verified by sweep: **6 live-mint-authority mints × all 9
profiles = EXTREME RISK in 54 of 54.** No positive verdict is constructible.
SKHY renders EXTREME RISK / 34 with three −9.0 penalties.

But three of the new failures are **the same bug class it had just fixed, one
field over** — which is the most useful thing this round produced:

- **`0 LP providers` printed as fact.** RugCheck returns 0 on 30 of 30 fresh
  mints, giving "22 pools · 0 LP providers · $2.43M across them" — impossible on
  its face. Identical to the `totalHolders: 0` bug it fixed in round 1, on a
  **sibling field in the same panel.** Fixed one at a time instead of swept.
- **Deployer mint history is displayed and not scored.** CATE prints "this wallet
  has issued 19042 mints… a serial deployer is a warning" — and the verdict is
  **POSITIVE / 73**. Structurally the same failure as round 1's headline: a fact
  the page shows prominently that the scorer cannot see.
- **The whale factor pays points for absent whales** — `+4.8, "no whale-sized
  trades in the window"`. A null result lands on the normalise midpoint and
  renders as credit.

### And the over-correction I asked the critic to hunt — it found it

PUMP: RugCheck 1/100, $42M pooled, 435 pools, **43 independent LP providers**, no
findings — and `LP Lock −9.0` is the largest single penalty on the page, under a
red `only 0.0% of LP locked — the pool can be withdrawn` printed directly above
`435 pools · 43 LP providers`. With 43 independent parties holding it, that
sentence is false.

Round 2 demoted the *flag* to medium and left the *penalty* at maximum. The audit
row's own text concedes the point and charges full anyway. Costs PUMP a whole
band. No reference tool raises an LP alarm on PUMP.

That is the same "most wrong on the largest tokens" trap that killed the
pool-excluded concentration figure — caught a third time, in a third place.

### Round 2: the score can now see the things that kill you

The four facts lived on `TokenInfo` and never reached `FeatureVector`. They do
now, along with three new `UnmeasuredField` keys so every adapter declares what
it didn't read, and five new risk factors.

The important design choice: **a veto, not a weight.** Nine points of penalty
can't stop a strong tape from rendering POSITIVE, so a verified-live mint
authority forces `EXTREME RISK` ahead of every score band, while the score itself
stays an honest weighted mean. And *unverified* ≠ *verified live*: unverified
stands the factors down and abstains through a named gate — never graded safe,
never asserted dangerous.

Reported effect: **SKHY 60 → 35, EXTREME RISK.** The most dangerous token tested
is now the lowest-ranked. A test proves a live mint authority cannot produce a
positive label **in any of the nine profiles** — and it ships with a control case
proving the scorer hasn't simply started failing everything.

**A find along the way:** Jupiter publishes top-level `mintAuthority` /
`freezeAuthority` *addresses* that are present only while live. SKHY carries both
and *no* audit flag — so reading the audit block alone reported "unknown" for the
one token where the answer was dangerous. RugCheck's token block is now a second
reader, and where the two disagree, **the dangerous answer wins**.

**And an over-correction it caught on itself:** grading LP lock as *high*
severity pushed PUMP to EXTREME RISK on 0.042% locked — which is simply what a
mature token reads across 435 pools and 43 independent LP providers. An unlocked
pool is only a rug when *one* party holds the LP, and nothing keyless publishes
that. Capped at medium. Same "most wrong on the largest tokens" trap that killed
the pool-excluded concentration figure earlier.

### Round 1 critic verdict, for the record: FAIL

Tested 6 real mints (PUMP $1.92B, ANSEM $368M, NYAN $114K liq, SKHY, a
**1-minute-old** token, a seconds-old one) plus malformed/nonexistent/empty input,
at two laptop viewports.

**Beat all four reference tools on:** working at all on real mints including one
minted 60 seconds earlier · time-to-useful (298ms header, 1231ms panels) ·
per-number provenance · the source-disagreement panel, which caught PUMP's holder
count differing 3.7× between vendors and SKHY's top-10 share differing by 55.6pp
and refused to average them. No reference tool does that last one.

**Disqualifying failure — and I verified it myself:**

`src/lib/engine/signals.ts` contains **zero** references to mint authority,
freeze authority, permanent delegate or LP lock. Those live on `TokenInfo`, never
on the `FeatureVector`, so **the scorer cannot see them even in principle.**

On screen that means ANSEM renders **69 / POSITIVE in green** inches from a red
43/100, while the security panel beside it says mint authority UNVERIFIED, freeze
authority UNVERIFIED, and *"only 45.8% of LP locked — the pool can be withdrawn"*.
SKHY — live mint authority, live freeze authority, permanent delegate set — scores
60, four points below fixed-supply PUMP.

And the page prints *"graded as live so an unexamined token is never treated as
safe."* Nothing grades it. **The scanner carries the same false claim, and I wrote
that line myself earlier today.**

The fix is to make the claim true, not to delete it.

Also failed: a RugCheck `totalHolders: 0` rendered as **"0 holders in total"
directly above 20 populated rows**; an insider figure that contradicts the panel
beside it; no price-change strip above the fold (every reference tool leads with
5m/1h/6h/24h); no socials despite Jupiter supplying them.

### 🚨 It found a live bug, and I confirmed it in production

Every row in the scanner links to `/token?m=<real mint>`. That page read the
**simulator's** store, which has never heard of a real Solana mint. So the
most-clicked path in the app — see an interesting token, click it — has been
landing on **"Token not found."**

Verified by me directly against `romapps.xyz` on the deployed 1.3.0 build, not
taken on the builder's word:

```
https://romapps.xyz/nova/token/?m=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
→ "Token not found. Back to the radar."
```

Live since the token list became real. Every release since has shipped a scanner
whose rows go nowhere. No test caught it because the handler was correct for the
world it was written against, and nothing asserted the two halves met.

Fixed on the W3 branch. **This is the top priority for the next release
regardless of how the rest of the critique lands.**

### Also surfaced by W3 (unverified by me yet — pending critique)

- Asking RugCheck for *more* detail returned *less*: `lpLockedPct` is published
  on `/report/summary` and not on `/report`, so the detail page was the only
  caller that lost the LP-lock figure.
- `handleCandles` threw a bare 404, leaving the chart on "LOADING CHART…"
  forever for a mint with no history.
- `liveFeatures` printed "momentum unavailable" four lines before "momentum from
  its 1h/24h stats" — two answers to one question, the exact failure that file
  had already fixed once for holder concentration.

---

## W4 — UI/UX + performance craft

**Target:** information density and latency that stands next to Axiom. Keyboard
navigation, instant perceived response, honest loading and empty states,
responsive down to a laptop.

**Status:** ⏸ scheduled after W1–W3 land, because it polishes what they add

---

## W5 — Alerts that actually fire

**Target:** desktop notifications in the Electron shell and in-app alerts on the
web, firing on wallet buys, score crossings and launch matches.

**Status:** ⏸ scheduled after W1–W3

---

## Deploy log

**1.5.0 — LIVE, verified 2026-08-31.** The critic-verified wave.

| check | result |
|---|---|
| tests | **447 passed** |
| release | `v1.5.0`, 83,128,856 bytes |
| SHA256 vs GitHub digest | **match** — `f079f2db…713073` |
| feed | `latest.yml` at 1.5.0 |
| site | v1.5.0 live; scanner/launches/token all 200 |
| other apps | untouched |

What users get that 1.4.0 didn't: a scanner that actually ranks · new mints no
longer depressed ~16 points by an unpriced pool · graduations at **p50 3.9s**
(was 123.6s) · a feed that admits when it's dead · the full W3 PASS (authority
veto, LP scaling, deployer cap, honest confidence) · quote-side charts showing
the right token's price · `/status` that says "not asked yet" instead of
pretending health.

**Two release-process traps, one old and one repeat:**
- The 1.5.0 bump committed `middleware.server-only` — `build-static.mjs` renames
  `middleware.ts` aside during export, and a `git add -A` landed inside that
  window, dropping rate limiting and security headers from any server build of
  that commit. **This exact accident IS v1.1.1's entire content** — twice is a
  pattern; the rename window needs closing. Caught before CI published; tag
  force-moved, broken run cancelled, checksums verified from the fixed tree.
- The site version bump via `Set-Content` mojibake'd 87 characters (the known
  PowerShell UTF-8 trap, re-confirmed). Reverted, redone with the Edit tool,
  final diff exactly 2 lines.
- Also merged in flight: the lint-fix PR from LO's separate session landed on
  main mid-release; rebased, single history, lint config included in the tag.

---

**1.4.0 — LIVE, verified 2026-08-30.** All three wave-1 streams merged.

| check | result |
|---|---|
| merge | W3 + W1 + W2 into one branch; 11 overlapping files, 8 conflicts resolved by hand |
| tests | **365 passed** (was 192 before the campaign) |
| release | `v1.4.0`, 83,121,683 bytes |
| SHA256 vs GitHub digest | **match** — `9897a045…07506b` |
| feed | `latest.yml` at 1.4.0 |
| site | v1.4.0 live; `/launches`, `/whale`, `/track`, `/token` all 200 |
| other apps untouched | Trader 1.15.1, Convert 1.0.0, Polybot 1.1.0, Scribe 1.2.0 |

### The live bug is dead

```
https://romapps.xyz/nova/token/?m=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
→ Bonk · VERIFIED · 1206D OLD · JUPITER
  PRICE $0.000002967 · 5m −0.1% · 1h +0.1% · 6h −0.6% · 24h −0.7% · MCAP $261.06M
```

Verified against production, not a local build. Every scanner row now leads
somewhere.

### Verified in the browser before shipping

- **Token page** — resolves real mints with the full 5m/1h/6h/24h change strip.
- **Launch feed** — 40 rows at **0s, 0s, 1s, 2s** old, every one triaged AVOID
  6–7/9, and one row reading **"MOGGED ×6 SAME NAME"** — the duplicate-name
  impersonation check, firing on live data.
- **Wallet page** — **$297.73M = $123.68M tokens + $174.05M in SOL**, the 52%
  understatement fixed and the split shown. "FILL WINDOW · NOT LIFETIME" above
  every figure. No 1969 timestamps.

### A verification trap worth remembering

The launch feed looked broken — zero rows for 25 seconds, zero fetches. It was
not. The page correctly refuses to poll a hidden tab (a launch feed left in a
background tab would hammer Jupiter every 3s on someone's battery), and **the
in-app browser pane reports `visibilityState: "hidden"`**. Forcing visibility
produced 40 rows immediately. The measurement was broken, not the app — the same
class of false alarm as the pane refusing to composite WebGL.

### Also fixed while shipping

The dashboard footer still read *"running on a deterministic synthetic universe
(demo mode) … connect provider API keys to prepare live mode."* Both halves false,
and in the direction that teaches a reader to discount a real number. That is the
third place this same stale claim has been found and killed.

---

**1.3.0 — LIVE, verified 2026-08-29.**

| check | result |
|---|---|
| release | `v1.3.0`, ROM-Nova-Setup.exe, 83,072,637 bytes |
| SHA256 vs GitHub digest | **match** — `7ea5affc…ab0b99` |
| update feed | `latest.yml` at `version: 1.3.0` |
| site | v1.3.0 live; `/nova/track/` returns 200 |
| stale "only the SOL price is real" claim | **gone** from the site |
| other apps' versions untouched | Trader 1.15.1, Convert 1.0.0, Polybot 1.1.0, Scribe 1.2.0 |

---

## Shipped in this campaign's first release (1.3.0, live)

- Jupiter Tokens V2 keyless — holders, concentration, dev balance, creator mint
  history, launchpad, and momentum without candles. List went 25 requests → 1.
- RugCheck — LP lock state, named risks, third-party grade, kept out of the score.
- Track Record — forward test of Nova's own scoring, cluster-bootstrapped over
  scan passes, built to be able to report no edge.
- Fixed: whale netflow rendered `$0` beside a wallet that had moved $249,426.
