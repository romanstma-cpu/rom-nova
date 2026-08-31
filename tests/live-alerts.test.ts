// The live alert engine's honesty contract, tested at the edges where an
// alerting product usually lies: a threshold crossed while nobody was
// evaluating, a rule created after the event it would have matched, and the
// same event arriving on ten consecutive polls.

import { describe, it, expect } from "vitest";
import {
  achievedCadenceMs,
  evaluateGraduationRule,
  evaluateLaunchRule,
  evaluateLiquidityRule,
  evaluatePriceRule,
  evaluateSignalBandRule,
  evaluateWalletRule,
  gapNoteFor,
  MAX_FIRES_PER_PASS,
  markEvaluated,
  type LiveAlertCondition,
  type LiveAlertRule,
  type RuleEvalState,
  type WalletObs,
} from "@/lib/alerts/rules";
import { ruleCoverage } from "@/app/alerts/page";
import type { TokenLaunch } from "@/lib/types";

const T0 = 1_700_000_000_000;

function rule(condition: LiveAlertCondition, over: Partial<LiveAlertRule> = {}): LiveAlertRule {
  return { id: "r1", name: "test rule", condition, enabled: true, notify: false, createdAt: T0, ...over };
}

const fresh = (): RuleEvalState => ({ ruleId: "r1" });

function launch(over: Partial<TokenLaunch>): TokenLaunch {
  return {
    mint: over.mint ?? "3bfjYG89vn6auJ7idZGUXuhZJu6zqFAzAH6goSwP4LPd",
    name: "Test Token",
    symbol: "TT",
    event: "pool",
    poolCreatedAt: T0,
    firstSeenAt: T0 + 3_000,
    liquidityUsd: 12_000,
    source: "jupiter",
    triage: { verdict: "unverified", checks: [], measured: 4, readings: 2, total: 7, unchecked: 3 },
    ...over,
  } as TokenLaunch;
}

const feedObs = (rows: TokenLaunch[], dataAsOf = T0 + 10_000) => ({ rows, dataAsOf, sourceName: "jupiter" });

// ------------------------------------------------------------ launch rules

describe("launch rule — a rule cannot catch an event that predates it", () => {
  it("consumes the backfill at arming and fires on nothing", () => {
    const r = rule({ kind: "launch" });
    const rows = [launch({ mint: "A".repeat(40) }), launch({ mint: "B".repeat(40) })];
    const res = evaluateLaunchRule(r, fresh(), feedObs(rows), T0 + 10_000);
    expect(res.fires).toHaveLength(0);
    expect(res.state.armedAt).toBe(T0 + 10_000);
    expect(res.state.lastEvaluatedAt).toBe(T0 + 10_000);
  });

  it("fires on a launch observed after arming, carrying the source's time claim", () => {
    const r = rule({ kind: "launch" });
    const armed = evaluateLaunchRule(r, fresh(), feedObs([]), T0 + 10_000).state;
    const row = launch({ firstSeenAt: T0 + 15_000, poolCreatedAt: T0 + 12_000 });
    const res = evaluateLaunchRule(r, armed, feedObs([row]), T0 + 16_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].eventAt).toBe(T0 + 12_000);
    // The pool-creation time is the vendor's claim, and the record says so.
    expect(res.fires[0].eventAtNote).toMatch(/source claim/);
    expect(res.fires[0].firedAt).toBe(T0 + 16_000);
  });

  it("suppresses the same launch on every later pass", () => {
    const r = rule({ kind: "launch" });
    const armed = evaluateLaunchRule(r, fresh(), feedObs([]), T0 + 10_000).state;
    const row = launch({ firstSeenAt: T0 + 15_000 });
    const first = evaluateLaunchRule(r, armed, feedObs([row]), T0 + 16_000);
    expect(first.fires).toHaveLength(1);
    const second = evaluateLaunchRule(r, first.state, feedObs([row]), T0 + 20_000);
    const third = evaluateLaunchRule(r, second.state, feedObs([row]), T0 + 24_000);
    expect(second.fires).toHaveLength(0);
    expect(third.fires).toHaveLength(0);
  });

  it("does not let UNMEASURED liquidity satisfy a liquidity filter", () => {
    // Absence is not a small number — and not a large one either. A row whose
    // liquidity nobody measured can match no threshold in either direction.
    const r = rule({ kind: "launch", minLiquidityUsd: 5_000 });
    const armed = evaluateLaunchRule(r, fresh(), feedObs([]), T0 + 10_000).state;
    const unmeasured = launch({ firstSeenAt: T0 + 15_000, liquidityUsd: undefined });
    const res = evaluateLaunchRule(r, armed, feedObs([unmeasured]), T0 + 16_000);
    expect(res.fires).toHaveLength(0);
  });

  it("filters by worst acceptable triage verdict", () => {
    const r = rule({ kind: "launch", maxVerdict: "caution" });
    const armed = evaluateLaunchRule(r, fresh(), feedObs([]), T0 + 10_000).state;
    const avoid = launch({
      mint: "C".repeat(40),
      firstSeenAt: T0 + 15_000,
      triage: { verdict: "avoid", checks: [], measured: 4, readings: 2, total: 7, unchecked: 3 },
    });
    const caution = launch({
      mint: "D".repeat(40),
      firstSeenAt: T0 + 15_000,
      triage: { verdict: "caution", checks: [], measured: 4, readings: 2, total: 7, unchecked: 3 },
    });
    const res = evaluateLaunchRule(r, armed, feedObs([avoid, caution]), T0 + 16_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].mint).toBe("D".repeat(40));
  });

  it("caps a burst and states the overflow instead of dropping it silently", () => {
    const r = rule({ kind: "launch" });
    const armed = evaluateLaunchRule(r, fresh(), feedObs([]), T0 + 10_000).state;
    const burst = Array.from({ length: MAX_FIRES_PER_PASS + 4 }, (_, i) =>
      launch({ mint: `${String.fromCharCode(65 + i)}`.repeat(40), firstSeenAt: T0 + 15_000 + i }),
    );
    const res = evaluateLaunchRule(r, armed, feedObs(burst), T0 + 16_000);
    expect(res.fires).toHaveLength(MAX_FIRES_PER_PASS + 1);
    const summary = res.fires[res.fires.length - 1];
    expect(summary.measurement).toContain("4 further launches");
    // And the overflow is consumed: nothing refires next pass.
    const next = evaluateLaunchRule(r, res.state, feedObs(burst), T0 + 20_000);
    expect(next.fires).toHaveLength(0);
  });

  it("treats a promoted row (pool → graduation) as a new event", () => {
    const r = rule({ kind: "launch", event: "graduation" });
    const asPool = launch({ firstSeenAt: T0 + 5_000 });
    const armed = evaluateLaunchRule(r, fresh(), feedObs([asPool]), T0 + 10_000).state;
    const graduated = launch({
      firstSeenAt: T0 + 5_000, // kept from the curve sighting, per mergeLaunch
      gradSeenAt: T0 + 60_000,
      poolCreatedAt: T0 + 58_000,
      event: "graduation",
    });
    const res = evaluateLaunchRule(r, armed, feedObs([graduated]), T0 + 61_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].measurement).toContain("graduated");
  });
});

// -------------------------------------------------------- graduation rule

describe("graduation rule — catching it live vs finding it done", () => {
  const MINT = "GradMint111111111111111111111111111111111";

  it("fires once when a watched pool graduates, then stays quiet", () => {
    const r = rule({ kind: "graduation", mint: MINT });
    const asPool = launch({ mint: MINT, firstSeenAt: T0 + 5_000 });
    const armed = evaluateGraduationRule(r, fresh(), feedObs([asPool]), T0 + 10_000).state;
    const grad = launch({ mint: MINT, event: "graduation", gradSeenAt: T0 + 90_000, graduatedAt: T0 + 88_000 });
    const res = evaluateGraduationRule(r, armed, feedObs([grad]), T0 + 91_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].eventAt).toBe(T0 + 88_000);
    expect(res.fires[0].measurement).toContain("graduation observed");
    const again = evaluateGraduationRule(r, res.state, feedObs([grad]), T0 + 95_000);
    expect(again.fires).toHaveLength(0);
  });

  it("says so when the token had ALREADY graduated at first evaluation", () => {
    // The rule was created after the event. Silence would leave the question
    // unanswered forever; claiming a live catch would be a lie. The honest
    // third option: fire once, and say the graduation was not caught live.
    const r = rule({ kind: "graduation", mint: MINT });
    const grad = launch({ mint: MINT, event: "graduation", gradSeenAt: T0 + 1_000 });
    const res = evaluateGraduationRule(r, fresh(), feedObs([grad]), T0 + 10_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].measurement).toContain("already graduated");
    expect(res.fires[0].measurement).toContain("not caught live");
  });

  it("counts an absent mint as an evaluation, not a skip", () => {
    // The feed WAS read; the mint is not in its 30-minute window. That is a
    // measured absence — lastEvaluatedAt must advance so the page does not
    // show a healthy rule as NOT EVALUATED.
    const r = rule({ kind: "graduation", mint: MINT });
    const res = evaluateGraduationRule(r, fresh(), feedObs([launch({})]), T0 + 10_000);
    expect(res.fires).toHaveLength(0);
    expect(res.state.lastEvaluatedAt).toBe(T0 + 10_000);
    expect(res.state.lastSkipReason).toBeUndefined();
  });
});

// ------------------------------------------------------------- price rule

const MINT = "PriceMint11111111111111111111111111111111";
const priceObs = (priceUsd: number, dataAsOf = T0) => ({ priceUsd, liquidityUsd: 50_000, dataAsOf, sourceName: "jupiter" });

describe("price rule — crossings, and what a crossing is not", () => {
  it("skips (never evaluates) on a missing price, and records why", () => {
    const r = rule({ kind: "price_cross", mint: MINT, direction: "above", thresholdUsd: 2 });
    const res = evaluatePriceRule(r, fresh(), priceObs(0), T0);
    expect(res.fires).toHaveLength(0);
    expect(res.state.lastSkipReason).toContain("no price");
    expect(res.state.lastEvaluatedAt).toBeUndefined();
  });

  it("fires at arming when the condition already holds — and admits the crossing was never observed", () => {
    const r = rule({ kind: "price_cross", mint: MINT, direction: "above", thresholdUsd: 2 });
    const res = evaluatePriceRule(r, fresh(), priceObs(3.5), T0);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].measurement).toContain("already true at the first evaluation");
    expect(res.fires[0].measurement).toContain("never observed");
    // No on-chain moment exists for a price crossing this app computed.
    expect(res.fires[0].eventAt).toBeUndefined();
  });

  it("reports a crossing with BOTH readings and the window between them", () => {
    const r = rule({ kind: "price_cross", mint: MINT, direction: "above", thresholdUsd: 2 });
    const below = evaluatePriceRule(r, fresh(), priceObs(1.5), T0).state;
    const res = evaluatePriceRule(r, below, priceObs(2.4), T0 + 60_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].measurement).toContain("previous scan saw");
    expect(res.fires[0].measurement).toContain("crossed somewhere in that window");
  });

  it("does not refire while the condition stays true; re-arms after it goes false", () => {
    const r = rule({ kind: "price_cross", mint: MINT, direction: "above", thresholdUsd: 2 });
    let s = evaluatePriceRule(r, fresh(), priceObs(1.5), T0).state;
    s = evaluatePriceRule(r, s, priceObs(2.4), T0 + 60_000).state; // fires
    const still = evaluatePriceRule(r, s, priceObs(2.9), T0 + 120_000);
    expect(still.fires).toHaveLength(0);
    const dropped = evaluatePriceRule(r, still.state, priceObs(1.2), T0 + 180_000);
    expect(dropped.fires).toHaveLength(0);
    const again = evaluatePriceRule(r, dropped.state, priceObs(2.1), T0 + 240_000);
    expect(again.fires).toHaveLength(1);
  });

  it("discloses the gap when the threshold was crossed while nobody evaluated", () => {
    // Below at T0, then the source is down for ten minutes, then above. The
    // alert must not read like a live catch: the crossing happened somewhere
    // inside a window this tab was blind in, and the record says how long.
    const r = rule({ kind: "price_cross", mint: MINT, direction: "above", thresholdUsd: 2 });
    const below = evaluatePriceRule(r, fresh(), priceObs(1.5), T0).state;
    const res = evaluatePriceRule(r, below, priceObs(4.0), T0 + 600_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].gapNote).toContain("600s evaluation gap");
    expect(res.fires[0].gapNote).toContain("not observed");
  });
});

// --------------------------------------------------------- liquidity rule

describe("liquidity floor — measured zero fires, unmeasured never does", () => {
  it("skips when the source did not measure liquidity", () => {
    const r = rule({ kind: "liquidity_floor", mint: MINT, thresholdUsd: 10_000 });
    const res = evaluateLiquidityRule(
      r,
      fresh(),
      { priceUsd: 1, liquidityUsd: 0, unmeasured: ["liquidity"], dataAsOf: T0, sourceName: "jupiter" },
      T0,
    );
    expect(res.fires).toHaveLength(0);
    expect(res.state.lastSkipReason).toContain("did not measure liquidity");
  });

  it("fires on a measured zero — the drained pool is the point of this rule", () => {
    const r = rule({ kind: "liquidity_floor", mint: MINT, thresholdUsd: 10_000 });
    const above = evaluateLiquidityRule(
      r,
      fresh(),
      { priceUsd: 1, liquidityUsd: 60_000, dataAsOf: T0, sourceName: "jupiter" },
      T0,
    ).state;
    const res = evaluateLiquidityRule(
      r,
      above,
      { priceUsd: 1, liquidityUsd: 0, dataAsOf: T0 + 60_000, sourceName: "jupiter" },
      T0 + 60_000,
    );
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].measurement).toContain("$0");
  });
});

// -------------------------------------------------------- signal band rule

const row = (mint: string, score: number, scored = true) => ({ mint, symbol: mint.slice(0, 3), signalScore: score, scored, dataTs: T0 });

describe("signal band — a crossing is two observations", () => {
  it("skips a pass with no scored rows instead of reading placeholder zeros", () => {
    const r = rule({ kind: "signal_band", band: 76 });
    const res = evaluateSignalBandRule(r, fresh(), [row("AAA", 0, false)], T0, T0);
    expect(res.state.lastSkipReason).toContain("no scored rows");
    expect(res.state.lastEvaluatedAt).toBeUndefined();
  });

  it("never fires on a token first sighted already inside the band", () => {
    const r = rule({ kind: "signal_band", band: 76 });
    const first = evaluateSignalBandRule(r, fresh(), [row("AAA", 90)], T0, T0);
    expect(first.fires).toHaveLength(0);
    const second = evaluateSignalBandRule(r, first.state, [row("AAA", 91)], T0, T0 + 20_000);
    expect(second.fires).toHaveLength(0);
  });

  it("fires exactly once on an observed crossing, with both readings", () => {
    const r = rule({ kind: "signal_band", band: 76 });
    let s = evaluateSignalBandRule(r, fresh(), [row("AAA", 60)], T0, T0).state;
    const crossed = evaluateSignalBandRule(r, s, [row("AAA", 81)], T0, T0 + 20_000);
    expect(crossed.fires).toHaveLength(1);
    expect(crossed.fires[0].measurement).toBe("signal score 60 → 81, crossing the 76 band");
    expect(crossed.fires[0].eventAt).toBeUndefined();
    s = crossed.state;
    const still = evaluateSignalBandRule(r, s, [row("AAA", 84)], T0, T0 + 40_000);
    expect(still.fires).toHaveLength(0);
  });

  it("forgets a mint that leaves the list — its climb resumes unobserved", () => {
    const r = rule({ kind: "signal_band", band: 76 });
    let s = evaluateSignalBandRule(r, fresh(), [row("AAA", 60)], T0, T0).state;
    s = evaluateSignalBandRule(r, s, [row("BBB", 40)], T0, T0 + 20_000).state; // AAA gone
    const back = evaluateSignalBandRule(r, s, [row("AAA", 90)], T0, T0 + 40_000);
    // AAA reappears above the band with no prior reading in hand: one
    // observation cannot claim a crossing, so nothing fires.
    expect(back.fires).toHaveLength(0);
  });
});

// -------------------------------------------------------- wallet fills rule

const WALLET = "WaLLet111111111111111111111111111111111111";
const fill = (sig: string, ts: number, valueUsd?: number) => ({
  signature: sig,
  ts,
  mint: MINT,
  side: "buy" as const,
  tokens: 1000,
  valueUsd,
});
const walletObs = (fills: ReturnType<typeof fill>[], newestTs: number, dataAsOf = T0): WalletObs => ({
  fills,
  newestTs,
  windowHours: 48,
  dataAsOf,
  sourceName: "solana-rpc",
});

describe("wallet fills — the baseline is the arming read", () => {
  it("never fires on fills that predate the rule", () => {
    const r = rule({ kind: "wallet_fills", wallet: WALLET });
    const res = evaluateWalletRule(r, fresh(), walletObs([fill("sig1", T0 - 3_600_000), fill("sig2", T0 - 60_000)], T0 - 60_000), T0);
    expect(res.fires).toHaveLength(0);
    expect(res.state.watermarkTs).toBe(T0 - 60_000);
  });

  it("fires on a new fill with the block time as the event time", () => {
    const r = rule({ kind: "wallet_fills", wallet: WALLET });
    const armed = evaluateWalletRule(r, fresh(), walletObs([fill("sig1", T0 - 60_000)], T0 - 60_000), T0).state;
    const res = evaluateWalletRule(
      r,
      armed,
      walletObs([fill("sig1", T0 - 60_000), fill("sig2", T0 + 120_000, 3_400)], T0 + 120_000, T0 + 240_000),
      T0 + 240_000,
    );
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].eventAt).toBe(T0 + 120_000);
    expect(res.fires[0].eventAtNote).toContain("block time");
    expect(res.fires[0].measurement).toContain("BUY");
    expect(res.fires[0].measurement).toContain("$3.4K");
  });

  it("suppresses a fill already fired, by signature, on later reads", () => {
    const r = rule({ kind: "wallet_fills", wallet: WALLET });
    const armed = evaluateWalletRule(r, fresh(), walletObs([], 0), T0).state;
    const seen = evaluateWalletRule(r, armed, walletObs([fill("sig9", T0 + 100_000)], T0 + 100_000), T0 + 240_000);
    expect(seen.fires).toHaveLength(1);
    const again = evaluateWalletRule(r, seen.state, walletObs([fill("sig9", T0 + 100_000)], T0 + 100_000), T0 + 480_000);
    expect(again.fires).toHaveLength(0);
  });

  it("does not fire on an unseen fill OLDER than the watermark", () => {
    // A fill from before arming that the arming read missed (indexing delay,
    // pagination boundary) surfaces later. It predates the rule, so it stays
    // history — the watermark lives in the BLOCK clock so a skewed local
    // clock cannot shift the boundary.
    const r = rule({ kind: "wallet_fills", wallet: WALLET });
    const armed = evaluateWalletRule(r, fresh(), walletObs([fill("sig1", T0 - 60_000)], T0 - 60_000), T0).state;
    const res = evaluateWalletRule(
      r,
      armed,
      walletObs([fill("sig1", T0 - 60_000), fill("sigOld", T0 - 90_000)], T0 - 60_000),
      T0 + 240_000,
    );
    expect(res.fires).toHaveLength(0);
  });

  it("labels an unpriced fill as unpriced rather than inventing a dollar figure", () => {
    const r = rule({ kind: "wallet_fills", wallet: WALLET });
    const armed = evaluateWalletRule(r, fresh(), walletObs([], 0), T0).state;
    const res = evaluateWalletRule(r, armed, walletObs([fill("sigU", T0 + 100_000, undefined)], T0 + 100_000), T0 + 240_000);
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0].measurement).toContain("unpriced");
  });
});

// ------------------------------------------------------------- bookkeeping

describe("evaluation bookkeeping — the numbers the page prints", () => {
  it("measures achieved cadence as the median gap of real passes", () => {
    let s: RuleEvalState = { ruleId: "r1" };
    for (const t of [T0, T0 + 10_000, T0 + 21_000, T0 + 30_000, T0 + 95_000]) s = markEvaluated(s, t);
    // Gaps: 10s, 11s, 9s, 65s → median 10.5s-ish (10 or 11 by index). The
    // throttled 65s outlier must not drag the figure the way a mean would.
    const cadence = achievedCadenceMs(s)!;
    expect(cadence).toBeGreaterThanOrEqual(10_000);
    expect(cadence).toBeLessThanOrEqual(11_000);
  });

  it("reports no cadence under three samples — two passes is not a rhythm", () => {
    let s: RuleEvalState = { ruleId: "r1" };
    s = markEvaluated(s, T0);
    s = markEvaluated(s, T0 + 10_000);
    expect(achievedCadenceMs(s)).toBeNull();
  });

  it("only writes a gap note when the silence was abnormal for the cadence", () => {
    // 12s since the last pass on a 10s cadence is normal operation.
    expect(gapNoteFor(T0, T0 + 12_000, 10_000)).toBeUndefined();
    // 10 minutes on a 60s cadence is a coverage hole and says so.
    expect(gapNoteFor(T0, T0 + 600_000, 60_000)).toContain("600s evaluation gap");
    // A four-minute wallet cadence makes a five-minute silence unremarkable.
    expect(gapNoteFor(T0, T0 + 300_000, 240_000)).toBeUndefined();
  });
});

// ------------------------------------------------------- the coverage chip
//
// The chip the page renders per rule. NOT EVALUATED is the load-bearing
// state: a rule whose source is down has said NOTHING about the world, and
// this is what keeps that from reading as "no alert".

describe("ruleCoverage — NOT EVALUATED is never spelled as silence", () => {
  const scannerRule = rule({ kind: "signal_band", band: 76 });

  it("labels a disabled rule OFF, not evaluated and not watching", () => {
    const r = { ...scannerRule, enabled: false };
    expect(ruleCoverage(r, markEvaluated({ ruleId: "r1" }, T0), T0).label).toBe("OFF");
  });

  it("labels a rule with no attempt yet NOT EVALUATED", () => {
    const c = ruleCoverage(scannerRule, undefined, T0);
    expect(c.ok).toBe(false);
    expect(c.label).toBe("NOT EVALUATED");
  });

  it("surfaces the skip reason verbatim", () => {
    const s: RuleEvalState = { ruleId: "r1", lastAttemptAt: T0, lastSkipReason: "launch feed stale — no successful poll for 40s" };
    const c = ruleCoverage(scannerRule, s, T0 + 5_000);
    expect(c.label).toBe("NOT EVALUATED");
    expect(c.detail).toContain("launch feed stale");
  });

  it("marks a freshly evaluated rule WATCHING", () => {
    const c = ruleCoverage(scannerRule, markEvaluated({ ruleId: "r1" }, T0), T0 + 15_000);
    expect(c.ok).toBe(true);
    expect(c.label).toBe("WATCHING");
  });

  it("turns a stale rule back into NOT EVALUATED and names the gap", () => {
    // Scanner cadence is 20s; three minutes of silence is a hole, and the
    // detail says what a hole means: nothing in it was watched.
    const c = ruleCoverage(scannerRule, markEvaluated({ ruleId: "r1" }, T0), T0 + 180_000);
    expect(c.ok).toBe(false);
    expect(c.label).toBe("NOT EVALUATED");
    expect(c.detail).toContain("coverage gap");
  });

  it("judges staleness against the RULE'S OWN cadence, not a global one", () => {
    // Five minutes of silence on a four-minute wallet cadence is a normal
    // rotation, not a coverage hole.
    const walletRule = rule({ kind: "wallet_fills", wallet: "W".repeat(40) });
    const c = ruleCoverage(walletRule, markEvaluated({ ruleId: "r1" }, T0), T0 + 300_000);
    expect(c.ok).toBe(true);
  });
});
