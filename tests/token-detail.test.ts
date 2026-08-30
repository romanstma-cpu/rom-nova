// The token detail page is the one screen that claims to answer "should I
// touch this". Every assertion here guards one of the three ways it could lie:
//
//   1. printing a number nobody measured as though somebody had,
//   2. showing one source's answer where two sources gave different ones,
//   3. asking for MORE detail and quietly getting less.
//
// (3) is not hypothetical. RugCheck publishes `lpLockedPct` — the share of the
// liquidity pool that is locked, and the only view this stack has of the
// mechanic behind most memecoin losses — on its SUMMARY endpoint and NOT on the
// full report. Measured on four trending mints, all four. So the detail page,
// the one caller that asks for the full report, was the one caller that lost it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { RugCheckRiskProvider, creatorShare } from "@/lib/providers/rugcheck";
import {
  creatorPanel,
  findDisagreements,
  flowPanel,
  holderTable,
  supplyPanel,
  CONCENTRATION_DISAGREEMENT_PP,
  HOLDER_DISAGREEMENT_RATIO,
} from "@/lib/api/detail";
import { DemoStore } from "@/lib/demo/store";
import { handleCandles, handleTokenDetail, MINT_SHAPE } from "@/lib/api/handlers";
import { safePath } from "@/lib/local";
import { computeSignal, auditFactors, scoreFeatures, PROFILES, RISK_FACTORS } from "@/lib/engine/signals";
import { extractFeatures } from "@/lib/engine/features";
import { authorityState } from "@/lib/providers/jupiter";
import type { TokenFlow, TokenRisk } from "@/lib/providers/types";
import type { FeatureVector, StrategyProfileId, TokenInfo, TokenSnapshot, UnmeasuredField } from "@/lib/types";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const CREATOR = "9ENSWnedBEAvVB7jJKZrLRZ9vuVuJdBE7uJt2oAsG1jr";

/** The report as the live API actually returns it: no lpLockedPct anywhere. */
const REPORT = {
  score: 6072,
  score_normalised: 43,
  risks: [{ name: "Single holder ownership", value: "49.23%", description: "", level: "danger" }],
  totalHolders: 305_306,
  rugged: false,
  graphInsidersDetected: 12,
  insiderNetworks: [{ id: "a" }, { id: "b" }, { id: "c" }],
  creator: CREATOR,
  creatorBalance: 250_000,
  token: { mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, decimals: 6 },
  token_extensions: { permanentDelegate: null },
  transferFee: { pct: 0 },
  markets: [{}, {}, {}],
  totalMarketLiquidity: 7_780_320,
  totalLPProviders: 23,
  launchpad: { name: "Pump.Fun" },
  topHolders: [
    { address: "acc1", owner: "own1", pct: 49.23, insider: false },
    { address: "acc2", owner: CREATOR, pct: 4.56, insider: true },
    { address: "acc3", owner: "own3", pct: 3.55, insider: false },
  ],
  knownAccounts: { own3: { name: "Meteora DLMM Pool", type: "AMM" } },
};

/** The summary, which is where the lock figure lives. */
const SUMMARY = { score: 6072, score_normalised: 43, risks: REPORT.risks, lpLockedPct: 45.72831936635781 };

/** Answers by URL, so the two endpoints can disagree the way they really do. */
function mockByPath(map: Record<string, unknown | "fail">) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const key = url.endsWith("/summary") ? "summary" : "report";
    const body = map[key];
    if (body === "fail" || body === undefined) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("asking for more detail must not return less", () => {
  it("recovers the LP lock from the summary when the report omits it", async () => {
    // The whole reason this provider exists. Without the second request the
    // detail page renders "LP lock not reported" for a pool that is 45.7%
    // locked, and the reader loses the only rug-mechanic signal in the stack.
    mockByPath({ report: REPORT, summary: SUMMARY });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.detailed).toBe(true);
    expect(r?.lpLockedPct).toBeCloseTo(0.4572831, 6);
  });

  it("leaves the lock undefined rather than zero when the summary fails too", async () => {
    // Zero would be the worst possible finding — nothing locked — invented from
    // a failed request. Undefined renders as "not reported".
    mockByPath({ report: REPORT, summary: "fail" });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r).not.toBeNull();
    expect(r?.lpLockedPct).toBeUndefined();
  });

  it("still refuses everything when the report itself fails", async () => {
    mockByPath({ report: "fail", summary: SUMMARY });
    await expect(new RugCheckRiskProvider().getTokenRisk(MINT, true)).rejects.toThrow();
  });

  it("carries the deployer, the pools and the insider graph the page needs", async () => {
    mockByPath({ report: REPORT, summary: SUMMARY });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.creator).toBe(CREATOR);
    expect(r?.markets).toBe(3);
    expect(r?.totalLpProviders).toBe(23);
    expect(r?.insiderNetworks).toBe(3);
    expect(r?.graphInsiders).toBe(12);
    expect(r?.mintAuthority).toBeNull();
    expect(r?.permanentDelegate).toBeNull();
  });

  it("flags the deployer's own row in the holder table", async () => {
    // Two of ten trending tokens had their creator inside the top twenty. The
    // label map names 6% of rows and missed both; the report's own `creator`
    // field names them for free.
    mockByPath({ report: REPORT, summary: SUMMARY });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.topHolders?.[1].isCreator).toBe(true);
    expect(r?.topHolders?.[0].isCreator).toBe(false);
  });
});

describe("a vendor's zero that means 'not indexed yet'", () => {
  it("does not print '0 holders in total' above twenty populated rows", async () => {
    // Live DOM on a one-minute-old mint: the panel header said 0 holders while
    // the table below it listed twenty, and the page header said 80. A freshly
    // launched token gets `totalHolders: 0` from the vendor before its indexer
    // catches up; it is a silence, not a count.
    mockByPath({ report: { ...REPORT, totalHolders: 0 }, summary: SUMMARY });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.totalHolders).toBeUndefined();
    expect(holderTable(r ?? undefined).totalHolders).toBeUndefined();
    // The rows are real and must survive the correction.
    expect(holderTable(r ?? undefined).rows.length).toBe(3);
  });

  it("keeps the guard in ONE place, so no reader has to re-derive it", () => {
    // The bug shipped because the page and the disagreement finder each wrote
    // their own rule for the same field, and only one of them was right.
    const zeroed = { ...RISK, totalHolders: undefined };
    expect(findDisagreements("jupiter", info(), snap(), zeroed, true, "solana-rpc").some((d) =>
      d.question.includes("How many wallets"),
    )).toBe(false);
  });

  // THE SWEEP. The same bug shipped twice on sibling fields in one panel —
  // `totalHolders: 0` in round one, `totalLPProviders: 0` in round two,
  // measured on 30 of 30 freshly-listed mints — because each was fixed
  // individually. Every count-shaped field in the payload is asserted here at
  // once, so a third one cannot arrive quietly.
  it("sweeps every count whose zero is arithmetically impossible", async () => {
    mockByPath({
      report: {
        ...REPORT,
        totalHolders: 0,
        totalLPProviders: 0,
        totalMarketLiquidity: 0,
        markets: [],
        token: { ...REPORT.token, supply: 0 },
      },
      summary: SUMMARY,
    });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.totalHolders).toBeUndefined();
    expect(r?.totalLpProviders).toBeUndefined();
    expect(r?.totalMarketLiquidityUsd).toBeUndefined();
    expect(r?.markets).toBeUndefined();
    expect(r?.supply).toBeUndefined();
  });

  it("keeps the zeros that are real answers", async () => {
    // The other side of the rule, or the sweep becomes its own bug: 0% of LP
    // locked is the WORST case rather than a missing one, a deployer who sold
    // out really does hold nothing, and a clean vendor grade really is low.
    mockByPath({
      // The grade comes off the REPORT on the detailed path, so a vendor's
      // cleanest possible score has to be zeroed there to be exercised at all.
      report: { ...REPORT, score_normalised: 0, creatorBalance: 0, graphInsidersDetected: 0, insiderNetworks: [] },
      summary: { ...SUMMARY, lpLockedPct: 0 },
    });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.lpLockedPct).toBe(0);
    expect(r?.creatorHoldsPct).toBe(0);
    expect(r?.score).toBe(0);
    expect(r?.graphInsiders).toBe(0);
    expect(r?.insiderNetworks).toBe(0);
  });

  it("reads supply out of base units rather than assuming decimals", async () => {
    mockByPath({ report: REPORT, summary: SUMMARY });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    // 1e9 base units at 6 decimals is a thousand whole tokens, not a billion.
    expect(r?.supply).toBe(1_000);
  });

  it("refuses a supply whose decimals are missing", async () => {
    // Off by a factor of a billion is worse than a dash.
    mockByPath({
      report: { ...REPORT, token: { mintAuthority: null, freezeAuthority: null, supply: 1e9 } },
      summary: SUMMARY,
    });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.supply).toBeUndefined();
  });
});

describe("a mint address that is not one", () => {
  it("refuses the shape before it costs five provider calls", async () => {
    // `/token?m=<script>alert(1)</script>` reached the dispatcher, matched no
    // route, and came back as "no local route for /api/tokens/<script>…" — which
    // the page prints verbatim. React escapes it, so never XSS, but a terminal
    // that echoes its own query string is a phishing surface.
    await expect(handleTokenDetail(new DemoStore(3), "<script>alert(1)</script>")).rejects.toThrow(
      /not a Solana mint address/,
    );
    await expect(handleTokenDetail(new DemoStore(3), "")).rejects.toThrow(/not a Solana mint/);
    // Base58 has no 0, O, I or l, so a lookalike is rejected too.
    await expect(
      handleTokenDetail(new DemoStore(3), "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB26O"),
    ).rejects.toThrow(/not a Solana mint/);
  });

  it("lets a real mint through, simulator addresses included", async () => {
    const store = new DemoStore(3);
    const real = store.tokenList()[0].info.mint;
    expect(MINT_SHAPE.test(real)).toBe(true);
    expect(MINT_SHAPE.test(MINT)).toBe(true);
    await expect(handleTokenDetail(store, real)).resolves.toBeTruthy();
  });

  it("does not repeat an unrouteable path back at the reader", () => {
    // The payload's own text must not survive in ANY form. Sanitising alone
    // left "/api/tokens/3Cscript3Ealert13C/script3E" on screen — no markup, and
    // still the attacker's string. The route-identifying prefix is the whole
    // diagnostic value; everything after it is the caller's content.
    expect(safePath("/api/tokens/<script>alert(1)</script>")).toBe("/api/tokens");
    expect(safePath("/api/tokens/%3Cscript%3Ealert(1)%3C/script%3E")).toBe("/api/tokens");
    expect(safePath("/api/tokens/javascript:alert`1`")).toBe("/api/tokens");
    // Bounded, so a kilobyte of query string cannot become a kilobyte of page.
    expect(safePath(`/api/${"a".repeat(500)}`).length).toBeLessThanOrEqual(52);
    // A route name survives, or the error stops being diagnostic.
    expect(safePath("/api/wallets/movers")).toBe("/api/wallets/movers");
    expect(safePath("/api/nope")).toBe("/api/nope");
  });
});

describe("authorityState — Jupiter as a real reader, not a default", () => {
  it("reads the audit flags when the audit ran", () => {
    expect(authorityState({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } })).toEqual({
      mintRevoked: true,
      freezeRevoked: true,
      known: true,
    });
  });

  it("reads the live ADDRESSES when the audit is silent", () => {
    // SKHY's exact shape: no audit flags at all, both authority addresses
    // present, and both genuinely live on chain. Reading the audit block alone
    // reported "unknown" for the single most dangerous token in the sample.
    expect(
      authorityState({
        audit: { topHoldersPercentage: 32.3 } as never,
        mintAuthority: "Bv1CLW7r7JNv18Zgp8bebE6KPjhkaeFHCHgNDHHXjkYD",
        freezeAuthority: "2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a",
      }),
    ).toEqual({ mintRevoked: false, freezeRevoked: false, known: true });
  });

  it("reports unknown, and fails safe, when the payload says neither", () => {
    const a = authorityState({});
    expect(a.known).toBe(false);
    // Unknown must never read as renounced for anything that ignores `known`.
    expect(a.mintRevoked).toBe(false);
    expect(a.freezeRevoked).toBe(false);
  });

  it("treats a half-answer as no answer", () => {
    // One read of the mint account yields both. A payload carrying only one is
    // not a reading of that account.
    expect(authorityState({ audit: { mintAuthorityDisabled: true } }).known).toBe(false);
  });
});

describe("creatorShare — arithmetic on one source, or nothing", () => {
  it("divides the vendor's own two fields", () => {
    expect(creatorShare({ creatorBalance: 250_000, token: { supply: 1_000_000_000 } })).toBeCloseTo(0.00025, 8);
  });

  it("refuses when the supply is unreadable rather than reporting a dev holding nothing", () => {
    expect(creatorShare({ creatorBalance: 250_000, token: { supply: 0 } })).toBeUndefined();
    expect(creatorShare({ creatorBalance: 250_000 })).toBeUndefined();
    expect(creatorShare({ token: { supply: 1_000 } })).toBeUndefined();
  });

  it("keeps a real zero balance, which is a finding", () => {
    expect(creatorShare({ creatorBalance: 0, token: { supply: 1_000 } })).toBe(0);
  });
});

// ---------------------------------------------------------------- score audit

const store = new DemoStore(77);
const now = store.universe.genesis;
const demoMint = store.tokenList()[0].info.mint;

/** Everything a keyless snapshot cannot see, as a live vector really carries it. */
const BLIND: readonly UnmeasuredField[] = [
  "top10Pct",
  "devHoldsPct",
  "insiderPct",
  "bundlerPct",
  "sniperPct",
  "organicScore",
  "socialScore",
  "holders",
  "smartMoney",
  "whaleFlow",
];

describe("auditFactors — the score, fully auditable", () => {
  it("shows every factor the profile defines, measured or not", () => {
    const sig = computeSignal(store, demoMint, now)!;
    const audit = auditFactors(sig);
    const profileKeys = Object.keys(PROFILES.balanced.weights).length;
    // Counted against the definitions rather than a literal, so adding a factor
    // updates the expectation instead of failing a test that was only ever
    // asserting "nobody touched this".
    expect(audit.rows.filter((r) => r.kind === "signal").length).toBe(profileKeys);
    expect(audit.rows.filter((r) => r.kind === "risk").length).toBe(RISK_FACTORS.length);
  });

  it("carries the weight the profile WANTED, not the zero the scorer stored", () => {
    // `SignalFactor.weight` is 0 on a dropped factor, which in a table is
    // indistinguishable from a factor this profile does not care about. The
    // point of the audit is that a reader can see 1.6 of weight went missing.
    const blind = { ...extractFeatures(store, demoMint, now)!, unmeasured: BLIND };
    const audit = auditFactors(scoreFeatures(blind, demoMint, now, "balanced"));
    const sm = audit.rows.find((r) => r.key === "smart_money")!;
    expect(sm.measured).toBe(false);
    expect(sm.intendedWeight).toBe(PROFILES.balanced.weights.smart_money);
    expect(sm.intendedWeight).toBeGreaterThan(0);
  });

  it("reproduces the coverage the scorer actually used, to the printed digit", () => {
    // The NO TRADE reason prints the coverage figure. If the audit computed a
    // different one the page would contradict the sentence beside it — the
    // exact "two answers to one question" failure this repo already hit once.
    //
    // Blinded so that exactly ONE risk factor is unassessable: the scorer
    // checks `unmeasuredRisks >= 2` first, and that gate would fire before the
    // coverage gate and hide the number under test.
    const one = {
      ...extractFeatures(store, demoMint, now)!,
      unmeasured: ["smartMoney", "whaleFlow", "momentum", "volumeAccel", "holders", "insiderPct"] as UnmeasuredField[],
    };
    const sig = scoreFeatures(one, demoMint, now, "balanced");
    const audit = auditFactors(sig);
    const stated = sig.noTradeReason?.match(/only (\d+)% of the model/);
    expect(stated, `expected a coverage gate, got: ${sig.noTradeReason}`).toBeTruthy();
    expect(Math.round(audit.coverage * 100)).toBe(Number(stated![1]));
    expect(audit.unmeasuredRisks).toBe(1);
    expect(audit.missingWeight).toBeCloseTo(5.8, 5);
  });

  it("counts risk factors that could not be assessed at all", () => {
    const blind = { ...extractFeatures(store, demoMint, now)!, unmeasured: BLIND };
    const audit = auditFactors(scoreFeatures(blind, demoMint, now, "balanced"));
    // concentration, insider, bundler/sniper and dev all read blinded fields.
    // The authority and LP factors do not: BLIND is what a keyless SNAPSHOT
    // cannot see, and those come from elsewhere.
    expect(audit.rows.filter((r) => r.kind === "risk" && !r.measured).map((r) => r.key).sort()).toEqual(
      ["bundler_sniper", "concentration_risk", "dev_risk", "insider_risk"].sort(),
    );
    expect(audit.unmeasuredRisks).toBe(4);
  });

  it("leaves exactly two gaps on a simulated token: LP lock and deployer history", () => {
    // The simulator authors its own authorities and delegate, so those are
    // measured here. It has no concept of liquidity locking, and inventing a
    // 100% lock would be the most reassuring possible reading of something this
    // universe does not simulate.
    //
    // Deployer history joined that list rather than being an oversight: the
    // synthetic universe gives every token a `devWallet` but never a count of
    // what else that wallet minted. On live data Jupiter publishes it, and
    // treating the simulator's silence as "first-time creator" would be the
    // same reassuring default in a second place.
    const audit = auditFactors(computeSignal(store, demoMint, now)!);
    expect(audit.rows.filter((r) => !r.measured).map((r) => r.key).sort()).toEqual([
      "deployer_history",
      "lp_lock",
    ]);
    // Coverage weighs the SIGNAL factors only, and none of those is missing.
    expect(audit.coverage).toBe(1);
    expect(audit.unmeasuredRisks).toBe(2);
  });
});

// ------------------------------------------------- the security veto

/**
 * The strongest possible token: deep liquidity, running hot, organic, well
 * distributed, whales accumulating. Every input the scorer likes.
 *
 * Used to prove the veto rather than the arithmetic. A penalty of nine points
 * cannot stop a vector this good from rendering POSITIVE, which is exactly why
 * a live mint authority must be a veto on the LABEL and not a weight.
 */
function strongVector(over: Partial<FeatureVector> = {}): FeatureVector {
  return {
    ...extractFeatures(store, demoMint, now)!,
    liquidityUsd: 5_000_000,
    liquidityChangePct: 20,
    holderGrowthPct: 25,
    momentum1h: 8,
    momentum24h: 30,
    volumeAccel: 2.6,
    organicScore: 0.97,
    socialScore: 0.8,
    top10Pct: 0.12,
    devHoldsPct: 0,
    insiderPct: 0,
    bundlerPct: 0,
    sniperPct: 0,
    devSold: false,
    buySellImbalance: 0.4,
    exitDepthUsd: 900_000,
    smartMoneyNetFlowUsd: 300_000,
    smartMoneyWallets: 6,
    whaleNetFlowUsd: 400_000,
    whaleBuys: 5,
    whaleSells: 0,
    ageHours: 400,
    sampleSize: 120,
    worstStalenessMs: 0,
    regime: "risk_on",
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    permanentDelegate: false,
    lpLockedPct: 1,
    unmeasured: [],
    ...over,
  };
}

const POSITIVE_LABELS = ["EXTREME POSITIVE", "STRONG POSITIVE", "POSITIVE", "WATCH"];

describe("a token that can still be minted must never read POSITIVE", () => {
  it("scores the strongest possible vector as positive when it is actually safe", () => {
    // The control. Without this the tests below would pass on a scorer that
    // labels everything EXTREME RISK.
    const s = scoreFeatures(strongVector(), demoMint, now, "balanced");
    expect(POSITIVE_LABELS).toContain(s.label);
    expect(s.securityVeto).toBeUndefined();
  });

  it("vetoes the label on a LIVE mint authority, however good the tape is", () => {
    const s = scoreFeatures(strongVector({ mintAuthorityRevoked: false }), demoMint, now, "balanced");
    expect(s.label).toBe("EXTREME RISK");
    expect(POSITIVE_LABELS).not.toContain(s.label);
    expect(s.securityVeto).toMatch(/mint authority is LIVE/);
  });

  it("vetoes the label on a LIVE freeze authority", () => {
    const s = scoreFeatures(strongVector({ freezeAuthorityRevoked: false }), demoMint, now, "balanced");
    expect(s.label).toBe("EXTREME RISK");
    expect(s.securityVeto).toMatch(/freeze authority is LIVE/);
  });

  it("vetoes the label on a permanent delegate", () => {
    const s = scoreFeatures(strongVector({ permanentDelegate: true }), demoMint, now, "balanced");
    expect(s.label).toBe("EXTREME RISK");
    expect(s.securityVeto).toMatch(/permanent delegate/);
  });

  it("holds the veto across every strategy profile", () => {
    // A profile is a set of weights. None of them is allowed to weigh its way
    // past "the supply can be inflated at will" — including high_risk, whose
    // whole point is tolerating risk.
    for (const id of Object.keys(PROFILES) as StrategyProfileId[]) {
      const s = scoreFeatures(strongVector({ mintAuthorityRevoked: false }), demoMint, now, id);
      expect(POSITIVE_LABELS, `profile ${id} let a live mint authority through`).not.toContain(s.label);
    }
  });

  it("actually subtracts points as well as vetoing", () => {
    // The veto handles the label; the risk factors have to move the number too,
    // or the score beside the label still says the token is fine.
    const safe = scoreFeatures(strongVector(), demoMint, now, "balanced");
    const unsafe = scoreFeatures(
      strongVector({ mintAuthorityRevoked: false, freezeAuthorityRevoked: false, permanentDelegate: true, lpLockedPct: 0 }),
      demoMint,
      now,
      "balanced",
    );
    expect(unsafe.score).toBeLessThan(safe.score);
    const drop = safe.score - unsafe.score;
    expect(drop, `only ${drop} points for four disqualifying findings`).toBeGreaterThanOrEqual(15);
  });

  it("puts the disqualifying fact at the top of the bear case", () => {
    // The review found ANSEM's "WHAT COULD MAKE THIS FAIL" listing momentum
    // risk and nothing about the security panel beside it.
    const s = scoreFeatures(strongVector({ mintAuthorityRevoked: false }), demoMint, now, "balanced");
    expect(s.bearCase[0]).toMatch(/^Disqualifying: .*mint authority is LIVE/);
    expect(s.risks.some((r) => r.key === "mint_authority" && r.severity === "high")).toBe(true);
    expect(s.kind).toBe("rug_risk_escalation");
  });

  it("does NOT veto when the authorities were merely unverified", () => {
    // The distinction the whole design turns on. "We looked and it is live" is
    // a verdict; "nobody looked" is an absence, and collapsing them would put a
    // red EXTREME RISK on every token whose RPC call timed out.
    const s = scoreFeatures(
      strongVector({ mintAuthorityRevoked: false, unmeasured: ["authorities"] }),
      demoMint,
      now,
      "balanced",
    );
    expect(s.securityVeto).toBeUndefined();
    expect(s.label).toBe("NO TRADE");
    expect(s.noTradeReason).toMatch(/could not be read/);
  });

  it("stands the authority factors down when unverified rather than penalising", () => {
    const s = scoreFeatures(strongVector({ unmeasured: ["authorities"] }), demoMint, now, "balanced");
    const rows = auditFactors(s).rows;
    for (const key of ["mint_authority", "freeze_authority"]) {
      const row = rows.find((r) => r.key === key)!;
      expect(row.measured, `${key} should stand down`).toBe(false);
      expect(row.contribution).toBe(0);
    }
    // And it must not be silently scored as safe either — the flag is raised.
    expect(s.risks.some((r) => r.key === "authority_unknown")).toBe(true);
  });

  it("penalises an unlocked pool and rewards a locked one", () => {
    const locked = scoreFeatures(strongVector({ lpLockedPct: 1 }), demoMint, now, "balanced");
    const open = scoreFeatures(strongVector({ lpLockedPct: 0 }), demoMint, now, "balanced");
    expect(open.score).toBeLessThan(locked.score);
    expect(open.risks.some((r) => r.key === "lp_lock")).toBe(true);
  });

  it("lets extreme concentration subtract, not merely fail to add", () => {
    // 65% in the top ten scored +0.0 before: the floor of a positive-family
    // factor. A cap table that concentrated has to be able to cost points.
    const spread = scoreFeatures(strongVector({ top10Pct: 0.12 }), demoMint, now, "balanced");
    const concentrated = scoreFeatures(strongVector({ top10Pct: 0.8 }), demoMint, now, "balanced");
    const risk = auditFactors(concentrated).rows.find((r) => r.key === "concentration_risk")!;
    expect(risk.measured).toBe(true);
    expect(risk.contribution).toBeLessThan(0);
    expect(concentrated.score).toBeLessThan(spread.score);
  });
});

// ------------------------------------- LP lock, scaled by who holds the pool

/**
 * PUMP as measured: RugCheck 1/100, $42M pooled, 435 pools, 43 independent LP
 * providers, no findings — and `LP Lock` was the largest single penalty on the
 * page, under a red line reading "the pool can be withdrawn".
 *
 * With forty-three independent parties holding the LP, no one of them can
 * withdraw it, so that sentence was false AND it cost the token a whole verdict
 * band. This is the third appearance in this project of one trap — a metric
 * that is most wrong on the largest, most legitimate tokens — after the
 * pool-excluded concentration figure and the bonding-curve lock inversion.
 */
function pumpish(over: Partial<FeatureVector> = {}): FeatureVector {
  return strongVector({ lpLockedPct: 0.0004, lpProviders: 43, ...over });
}

const lpRow = (s: ReturnType<typeof scoreFeatures>) =>
  auditFactors(s).rows.find((r) => r.key === "lp_lock")!;

describe("the LP penalty scales with how many parties hold the pool", () => {
  it("does not charge a deep multi-provider token the maximum", () => {
    const many = scoreFeatures(pumpish(), demoMint, now, "balanced");
    const one = scoreFeatures(pumpish({ lpProviders: 1 }), demoMint, now, "balanced");
    const worst = Math.abs(lpRow(one).contribution);
    const actual = Math.abs(lpRow(many).contribution);
    expect(actual).toBeLessThan(worst);
    // Not merely "less" — 1/sqrt(43) is 0.152, so it must be a small fraction
    // of the maximum rather than a token discount.
    expect(actual).toBeLessThan(worst * 0.25);
  });

  it("still charges something, because the split between providers is unknown", () => {
    // The correction must not become an exemption. Nothing publishes how much
    // of the LP each of the forty-three holds; one of them could hold most.
    expect(lpRow(scoreFeatures(pumpish(), demoMint, now, "balanced")).contribution).toBeLessThan(0);
  });

  it("charges the maximum when ONE party holds the pool", () => {
    const one = scoreFeatures(pumpish({ lpProviders: 1 }), demoMint, now, "balanced");
    const locked = scoreFeatures(pumpish({ lpLockedPct: 1, lpProviders: 1 }), demoMint, now, "balanced");
    expect(lpRow(one).contribution).toBeLessThan(lpRow(locked).contribution);
    expect(lpRow(one).explanation).toMatch(/single provider holds the pool/);
  });

  it("charges the maximum when the provider count is UNKNOWN", () => {
    // Fail-safe direction. The discount is bought with evidence or not at all,
    // so an unmeasured count reads exactly like a single provider.
    const unknown = scoreFeatures(
      pumpish({ unmeasured: ["lpProviders"] }),
      demoMint,
      now,
      "balanced",
    );
    const one = scoreFeatures(pumpish({ lpProviders: 1 }), demoMint, now, "balanced");
    expect(lpRow(unknown).contribution).toBeCloseTo(lpRow(one).contribution, 5);
    expect(lpRow(unknown).explanation).toMatch(/no source here says by how many/);
  });

  it("treats a vendor zero as unknown rather than as one provider", () => {
    // `totalLPProviders: 0` means "not indexed" on 30 of 30 freshly-listed
    // mints sampled. Reaching the factor as a count would take max(1, 0) and
    // print "a single provider holds the pool — that party can withdraw it",
    // which invents the WORST reading from an absence.
    const zero = scoreFeatures(pumpish({ lpProviders: 0 }), demoMint, now, "balanced");
    expect(lpRow(zero).explanation).toMatch(/no source here says by how many/);
    expect(lpRow(zero).explanation).not.toMatch(/single provider/);
  });

  it("recovers the band the over-correction was costing", () => {
    const many = scoreFeatures(pumpish(), demoMint, now, "balanced");
    const one = scoreFeatures(pumpish({ lpProviders: 1 }), demoMint, now, "balanced");
    expect(many.score).toBeGreaterThan(one.score);
  });

  it("does not let the falsehood survive in the bear case", () => {
    // The penalty, the panel and the provenance were all corrected and this
    // one was not: the risk FLAG's detail still read "whoever holds the rest
    // can withdraw it, and no source here says who that is", which reached the
    // reader through WHAT COULD MAKE THIS FAIL on a token where the app knew
    // there were forty-three of them.
    const s = scoreFeatures(pumpish(), demoMint, now, "balanced");
    const flag = s.risks.find((r) => r.key === "lp_lock")!;
    expect(flag.detail).toContain("43 independent providers");
    expect(flag.detail).not.toContain("no source here says who that is");
    expect(s.bearCase.some((b) => /43 independent providers/.test(b))).toBe(true);
  });

  it("keeps the alarm at medium however low the figure goes", () => {
    // The FLAG and the PENALTY are separate decisions and both are now right.
    // Grading this high-severity fired EXTREME RISK on exactly the tokens where
    // an unlocked aggregate means least.
    const s = scoreFeatures(pumpish({ lpLockedPct: 0 }), demoMint, now, "balanced");
    expect(s.risks.find((r) => r.key === "lp_lock")?.severity).toBe("medium");
  });
});

// --------------------------- points paid for the absence of what is measured

describe("an unmeasured or midpoint input cannot produce a positive contribution", () => {
  it("stands the whale factor down rather than scoring its midpoint", () => {
    // SKHY showed "Whale Accumulation +4.8 — no whale-sized trades in the
    // window" as its THIRD-LARGEST positive: a null flow result landing on the
    // normalise midpoint and rendering as credit.
    const s = scoreFeatures(strongVector({ unmeasured: ["whaleFlow"] }), demoMint, now, "balanced");
    const row = auditFactors(s).rows.find((r) => r.key === "whale_flow")!;
    expect(row.measured).toBe(false);
    expect(row.contribution).toBe(0);
    expect(row.explanation).toMatch(/not measured/);
  });

  it("pays exactly zero for a MEASURED factor sitting at its midpoint", () => {
    // The other half. A flow provider that answered, with no whale-sized move
    // in the window, is a real reading of 0.5 — and 0.5 is "no information",
    // which must be worth nothing rather than half the factor's weight.
    const s = scoreFeatures(
      strongVector({ whaleNetFlowUsd: 0, whaleBuys: 0, whaleSells: 0 }),
      demoMint,
      now,
      "balanced",
    );
    const row = auditFactors(s).rows.find((r) => r.key === "whale_flow")!;
    expect(row.measured).toBe(true);
    expect(row.normalized).toBeCloseTo(0.5, 6);
    expect(row.contribution).toBe(0);
  });

  it("holds that guarantee in every regime", () => {
    // The regime multiplier used to scale the whole 0-100 mean, which made it a
    // constant added to every row — so a midpoint factor drew credit in a
    // friendly market and a penalty in a hostile one. It scales the DEVIATION
    // from neutral now, and 50 maps to 50 under all of them.
    for (const regime of ["meme_mania", "risk_on", "neutral", "risk_off", "low_liquidity"] as const) {
      const s = scoreFeatures(
        strongVector({ regime, whaleNetFlowUsd: 0, whaleBuys: 0, whaleSells: 0 }),
        demoMint,
        now,
        "balanced",
      );
      const row = auditFactors(s).rows.find((r) => r.key === "whale_flow")!;
      expect(row.contribution, `whale_flow paid points in ${regime}`).toBe(0);
    }
  });

  it("still reconciles: 50 plus every contribution equals the score", () => {
    // The property that makes the table auditable, re-asserted because the
    // regime change touched both halves of the arithmetic.
    for (const regime of ["meme_mania", "risk_on", "neutral", "risk_off"] as const) {
      const s = scoreFeatures(strongVector({ regime }), demoMint, now, "balanced");
      expect(auditFactors(s).reconciled, `reconciliation broke in ${regime}`).toBe(s.score);
    }
  });
});

// -------------------------------------------- the serial deployer, calibrated

describe("a mint factory caps the verdict without vetoing it", () => {
  /** CATE as measured: 19,083 mints, 340 of them reaching a real pool. */
  const factory = { devMints: 19_083, devMigrations: 340 };
  /**
   * Strictly the labels the cap is supposed to prevent.
   *
   * NOT the file's `POSITIVE_LABELS`, which includes WATCH — asserting against
   * that list would pass whether the cap fired or not, since WATCH is exactly
   * what the cap produces.
   */
  const ABOVE_WATCH = ["EXTREME POSITIVE", "STRONG POSITIVE", "POSITIVE"];

  it("holds a strong tape at WATCH instead of calling it POSITIVE", () => {
    // The review's finding: `deployer_history -5.9` with a high-severity flag,
    // and the label still POSITIVE / 73. A nine-point penalty cannot outvote a
    // strong tape, so the score band had the last word.
    const capped = scoreFeatures(strongVector(factory), demoMint, now, "balanced");
    expect(capped.label).toBe("WATCH");
    expect(capped.labelCap).toMatch(/19,083 mints/);
    // The SCORE is not fudged to agree — it stays the honest weighted mean.
    expect(capped.score).toBeGreaterThan(60);
  });

  it("puts the deployer in the bear case, where a reader looks for it", () => {
    const capped = scoreFeatures(strongVector(factory), demoMint, now, "balanced");
    expect(capped.bearCase.some((b) => /Caps the verdict:.*19,083/.test(b))).toBe(true);
  });

  it("does NOT cap a prolific deployer whose mints actually graduate", () => {
    // The half that keeps this from being a tax on success. A launchpad or a
    // builder at 30% graduation clears it, and should.
    const busy = scoreFeatures(strongVector({ devMints: 19_083, devMigrations: 6_000 }), demoMint, now, "balanced");
    expect(busy.labelCap).toBeUndefined();
    expect(ABOVE_WATCH).toContain(busy.label);
  });

  it("does NOT cap the median deployer, or it would fire on half the feed", () => {
    // W2 measured the population: the median new pump.fun deployer is on their
    // 75th mint. Any threshold low enough to be principled about "serial" would
    // abstain on half the list, which is a verdict carrying no information —
    // the exact failure the abstention gate has already had twice.
    const median = scoreFeatures(strongVector({ devMints: 75, devMigrations: 1 }), demoMint, now, "balanced");
    expect(median.labelCap).toBeUndefined();
    expect(ABOVE_WATCH).toContain(median.label);
  });

  it("refuses to judge a rate it has no sample for", () => {
    // Three mints, none graduated, is a 0% graduation rate — and it is noise.
    // The count threshold exists to stop that from reading as a factory.
    const tiny = scoreFeatures(strongVector({ devMints: 3, devMigrations: 0 }), demoMint, now, "balanced");
    expect(tiny.labelCap).toBeUndefined();
  });

  it("caps on today's real trending list exactly where the rate is bad", () => {
    // The population that matters, taken live. The row that must NOT be capped
    // is the one with hundreds of mints and a rate that works — if the cap
    // catches that, it has become a tax on being prolific.
    const observed: [string, number, number, boolean][] = [
      ["CATE", 19_098, 341, true],
      ["PBJ", 13_843, 199, true],
      ["STONK", 6_161, 11, true],
      ["MAGA", 4_681, 202, true],
      ["STACY", 731, 33, true],
      ["Orangutan", 405, 34, false],
      ["PINK", 55, 1, false],
      ["nub", 2, 0, false],
    ];
    for (const [sym, devMints, devMigrations, shouldCap] of observed) {
      const s = scoreFeatures(strongVector({ devMints, devMigrations }), demoMint, now, "balanced");
      expect(Boolean(s.labelCap), `${sym} (${devMints}/${devMigrations})`).toBe(shouldCap);
    }
  });

  it("never caps on a history nobody published", () => {
    const blind = scoreFeatures(strongVector({ devMints: 0, devMigrations: 0, unmeasured: ["devHistory"] }), demoMint, now, "balanced");
    expect(blind.labelCap).toBeUndefined();
  });

  it("only ever moves a label DOWN, never up", () => {
    // A capped token that already reads NEUTRAL must not be lifted to WATCH —
    // that would make a warning render as an upgrade. Asserted as monotonicity
    // against the same vector uncapped, rather than against a hand-picked
    // expected label that would have to be retuned every time a weight moves.
    const order = ["NO TRADE", "EXTREME RISK", "NEGATIVE", "WEAK", "NEUTRAL", "WATCH", "POSITIVE", "STRONG POSITIVE", "EXTREME POSITIVE"];
    const tape: Partial<FeatureVector>[] = [
      {},
      { momentum1h: -5, momentum24h: -30, volumeAccel: 0.3, organicScore: 0.2 },
      { liquidityUsd: 60_000, exitDepthUsd: 11_000, momentum24h: -40, volumeAccel: 0.2, organicScore: 0.1, top10Pct: 0.45, socialScore: 0.05, buySellImbalance: -0.5, whaleNetFlowUsd: -200_000, whaleBuys: 0, whaleSells: 4, smartMoneyNetFlowUsd: -100_000 },
    ];
    for (const over of tape) {
      const plain = scoreFeatures(strongVector(over), demoMint, now, "balanced");
      const capped = scoreFeatures(strongVector({ ...over, ...factory }), demoMint, now, "balanced");
      expect(
        order.indexOf(capped.label),
        `cap raised ${plain.label} to ${capped.label}`,
      ).toBeLessThanOrEqual(order.indexOf(plain.label));
    }
  });

  it("is outranked by the security veto, which is a different kind of fact", () => {
    // A capability beats a base rate. EXTREME RISK, not WATCH.
    const both = scoreFeatures(strongVector({ ...factory, mintAuthorityRevoked: false }), demoMint, now, "balanced");
    expect(both.label).toBe("EXTREME RISK");
  });
});

describe("the abstention gate says something a reader can act on", () => {
  it("names the authorities rather than counting anonymous risk factors", () => {
    const s = scoreFeatures(strongVector({ unmeasured: ["authorities"] }), demoMint, now, "balanced");
    expect(s.noTradeReason).toContain("mint and freeze authorities");
  });

  it("does not abstain merely because one source omits bundler data", () => {
    // The old rule was `unmeasuredRisks >= 2`, and Jupiter never publishes
    // bundlerPct or sniperPct — so a single further gap took every live token
    // to NO TRADE. Five of six mints in review abstained through it, which is a
    // verdict carrying no information.
    const s = scoreFeatures(
      strongVector({ unmeasured: ["bundlerPct", "sniperPct", "smartMoney"] }),
      demoMint,
      now,
      "balanced",
    );
    expect(s.label).not.toBe("NO TRADE");
  });

  it("still abstains when most of the risk model is blind", () => {
    const s = scoreFeatures(
      strongVector({
        unmeasured: ["bundlerPct", "sniperPct", "insiderPct", "devHoldsPct", "top10Pct", "lpLocked"],
      }),
      demoMint,
      now,
      "balanced",
    );
    expect(s.label).toBe("NO TRADE");
    // The reason names the FAMILY that went unread, not a fraction of a list.
    // Counting all risk factors was tried and broke when the list grew: the
    // three authority checks took it from eight to eleven, and this exact
    // vector — cap table, insiders, bundlers and dev holdings all unknown —
    // then cleared "more than half assessable" on the authorities alone and
    // scored EXTREME POSITIVE.
    expect(s.noTradeReason).toMatch(/the supply is not/);
    expect(s.noTradeReason).toMatch(/who actually holds/);
  });
});

// ---------------------------------------------------------------- panels

const RISK: TokenRisk = {
  mint: MINT,
  source: "rugcheck",
  score: 43,
  risks: [],
  detailed: true,
  totalHolders: 305_306,
  labelledHolders: 1,
  creator: CREATOR,
  topHolders: [
    { owner: "own1", account: "acc1", pct: 0.4923, insider: false, isCreator: false },
    { owner: CREATOR, account: "acc2", pct: 0.0456, insider: true, isCreator: true },
    { owner: "own3", account: "acc3", pct: 0.0355, label: "Meteora DLMM Pool", insider: false, isCreator: false },
  ],
};

describe("holderTable — labels where they exist, coverage where they do not", () => {
  it("never invents a label", () => {
    const t = holderTable(RISK);
    expect(t.rows[0].label).toBeUndefined();
    expect(t.rows[2].label).toBe("Meteora DLMM Pool");
  });

  it("reports coverage so an unlabelled row is not read as a wallet", () => {
    const t = holderTable(RISK);
    expect(t.labelled).toBe(1);
    expect(t.rows.length).toBe(3);
  });

  it("sums only what was published, and says so as its own figure", () => {
    const t = holderTable(RISK);
    expect(t.listedPct).toBeCloseTo(0.5734, 4);
    // The vendor's own total is a different number and stays separate.
    expect(t.totalHolders).toBe(305_306);
  });

  it("returns an empty table rather than a flat cap table when nobody looked", () => {
    const t = holderTable(undefined);
    expect(t.rows).toEqual([]);
    expect(t.source).toBeUndefined();
    expect(t.listedPct).toBe(0);
  });
});

function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint: MINT,
    ts: now,
    priceUsd: 0.37,
    marketCapUsd: 3.7e8,
    fdvUsd: 3.7e8,
    liquidityUsd: 4.6e6,
    volume24hUsd: 1e7,
    buys1h: 100,
    sells1h: 90,
    uniqueBuyers1h: 0,
    uniqueSellers1h: 0,
    holders: 136_357,
    top10Pct: 0.6535,
    devHoldsPct: 0,
    organicScore: 0.97,
    socialScore: 0,
    bundlerPct: 0,
    sniperPct: 0,
    insiderPct: 0,
    ...over,
  };
}

function info(over: Partial<TokenInfo> = {}): TokenInfo {
  return {
    mint: MINT,
    name: "The Black Bull",
    symbol: "ANSEM",
    createdAt: now - 73 * 24 * 3_600_000,
    decimals: 6,
    narrative: "Community",
    verified: true,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    permanentDelegate: false,
    devWallet: "yHCxHBEaJW5tbndqC8JciSThr7U1cqLpdcsvHcx6PRe",
    hue: 200,
    devMints: 873,
    devMigrations: 291,
    ...over,
  };
}

describe("creatorPanel — a dev balance nobody published is not zero", () => {
  it("blanks the dev holding when the snapshot declared it unmeasured", () => {
    const c = creatorPanel(info(), snap({ unmeasured: ["devHoldsPct"] }), undefined);
    expect(c.holdsPct).toBeUndefined();
    expect(c.holdsUnmeasured).toBe(true);
  });

  it("keeps a measured near-zero, which is a real answer", () => {
    // Jupiter really does publish 9.9e-9 for a dev who sold out. That is a
    // measurement and must survive to the panel.
    const c = creatorPanel(info(), snap({ devHoldsPct: 9.878e-9 }), undefined);
    expect(c.holdsPct).toBeCloseTo(9.878e-9, 12);
    expect(c.holdsUnmeasured).toBe(false);
  });

  it("stops calling it unmeasured once the risk vendor supplies it", () => {
    const c = creatorPanel(info(), snap({ unmeasured: ["devHoldsPct"] }), { ...RISK, creatorHoldsPct: 0.00025 });
    expect(c.holdsUnmeasured).toBe(false);
    expect(c.vendorHoldsPct).toBeCloseTo(0.00025, 8);
  });

  it("carries the creator's mint history, and leaves it undefined when absent", () => {
    expect(creatorPanel(info(), snap(), undefined).mints).toBe(873);
    expect(creatorPanel(info({ devMints: undefined }), snap(), undefined).mints).toBeUndefined();
  });

  // ---- the panel that contradicted itself in adjacent lines
  //
  // Live on PUMP, SKHY, TRX and CATE: "Dev still holds —", tooltipped "no
  // source published the deployer's balance — this is not zero", printed ONE
  // LINE above "rugcheck independently puts the deployer balance at 0.000%".
  // The cell read `holdsPct` alone and the footnote read `vendorHoldsPct`
  // alone, so a token where only the vendor answered rendered both sentences.

  it("prints the vendor's figure rather than a dash when only the vendor answered", () => {
    const c = creatorPanel(info(), snap({ unmeasured: ["devHoldsPct"] }), { ...RISK, creatorHoldsPct: 0 }, "jupiter");
    expect(c.holdsShown).toEqual({ pct: 0, source: "rugcheck" });
    // And the dash-with-tooltip path is now unreachable for this token, which
    // is the whole point: one question, one answer, one source named.
    expect(c.holdsUnmeasured).toBe(false);
  });

  it("prefers the token provider, because that is the figure the score reads", () => {
    const c = creatorPanel(info(), snap({ devHoldsPct: 0.031 }), { ...RISK, creatorHoldsPct: 0.02 }, "jupiter");
    expect(c.holdsShown).toEqual({ pct: 0.031, source: "jupiter" });
    // The vendor's number survives beside it — it is a genuine second opinion
    // here, and the panel prints it as one.
    expect(c.vendorHoldsPct).toBeCloseTo(0.02, 6);
  });

  it("shows nothing at all when nobody published a balance", () => {
    const c = creatorPanel(info(), snap({ unmeasured: ["devHoldsPct"] }), undefined, "jupiter");
    expect(c.holdsShown).toBeUndefined();
    expect(c.holdsUnmeasured).toBe(true);
  });
});

describe("supplyPanel — ratios from published figures, never derived supply", () => {
  it("takes supply only from a vendor that read the mint", () => {
    expect(supplyPanel(snap(), { ...RISK, supply: 998_739_012 }).supply).toBe(998_739_012);
    // NOT marketCap / price, which would be arithmetic across two vendors'
    // roundings presented as somebody's measurement.
    expect(supplyPanel(snap(), RISK).supply).toBeUndefined();
    expect(supplyPanel(snap(), undefined).supply).toBeUndefined();
  });

  it("computes liquidity over market cap, which is the reachability of the header", () => {
    const p = supplyPanel(snap({ liquidityUsd: 90_000, marketCapUsd: 40_000_000 }), undefined);
    expect(p.liqToMcap).toBeCloseTo(0.00225, 5);
  });

  it("divides by nothing rather than returning Infinity", () => {
    const p = supplyPanel(snap({ marketCapUsd: 0, fdvUsd: 0 }), undefined);
    expect(p.liqToMcap).toBeUndefined();
    expect(p.mcapToFdv).toBeUndefined();
    expect(p.fdvUsd).toBeUndefined();
  });
});

describe("findDisagreements — two answers to one question, both printed", () => {
  it("says nothing when the sources agree", () => {
    const agreeing: TokenRisk = { ...RISK, totalHolders: 136_400, mintAuthority: null, freezeAuthority: null, creator: info().devWallet };
    expect(findDisagreements("jupiter", info(), snap(), agreeing, true, "solana-rpc")).toEqual([]);
  });

  it("reports a holder count that is 2.2x apart", () => {
    // Measured live: jupiter 136,357 against rugcheck 305,306 on ANSEM, and
    // 547,888 against 1,961,156 on PENGU.
    const out = findDisagreements("jupiter", info(), snap(), RISK, true, "solana-rpc");
    const d = out.find((x) => x.question.includes("How many wallets"))!;
    expect(d).toBeTruthy();
    expect(d.claims.map((c) => c.source)).toEqual(["jupiter", "rugcheck"]);
    expect(d.claims[0].value).toContain("136,357");
    expect(d.claims[1].value).toContain("305,306");
    // The note has to say the app is refusing to reconcile them, or a reader
    // will assume one of the two is the answer and the other a rounding error.
    expect(d.note).toContain("shows both");
  });

  it("stays quiet inside the tolerance", () => {
    const close: TokenRisk = { ...RISK, totalHolders: Math.round(136_357 * (HOLDER_DISAGREEMENT_RATIO - 0.05)) };
    const out = findDisagreements("jupiter", info(), snap(), close, true, "solana-rpc");
    expect(out.some((x) => x.question.includes("How many wallets"))).toBe(false);
  });

  it("reports a concentration gap only once it is material", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      owner: `o${i}`,
      pct: 0.09,
      insider: false,
      isCreator: false,
    }));
    // Vendor rows sum to 90%; the token provider says 65.35%.
    const wide: TokenRisk = { ...RISK, totalHolders: 136_400, topHolders: ten };
    const out = findDisagreements("jupiter", info(), snap(), wide, true, "solana-rpc");
    const d = out.find((x) => x.question.includes("top 10"))!;
    expect(d).toBeTruthy();
    expect(d.note).toContain("holder table below");

    const narrow: TokenRisk = {
      ...RISK,
      totalHolders: 136_400,
      topHolders: ten.map((h) => ({ ...h, pct: 0.06535 })),
    };
    expect(
      findDisagreements("jupiter", info(), snap(), narrow, true, "solana-rpc").some((x) =>
        x.question.includes("top 10"),
      ),
    ).toBe(false);
    expect(CONCENTRATION_DISAGREEMENT_PP).toBeGreaterThan(0);
  });

  it("never compares a concentration figure nobody measured", () => {
    // top10Pct is declared unmeasured, so the snapshot's placeholder is a zero
    // nobody measured. Comparing it against the vendor's real 57% would print a
    // 57-point "disagreement" between one measurement and one absence.
    const out = findDisagreements(
      "jupiter",
      info(),
      snap({ unmeasured: ["top10Pct"], top10Pct: 0 }),
      { ...RISK, totalHolders: 136_400 },
      true,
      "solana-rpc",
    );
    expect(out.some((x) => x.question.includes("top 10"))).toBe(false);
  });

  it("surfaces an authority the chain and the vendor read differently", () => {
    const out = findDisagreements(
      "jupiter",
      info({ mintAuthorityRevoked: true }),
      snap(),
      { ...RISK, totalHolders: 136_400, mintAuthority: "Bv1CLW7r7JNv18Zgp8bebE6KPjhkaeFHCHgNDHHXjkYD", creator: info().devWallet },
      true,
      "solana-rpc",
    );
    const d = out.find((x) => x.question.includes("mint authority"))!;
    expect(d.claims).toEqual([
      { source: "solana-rpc", value: "revoked" },
      { source: "rugcheck", value: "LIVE" },
    ]);
  });

  it("does not manufacture an authority conflict out of a fail-safe default", () => {
    // The keyless token providers report "not revoked" whether they read the
    // mint account or not. Treating that as a claim would put a red panel on
    // every token where nobody checked — which is most of them.
    const out = findDisagreements(
      "jupiter",
      info({ mintAuthorityRevoked: false }),
      snap(),
      { ...RISK, totalHolders: 136_400, mintAuthority: null, creator: info().devWallet },
      false,
      undefined,
    );
    expect(out.some((x) => x.question.includes("authority"))).toBe(false);
  });

  it("shows both deployer addresses rather than choosing one", () => {
    const out = findDisagreements("jupiter", info(), snap(), { ...RISK, totalHolders: 136_400 }, true, "solana-rpc");
    const d = out.find((x) => x.question.includes("deployed"))!;
    expect(d.claims.map((c) => c.value)).toEqual([info().devWallet, CREATOR]);
  });

  it("says nothing at all when nobody graded the token", () => {
    expect(findDisagreements("jupiter", info(), snap(), undefined, true, "solana-rpc")).toEqual([]);
  });
});

describe("a rate-limited source is not a verdict on the token", () => {
  it("says the source failed rather than 'unknown mint'", async () => {
    // Jupiter answers a burst with 429. Every real mint then missed in the
    // simulator too and the page reported "unknown mint" — a permanent-sounding
    // claim about the token standing in for a temporary fact about us.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Rate limit exceeded, please try again later.", { status: 429 }),
    );
    await expect(handleTokenDetail(new DemoStore(5), MINT)).rejects.toThrow(/live data unavailable/);
  });

  it("still resolves a simulated mint while the live source is down", async () => {
    // The fallback has to keep working, or one provider outage takes the whole
    // demo universe with it.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 429 }));
    const store = new DemoStore(77);
    const demoMintId = store.tokenList()[0].info.mint;
    const out = (await handleTokenDetail(store, demoMintId)) as { mode: string };
    expect(out.mode).toBe("demo");
  });
});

describe("an empty chart has to say why", () => {
  it("puts the reason in the 404 instead of 'unknown mint or empty range'", async () => {
    // The chart panel renders whatever this message says. When it was generic,
    // a real Solana mint with no OHLCV left the panel on "LOADING CHART…"
    // forever, because there was nothing worth printing — an absence wearing
    // the appearance of something still on its way.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(handleCandles(new DemoStore(5), MINT)).rejects.toThrow(/no on-chain history for this mint/);
  });
});

describe("flowPanel — the window covered, never the window requested", () => {
  const flow: TokenFlow = {
    mint: MINT,
    source: "sqd",
    fromBlock: 1000,
    toBlock: 2500,
    reachedBlock: 1600,
    blocksRequested: 1500,
    blocksCovered: 600,
    lastTimestamp: 0,
    complete: false,
    bytesRead: 8 * 1048576,
    movements: 726,
    touchedNotMoved: 10_357,
    wallets: 187,
    netUnits: "0",
    inflowUnits: "0",
    outflowUnits: "0",
    buyers: 83,
    sellers: 94,
    largest: [
      { owner: "small", deltaUnits: "1000" }, // $0.0001 at the price below — dust
      { owner: "big", deltaUnits: "-50000000000" },
      { owner: "mid", deltaUnits: "20000000000" },
    ],
  };

  it("reports four minutes as four minutes when the budget cut ten", () => {
    const p = flowPanel(flow, 6, 1)!;
    expect(p.minutesCovered).toBeCloseTo(4, 5);
    expect(p.minutesRequested).toBe(10);
    expect(p.complete).toBe(false);
  });

  it("ranks movers by size in both directions", () => {
    // Taking only the top of a descending sort would report buyers and never
    // the wallet quietly unloading.
    const p = flowPanel(flow, 6, 1)!;
    expect(p.movers.map((m) => m.owner)).toEqual(["big", "mid"]);
    expect(p.movers[0].usd).toBeLessThan(0);
  });

  it("drops sub-dollar dust rather than burying the wallet that moved size", () => {
    const p = flowPanel(flow, 6, 1)!;
    expect(p.movers.some((m) => m.owner === "small")).toBe(false);
  });

  it("is undefined, not empty, when no provider answered", () => {
    // An empty panel reads as "nobody traded". Undefined reads as "nobody
    // looked", which is what it means and is why the whale factor stands down.
    expect(flowPanel(undefined, 6, 1)).toBeUndefined();
  });
});
