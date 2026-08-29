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
  CONCENTRATION_DISAGREEMENT_PP,
  HOLDER_DISAGREEMENT_RATIO,
} from "@/lib/api/detail";
import { DemoStore } from "@/lib/demo/store";
import { handleCandles, handleTokenDetail } from "@/lib/api/handlers";
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

  it("leaves exactly one gap on a simulated token: the LP lock it does not model", () => {
    // The simulator authors its own authorities and delegate, so those are
    // measured here. It has no concept of liquidity locking, and inventing a
    // 100% lock would be the most reassuring possible reading of something this
    // universe does not simulate.
    const audit = auditFactors(computeSignal(store, demoMint, now)!);
    expect(audit.rows.filter((r) => !r.measured).map((r) => r.key)).toEqual(["lp_lock"]);
    // Coverage weighs the SIGNAL factors only, and none of those is missing.
    expect(audit.coverage).toBe(1);
    expect(audit.unmeasuredRisks).toBe(1);
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
    expect(s.noTradeReason).toMatch(/risk factors could be assessed/);
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
