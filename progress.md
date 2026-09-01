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
| W4 | UI/UX + performance craft | Axiom & Photon density and latency | ✅ **PASS round 1** — merged to main, post-PASS list closed same hour |
| W5 | Alerts that actually fire | Cielo alerts, Photon alerts | 🟢 round 6 FAIL (1 item) — enumerations dropped, guard now self-finding (@ 037877d) · round-7 confirm running |
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
