# W2 round 2 — the launch feed, measured again

Everything below was measured on this machine against the live APIs, after
bracketing the clock. Where a number contradicts what the brief predicted, the
measurement is reported and the brief is not.

## 0. The clock, first, because nothing below means anything without it

Bracketed NTP-style off the HTTP `Date` header against four independent hosts
(Cloudflare, Google, pump.fun, GeckoTerminal), intersecting the per-sample
intervals. `Date` is floored to the second, so one sample bounds the skew to a
1s-wide interval and repeated sampling narrows it.

```
SKEW (local - server) in [-2.939, -2.762]s  =>  -2.850 +/- 0.088s
```

**This machine runs 2.85s BEHIND real time**, and it is drifting:

| when | measured by | skew |
|---|---|---|
| earlier round | the critic | 2.39s ± 0.05s behind |
| start of this session | this agent | 2.787s ± 0.093s behind |
| ~1h later, same session | this agent | 2.850s ± 0.088s behind |

Behind is the direction that **flatters** every latency figure the feed
reports: a local clock that lags subtracts itself from `firstSeenAt -
poolCreatedAt`. Any raw lag printed by the UI understates the truth by ~2.85s
today.

Two consequences carried into the work:

- The head-to-head measurements below **do not use the local clock at all**.
  Each response's own HTTP `Date` header is the "now" at the moment that
  response was stamped, so the arithmetic is (server's clock at first sighting)
  − (the timestamp the payload publishes). The skew is removed rather than
  corrected for.
- The page now flags the flattering direction as well as the safe one — see §4.

## 1. Graduation latency — fixed, and not the way the brief said

### The brief's premise was wrong, and I verified it exactly as instructed

The brief said pump.fun's `/coins` is keyless, returns 200, and to check CORS
with an explicit `Origin: app://rom-nova` because a bare GET would fool me into
rejecting a working API. I ran that check. It produced the opposite result:

```
no headers at all             200   acao=(none)        len=3428
browser UA only              200   acao=(none)        len=3424
Origin: app://rom-nova       403   {"message":"Not allowed by CORS"}
Origin: https://romapps.xyz  403   same
Origin: http://localhost     403   same
Origin: https://pump.fun     200   acao=https://pump.fun
OPTIONS preflight            403
```

pump.fun allowlists **its own origin and nothing else**. `Origin` is a
forbidden header name — a page cannot set it and the browser always sends the
real one — so no arrangement of client code reaches that 200. The bare GET *is*
the misleading measurement, exactly as the brief warned; it just misleads in
the other direction. The existing code comment was right and stays, now with
the `Origin: https://pump.fun` row added as the proof of *why* it 403s.

For the record, its board is genuinely fresh — the newest coin was 2.0s old
against the server's own `Date`. It is simply unreachable from a static export
running in a visitor's tab.

### The actual fix: the same vendor already in the stack

`POST https://datapi.jup.ag/v1/pools/gems` publishes a `graduated` bucket and
answers this app's origin:

```
OPTIONS preflight   204  acao=app://rom-nova  allow-headers=content-type
POST with Origin    200  acao=app://rom-nova
```

Head to head over seven minutes, both sources polled on their own safe
cadences, arrival lag against each response's own `Date`:

| source | n | min | **p50** | p90 | max |
|---|---|---|---|---|---|
| `datapi gems.graduated` | 11 | 1.0s | **3.0s** | 4.0s | 5.0s |
| `geckoterminal new_pools` | 14 | 11.0s | **40.0s** | 72.0s | 78.0s |

On the six graduations **both** sources saw — the only comparison not
confounded by them seeing different events — gems led on every single one, by a
median of **50.0s**:

```
PBJ     jup  2.0s   gt 38.0s      HOOD    jup 2.0s   gt 38.0s
pump    jup  5.0s   gt 78.0s      PayPal  jup 3.0s   gt 66.0s
PayPal  jup  3.0s   gt 21.0s      NODEBT  jup 3.0s   gt 53.0s
```

Rate limit measured past the point where it should break, because the last
comment in this file that inferred headroom from a short clean run was wrong:
**106 consecutive requests, zero 429s** (6 with no gap, 60 at 1/s, 40 at 1/3s),
p50 117ms. The poll is set to 3s — a third of the fastest rate measured clean,
stated as what was measured rather than as a budget to raise the rate into.

GeckoTerminal is **kept**, demoted to the job nothing else does: a pool opened
straight onto an AMM, which no launchpad feed lists. A graduation only it
catches really did take that long to arrive, so those are still counted and the
reported figure is the blended truth rather than the best case.

### A dating bug the new source exposed

`mergeLaunch` dated every row `Math.min(existing, incoming)`. That is right for
two sources describing one pool and wrong in both directions once a mint can be
seen twice — first as a curve, then as a graduation:

- **promotion** — a mint already in the feed graduates. `min` keeps the *curve*
  time, so the row reads GRAD with the age of the whole curve and contributes
  that to a statistic measuring seconds.
- **regression** — the row is already a graduation and the primary listing
  mentions the mint again with its curve time. `min` silently drags it back.

Not a corner case. The real fixture in the test is TURINF: curve opened
04:05:51, graduated 04:30:29 — **24m38s apart**. Dating it by the curve reports
a **1,478-second** graduation lag. Both new tests were confirmed to fail against
the old `Math.min` by exactly 1,478,000 ms before the fix was restored.

Also fixed alongside: `{...existing, ...obs}` overwrites with `undefined`
wherever the newer payload simply lacks a field, and the primary listing
carries neither `graduatedAt` nor `bondingCurvePct`. An un-dated graduation is
one the feed cannot measure at all.

## 2. The lag statistic — already shipped, verified intact

`gradLagP50Ms` / `gradLagP90Ms` / `gradLagSamples` already existed in the tree
with their own `sweepStartedAt` baseline, and the page already rendered "mint
lag" and "grad lag" as two separate figures. Nothing to do. The gems pass
contributes to the same graduation baseline rather than opening a third one.

## 3. Overclaims — two of three already shipped, one still live in a third place

| claim | state on arrival |
|---|---|
| `page.tsx` "Every new mint and pool on Solana…" | already replaced |
| `registry.ts` "~2.3s of pool creation" | already corrected to p50 5.7s |
| `launches.ts` "45 consecutive calls at 1/s" | already corrected to the 150-call run |

The 2.3s overclaim survived in a **third** location the list did not name:
`LAUNCH_POLL_MS`'s own doc comment still read "source indexing costs about 2.3s
and is not negotiable". Corrected to the p50 of 5.7s with 2.3s named as the
floor. The `registry.ts` note also now carries the graduation source and its
measured figure, since `/status` is operator-visible copy.

## 4. Clock-skew disclosure — now two-directional

The one-directional `lagMinMs < 0` check the brief describes was already gone;
the tree had a `clockNote` covering both directions in prose. Two things were
still wrong with it:

- it baked "the machine this was built on ran 2.3s behind" into UI copy, a
  build-machine anecdote that has since drifted to 2.85s;
- there was still no *signal* for the flattering direction, only prose.

### I got the direction backwards first, and the live feed caught it

Worth recording because it is the exact class of error this round is about.

My first version labelled `lagMinMs < 0` as "clock **ahead**". Running it
against the live build, the page rendered "clock ahead" on a machine I had just
bracketed at **2.85s behind**. The label was inverted.

The arithmetic: every figure on the page is `firstSeenAt - poolCreatedAt`, one
timestamp from the local clock and one from the source. With a local offset `s`
(positive = ahead) that is `true_lag + s`. So a clock running ahead can only
ever **inflate** a lag and can never produce a negative one. Seeing a pool
before the source says it existed means our "now" reads *earlier* than theirs —
which is the **behind** case.

Corrected, and both tests now point at the flattering direction, because it is
the only one these numbers can detect:

- `lagMinMs < 0` → **clock behind**. Proof-strength: the reading is impossible
  otherwise.
- `0 ≤ lagMinMs < 2.3s` → **clock may be behind**. The source's own indexing
  floor was measured at 2.3s over a sustained 1/s run and it cannot publish a
  pool it has not indexed. Labelled evidence, not proof — the source could
  genuinely have got quicker.

The *ahead* direction is now stated as undetectable here rather than falsely
claimed: it produces no impossible reading, only a pessimistic one, and there
is no upper bound to test a lag against. Four tests pin the direction so it
cannot silently invert again.

A browser genuinely cannot bracket this itself: I checked all four sources and
none sends `Access-Control-Expose-Headers`, so `Date` is unreadable from a
page. That claim in the copy is accurate.

## 5. The "1/100" sentence and the check strip — already shipped

Both already fixed in the tree. `triage.ts:413` now explicitly refuses to quote
the vendor's numeric score inside a passing check, with the reason. The check
strip already splits a solid `✓` (a direct reading) from a hollow `○` (nobody
found anything), in the glyph, the tooltip and the legend. Verified, left alone.

## 6. Missing columns — market cap already shipped, curve added

`MCap` was already a column. Added **Curve**: bonding-curve progress, which
arrives free in the same `gems` POST and exists in no other source wired here.

### A 100× error caught by rendering it

The field is a **percentage 0–100**, not a fraction. I assumed a fraction —
the first values I saw were `0.7028` and `0.7772`, which read perfectly
plausibly as 70% and 78%. They mean **0.70%** and **0.78%**: those rows were
seconds old and had barely started up the curve.

It surfaced only when the column rendered against live data and showed `383%`,
`938%`, `3538%`. Measuring all three buckets settled it:

| bucket | n | min | median | max |
|---|---|---|---|---|
| `aboutToGraduate` | 30 | 65.76 | 74.58 | 91.49 |
| `recent` | 30 | 0.00 | 1.07 | 47.39 |
| `graduated` | 30 | — | *field absent entirely* | — |

Converted to a fraction in the adapter, matching the `top10Pct` / `devHoldsPct`
convention the codebase already uses (name says Pct, value is a fraction), with
a test pinning the exact figure.

The same measurement exposed a second problem: the `recent` bucket medians
1.07%, so a Curve column fed from it alone would have been a page of
near-zeroes and a "near graduation" filter that matched nothing. The request now
also asks for `aboutToGraduate`, which is where the 65–91% rows live. Still one
POST.

Three distinct states that must not collapse:

- **n/a** — graduated. There is no curve left to be a fraction of.
- **—** — nobody published a figure. Most non-launchpad pools.
- **0%** — a real reading about a curve nobody has bought into.

A default of zero would render all three as the last one. Added a matching
**near graduation** filter (≥80%), which *hides* rows with no published figure
rather than treating them as 0% — the same rule the min-liquidity filter
already follows.

## 7. Latent zeros bug — already shipped

`geckoterminal.ts` already carries `numOrNone` alongside `num`, and
`getNewPools` already uses it for price, liquidity and trade counts, with a
comment naming the `$0` / `0/0` failure. Nothing to do.

## What remains structurally impossible

- **Beating ~5.7s on new mints.** Not chargeable and I am not closing it with a
  worse number. Jupiter's own indexing is the floor at p50 5.7s even polled at
  1/s; 2.3s is the best row, not the median. Getting under it needs
  Geyser/Yellowstone or a push stream, both already measured and rejected on
  cost — `logsSubscribe` on PumpSwap alone measured 455 frames/s and 4,020 MB/hr
  to extract about two pool creations a minute.
- **Reading pump.fun from a browser.** Not a rate-limit or key problem; it is a
  server-side origin allowlist against a header the client is not permitted to
  set. No client-side change reaches it. A proxy would work and would stop Nova
  being a static export that runs entirely in the visitor's tab.
- **Bracketing clock skew in the page.** No source exposes `Date` to scripts.
  The page can only disclose, flag the evidence, and point at the probe.
- **Raising any poll rate on measured headroom.** The `tokens/v2` host 429s from
  request 89 of a 1/s run. The datapi host did not break in 106 requests, which
  is a statement about 106 requests and not a budget.

## Gates

```
npx tsc --noEmit          clean
npm test                  23 files, 375 tests passed (10 new)
npm run build:static      clean, static export written to ./out
npx eslint <touched>      clean
```

Served on **port 8793** (non-default, as instructed) and confirmed the served
HTML contained the `near graduation` marker that exists only in this change —
so the numbers below came from this build and not another worktree's.
`document.visibilityState` was forced to `visible` before measuring, because the
page correctly refuses to poll a hidden tab and would otherwise have looked
dead.
