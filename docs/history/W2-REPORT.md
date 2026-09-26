# W2 — Launch Feed

A `/launches` page that shows new Solana pools and launchpad graduations within
seconds of creation, each one triaged on arrival. Everything below was measured
with `npm run probe:launches` against the live internet, not estimated.

---

## The measurement nobody else would have taken first

**This machine's clock runs 2.3 seconds behind every server the app talks to.**

Feed lag is `(when we saw it) − (when the source says the pool was created)`,
and those two timestamps come off two different clocks. Bracketed NTP-style off
the HTTP `Date` header against three independent hosts:

| host | offset |
|---|---|
| lite-api.jup.ag | behind by 2.35s, bracketed to [−2.48, −2.23] |
| api.rugcheck.xyz | behind by 2.48s, bracketed to [−2.71, −2.26] |
| api.geckoterminal.com | behind by 2.23s, bracketed to [−2.39, −2.06] |

Three unrelated servers agreeing means the offset is this machine, not them, so
correcting for it is valid. Uncorrected, the feed would have reported a 3.7s
median lag on a real 6.1s — flattering itself by 40% for no reason but a
wrong clock. Every number below is corrected and says so.

---

## Measured end-to-end latency, launch → triaged row on screen

Three runs of the real path (`launchFeed()`, the same function the page calls),
90 seconds each, at the shipped 3s poll:

| | raw | clock-corrected |
|---|---|---|
| p50 | 3.7 – 5.3s | **6.1 – 7.6s** |
| p90 | 6.4 – 7.3s | 8.8 – 9.7s |

Against the raw adapter with no triage fan-out in the loop (120s, 66–108
launches per run):

| | raw | clock-corrected |
|---|---|---|
| min | −0.3 – 0.3s | **2.1 – 2.7s** ← the floor |
| p50 | 2.7 – 3.4s | 5.1 – 5.8s |
| p90 | 5.4 – 5.7s | 7.9 – 8.1s |

**Call it six seconds, with a floor of about 2.3.** That splits into:

- **~2.3s** — Jupiter's own indexing delay. Not negotiable. The best-case row
  ever observed was 2.1s old when it first became visible.
- **~1.5s** — average wait for the next 3s poll.
- **~0.5s** — triage completing after the row appears (below).
- the rest is jitter in the launch rate and the request itself (p50 93ms).

The lag figure the page shows **excludes the opening backfill**. The first poll
returns a whole page of Solana — thirty mints spanning up to 82 seconds — all
stamped "first seen now". Counted, they turned a real 2.5s into a reported
**31.2s**. That is in the code as a deliberate exclusion with the reason
attached, because the same arithmetic on a slower source flatters it instead.

---

## What triage completes in that window, and what does not

**Verdict lands p50 501ms / p90 551ms after the row first appears, for 100% of
rows.** Two runs measured 363/521ms and 513/656ms.

The reason it is that fast: seven of eight checks cost **nothing extra**. They
ship inside the same listing response as the price — creator mint count,
migration count, mint and freeze authority, deployer allocation, top-holder
share, the source's own suspicion bit. Only the two RugCheck-fed checks are a
second request, and that request is ~300 bytes at p50 129ms.

### Completes inside the window

| check | coverage (87-row sample) |
|---|---|
| Mint authority | 100% |
| Freeze authority | 100% |
| Creator history (mint count, migration rate) | 100% |
| Creator rug history (RugCheck) | 100% |
| Vendor flags | 100% |
| Deployer allocation | **40%** — see below |

### Does not complete, and is reported as not completing

- **Deployer allocation is missing on ~60% of launches.** `devBalancePercentage`
  was present on 10 of 47 mints in one sample and 33 of 87 in another. This is
  the most damaging gap in the whole feed, because on a bonding-curve token it
  is the *only* concentration figure that means anything.
- **Holder distribution and LP lock cannot be answered before graduation at
  all.** Not a coverage gap — a structural one. See the next section.
- **No wallet flow.** Nothing keyless sees who is buying a 10-second-old token.
- **No price history.** There isn't any.

---

## The finding that changed the design

**LP-lock percentage is worse than useless on a fresh launch. It is inverted.**

Measured across 24 brand-new pump.fun mints, RugCheck's `lpLockedPct` came back
**100 on nineteen of them and 0 on five, with nothing in between.** Meanwhile
the same field on the deepest markets on Solana reads:

| token | liquidity | lpLockedPct |
|---|---|---|
| PUMP | $41.9M | **0.04** |
| TRUMP | $51.0M | **0.01** |
| HYPE | $5.8M | 0.006 |
| ANSEM (graduated) | $4.6M | 45.7 |

Rendered as a percentage bar, this column would paint a green 100% on unaudited
seconds-old mints and a red 0% on the two largest markets in the ecosystem. The
100 is the bonding curve, which is not a pool and which nobody can withdraw
from.

So a token still on its curve gets **n/a** for LP lock and for top-10
concentration, each with a sentence explaining why and pointing at the figure
that *does* mean something at that stage. `n/a` is excluded from the "N of 8
checks could run" count, so a structural non-answer never inflates the
reassurance.

The same reasoning removed two more false positives. RugCheck's most common
danger on fresh mints is **"Single holder ownership"** — on a curve, that single
holder is the curve — and **"Low Liquidity"** fires on every pump.fun launch
because they all start near $3.2k. Both are suppressed pre-graduation and both
come back the moment there is a real pool.

---

## The composition of the launch stream (why there is no green verdict)

Sampled 47 distinct fresh mints across three pages:

| deployer's prior mints | share |
|---|---|
| 1 | 21% |
| 2–4 | 9% |
| 5–49 | 19% |
| 50+ | **51%** |
| 1,000+ | **28%** |

Median 75. p90 3,536. **Max 155,516.**

The median new pump.fun token comes from a wallet on its 75th mint, so a 50-mint
threshold would flag half the feed and train the reader to ignore the verdict
inside an hour. The thresholds shipped are calibrated to that distribution:
fail at 1,000+, or at 50+ with under 5% of mints reaching a pool (measured
examples: 159/3,911 and 68/5,623); warn at 50+; warn at 5+.

RugCheck's **"Creator history of rugged tokens"** hit **1 of 24 mints** in one
sample and **18 of 30** in another taken hours later. The composition of the
stream swings that hard by the hour, which is itself worth knowing: a filter
tuned on one afternoon's data would be miscalibrated by evening.

Resulting verdict mix, 66–87 row samples: **avoid 60–66%, caution 8–14%,
unverified 22–26%.** The feed is a filter that removes about two thirds.

**There is no positive verdict in the vocabulary.** `unverified` is the ceiling
— every check that could run, ran, and none of them found anything, which on a
token this young mostly means the evidence does not exist yet. RugCheck answered
a 7-second-old mint in 130ms with `risks: []` and `score_normalised: 1`, which
read literally says "the safest token on Solana". That is the exact failure the
`n/a` / `unchecked` / `assumed` states exist to prevent.

---

## Rate-limit headroom, measured

| source | shipped rate | measured tolerance | result |
|---|---|---|---|
| jupiter `/recent` | 1 per 3s = **1,200/hr** | 45 consecutive at 1/s (3,600/hr) | **zero 429s**, p50 61–95ms |
| rugcheck summary | ≤8 per pass, once per mint ever | 36 at 1.25/s | **zero 429s**, p50 131ms |
| geckoterminal `/new_pools` | 1 per 20s = 180/hr | 4 with no gap | **200,200,200,200 then four straight 429s** |
| jupiter `/search` batched | ≤1 per 20s | 100 comma-joined mints in one call | 200 in 207ms |

Total ≈ **1,500 requests/hour per open tab**, against limits that tolerated
several times that. Sustained runs logged `200=40, 0 errors` every time.

Two rate-limit details worth writing down:

- **GeckoTerminal's 429 carries no CORS header at all.** A throttled browser
  sees a network error rather than a status, so a probe that hits the limit
  reports a perfectly working adapter as "unreachable from app://". The probe
  now backs off and retries rather than condemning it.
- **`/recent` caps at 30 rows.** `?limit=50`, `100` and `200` return exactly
  thirty, byte-identical. There is no cursor and nothing queues what falls off
  the back. Those thirty rows spanned **19–82 seconds** of Solana depending on
  how fast people were launching — so the 3s poll runs at a 6.3–27x margin, and
  `windowSeconds` is reported in the response so the margin can be watched
  rather than assumed.

CORS from the Electron shell origin, verified with an explicit
`Origin: app://rom-nova` header on every call:

```
jupiter recent            200  ACAO=app://rom-nova
jupiter search (batched)  200  ACAO=app://rom-nova
rugcheck summary          200  ACAO=*
geckoterminal new_pools   200  ACAO=*
```

---

## Push instead of poll: investigated, measured, not adopted

Two keyless streams exist and both were reachable with `Origin: app://rom-nova`.

**`wss://solana-rpc.publicnode.com` · `logsSubscribe` on the pump.fun program.**
Works, and it is a firehose: **220–620 frames/s, 0.28–0.69 MB/s, ~1,000–2,500
MB per hour**, of which the token creations were **6 to 18 frames per 20
seconds**. Filtering client-side means paying a multi-gigabyte-per-hour bill in
the visitor's tab to extract under one useful event per second. Rejected on the
measurement.

**`wss://pumpportal.fun/api/data` · `subscribeNewToken`.** Genuinely cheap:
**~1 MB/hr**, 8–15 create events per 20s, first payload 1.7–6.7s after
subscribing. This is a real option and it is not wired in, for three reasons
worth stating rather than hiding:

1. It covers **pump.fun only**. Graduations, Meteora, Raydium and direct AMM
   launches are not in it.
2. Its payload carries **no triage data at all** — mint, signature, trader,
   bonding-curve key. Every check on this page would still wait on Jupiter's
   ~2.3s indexing, so it would buy **time-to-first-row, not time-to-verdict**,
   and the row it produced would be one nobody could yet triage. The brief asks
   for a filter, not a firehose.
3. It is a third-party relay, not an official endpoint of anything.

**Honest summary: the fastest keyless path to a *triaged* launch is about six
seconds, and roughly 2.3s of that is a floor no polling change can move.** A
push transport could take the poll's ~1.5s off the top. It cannot touch the
indexing delay, because the indexing delay is where the triage data comes from.

---

## What a user can do now that they could not before

- **See a Solana pool that did not exist six seconds ago**, with age ticking in
  seconds. Nothing in the app previously showed anything younger than the
  1h-trending list, which is a different universe of tokens entirely.
- **Know whether the deployer is on their 1st token or their 155,516th, before
  buying.** This is the single most predictive fact about a memecoin launch and
  no price feed carries it. It is now a column, a filter, and a triage check
  calibrated against the measured population.
- **Filter out serial deployers, AVOID verdicts, low liquidity, and by venue**,
  live, without a round trip.
- **See a verdict half a second after the row lands**, with the count of checks
  that could not run attached to it — so "AVOID — 2 failed, 1 not checked (6 of
  8 checks could run)" is an argument rather than a claim.
- **Read the sentence behind every check**, by hovering a glyph or clicking the
  row open.
- **See graduations** — pump.fun curves completing into PumpSwap pools, and
  direct Meteora / Raydium / daos.fun launches — which Jupiter's launchpad-shaped
  `/recent` feed never lists (0 of 47 sampled rows carried `graduatedAt`). That
  is the entire reason the GeckoTerminal sweep exists.
- **Watch the feed measure its own latency.** The lag figure is computed from
  the rows on screen, excludes backfill, reports its sample count, and says in
  its tooltip that it contains any clock difference between the source and the
  viewer.

## What it still cannot do

- Answer LP lock or holder concentration before graduation. Structural, and
  stated on every affected row rather than papered over.
- Report deployer allocation on ~60% of launches. Source gap.
- See wallet flow, smart money, or price history on a token this young. None of
  it exists yet.
- Beat ~2.3s. That is Jupiter's index, and no keyless source measured here is
  faster with the audit data attached.

---

## Files

| | |
|---|---|
| `src/lib/engine/triage.ts` | the eight checks, thresholds calibrated to measured distributions |
| `src/lib/api/launches.ts` | rolling feed, poll budget, risk fan-out, lag statistics |
| `src/lib/providers/jupiter.ts` | `getRecentLaunches`, `getLaunchesByMint` (batched), `toLaunch` |
| `src/lib/providers/geckoterminal.ts` | `getNewPools`, graduation-DEX filter |
| `src/app/launches/page.tsx` | the feed UI |
| `src/app/api/launches/route.ts` + `src/lib/local.ts` | server route and static-build dispatch |
| `scripts/launch-probe.ts` | `npm run probe:launches` (`-- --quick` skips the sustained poll and the streams) |
| `tests/triage.test.ts`, `tests/launches.test.ts` | 40 tests, all encoding a measured failure |

Gates: `npx tsc --noEmit` clean, `npm test` 232 passed / 18 files, `npm run
build:static` clean, `npx eslint` clean on every touched file. Verified in a
browser against `out/` served at `/nova/launches/`.
