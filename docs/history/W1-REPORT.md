# W1 — Real wallet tracking

Wallet tracking was the last entirely synthetic capability in ROM Nova. Every
address in the app came from `src/lib/demo/universe.ts` with an invented name
("Meridian Desk"), and `/status` said so: *wallet activity — simulated*. Paste a
real Solana address into `/whale` and the app answered "wallet not tracked".

It reads the chain now. Paste any Solana address and you get that wallet's
actual fills, actual positions, and PnL computed from them — keyless, from the
static export, in the browser.

The headline caveat is not a footnote and is repeated on screen: **the trade
history is a ~48-hour window, not a lifetime.** That limit is measured, not
assumed, and the measurement is below.

---

## What is now real

| Claim | Source | Real? |
|---|---|---|
| Current token positions | Jupiter Ultra holdings | Complete. Balances read whole, independent of any window. |
| Position USD value | Jupiter Price V3 | Real, for up to 200 mints per wallet; the rest are reported unpriced. |
| Trade history (entries and exits, with prices) | `getSignaturesForAddress` + `getTransaction` on publicnode | Real, over ~48h. |
| Fill price in USD | derived leg ÷ leg, × SOL/USD **at the fill's hour** | Real. |
| Realized PnL | FIFO over observed fills | Real, over the window, excluding sells with no observed buy. |
| Unrealized PnL | position value − FIFO cost | Real **only** where the fills reconcile against the chain balance. |
| Win rate, profit factor, median hold | `engine/perf.ts`, repointed at real fills | Real, over the window. |
| What they are buying right now | the same read, newest first | Real. Latest fills are minutes old. |
| Wallet labels / smart-money score | — | **Not computed.** Returns an empty list rather than an invented tag. |

The scanner's top movers are now links: see a real wallet accumulating a
trending token, click it, read its book.

---

## What is still unmeasured, and why

Declared through `UnmeasuredWalletField` and rendered as `UNMEASURED` /
`COST UNKNOWN`, never as a dash and never as zero.

**`lifetimeHistory` — set on every read, unconditionally.**
publicnode is the only keyless Solana RPC that answers
`getSignaturesForAddress` at all, and it retains about two days. Measured
against a quiet, years-old address across three runs: oldest signature 2.02,
2.03 and 2.04 days back, and paging before it returns nothing. Everything else
refuses the method:

```
solana-rpc.publicnode.com     n=78, reaches back 2.04 days, CORS *   ← the only one
api.mainnet-beta.solana.com   HTTP 403
rpc.ankr.com/solana           HTTP 403
solana.drpc.org               HTTP 400
solana.blockpi.network        HTTP 503
solflare / onfinality / getblock / tatum / blockeden   403, 429, 401, 403, 402
```

A keyless lifetime PnL does not exist. This is the documented negative result of
W1, and it is why `DataMode` grew a third column: wallet history is listed as
**real but bounded**, not as live.

**`fillPrice` — 46% of token movements carry no price.**
Measured across five real wallets, 577 transactions, every movement classified:

```
quote leg in the wallet's own wSOL / USDC account      59
quote leg in the wallet's native SOL balance          201
BOTH                                                    0
NEITHER                                               218   ← 46%
```

The "neither" cases are transfers in, airdrop claims, token-for-token rotations
routed entirely through pools, and — the one that surprised the probe — buys
signed and *paid for by a different wallet* (terminal bots and desks work this
way; one wallet's ANSEM balance grew four times with no SOL ever leaving it).
There is no cost attributable to this wallet in any of them. They appear in the
movements table as IN/OUT with "no price observed" and never enter a PnL figure.

That BOTH column being zero is load-bearing: the two quote paths are mutually
exclusive, so taking whichever is present cannot double-count.

**`costBasis` — where the fills do not reconcile with the balance.**
This is the check most trackers skip. A position derived from trades and a
position read from the chain are independent measurements; when they disagree,
the wallet acquired the difference where nobody could see it. Real output:

```
9cRCn9rGT8…  4,122.07 tok  $1,517.47  cost UNKNOWN —
  fills account for 3,505.48 of 4,122.07 tokens held — the rest was acquired outside this window
```

Such a position gets a value and **no** unrealized PnL. Assuming instead is how
a bag bought months ago renders as a clean multiple.

**`realizedPnl` — sells with no observed buy.**
Proceeds are real; profit is not computable. They are excluded from realized PnL
and counted in `unmatchedSellTokens`, rather than matched at zero cost — which
would book the entire sale as gain. On one measured wallet that was 5,210 tokens
across 18 mints.

**`reputation` — nothing keyless publishes it.**
A 48-hour win rate is a sample, not a record. `getWalletLabels` returns `[]`.

---

## Measured latency

End to end (signatures → transactions → balances → prices → FIFO), from Node and
confirmed identically from a browser:

| Wallet shape | Result |
|---|---|
| 71 txs / 43.3h window | **864 ms** |
| 112 txs / 48.7h window | **1,107 ms** |
| 193 txs / 48.4h window | **1,769 ms** |
| 400 txs (budget cap) | **3.3 – 5.0 s** |

Component costs: `getSignaturesForAddress` ~300 ms/1,000; `getTransaction`
20.7 ms at concurrency 4, 6.1 ms at 16; Jupiter holdings 110–175 ms; Jupiter
prices ~226 ms/batch; SOL bars ~300 ms (cached 10 min).

Browser-side, from the built static export at `localhost:8788/nova/`:

```
solana-rpc.publicnode.com: 113 requests, 94ms avg
lite-api.jup.ag:             2 requests, 157ms avg
api.crypto.com:              2 requests, 210ms avg
```

All three reflect `Origin: app://rom-nova`, so the Electron shell works too.
(A bare GET returns no CORS header at all and would have fooled the check —
every source here was probed with the header set explicitly.)

### The rate limit, which two probe rounds found and one fixed

publicnode allows **2,400 requests / 60 s** and does not degrade gracefully:
crossing it blacklists the caller for the rest of the window. Measured, before
any limiter:

```
600 fetches @ concurrency 12 → 359 ok, 241 refused
same 600 retried @ conc 6    → 0 ok, 600 refused    (the minute was already spent)
same 600 retried @ conc 3    → 0 ok, 600 refused
```

Profiling four wallets at 600 transactions each spends the entire budget; the
fourth came back with 544 of 600 refused. Fixed with three things: a shared
sliding-window budget of 1,800/min, a **shared** 800 ms cooldown triggered by
any 429 (twelve workers each backing off alone would arrive together and refuse
each other again), and two jittered retries. That took a repeat run from
139 refused to 5, and the current run to zero. A 25-second deadline bounds the
worst case, and skipped transactions are counted, not dropped.

## Measured coverage limits

- **~48 hours** of history, hard, from RPC retention.
- **400 transactions** per read by default. Retail wallets measured 33–214 over
  their whole readable window and are covered completely. High-frequency wallets
  carry 1,000+ inside minutes and cannot be covered by any budget — those report
  a 2–3 minute window and `cappedByBudget: true` rather than presenting three
  minutes as a career.
- **200 mints** priced per wallet. One real trader held 728 mints with a
  balance; the other 528 are reported as `unpricedMints`, not valued at zero.
- **SOL/USD bars** cover 12.5 days (300 hourly bars, Crypto.com; Coinbase
  fallback). A fill outside that range keeps its SOL leg and loses only its USD
  — SOL moved $75 → $105 across those bars, so reaching for today's price would
  put the entire error into the PnL. Binance is the obvious source and is
  geo-blocked with no CORS header.

## Price sanity

Derived fill prices, checked against the token's current price — a misread
decimal or a mispaired leg would show up here as orders of magnitude:

```
06:05 SELL 9cRCn9rG  fill $3.385e-1  now $3.747e-1  ratio 0.904  via stable
11:52 BUY  9cRCn9rG  fill $3.335e-1  now $3.747e-1  ratio 0.890  via stable
14:24 BUY  9cRCn9rG  fill $3.352e-1  now $3.747e-1  ratio 0.895  via stable
```

A USDC-quoted fill reproduced Jupiter's published price to four significant
figures independently.

---

## What a user can now do that they could not before

1. **Paste any Solana address** into `/whale` (or `/whales`) and get that
   wallet's real book. Before: "wallet not tracked".
2. **See what a wallet is buying right now** — the newest fill is typically
   minutes old, with the transaction signature linked to Solscan so any number
   on the page can be checked against the chain.
3. **Read a real realized PnL** built from actual fills at actual prices —
   with the window it covers stated above it, and the sells it could not
   attribute excluded rather than counted as profit. One measured wallet:
   −$159.71 over 23 round trips, 70% win rate, profit factor 0.60, median hold
   36 minutes.
4. **See real unrealized PnL where it is knowable, and be told where it is not.**
   Of 24 positions on one wallet, 2 reconciled and carry a cost basis; 22 say
   `COST UNKNOWN` with the specific reason.
5. **Click a whale in the scanner.** The top movers behind the WHALE 6H column
   are real addresses SQD watched move; they now lead to a profile.

## Deliberately not built

- **A ranked list of real smart-money wallets.** Nothing keyless publishes one,
  and ranking wallets on 48 hours of trades would be a leaderboard of luck. The
  `/whales` roster stays the simulator with a `SIMULATED LIST` banner on it.
- **A smart-money score for real wallets.** `smartMoneyScore()` exists and is
  good; a two-day sample does not deserve it.
- **Token-for-token rotation pricing.** It would need historical prices for
  arbitrary memecoins, which no keyless source has.

## Files

| Path | Role |
|---|---|
| `src/lib/providers/wallet-chain.ts` | Fill recovery from balance deltas; rate limiting; coverage. |
| `src/lib/providers/holdings.ts` | Jupiter Ultra balances + batch prices. |
| `src/lib/providers/sol-history.ts` | Hourly SOL/USD, so a fill is priced when it happened. |
| `src/lib/engine/wallet-profile.ts` | FIFO replay, reconciliation, unmeasured declarations. |
| `src/lib/api/source.ts` | `walletProfile()` — orchestration, caching, provenance. |
| `src/components/wallet/RealWalletProfile.tsx` | The page, coverage-first. |
| `src/app/whale/page.tsx` | Routes real vs simulated addresses. |
| `scripts/wallet-probe.ts` | `npm run probe:wallet` — retention, latency, coverage, price sanity. |
| `tests/wallet-chain.test.ts`, `tests/wallet-profile.test.ts`, `tests/wallet-sources.test.ts` | 55 tests. |

## Gates

```
npx tsc --noEmit     clean
npm test             19 files, 254 tests, all passing
npm run build:static clean (24 routes)
npx eslint <touched> clean
```

Verified in a real browser against the built static export, not only in Node.
