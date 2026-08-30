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
| W1 | Real wallet tracking | GMGN wallet page, Cielo, Nansen Profiler | ✅ shipped in 1.4.0 · critic list open |
| W2 | Launch / sniper feed | Photon New Pairs, Axiom Pulse | 🔨 round 2 · graduation latency |
| W3 | Token deep-dive | Photon token page, GMGN, DexScreener | 🔨 round 3 · LP over-penalty |
| W4 | UI/UX + performance craft | Axiom & Photon density and latency | ⏸ until W1–W3 pass |
| W5 | Alerts that actually fire | Cielo alerts, Photon alerts | ⏸ until W1–W3 pass |
| — | **Blind critic on the MERGED 1.4.0 build** | all of the above | ❌ FAIL · 5 fixed, rest routed |

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
