# W3 round 3 — what changed, what it was measured against, and two judgement calls

Branch: `worktree-agent-a7affd2664d946d9b`, merged with `main` at `602c536`.

Gates, all green on the final tree: `npx tsc --noEmit`, `npm test` (421 tests, 24
files), `npx eslint src tests scripts`, `npm run build:static`. Served on
`PORT=8794` and verified against that build — the browser pane reports
`visibilityState: "hidden"`, which stops every polling page from ever fetching,
so each check below forced it visible first.

The engine half of this round was already on `main` in `bb60d49`, an interrupted
WIP commit. Everything below is either the page/detail/router half that commit
never reached, a defect in what it left behind, or the four items the coordinator
added mid-round.

---

## 1. LP lock over-corrects, and the panel line is false — HIGH

`bb60d49` had already added `dispersionDampener`. Three things were still wrong.

**The dampener could not see a vendor zero.** `knownProviders` returned
`f.lpProviders` directly, and RugCheck returns `totalLPProviders: 0` for "not
indexed" on most freshly-listed mints. That zero took `Math.max(1, 0)` and
produced the sentence *"a single provider holds the pool — that party can
withdraw it"*. Inventing the WORST reading from an absence is the same bug as
inventing the best one. Zero is now treated as unknown, and unknown keeps the
full penalty — the discount is bought with evidence or not at all.

**`lpProviders` was never actually declared unmeasured.** The comment in
`live-features.ts` claimed it stayed unmeasured; nothing added it to the set. It
is now asserted at the seam, and pushed by every snapshot adapter.

**The prose was false in four places, and three of them survived the first fix.**
The penalty, the security panel, the provenance line and the risk FLAG all
carried "the pool can be withdrawn". Fixing the arithmetic left the flag's own
`detail` string wrong, and that string reaches the reader through WHAT COULD MAKE
THIS FAIL — the most-read list on the page. All four now carry the provider
count.

Measured on PUMP (RugCheck 1/100, $41M pooled, 435 pools, 43 LP providers):

| | before | after |
|---|---|---|
| LP Lock contribution | −6.3, the largest single penalty | **−1.0** |
| Panel line | `✕ only 0.0% of LP locked — the pool can be withdrawn` | `⚠ only 0.0% of LP locked or burned, but it is spread over 43 independent providers — no single one of them can withdraw the pool, so the penalty is scaled down rather than charged in full` |
| Score | 49 | **51** |

The score did not reach the ~55 the review predicted, and the remaining gap is
legitimate: `Holder Distribution −8.4` and `Supply Concentration −3.2` on a
measured 68% top-ten share. That is the pool-excluded concentration problem the
review explicitly said to leave alone, and manufacturing an exclusion from a
label map that names 0 of 20 rows would be the same trap a third time.

## 2. Sweep the vendor payload for zeros that mean "not computed" — MED

`counted()` existed; the sweep did not. Every count-shaped field in the RugCheck
payload was walked once, and **the dividing line is now written down** so the
next field lands on the right side of it:

> sweep a count whose zero is arithmetically impossible given something else in
> the same payload; keep a zero that a real token can actually have.

Swept: `totalHolders`, `totalLPProviders`, `markets`, `totalMarketLiquidity`,
`token.supply`. Deliberately not: `lpLockedPct` (0% locked is the worst case),
`creatorBalance` (a dev who sold out holds nothing), `score` (a clean grade),
`graphInsiders` / `insiderNetworks` (0 found is a result), `transferFee.pct`,
`labelledHolders`. Both halves are asserted in one test each, so a future sweep
cannot quietly swallow a real zero.

The panel line was rebuilt from parts and joined rather than concatenated with
leading separators — it printed `22 pools · 0 LP providers · $2.43M across them`,
and once the provider normalised those zeros away the old form would have printed
a dangling ` · $2.43M across them`. Pluralised: no more `1 pools`.

**The coordinator's item A extended this sweep to the token provider, and that
turned out to be the most serious defect in the app.** See §10.

## 3. The deployer card contradicted itself in adjacent lines — MED

`Dev still holds —` tooltipped *"no source published the deployer's balance —
this is not zero"*, one line above *"rugcheck independently puts the deployer
balance at 0.000%"*. Live on PUMP, SKHY, TRX, CATE. The cell read `holdsPct`
alone and the footnote read `vendorHoldsPct` alone, so a token where only the
vendor answered rendered both sentences.

`detail.ts` now resolves the two into one `holdsShown: { pct, source }`, in a
stated order: the token provider wins where it published a figure, because that
is the field the feature vector scores and the panel must agree with the audit;
the vendor is the named fallback. The "independently puts" footnote only renders
when it is genuinely a *second* opinion, and says so when the two disagree.

PUMP now reads `Dev still holds 0.000%` with `per rugcheck` in the tooltip, and
nothing else. The detail probe was reading the same two fields the same broken
way and was fixed with it.

## 4. `devSold` hardcoded on every live token — MED

Already done in `bb60d49`: declared in `NEVER_AVAILABLE`, `dev_selling` split
into its own factor, `dev_risk` no longer silently halved, and the INVALIDATION
copy no longer promises a flag that cannot fire. Verified, left alone.

## 5. Deployer mint history could not change the verdict — MED → **judgement call, see §J1**

## 6. The whale factor pays points for ABSENT whales — LOW

`bb60d49` rebased contributions from the neutral midpoint, which fixes the
headline case. It left one leak, and the coordinator's item C is its mirror.

**The leak.** `REGIME_ADJUST` multiplied the whole 0–100 mean, which makes it a
*constant added to every factor row* once the table is decomposed — so a factor
sitting at exactly 0.5 drew positive credit in a friendly regime and a penalty in
a hostile one. It also meant a token with nothing measured either way scored 42.5
in `risk_off` and 53 in `meme_mania`. The regime now scales the **deviation** from
neutral: 50 maps to 50 under every regime, a midpoint factor contributes exactly
zero under every regime, and `50 + Σ contributions` still reconciles to the score
(asserted across four regimes).

**The mirror (item C).** A ten-minute scan of a four-minute-old token returned
"no whale-sized trades in the window" and the factor charged −1.7 for it.
`unmeasured.add("whaleFlow")` only fired when the provider returned *nothing*,
not when it returned movements with no whale among them. A token minutes old
cannot have had a $20,000 trade in a ten-minute window — the window is the
constraint, not the token. A window with movement but no whale is now unmeasured.
A window that *did* contain a whale is a real measurement and stays one.

## 7. Two verdicts on one screen — LOW

`labelOf` already checked the veto first. The audit panel still printed a bold
**NO TRADE** underneath a header chip reading EXTREME RISK — a third answer.
Under a veto it now reads "Also abstained", and says why the veto outranks it.

## 8. Confidence is near-constant — LOW

`evidenceQuality` was widened in `bb60d49`. Both halves of the review's demand
are now met: it **discriminates** (0.56–0.77 across the live sweep, six distinct
values on twelve rows, against "77% on 8 of 12" before), and where it does not,
the page **says plainly** which term is binding. The audit header now reads
`confidence 77% = 98% evidence × 79% coverage` — on CATE, evidence is at its
ceiling and coverage is the binding half, which a reader can now see rather than
infer.

## 9. Router string leaks into the page — LOW

`/token?m=<script>…</script>` becomes `/api/tokens/<script>…</script>`, which
matches no route (the segment pattern is `[^/]+` and the payload carries a slash)
and fell through to a 404 whose body was the raw path. The page prints the
handler's message verbatim.

Sanitising alone was tried first and **was not enough** — it rendered
`/api/tokens/3Cscript3Ealert13C/script3E`, which carries no markup and is still
the attacker's string on the reader's screen. `safePath` now echoes leading path
segments and stops at the first one that is not already a plain route name: a
segment that would need sanitising is caller content, and the caller does not get
to put content on the page. Verified in the browser: the payload now renders as
`no local route for /api/tokens`.

Separately, `handleTokenDetail` shape-checks the mint (base58, 32–44) before it
costs five provider calls, in the shared handler so the server route and the
static dispatcher get one rule.

## Free reference gaps closed

- **TXNS / BUYS / SELLS / MAKERS per window.** Jupiter ships `numBuys`,
  `numSells`, `numTraders` and the buy/sell volume split for 5m/1h/6h/24h in the
  same response as the price, and the app was throwing all of it away —
  `buys1h`/`sells1h` surfaced only as a derived "imbalance %" in one audit row.
  Now a panel. Live on PUMP: `24h 146.6K txns · 85.3K buys · 61.3K sells · 8.7K
  makers · $18.16M / $15.09M`. Every cell dashes rather than printing a zero it
  was not given; MAKERS dashes on DEX Screener and GeckoTerminal, which count
  transactions rather than wallets, because buys + sells would double-count
  anyone who did both.
- **FDV beside Mcap.** `snapshot.fdvUsd` was populated and unused. PUMP:
  `MCAP $1.95B · FDV $4.12B`.
- **Liquidity as a share of market cap.** `LIQUIDITY $40.97M (2.1%)`, amber under
  1%. The cheapest read on whether a quoted market cap is reachable.
- **Supply**, from RugCheck's own read of the mint account — never derived from
  market cap over price, which is arithmetic across two vendors' roundings
  presented as somebody's measurement.

---

# The four items added mid-round

## 10. [A, CRITICAL] A zeros bug inside the scoring engine, on the core population

`jupiter.ts` did `liquidityUsd: m.liquidity ?? 0` while the **launch** builder
twelve lines down passed the same field through undefined and rendered "the
source has not priced this pool yet". One field, two behaviours, one file — and
only the coerced one reached the scorer.

`liquidityUsd` was not a member of `UnmeasuredField`, so there was no way to
declare it. Added, along with `liquidityChange` and `holderGrowth`.

The blast radius was wider than the one factor, because everything downstream
derives from the pool:

| reader | with an unpriced pool |
|---|---|
| `liquidity` factor | `log10(max(0,1))/6.5` = 0 — the factor's **floor**, a total wipeout |
| `exitDepthUsd` (18% of the pool) | 0 → `exit_liquidity` at **maximum** severity |
| `structure` factor | reads the same zero |
| `exit` risk flag | fires **high**-severity "Thin exit liquidity ~$0" |
| `regimeOf` | returns `low_liquidity`, the most punitive multiplier (0.93) |
| profile floor | "liquidity **$0** below the Balanced floor of $40.0K" |

All six now follow the declaration. The abstention gate says *"no source has
priced this pool yet, so the Balanced liquidity floor of $40.0K cannot be
tested"*, and a `liquidity_unknown` flag keeps the absence visible — standing
factors down without saying so would be its own kind of silence.

**Measured against the live `recent` feed**, ten mints between 3 and 24 seconds
old:

```
sym         age    jup.liquidity   declared?   liquidity factor
USWR         3s        undefined   true        STOOD DOWN
COWORKERS    4s      3164.72782…   false       -5.8
meme         4s      3163.49097…   false       -5.8
CHEINF      11s       296.50089…   false       -10.9
████        18s      9080.82162…   false       -2.4
```

`USWR` is the case: Jupiter genuinely returned `undefined`, and the factor now
stands down instead of charging the full wipeout. Every mint with a real pool is
still scored on it. In test terms, the three pool-derived factors charged **worse
than −10 points** on a bare zero and charge **exactly 0** on a declared absence.

One deliberate asymmetry: the `liquidity` factor needs `liquidity` but **not**
`liquidityChange`. Standing the whole factor down for a missing 24h trend would
throw away the most important number on the page on every fresh mint — trading a
false reading for no reading. Its trend multiplier bottoms out at 0.7 for a flat
pool, and a flat pool is the median across the trending list, so an unknown trend
lands a token where its typical peer already sits. What was wrong there was the
**prose**, which claimed a measurement: "+0.0% vs 24h ago" on a token four
minutes old now reads "no 24h history for this pool, so only the depth is
scored". `holder_growth` is pure trend with nothing else in it, so it stands down
outright.

## 11. [B, HIGH] "WHALE 6H" was a ten-minute window

Six hours is not purchasable: ten minutes of balance deltas costs ~0.3MB and the
scan is byte-budgeted. So the **name** changed, everywhere, rather than the
window.

- `whaleFlow6hUsd` → `whaleFlowUsd` (rows, source, four pages, probe, tests).
- Four column headers: "Whale 6h" → **"Whale flow"**, each with a title naming the
  real window.
- A shared `whaleFlowCell` helper does the two corrections together, because they
  are one mistake: a **measured zero is now neutral, not green** (production
  showed $0 on 11 of 12 rows, all green, reading as "no whale sold this in six
  hours"), and the tooltip takes the row's **own** `flowMinutes` — which was
  already on the row and never rendered — because a truncated read covers less
  than it asked for.
- The INVALIDATION copy no longer promises "over 6h".

Verified live on the scanner: CATE's cell tooltips *"net whale movement over the
last **5 min** of chain"* (its read was truncated) while HNT's says *"the last **10
min**"*. Rows with no whale-sized move now render an honest dash rather than a
green zero.

## 12. [D, MED] The chart, and a chip that claimed candles it did not have

I reproduced the coordinator's diagnosis and it is right: GeckoTerminal returns
**429 with no `access-control-allow-origin` header at all**, which a browser
reports as `TypeError: Failed to fetch` — indistinguishable from an outage.

**The fallback's parameters, measured before relying on them.** The coordinator's
quoted params returned `{"candles":[]}` because `from`/`to` must be
**milliseconds**; `candles` is also required. Seconds are not an error — the
endpoint answers **200 with an empty array**, which reads exactly like "this mint
has no history". That silent empty is why the adapter was written against a probe
rather than against the parameters as given.

Verified through the adapter on CATE: 7d → 168 hourly bars, 30d → 720, open-ended
45d → coarsens to `4_HOUR` and returns 208; all ordered, last close `0.0552`
against the page's `$0.05503`. CORS reflects correctly for all three runtimes.

GeckoTerminal **stays primary**, exactly as instructed — swapping out a source
that works is not a fix for a source that is throttled. Jupiter is tried only
when the primary returns nothing or fails for a non-404 reason, and the chart's
provenance chip names whichever answered and why.

**The volume field is deliberately not claimed.** Its unit could not be
established — ~4.07M per hourly bar on PUMP reconciles with neither the token's
~$1.4M hourly USD volume nor its ~280M hourly token volume, and it is
byte-identical between `type=price` and `type=mcap`. `Candle.v` is documented as
USD, so rather than fill a documented field with a number that means something
else, it is carried through unlabelled with the reason in the adapter.

**The chip.** `dataMode()` tested the provider's NAME, which is a fact about
configuration. `providers/health-log.ts` is a new leaf module (the registry
cannot import `api/source.ts` — that is a cycle) recording what each capability
last *did*. "prices & candles — LIVE" is now demoted to a bounded claim naming the
failure when the last candle request failed, and a stale outcome returns null
rather than asserting either answer.

## 13. The two smaller ones

- **`/token` given a wallet.** "unknown mint" is a definite claim about a token,
  and the commonest way to reach it is pasting a wallet. `/whale` already handles
  the mirror case. The 404 path now asks the chain what the address actually is —
  one RPC call, on a path that is already an error — and answers *"that is a
  WALLET, not a token mint — open it on the wallet page instead: /whale?a=…"*, or
  names a token account, program, empty account, or a real-but-unlisted mint. A
  failed RPC call returns null and keeps the original error, because an
  unreachable node must not become a confident claim about the address.
- **Addresses linking only to solscan.** Every row in Top holders and Live flow
  now leads with a link to `/whale?a=`, keeping the explorer arrow beside it. The
  most natural click in the app — mover → their profile — was leaving the product,
  and the scanner had already made the opposite choice.

---

# J1. Should a serial deployer veto a positive label?

**No. It caps it at WATCH instead.** The reasoning lives in `labelCapOf` in
`signals.ts`, next to the rule, not only here.

The two facts are different **kinds** of fact:

- A **live mint authority is a capability**. The key exists, it is on chain, its
  holder can inflate the supply unilaterally at any moment, and nothing the token
  does between now and then changes that. Binary, verified, and no quantity of
  good tape trades it away. It vetoes.
- A **deployer's mint count is a base rate**. It confers no power over this mint
  and takes nothing from anybody. It says this token is one attempt among many —
  a prior about the outcome, not a fact about the contract.

And a veto needs a threshold that survives the population. W2 measured it: the
median new pump.fun deployer is on their **75th** mint. Any veto line low enough
to be principled about "serial" would abstain on half the feed, and a verdict that
fires on half the feed carries no information — the exact failure the abstention
gate has already had twice in this file.

So the fact gets three graduated mechanisms instead of one:

1. a log-scaled **penalty** on every deployer, discharged by migrations — CATE
   draws −5.9 through it;
2. a high-severity **flag** at the factory threshold, which reaches the bear case
   and counts toward the existing `highRisks` gates;
3. the **cap**, which holds the label at WATCH.

**The threshold was calibrated, not guessed — and the first version was wrong.**
I set it at 1,000 mints and then pulled today's live trending list, which showed
it capping MAGA at 4,681 mints / 4.3% graduation and clearing STACY at 731 / 4.5%.
Those are the same object; a line that splits two tokens a percentage point apart
is not measuring anything.

The principled form is a **sample-size floor with the rate doing the judging**:
250 mints is enough for a graduation rate to separate 2% from 8%, and below that
a low rate is noise. Against the live list:

| | mints | reached a pool | rate | capped |
|---|---|---|---|---|
| CATE | 19,098 | 341 | 1.8% | yes |
| PBJ | 13,843 | 199 | 1.4% | yes |
| STONK | 6,161 | 11 | 0.2% | yes |
| BUTTHOLE | 6,161 | 11 | 0.2% | yes (same deployer as STONK) |
| MAGA | 4,681 | 202 | 4.3% | yes |
| STACY | 731 | 33 | 4.5% | yes |
| **Orangutan** | **405** | **34** | **8.4%** | **no — the rate clears it** |
| PINK | 55 | 1 | — | no — no sample |
| nub, fone, ANTFUN, HNT, TROLL, ALEIAH | 1–5 | | | no |

Six of fourteen. That is high, and it is high because this population really is
mostly serial deployers — but it is not the "flags half the feed on a naive
threshold" failure the review warned about, because **the one deployer here with
hundreds of mints and a working record is exactly the one it lets through**. That
row is the test.

The cap only ever moves a label **down** — a capped token already reading NEUTRAL
stays NEUTRAL, because lifting it to WATCH would make a warning read as an
upgrade — and the security veto outranks it, because a capability beats a base
rate.

**The score is not fudged to agree.** CATE now renders **74 / WATCH**, with a
`HELD AT WATCH` banner carrying the reason and the deployer at the **top of the
bear case** — which is where the review said a reader looks for what could go
wrong, and where it was missing. The 74 is still the honest weighted mean of what
was measured.

# J2. cbBTC and USDC render EXTREME RISK. Should they?

**Yes. The rule stays exactly as it is, and I would resist changing it.**

The facts are not in dispute and I re-verified them this round. cbBTC: `mint
LIVE, freeze LIVE`, read by `solana-rpc + rugcheck` independently, score 45,
EXTREME RISK. USDC: identical. Coinbase and Circle genuinely retain both
authorities on their wrapped assets. Every reference tool shows them as normal.

The case for an exemption is that the rule is harsh on legitimate custodial
wrappers and that no reference tool does this. Both are true. I am not persuaded,
for three reasons.

**An exemption is a list, and a list is an attack surface.** Any carve-out has to
be keyed on something: a mint allowlist, an issuer name, a "verified" flag, a
market-cap floor. A mint allowlist is the only one that cannot be forged — and
a hardcoded allowlist of blessed mints is precisely the mechanism a scam
impersonating USDC needs to get onto. The failure mode of the current rule is a
reader being over-warned about Circle. The failure mode of an allowlist that is
ever wrong, stale, or matched loosely is a reader being under-warned about
something wearing Circle's name. Those are not symmetric, and this app's whole
premise is that it fails toward caution.

**The rule is not actually wrong about them.** Circle *can* freeze USDC balances
and *has*, on request from law enforcement, more than once. "Balances can be
frozen in place, including yours" is a true statement about USDC. That it is a
feature rather than a trap is a judgement about the *issuer*, and this app has no
source for issuer reputation — the same gap that keeps `smartMoney` permanently
unmeasured. Encoding "Coinbase is fine" would be exactly the kind of unsourced
claim the unmeasured machinery exists to stop, wearing a friendlier face.

**Nova is not a price site, and the mismatch with reference tools is the point.**
DexScreener and Birdeye show USDC as normal because they are quoting a market.
This page's one claim is "should I touch this, and why", answered from chain
facts. A tool whose headline question is about custody risk should say that a
custodian holds the keys. The honest complaint is not that the verdict is wrong,
it is that the verdict is *unhelpful* on an asset nobody is evaluating for rug
risk.

**What I did instead of an exemption**, and what I would do next if it is judged
insufficient: nothing this round, deliberately — the veto copy already names the
authority holder's address where the vendor publishes it, which is the fact that
distinguishes Circle from an anonymous deployer, and a reader who checks it gets
the right answer. If this is revisited, the right shape is a **second line**, not
a softer verdict: keep EXTREME RISK and add "this authority is held by a
publicly-identified issuer" **only** when a source publishes that identity, so it
is a measurement like everything else rather than a hardcoded opinion. That
source does not exist in this stack today, which is why the answer this round is
"leave it, and write down why".

---

# Standing check: the metric that is most wrong on the largest tokens

The review named this as the third appearance of one trap and asked for it to be
treated as a standing check. It appeared **twice more** this round, which suggests
the shape is worth stating explicitly:

> A metric derived from a count, where the count is unavailable exactly when the
> token is unusual — largest, newest, or least indexed — and where the missing
> value coerces to a number that is a *finding* rather than a *silence*.

- **LP lock** (this round, §1): most wrong on the largest tokens, where the
  aggregate lock runs near zero by construction across hundreds of pools.
- **Liquidity** (§10): most wrong on the *newest* tokens, where the indexer has
  not caught up — the opposite end of the same distribution, and the more damaging
  one, because new mints are what a launch terminal is for.
- **LP providers** (§1): the zero coerced to "one provider holds the pool", which
  is the worst reading rather than the best — proof the trap is not directional.

The common defence is the one this codebase already built and keeps forgetting to
apply at the seam: **a field that can be absent must be declarable, and the
declaration must be asserted where the vector is assembled, not left to whichever
adapter remembers.** Both new declarations are asserted in `liveFeatures` for that
reason, on top of the adapters pushing them.
