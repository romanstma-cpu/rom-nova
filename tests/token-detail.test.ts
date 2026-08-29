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
import { handleCandles } from "@/lib/api/handlers";
import { computeSignal, auditFactors, scoreFeatures, PROFILES } from "@/lib/engine/signals";
import { extractFeatures } from "@/lib/engine/features";
import type { TokenFlow, TokenRisk } from "@/lib/providers/types";
import type { TokenInfo, TokenSnapshot, UnmeasuredField } from "@/lib/types";

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
    // Signal factors plus the four risk factors that subtract from the score.
    expect(audit.rows.filter((r) => r.kind === "signal").length).toBe(profileKeys);
    expect(audit.rows.filter((r) => r.kind === "risk").length).toBe(4);
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
    // insider, bundler/sniper and dev all read blinded fields.
    expect(audit.unmeasuredRisks).toBe(3);
  });

  it("marks everything measured when nothing is missing", () => {
    const audit = auditFactors(computeSignal(store, demoMint, now)!);
    expect(audit.rows.every((r) => r.measured)).toBe(true);
    expect(audit.coverage).toBe(1);
    expect(audit.unmeasuredRisks).toBe(0);
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
