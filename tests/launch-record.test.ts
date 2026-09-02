// The launch record: what the feed saw, resolved later, and refused early.
//
// Pinned against a fake lookup on a fake clock: a row is recorded with the
// verdict it was shown with, the verdict settles when the risk read lands,
// the first price inside two minutes counts and a later one does not, a
// graduation the feed itself sees is an outcome with no lookup, horizons
// resolve inside their window and expire outside it, a mint the lookup no
// longer lists is dead rather than missing, and no rate prints below thirty.

import { describe, it, expect, beforeEach } from "vitest";
import type { TokenLaunch } from "@/lib/types";
import {
  applyLookup,
  clearLaunchRecord,
  dueNow,
  launchSnapshot,
  noteLaunchMerged,
  resetLaunchRecord,
  setLaunchLookup,
  tickLaunchRecord,
  RESOLVE_EVERY_MS,
} from "@/lib/launch-record/store";
import {
  ALIVE_LIQUIDITY_USD,
  LAUNCH_MIN_RESOLVED,
  deployerBucket,
  graduatedWithin24h,
  launchReport,
} from "@/lib/launch-record/report";

const T0 = 1_700_000_000_000;
const H = 3_600_000;

function row(over: Partial<TokenLaunch> & { mint: string }): TokenLaunch {
  return {
    name: over.mint,
    symbol: over.mint.slice(0, 4),
    hue: 0,
    decimals: 6,
    firstSeenAt: T0,
    event: "pool",
    launchpad: "pump.fun",
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: false,
    authorityKnown: false,
    source: "jupiter",
    triage: { verdict: "unverified", checks: [], measured: 2, readings: 2, total: 8, unchecked: 3 },
    ...over,
  } as TokenLaunch;
}

beforeEach(() => resetLaunchRecord());

describe("recording", () => {
  it("writes a new row down with the verdict it was shown with, unsettled until the risk read lands", () => {
    noteLaunchMerged(row({ mint: "A", devMints: 1, priceUsd: 0.001 }), true, T0);
    const o = launchSnapshot().obs[0];
    expect(o.verdict).toBe("unverified");
    expect(o.settled).toBe(false);
    expect(o.priceUsd).toBe(0.001);
    expect(o.priceAt).toBe(T0);
    // The risk read lands and the verdict moves: the settled one is kept.
    noteLaunchMerged(row({ mint: "A", triage: { verdict: "avoid", checks: [], measured: 3, readings: 2, total: 8, unchecked: 2, riskScore: 71 } }), false, T0 + 5_000);
    const s = launchSnapshot().obs[0];
    expect(s.settled).toBe(true);
    expect(s.verdict).toBe("avoid");
    expect(s.riskScore).toBe(71);
    // A later change is ignored — the settled verdict is what a reader acted on.
    noteLaunchMerged(row({ mint: "A", triage: { verdict: "caution", checks: [], measured: 3, readings: 2, total: 8, unchecked: 2, riskScore: 40 } }), false, T0 + 60_000);
    expect(launchSnapshot().obs[0].verdict).toBe("avoid");
  });

  it("settles on time even when no risk read ever lands", () => {
    noteLaunchMerged(row({ mint: "B" }), true, T0);
    noteLaunchMerged(row({ mint: "B" }), false, T0 + 30_000);
    expect(launchSnapshot().obs[0].settled).toBe(false);
    noteLaunchMerged(row({ mint: "B" }), false, T0 + 95_000);
    expect(launchSnapshot().obs[0].settled).toBe(true);
  });

  it("takes the first price inside two minutes as the price at first sight, and refuses a later one", () => {
    noteLaunchMerged(row({ mint: "C" }), true, T0);
    noteLaunchMerged(row({ mint: "C", priceUsd: 0.002 }), false, T0 + 60_000);
    expect(launchSnapshot().obs[0].priceUsd).toBe(0.002);
    expect(launchSnapshot().obs[0].priceAt).toBe(T0 + 60_000);
    noteLaunchMerged(row({ mint: "D" }), true, T0);
    noteLaunchMerged(row({ mint: "D", priceUsd: 0.5 }), false, T0 + 10 * 60_000);
    expect(launchSnapshot().obs.find((o) => o.mint === "D")!.priceUsd).toBeUndefined();
  });

  it("a graduation the feed itself sees is an outcome, with no lookup", () => {
    noteLaunchMerged(row({ mint: "E" }), true, T0);
    noteLaunchMerged(row({ mint: "E", event: "graduation", gradSeenAt: T0 + 40 * 60_000 }), false, T0 + 40 * 60_000);
    const o = launchSnapshot().obs[0];
    expect(o.graduatedAt).toBe(T0 + 40 * 60_000);
    expect(graduatedWithin24h(o)).toBe(true);
  });

  it("does not double-record a mint the feed merges twice as new", () => {
    noteLaunchMerged(row({ mint: "F" }), true, T0);
    noteLaunchMerged(row({ mint: "F" }), true, T0 + 1);
    expect(launchSnapshot().obs).toHaveLength(1);
  });
});

describe("resolving", () => {
  it("is due inside the window, expired outside it, and never twice", () => {
    noteLaunchMerged(row({ mint: "G" }), true, T0);
    expect(dueNow(T0 + 30 * 60_000).due).toEqual([]);
    expect(dueNow(T0 + H + 1).due).toEqual([{ mint: "G", horizon: "1h" }]);
    // Apply, then it is no longer due.
    applyLookup([{ mint: "G", horizon: "1h" }], new Map([["G", { priceUsd: 1, liquidityUsd: 5_000 }]]), T0 + H + 1);
    expect(dueNow(T0 + H + 2).due).toEqual([]);
    // 24h: the app was closed until far past the tolerance — expired, not stretched.
    const r = dueNow(T0 + 3 * 24 * H);
    expect(r.due).toEqual([]);
    expect(r.expired).toBe(1);
    expect(launchSnapshot().obs[0].expired).toEqual(["24h"]);
  });

  it("a mint the lookup no longer lists is recorded as unlisted, not skipped", () => {
    noteLaunchMerged(row({ mint: "H" }), true, T0);
    applyLookup([{ mint: "H", horizon: "1h" }], new Map(), T0 + H + 1);
    const o = launchSnapshot().obs[0];
    expect(o.outcomes).toEqual([{ horizon: "1h", at: T0 + H + 1, listed: false, priceUsd: undefined, liquidityUsd: undefined, graduatedAt: undefined }]);
  });

  it("the tick is rate-gated and batches through the supplied lookup", async () => {
    const asked: string[][] = [];
    setLaunchLookup(async (mints) => {
      asked.push(mints);
      return new Map(mints.map((m) => [m, { priceUsd: 2, liquidityUsd: 10_000, graduatedAt: T0 + 30 * 60_000 }]));
    });
    for (let k = 0; k < 5; k++) noteLaunchMerged(row({ mint: `M${k}`, priceUsd: 1 }), true, T0);
    await tickLaunchRecord(T0 + H + 1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(5);
    expect(launchSnapshot().obs.every((o) => o.outcomes.length === 1 && o.graduatedAt === T0 + 30 * 60_000)).toBe(true);
    // Inside the gate: nothing more is asked even though nothing is due anyway.
    await tickLaunchRecord(T0 + H + RESOLVE_EVERY_MS / 2);
    expect(asked).toHaveLength(1);
    expect(launchSnapshot().lookups).toBe(1);
  });
});

describe("report: the floor, the buckets, the fates", () => {
  it("refuses a rate below the floor and says how many of thirty it has", () => {
    for (let k = 0; k < 5; k++) {
      noteLaunchMerged(row({ mint: `U${k}` }), true, T0);
      applyLookup([{ mint: `U${k}`, horizon: "24h" }], new Map([[`U${k}`, { liquidityUsd: 5_000 }]]), T0 + 24 * H + 1);
    }
    const rep = launchReport(launchSnapshot().obs, T0 + 24 * H + 2);
    const u = rep.byVerdict.find((b) => b.bucket === "unverified")!;
    expect(u.resolved24h).toBe(5);
    expect(u.enough24h).toBe(false);
    expect(rep.verdict).toContain(`5 of the ${LAUNCH_MIN_RESOLVED}`);
  });

  it("counts graduation, survival and return per bucket once the floor is cleared", () => {
    const n = LAUNCH_MIN_RESOLVED;
    for (let k = 0; k < n; k++) {
      const mint = `V${k}`;
      noteLaunchMerged(row({ mint, priceUsd: 1, devMints: 1 }), true, T0 + k);
      const graduated = k % 3 === 0;
      const alive = k % 2 === 0;
      applyLookup(
        [{ mint, horizon: "24h" }],
        alive
          ? new Map([[mint, { priceUsd: k % 4 === 0 ? 3 : 0.5, liquidityUsd: ALIVE_LIQUIDITY_USD + 1, graduatedAt: graduated ? T0 + k + H : undefined }]])
          : new Map(),
        T0 + 24 * H + 100,
      );
    }
    const rep = launchReport(launchSnapshot().obs, T0 + 24 * H + 200);
    const u = rep.byVerdict.find((b) => b.bucket === "unverified")!;
    expect(u.enough24h).toBe(true);
    expect(u.resolved24h).toBe(n);
    expect(u.alive24h).toBe(15);
    // Graduation is only visible on rows the lookup still listed here.
    expect(u.graduated24h).toBe([...Array(n).keys()].filter((k) => k % 3 === 0 && k % 2 === 0).length);
    expect(u.priced24h).toBe(15);
    expect(u.aboveWater24h).toBeCloseTo(8 / 15, 6);
    expect(rep.byDeployer[0].bucket).toBe("first mint");
    expect(rep.verdict).toContain("UNVERIFIED");
    expect(rep.verdict).toContain("One bucket has cleared the floor");
  });

  it("buckets deployers by history and keeps unknown separate from first", () => {
    expect(deployerBucket(undefined)).toBe("deployer history unknown");
    expect(deployerBucket(0)).toBe("first mint");
    expect(deployerBucket(1)).toBe("first mint");
    expect(deployerBucket(2)).toBe("repeat deployer (2–49)");
    expect(deployerBucket(50)).toBe("serial deployer (50+)");
  });

  it("counts pending and expired horizons and clears cleanly", () => {
    noteLaunchMerged(row({ mint: "W" }), true, T0);
    const early = launchReport(launchSnapshot().obs, T0 + 10);
    expect(early.pending).toBe(2);
    expect(early.expired).toBe(0);
    const late = launchReport(launchSnapshot().obs, T0 + 10 * 24 * H);
    expect(late.expired).toBe(2);
    clearLaunchRecord();
    expect(launchSnapshot().obs).toHaveLength(0);
    expect(launchReport([], T0).verdict).toContain("Nothing recorded yet");
  });
});
