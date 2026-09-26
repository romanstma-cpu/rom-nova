# W3 — the token detail page

> **Iteration 2.** A blind review failed the first pass on one disqualifying finding and six
> smaller ones. The section at the end, *"Second pass: the score could not see the security
> panel"*, records what was wrong and what changed. Everything above it still holds except where
> that section says otherwise.


## The thing that was actually broken

Every row in the live scanner linked to `/token?m=<real Solana mint>`. That page called
`handleTokenDetail`, which read `DemoStore`, which has never heard of a real mint, and threw a
404. So the most-clicked path in the app — scan, find something, open it — ended on
**"Token not found."** Nothing failed loudly; the scanner looked fine and the link looked fine.

The page now has two halves. A real mint gets a live detail assembled from the keyless providers,
in the visitor's own browser; a simulated mint keeps the old page (paper desk, similarity study,
synthetic tape) and now wears a `SIMULATED` chip so the two cannot be confused. Verified by
clicking an actual scanner row in a real browser against the static export: it lands on the score
audit, the holder table and the flow table.

## What a user can now see that they could not before

Everything below is new on this page. All of it is keyless and all of it works from the static
export and from the Electron shell's `app://rom-nova` origin (every source was probed with an
explicit `Origin: app://rom-nova` header, not a bare GET).

- **The score, every factor.** A table of all eleven signal factors and four risk factors, each
  with the weight this profile assigns, its normalised reading, its signed points on the 0–100
  scale, and the sentence the factor produced. Factors that **stood down** are struck through with
  the weight they wanted, so "the model has no smart-money input" is visible as *1.6 of weight went
  unused* rather than as a silent absence. Footer carries coverage, confidence and the `NO TRADE`
  reason. The join between the stored signal and the profile's weights lives in
  `auditFactors()` in `src/lib/engine/signals.ts`, next to the weights, so it cannot drift.
- **A holder table with honest label coverage.** Up to twenty top holders with owner address
  (explorer link), share, running cumulative, insider flag, and the deployer's own row flagged.
  Above it, in the panel's most important sentence: *"1 of 20 rows carry a label"*.
- **Creator / dev history.** Deployer address, tokens minted, how many reached a pool, what the dev
  still holds, launchpad, and time since graduation. A dev balance nobody published renders as a
  dash, not `0.0%`.
- **A security panel where every line names who said it.** Mint authority, freeze authority,
  permanent delegate, LP lock, transfer fee, pool count, LP providers, insider networks, and
  RugCheck's named findings in RugCheck's own words — with the vendor's grade in its own header box,
  labelled *higher is riskier*, explicitly not an input to Nova's score.
- **Live flow with real addresses.** Up to twenty wallets that actually moved the token, net tokens
  and net USD, each linking to a block explorer, over the window **actually covered** rather than
  the one requested.
- **A disagreement panel.** See below.
- **A provenance panel.** The full narrative `liveFeatures` produces, with WARNING lines coloured.
- **A usable chart.** `PriceChart` gained an OHLC+volume crosshair readout (a memecoin's bars live
  four significant digits below a cent, and the price axis can only label a handful of them),
  24h/7d/30d/all ranges, a log-scale toggle, double-click to fit, and marker cleanup —
  `createSeriesMarkers` was being called fresh on every poll, stacking duplicate arrows and never
  clearing an emptied batch.

## Measured time-to-useful

Static export, `node scripts/serve-static.mjs`, real Chrome, cold navigation, timed from
`performance.now()` origin (navigation start) to the element appearing in the DOM.

| Mint | Header + score audit + holders + flow + security | Chart |
|---|---|---|
| `Dz9m…Mbonk` (USELESS) | 1599 ms | 4152 ms |
| `2zMM…ouauv` (PENGU) | 1686 ms | — |
| `Ce2g…3pump` (neet) | 1341 ms | 3973 ms |
| `SKHY…i9EQ3` (SKHY) | 1166 ms | — |
| `zj1j…ry2k` | 1184 ms | 3702 ms |
| `Gbbe…LkKc` | 960 ms | 3672 ms |
| a simulated mint (CHOR) | 576 ms | (store) |

**~1.0–1.7s to everything except the chart; ~3.7–4.2s to the chart.** That split is a design
decision, not an accident. GeckoTerminal is the only keyless source with history, it needs two
calls (pool lookup, then OHLCV), and the repo serialises it with a 2.1s gap because it answers
bursts with 429. Paying that before showing the score would have tripled the time to anything
useful, so the detail handler deliberately passes a no-op market provider and the chart keeps its
own endpoint and its own provenance chip.

The cost of that split is stated on the page rather than hidden: with no bars in its vector, the
score reads the token provider's published 1h/24h price change, and a line under the chart says so.
A reader must not assume the candles above the score fed the score.

The simulated path costs ~250ms more than before, because the live path is attempted first and
Jupiter's search has to miss before the fallback runs. 576ms total.

Per-load byte cost: RugCheck's full report measured 53KB (SKHY) to 1.1MB (ANSEM); SQD's flow stream
0.5–3.8MB for a ten-minute window. `liveTokenDetail` caches an assembly for 20s and de-duplicates
in-flight requests, so the page's 30s poll does not re-download a megabyte every tick.

## Bugs found by building this

1. **Asking for more detail returned less.** RugCheck publishes `lpLockedPct` on
   `/report/summary` and **not** on `/report`. Measured on four trending mints, absent from all
   four. The detail page is the only caller that asks for the full report, so it was the only
   caller that lost the LP-lock figure — the single risk in this stack that catches the mechanic
   behind most memecoin losses. The per-market `lp.lpLockedPct` values in the report do **not**
   reconstruct the summary's aggregate (PUMP: summary 0.042%, its pump_fun_amm pool 0.0000021%,
   every other pool 0), so deriving one would have produced a second unexplainable number. Fixed by
   fetching the ~300B summary in parallel and taking the vendor's own aggregate. Test:
   `tests/token-detail.test.ts`, "asking for more detail must not return less".

2. **A chart with no data loaded forever.** `handleCandles` threw a generic
   `404 unknown mint or empty range`, and the panel had nothing to print, so it sat on
   "LOADING CHART…" indefinitely — the chart-shaped version of rendering an unmeasured field as a
   zero. The 404 now carries the provenance note, and the panel renders it. Seen live once
   GeckoTerminal started rate-limiting: *"No price history for this mint — coingecko unavailable —
   Failed to fetch. The rest of this page does not depend on it: the score never read these bars."*

3. **Two answers to one question, in the provenance.** `liveFeatures` printed
   `NO candles — momentum and volume acceleration unavailable` and then, four lines later,
   `momentum from its 1h/24h stats rather than from bars`. The first line now reports only what the
   market source returned and lets the block below say what filled the gap.

## Where two sources disagree — measured, on live data

The page collects these and prints every claim with its source attached. It never reconciles them:
averaging two irreconcilable counts manufactures a third number nobody measured.

- **Holder count.** Jupiter and RugCheck are consistently far apart, and neither publishes its
  counting rule. PUMP: 135,714 vs 505,751 (3.7x). PENGU: 547,888 vs 1,961,156 (3.6x). ANSEM:
  136,357 vs 305,306 (2.2x). SKHY: 1,057 vs 2,945 (2.8x). Threshold to report: 1.25x.
- **Top-10 share.** Sometimes identical, sometimes not. PUMP 67.60% vs 67.72%; ANSEM 65.35% vs
  65.44% — but PENGU 38.97% vs 45.09% (6.1 points) and SKHY 32.32% vs 87.98% (55.7 points).
  Threshold to report: 3 percentage points. The score uses the token provider's figure; the holder
  table shows the vendor's rows; the panel says which is which.
- **Deployer address.** Jupiter's `dev` and RugCheck's `creator` differ on ANSEM
  (`yHCxHB…6PRe` vs `9ENSWn…G1jr`) and on SKHY. One is likely the launchpad's deploy account and
  the other the wallet that paid it; nothing here can say which, so both are shown.
- **Mint / freeze authority.** Jupiter, the chain (`solana-rpc`) and RugCheck all agreed on every
  mint tested. The comparison is deliberately restricted to sources that genuinely *read* the mint
  account: the keyless token providers report "not revoked" whether they looked or not, and
  treating that fail-safe default as a claim would put a conflict panel on every unexamined token.
  Test covers both directions.

## Documented negative result: pool labelling does not work

The obvious fix for a holder table that is 94% unlabelled is to find another way to name the pools.
The report carries a `markets[]` array whose `liquidityA` / `liquidityB` / `pubkey` fields **are**,
on some tokens, verbatim the accounts topping the holder list — SKHY's largest holder (43.17%) is
exactly `markets[0].liquidityA`, and its owner is exactly `markets[0].pubkey`.

Measured across ten trending tokens, 200 top-holder rows:

| labelling route | rows named |
|---|---|
| `knownAccounts` (what ships) | 12 / 200 — 6% |
| `markets[]` vaults and pools | 9 / 200 — 5% |
| either | **13 / 200 — 7%** |

Half a percentage point does not pay for a second labelling path, so it was not shipped. The
adapter still asks `knownAccounts` and only `knownAccounts`.

This also re-measures the claim in `rugcheck.ts`'s header. That note says the labels covered
"12 of 20 top holders for CARDS"; today's trending list gives 6% overall, with **zero of twenty**
on PUMP and on HNT and a best case of 3 of 20. Whatever CARDS was, it is not typical, and the
header comment now says so.

One thing that *did* pay: the report's own `creator` field. On two of the ten tokens the deployer
was inside the top twenty and `knownAccounts` named neither. That row is now flagged `deployer`.

## What remains unmeasured, and why

Rendered as dashes with a tooltip, never as zeros. On the ANSEM page, six of fifteen factor rows
carried no reading.

| Field | Why |
|---|---|
| `smartMoney` | Knowing which wallets moved is not knowing whether they are any good. No source in this stack carries wallet reputation, so the 1.6-weight Smart Money factor stands down on every live token. |
| `socialScore` | Needs a social-listening product. Nothing keyless. |
| `bundlerPct`, `sniperPct` | Needs launch-time forensics no keyless source publishes. The Bundler/Sniper risk factor is never assessed, which is one of the two unassessable risks that can trigger `NO TRADE`. |
| `uniqueBuyers1h`, `uniqueSellers1h` | Jupiter counts traders and net buyers; a net cannot be unpacked into two counts without inventing the split. |
| `momentum` / `volumeAccel` from bars | Available, deliberately not fetched on this path — see the timing section. Filled from the token provider's published interval stats, and the audit row names the source. |
| holder labels | 94% of top-holder rows are unnamed. The coverage count is printed instead of a derived figure. |
| `insiderPct` | Measured *only* from the full report, where the graph analysis ran; a defined zero there is a finding, not a silence. |

## Things worth knowing about the flow panel

SQD returns the ten-minute window in 260–655ms for a trending memecoin, well inside its byte
budget, so `complete: true` on everything tested. The discard rate is enormous and now visible: on
ANSEM, **16,772 rows were accounts merely touched by a transaction** against 641 real balance
changes. Counting rows instead of changes would have overstated participation by 26x.

The whale threshold is $20,000, which means a busy flow table can sit under a Whale Accumulation
factor reading "no whale-sized trades in the window". Both are true; the panel now states the
threshold so the two panels are not read as contradicting each other.

## Gates

```
npx tsc --noEmit          clean
npm test                  17 files, 227 tests passed (35 new in tests/token-detail.test.ts)
npm run build:static      clean, 22 routes exported
npx eslint <touched>      clean
```

Browser console on the token page shows only the static export's pre-existing
`__next.<route>.__PAGE__.txt` 404s from nav-rail prefetching — emitted for other routes, present
before this work, unrelated to it.

`npm run probe:detail -- <mint>` prints the whole assembled payload from a terminal, including the
factors that stood down and any disagreements, without a browser.

## Second pass: the score could not see the security panel

A blind review of six real mints found the page's central claim was false. It was right.

### The disqualifying one

`src/lib/engine/signals.ts` contained zero references to `mintAuthorityRevoked`,
`freezeAuthorityRevoked`, `permanentDelegate` or `lpLocked`. Those facts lived on `TokenInfo` and
never on `FeatureVector`, so **the scorer could not read them even in principle**. The page said
otherwise in two places, and the scanner's hint text claimed the score weighed "chain-read mint &
freeze authority". It did not.

What that produced: **SKHY** — live mint authority, live freeze authority, permanent delegate set,
0% LP locked, RugCheck 81/100 — scored **60**, four points *below* fixed-supply PUMP. **ANSEM**
rendered 69/POSITIVE in green beside a red 43/100, and its "WHAT COULD MAKE THIS FAIL" list
mentioned none of the security panel's findings.

The fix makes the claim true rather than deleting it:

- Four fields added to `FeatureVector`: `mintAuthorityRevoked`, `freezeAuthorityRevoked`,
  `permanentDelegate`, `lpLockedPct`. Three new `UnmeasuredField` keys — `authorities`,
  `permanentDelegate`, `lpLocked` — so every adapter declares what it did not read.
- Five new risk factors: **Mint Authority**, **Freeze Authority**, **Permanent Delegate**,
  **LP Lock**, and **Supply Concentration**. The last one exists because `distribution` is a
  positive-family factor that bottoms out at zero around 60%, so extreme concentration could only
  fail to add points, never cost any (the review's item 6). It starts where `distribution` has
  already saturated, so the two do not double-count.
- A **veto**, not a weight. A risk factor is worth nine points; a vector with deep liquidity, 240%
  volume acceleration and a 97/100 organic score absorbs that and still renders POSITIVE. So
  `securityVetoOf()` returns a measured, disqualifying fact and `labelOf` forces `EXTREME RISK`
  ahead of every score band. The score stays an honest weighted mean; the label carries the veto.
- **"Unverified" and "verified live" stay distinct**, which is the whole design. Verified-live →
  penalty plus veto. Unverified → the factors stand down, a named gate abstains
  (*"the mint and freeze authorities could not be read"*), and nothing is graded as safe.

Measured before → after, same four mints:

| | before | after |
|---|---|---|
| SKHY (mint + freeze live, delegate set, 0% LP) | 60, scored | **35, EXTREME RISK** |
| PUMP (both revoked) | — | 53, NEUTRAL |
| PENGU | — | 55, WATCH |
| ANSEM (both revoked, 46% LP locked) | 69, POSITIVE | 65, POSITIVE |

The most dangerous token tested is now the lowest-scoring one, and the verdict moves when the
authorities do. `tests/token-detail.test.ts` proves a live mint authority cannot produce a positive
label **in any of the nine strategy profiles**, including `high_risk`.

### A source that reads what nobody noticed

Jupiter publishes top-level `mintAuthority` / `freezeAuthority` **addresses**, present only while
the authority is live. SKHY carries both and carries no `audit.mintAuthorityDisabled` at all — so
reading the audit block alone reported "unknown" for the one token in the sample where the answer
was dangerous. `authorityState()` reads both signals. RugCheck's `token` block is wired in as a
second reader, and where two readers disagree the **dangerous** answer wins. That is why the
authorities now read `solana-rpc + rugcheck` instead of the review's observed UNVERIFIED: one
rate-limited RPC call no longer blanks a fact two other sources have.

### The other findings

- **A zero standing in for "not indexed yet".** RugCheck returns `totalHolders: 0` on fresh mints
  with twenty populated rows, and the page printed "0 holders in total" above them. Two consumers
  had written two different guards for one field. Normalised once, in the provider.
- **The self-contradicting insider claim.** "insider-linked wallets hold ~0% of supply" beside
  "3 insider networks, 12 wallets". The field only sums insider flags among the *published top
  holders*; both sentences now say their scope, and the zero case says outright that networks
  outside the top holders are not counted there.
- **No price-change strip.** 5m/1h/6h/24h now sits second in the header. `momentum6h` was added to
  `TokenSnapshot` — `rows.ts` had been filling its 6h column with the 24h figure.
- **No socials.** Website, X and Telegram from the Jupiter payload already being fetched.
- **NO TRADE carried no information.** Five of six mints abstained through `unmeasuredRisks >= 2`,
  which fires permanently because Jupiter never publishes `bundlerPct`/`sniperPct`. Replaced with a
  proportional rule over the eight risk factors, plus the named authority gate. The scanner now
  shows a 30–90 spread that tracks the third-party risk column instead of a wall of dashes.

### One thing the fix got wrong first

Grading LP lock as *high* severity pushed **PUMP** to EXTREME RISK on 0.042% locked. That number
runs near zero on any mature token by construction — PUMP has 435 pools and 43 independent LP
providers, none of whom withdrawing is a rug — and an unlocked pool is only a rug when *one* party
holds the LP, which nothing in this stack publishes. The severity is now capped at medium, the
penalty still scales, and the factor's own explanation states the limitation. This is the same
"most wrong on the largest tokens" trap that killed the pool-excluded concentration figure.

### Also fixed while there

A rate-limited token provider used to surface as **"unknown mint"** — a permanent-sounding claim
about the token standing in for a temporary fact about us. `liveTokenDetail` no longer swallows the
error; the handler carries the reason and only reports it if the simulator misses too, so a demo
mint still resolves during an outage.

### Gates, second pass

```
npx tsc --noEmit          clean
npm test                  17 files, 249 tests passed
npm run build:static      clean
npx eslint <touched>      clean
```

Verified in Chrome at 1440x900 and 1280x800 against the static export: SKHY renders the red veto
banner and score 34, its holder panel reads "2,945 holders in total", its 5m change cell renders a
**dash** because Jupiter published none; ANSEM renders site/X/TG links, `solana-rpc + rugcheck` on
both authorities, and a bear case that finally leads with the LP lock and the concentration.

## What this is not

The score is still not a prediction of profit, and this page does not claim it is. It is a claim
that the evidence Nova can see points a particular way, with every input, every weight, every
missing input and every disagreement now visible on one screen so a reader can decide how much that
is worth.
