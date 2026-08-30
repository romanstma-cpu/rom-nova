// Triage exists to keep two things apart on a token too young to have a
// record: "we looked and it is fine" and "nobody has looked yet". Every
// assertion below guards one specific way those could be confused.
//
// The measured failures these tests encode:
//
//   RugCheck answered a 7-second-old mint in 130ms with `risks: []` and
//   `score_normalised: 1`. Read literally that is the safest token on Solana.
//
//   It reported `lpLockedPct: 100` on nineteen of twenty-four fresh mints and
//   0 on five, while reporting 0.04 for PUMP ($41.9M liquidity) and 0.01 for
//   TRUMP ($51.0M). Rendered as a percentage bar, that column is inverted.
//
//   "Single holder ownership [danger]" was the most common finding on fresh
//   mints. On a bonding curve, that single holder is the curve.

import { describe, it, expect } from "vitest";
import {
  DEAD_MINT_RATE,
  INDUSTRIAL_DEPLOYER_MINTS,
  onBondingCurve,
  triageHeadline,
  triageLaunch,
} from "@/lib/engine/triage";
import type { LaunchObservation } from "@/lib/types";
import type { TokenRisk } from "@/lib/providers/types";

/** A brand-new pump.fun mint with everything the listing actually carries. */
function fresh(over: Partial<LaunchObservation> = {}): LaunchObservation {
  return {
    mint: "CTPoyCwkjMvoJwU4xvZZqoD8tiYk6yDchySiN5gGpump",
    name: "fone",
    symbol: "fone",
    hue: 100,
    decimals: 6,
    poolCreatedAt: 1_700_000_000_000,
    firstSeenAt: 1_700_000_002_500,
    event: "pool",
    launchpad: "pump.fun",
    venue: "pump.fun",
    dev: "devWallet1111111111111111111111111111111111",
    devMints: 1,
    devMigrations: 0,
    priceUsd: 0.0000031,
    liquidityUsd: 3_284,
    holders: 5,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    authorityKnown: true,
    source: "jupiter",
    ...over,
  };
}

function risk(over: Partial<TokenRisk> = {}): TokenRisk {
  return { mint: "m", source: "rugcheck", score: 1, risks: [], detailed: false, ...over };
}

const stateOf = (l: LaunchObservation, r?: TokenRisk) => (key: string) =>
  triageLaunch(l, r).checks.find((c) => c.key === key)!;

describe("there is no clean bill of health", () => {
  it("never reaches a positive verdict, even with every check passing", () => {
    const t = triageLaunch(
      fresh({ launchpad: undefined, venue: undefined, top10Pct: 0.1, devHoldsPct: 0.01 }),
      risk({ lpLockedPct: 1 }),
    );
    expect(t.checks.every((c) => c.state === "pass")).toBe(true);
    // The ceiling. `unverified` is as good as a launch gets, and the verdict
    // vocabulary contains no third option above it.
    expect(t.verdict).toBe("unverified");
  });

  it("treats an empty vendor risk list as silence, not as absolution", () => {
    // The exact payload measured on a 7-second-old mint.
    const t = triageLaunch(fresh({ devHoldsPct: undefined }), risk({ score: 1, risks: [], lpLockedPct: 100 }));
    expect(t.verdict).toBe("unverified");
    // And it must SAY what did not run rather than counting silence as a pass.
    expect(t.unchecked).toBeGreaterThan(0);
    expect(triageHeadline(t)).toContain("not checked");
  });

  it("reports the check counts in the headline, never a bare verdict", () => {
    const t = triageLaunch(fresh());
    expect(triageHeadline(t)).toMatch(/\d+ of \d+ checks could run/);
  });
});

describe("absent authority data fails safe", () => {
  it("grades an unaudited mint as NOT revoked", () => {
    const at = stateOf(fresh({ authorityKnown: false, mintAuthorityRevoked: false }));
    expect(at("mint_authority").state).toBe("fail");
    expect(at("freeze_authority").state).toBe("fail");
  });

  it("marks that grade as assumed rather than measured", () => {
    // The state is correct to act on and wrong to describe as a reading. A feed
    // that cannot tell "authority is LIVE" from "nobody audited it" cries wolf
    // on every unindexed mint.
    const at = stateOf(fresh({ authorityKnown: false }));
    expect(at("mint_authority").assumed).toBe(true);
    expect(at("mint_authority").detail).toMatch(/nobody has actually looked/i);
  });

  it("does not mark a real reading as assumed", () => {
    const at = stateOf(fresh({ authorityKnown: true, mintAuthorityRevoked: false }));
    expect(at("mint_authority").state).toBe("fail");
    expect(at("mint_authority").assumed).toBeUndefined();
  });
});

describe("LP lock is answered only where it means something", () => {
  it("refuses to answer for a token still on its bonding curve", () => {
    // The 100 measured on nineteen of twenty-four fresh mints is the curve, and
    // rendering it as a pass would be the single most misleading cell here.
    const c = stateOf(fresh(), risk({ lpLockedPct: 1 }))("lp_locked");
    expect(onBondingCurve(fresh())).toBe(true);
    expect(c.state).toBe("n/a");
    expect(c.detail).toMatch(/bonding curve/i);
  });

  it("refuses equally when the same source reports zero", () => {
    // Five of the twenty-four came back 0. Failing those would be just as wrong
    // as passing the hundreds: neither number describes a withdrawable pool.
    const c = stateOf(fresh(), risk({ lpLockedPct: 0 }))("lp_locked");
    expect(c.state).toBe("n/a");
  });

  it("answers once the token has graduated to a real pool", () => {
    const graduated = fresh({ graduatedAt: 1_700_000_500_000 });
    expect(onBondingCurve(graduated)).toBe(false);
    expect(stateOf(graduated, risk({ lpLockedPct: 0.02 }))("lp_locked").state).toBe("fail");
    expect(stateOf(graduated, risk({ lpLockedPct: 1 }))("lp_locked").state).toBe("pass");
  });

  it("stays unchecked rather than passing when no grader answered", () => {
    const graduated = fresh({ graduatedAt: 1_700_000_500_000 });
    expect(stateOf(graduated, risk({ lpLockedPct: undefined }))("lp_locked").state).toBe("unchecked");
    expect(stateOf(graduated)("lp_locked").state).toBe("unchecked");
  });
});

describe("concentration is answered only where it describes wallets", () => {
  it("refuses on a bonding curve, where the top holder is the curve", () => {
    const c = stateOf(fresh({ top10Pct: 1 }))("top_holders");
    expect(c.state).toBe("n/a");
  });

  it("grades it once there is a real cap table, with the pool caveat attached", () => {
    const g = fresh({ graduatedAt: 1_700_000_500_000, top10Pct: 0.9 });
    const c = stateOf(g)("top_holders");
    expect(c.state).toBe("fail");
    expect(c.detail).toMatch(/AMM pool accounts/i);
  });
});

describe("creator history, calibrated against the measured population", () => {
  it("fails an industrial deployer", () => {
    const c = stateOf(fresh({ devMints: INDUSTRIAL_DEPLOYER_MINTS, devMigrations: 40 }))("creator_history");
    expect(c.state).toBe("fail");
  });

  it("fails a high-volume deployer whose mints never reach a pool", () => {
    // 68 of 5,623 = 1.2%, measured. A count with no graduations is a pipeline.
    const c = stateOf(fresh({ devMints: 5_623, devMigrations: 68 }))("creator_history");
    expect(68 / 5_623).toBeLessThan(DEAD_MINT_RATE);
    expect(c.state).toBe("fail");
  });

  it("only warns at the median deployer, because the median is 75 mints", () => {
    // Failing here would mark half of every page AVOID and train the reader to
    // ignore the verdict within an hour.
    const c = stateOf(fresh({ devMints: 75, devMigrations: 20 }))("creator_history");
    expect(c.state).toBe("warn");
    expect(triageLaunch(fresh({ devMints: 75, devMigrations: 20 })).verdict).toBe("caution");
  });

  it("passes a first mint without calling it safe", () => {
    const c = stateOf(fresh({ devMints: 1 }))("creator_history");
    expect(c.state).toBe("pass");
    expect(c.detail).toMatch(/not the same as a clean one/i);
  });

  it("leaves it unchecked when the source said nothing", () => {
    // Absent must never read as "first-time creator" — that is the reassuring
    // interpretation of a token nobody audited.
    expect(stateOf(fresh({ devMints: undefined }))("creator_history").state).toBe("unchecked");
  });
});

describe("vendor findings are not double counted", () => {
  const rugger = risk({
    score: 65,
    risks: [
      { name: "Creator history of rugged tokens", level: "danger", detail: "Creator has a history of rugging tokens." },
    ],
  });

  it("attributes a rug history to exactly one check", () => {
    const t = triageLaunch(fresh(), rugger);
    const failed = t.checks.filter((c) => c.state === "fail").map((c) => c.key);
    // The first version failed creator_history, rug_history AND vendor_flags on
    // this one fact, so a single finding read as "3 failed".
    expect(failed).toEqual(["rug_history"]);
    expect(t.verdict).toBe("avoid");
  });

  it("does not fail on a high vendor score alone", () => {
    // The score is dominated by whichever risk fired, so triggering on it means
    // counting the same evidence twice.
    const t = triageLaunch(fresh(), risk({ score: 65, risks: [] }));
    expect(t.checks.find((c) => c.key === "vendor_flags")!.state).toBe("pass");
    expect(t.verdict).toBe("unverified");
  });

  it("ignores concentration and liquidity findings while on a curve", () => {
    // Measured: "Single holder ownership [danger]" was the most common finding
    // on fresh mints, and "Low Liquidity" fires on every pump.fun launch
    // because they all start near $3.2k. Neither says anything about the token.
    const noisy = risk({
      score: 58,
      risks: [
        { name: "Single holder ownership", level: "danger", detail: "" },
        { name: "High holder concentration", level: "warn", detail: "" },
        { name: "Low Liquidity", level: "danger", detail: "" },
        { name: "Large Amount of LP Unlocked", level: "danger", detail: "" },
      ],
    });
    expect(triageLaunch(fresh(), noisy).checks.find((c) => c.key === "vendor_flags")!.state).toBe("pass");
  });

  it("still surfaces those findings once there is a real pool", () => {
    const graduated = fresh({ graduatedAt: 1_700_000_500_000 });
    const r = risk({ score: 58, risks: [{ name: "Low Liquidity", level: "danger", detail: "" }] });
    expect(triageLaunch(graduated, r).checks.find((c) => c.key === "vendor_flags")!.state).toBe("fail");
  });

  it("surfaces a genuinely new finding as its own failure", () => {
    const r = risk({ score: 30, risks: [{ name: "Copycat token", level: "warn", detail: "" }] });
    const c = triageLaunch(fresh(), r).checks.find((x) => x.key === "vendor_flags")!;
    expect(c.state).toBe("warn");
    expect(c.detail).toContain("Copycat token");
  });

  it("fails on the listing source's own suspicion bit", () => {
    expect(triageLaunch(fresh({ sus: true }), risk()).verdict).toBe("avoid");
  });
});

describe("n/a is not counted as verification", () => {
  it("excludes structurally-inapplicable checks from the measured count", () => {
    // "6 of 8 checks could run" must not become "8 of 8" by counting the two
    // the bonding curve makes unanswerable.
    const t = triageLaunch(fresh({ devHoldsPct: 0.03 }), risk());
    const na = t.checks.filter((c) => c.state === "n/a").length;
    expect(na).toBe(2);
    expect(t.measured).toBe(t.total - na - t.unchecked);
  });
});
