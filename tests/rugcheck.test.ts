// The risk overlay's dangerous direction is the opposite of everything else in
// this codebase. Elsewhere a missing field defaults to zero and reads as GOOD
// news — a clean cap table, no insiders. Here a missing lpLockedPct defaulted to
// zero would read as "nothing is locked", which is the worst possible finding,
// invented. Both directions are the same bug: a number nobody measured being
// rendered as one that was.

import { describe, it, expect, vi, afterEach } from "vitest";
import { RugCheckRiskProvider, levelOf, lpFraction, riskHeadline } from "@/lib/providers/rugcheck";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const SUMMARY = {
  risks: [
    {
      name: "Single holder ownership",
      value: "52.85%",
      description: "One user holds a large amount of the token supply",
      score: 5285,
      level: "danger",
    },
    { name: "Mutable metadata", value: "", description: "Token metadata can be changed", level: "warn" },
  ],
  score: 6438,
  score_normalised: 44,
  lpLockedPct: 0.014378569295838214,
};

const REPORT = {
  ...SUMMARY,
  totalHolders: 66832,
  rugged: false,
  graphInsidersDetected: 0,
  insiderNetworks: [],
  topHolders: [
    { address: "acc1", owner: "own1", pct: 52.85, insider: false },
    { address: "acc2", owner: "own2", pct: 4.56, insider: true },
    { address: "acc3", owner: "own3", pct: 3.55, insider: false },
  ],
  knownAccounts: {
    acc2: { name: "Streamflow Vault", type: "VAULT" },
    own3: { name: "Meteora DLMM Pool", type: "AMM" },
  },
};

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("lpFraction — the mirror-image zeros bug", () => {
  it("keeps a missing lock percentage missing", () => {
    // Defaulting to 0 would claim "no liquidity is locked" — a severe finding —
    // about a token whose vendor simply did not report the field.
    expect(lpFraction(undefined)).toBeUndefined();
    expect(lpFraction(NaN)).toBeUndefined();
  });

  it("preserves a genuine zero, which is a real and bad answer", () => {
    expect(lpFraction(0)).toBe(0);
  });

  it("normalises the vendor's percentage into a fraction", () => {
    expect(lpFraction(45.77)).toBeCloseTo(0.4577, 5);
    expect(lpFraction(100)).toBe(1);
  });

  it("clamps rather than emitting an impossible share", () => {
    expect(lpFraction(140)).toBe(1);
    expect(lpFraction(-5)).toBe(0);
  });
});

describe("levelOf", () => {
  it("narrows the vendor's vocabulary", () => {
    expect(levelOf("danger")).toBe("danger");
    expect(levelOf("warn")).toBe("warn");
    expect(levelOf("warning")).toBe("warn");
  });

  it("treats anything unrecognised as info rather than as safe-by-default", () => {
    expect(levelOf(undefined)).toBe("info");
    expect(levelOf("catastrophic")).toBe("info");
  });
});

describe("RugCheckRiskProvider", () => {
  it("reads the cheap summary by default", async () => {
    const f = mockFetch(SUMMARY);
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT);
    expect(f.mock.calls[0][0]).toContain("/report/summary");
    expect(r?.score).toBe(44);
    expect(r?.detailed).toBe(false);
    expect(r?.lpLockedPct).toBeCloseTo(0.000143786, 8);
  });

  it("leaves insider share unmeasured on the summary endpoint", async () => {
    // The summary carries no graph analysis at all. A zero here would mean
    // "nobody looked" while reading as "nobody found anything".
    mockFetch(SUMMARY);
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT);
    expect(r?.insiderPct).toBeUndefined();
    expect(r?.topHolders).toBeUndefined();
  });

  it("reports insider share only once the graph analysis has run", async () => {
    mockFetch(REPORT);
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.detailed).toBe(true);
    // own2 holds 4.56% and is flagged; nothing else is.
    expect(r?.insiderPct).toBeCloseTo(0.0456, 5);
  });

  it("matches holder labels on EITHER the account or the owner key", async () => {
    // Measured on live data: 12 top holders matched by token-account address
    // and 14 by owner on the same token, with neither a superset of the other.
    // Checking one key would silently halve the label coverage.
    mockFetch(REPORT);
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.topHolders?.[1].label).toBe("Streamflow Vault"); // by address
    expect(r?.topHolders?.[2].label).toBe("Meteora DLMM Pool"); // by owner
    expect(r?.labelledHolders).toBe(2);
  });

  it("reports label COVERAGE instead of a pool-excluded concentration figure", async () => {
    // The tempting derived number. Measured across five trending tokens, the
    // labels covered 12 of 20 top holders on one and ZERO of 20 on two others —
    // including the two largest, whose top holders are plainly pools. A
    // pool-excluded percentage would have claimed 83% wallet concentration for
    // RAY, wrong in exactly the direction that punishes legitimate tokens.
    mockFetch(REPORT);
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r).not.toHaveProperty("top10ExPoolsPct");
    expect(r?.labelledHolders).toBeLessThan(r!.topHolders!.length);
  });

  it("converts holder shares to fractions", async () => {
    mockFetch(REPORT);
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT, true);
    expect(r?.topHolders?.[0].pct).toBeCloseTo(0.5285, 5);
  });
});

describe("riskHeadline — a vendor's opinion, phrased as one", () => {
  it("attributes the score rather than stating it as fact", async () => {
    mockFetch(SUMMARY);
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT);
    const line = riskHeadline(r!);
    expect(line).toContain("rated 44/100 risk by rugcheck");
    expect(line).toContain("1 critical");
    expect(line).toContain("1 warning");
  });

  it("omits the LP figure entirely when it was not reported", async () => {
    mockFetch({ ...SUMMARY, lpLockedPct: undefined });
    const r = await new RugCheckRiskProvider().getTokenRisk(MINT);
    expect(riskHeadline(r!)).not.toContain("LP");
  });
});
