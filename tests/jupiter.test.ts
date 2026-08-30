// The Jupiter adapter's job is not "return numbers" — it is to be honest about
// which numbers it got. The version this replaced defaulted every gap:
// devHoldsPct 0, bundlerPct 0, insiderPct 0, and an organicScore that fell back
// to a hardcoded 50 when the field was missing. Each reads to the scorer as a
// measurement, and each was a fact nobody looked up.

import { describe, it, expect } from "vitest";
import { accelFromPct, toInfo, toSnapshot } from "@/lib/providers/jupiter";

/** A response with everything present, shaped like a real trending row. */
const FULL = {
  id: "CTPoyCwkjMvoJwU4xvZZqoD8tiYk6yDchySiN5gGpump",
  name: "fone",
  symbol: "fone",
  decimals: 6,
  dev: "devWallet1111111111111111111111111111111111",
  holderCount: 25058,
  organicScore: 93.42784810897427,
  organicScoreLabel: "high",
  isVerified: true,
  fdv: 21_250_898,
  mcap: 21_250_898,
  usdPrice: 0.021462711572674896,
  liquidity: 1_490_572,
  launchpad: "pump.fun",
  graduatedAt: "2026-08-27T00:03:44Z",
  audit: {
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPercentage: 11.116642949388448,
    devBalancePercentage: 2.5,
    devMigrations: 1,
    devMints: 1,
  },
  stats1h: { priceChange: 12.92, volumeChange: 87.25, numBuys: 3583, numSells: 3454, numTraders: 1255 },
  stats5m: { priceChange: 0.62 },
  stats6h: { volumeChange: 40 },
  stats24h: { priceChange: 30, holderChange: 5.5, liquidityChange: -12, buyVolume: 1000, sellVolume: 500 },
  firstPool: { createdAt: "2026-08-27T00:02:12Z" },
};

/** The same token as a bare listing — the shape that used to become zeros. */
const SPARSE = {
  id: "So11111111111111111111111111111111111111112",
  name: "Wrapped SOL",
  symbol: "SOL",
  decimals: 9,
  usdPrice: 180,
};

describe("jupiter — absence is declared, never defaulted", () => {
  it("declares every field a sparse payload did not carry", () => {
    const s = toSnapshot(SPARSE);
    const u = s.unmeasured ?? [];
    for (const f of [
      "top10Pct",
      "devHoldsPct",
      "holders",
      "organicScore",
      "momentum",
      "volumeAccel",
      "socialScore",
      "insiderPct",
      "bundlerPct",
      "sniperPct",
      // The LP provider count is in no Jupiter payload at any depth, and a
      // zero there reads as "one party holds the pool, they can withdraw it".
      "lpProviders",
      // Nor the deployer's other mints on a payload with no audit block. A
      // devMints of zero reads as "first mint from this deployer — no track
      // record either way", which is a claim about a wallet nobody looked up.
      "devHistory",
    ]) {
      expect(u, `${f} must be declared unmeasured`).toContain(f);
    }
  });

  // THE ZEROS BUG INSIDE THE SCORER, on the population the app exists for.
  //
  // `liquidity: m.liquidity ?? 0` in the snapshot builder, against
  // `liquidityUsd: m.liquidity` twelve lines down in the LAUNCH builder, which
  // renders "the source has not priced this pool yet". One field, two
  // behaviours, one file — and only the coerced one reached the score.
  //
  // Measured on 747MxrN9…pump at one minute old: Liquidity Quality -16.4 for
  // "$0 pooled" while Jupiter's API was reporting liquidity=3160.13 for that
  // same mint. Every new mint's score was depressed by ~16 points.
  it("declares an unpriced pool instead of scoring it as zero", () => {
    const fresh = { ...FULL, liquidity: undefined };
    const s = toSnapshot(fresh);
    expect(s.unmeasured ?? []).toContain("liquidity");
    // The field is not optional, so the value stays a number — the DECLARATION
    // is what makes it inert, not the value.
    expect(s.liquidityUsd).toBe(0);
    // A real pool must not be declared away.
    expect(toSnapshot(FULL).unmeasured ?? []).not.toContain("liquidity");
    expect(toSnapshot(FULL).liquidityUsd).toBe(1_490_572);
  });

  it("declares the 24h changes a token minutes old cannot have", () => {
    // "liquidity +0.0% vs 24h ago" and "holders +0.0% over 24h" on a four
    // minute old mint are measurements of a period that has not happened.
    const s = toSnapshot({ ...FULL, stats24h: { priceChange: 30 } });
    expect(s.unmeasured ?? []).toContain("liquidityChange");
    expect(s.unmeasured ?? []).toContain("holderGrowth");
    // And where the source DOES publish them, they are measurements.
    const full = toSnapshot(FULL).unmeasured ?? [];
    expect(full).not.toContain("liquidityChange");
    expect(full).not.toContain("holderGrowth");
  });

  it("stops calling the deployer history unmeasured once the audit carries it", () => {
    expect(toSnapshot(FULL).unmeasured ?? []).not.toContain("devHistory");
    // But the LP provider count is never Jupiter's to answer.
    expect(toSnapshot(FULL).unmeasured ?? []).toContain("lpProviders");
  });

  it("carries all four activity windows, and omits the ones it was not given", () => {
    // The block DEX Screener and Photon lead with, already in this payload and
    // thrown away: the page surfaced it only as a derived "imbalance %".
    const w = toSnapshot(FULL).windows!;
    expect(w["1h"]).toEqual({
      buys: 3583,
      sells: 3454,
      traders: 1255,
      buyVolumeUsd: undefined,
      sellVolumeUsd: undefined,
    });
    expect(w["24h"]?.buyVolumeUsd).toBe(1000);
    // stats5m carried only a price change, so it contributes no trade window.
    expect(w["5m"]).toBeUndefined();
    expect(toSnapshot(SPARSE).windows).toBeUndefined();
  });

  it("never invents an average organic score", () => {
    // The old adapter used `(m.organicScore ?? 50) / 100`, handing the scorer a
    // dead-centre 0.5 for a token nobody had assessed. A zero paired with a
    // declaration is safe; an undeclared 0.5 is a fabricated middle opinion.
    const s = toSnapshot(SPARSE);
    expect(s.organicScore).toBe(0);
    expect(s.unmeasured).toContain("organicScore");
  });

  it("declares nothing it actually received", () => {
    const u = toSnapshot(FULL).unmeasured ?? [];
    for (const f of ["top10Pct", "devHoldsPct", "holders", "organicScore", "momentum", "volumeAccel"]) {
      expect(u, `${f} was present and must not be declared missing`).not.toContain(f);
    }
  });

  it("still declares what no Jupiter payload can carry", () => {
    // numTraders is a count of traders, not a buyer/seller split, and a net
    // buyer figure cannot be unpacked into two counts without inventing one.
    const u = toSnapshot(FULL).unmeasured ?? [];
    expect(u).toContain("uniqueBuyers1h");
    expect(u).toContain("uniqueSellers1h");
    expect(u).toContain("socialScore");
  });

  it("converts published percentages into the fractions the engine stores", () => {
    const s = toSnapshot(FULL);
    expect(s.top10Pct).toBeCloseTo(0.111166, 5);
    expect(s.devHoldsPct).toBeCloseTo(0.025, 5);
    expect(s.organicScore).toBeCloseTo(0.934278, 5);
  });

  it("uses genuine 1h trade counts rather than a 24h figure divided down", () => {
    // The old adapter did `Math.round(numBuys / 24)`, which reports a token's
    // AVERAGE hour as though it were this one — the opposite of what a scanner
    // is for. A quiet token mid-spike looked identical to a busy one going flat.
    const s = toSnapshot(FULL);
    expect(s.buys1h).toBe(3583);
    expect(s.sells1h).toBe(3454);
  });

  it("carries interval stats so momentum survives without candles", () => {
    const s = toSnapshot(FULL);
    expect(s.momentum1h).toBeCloseTo(12.92, 5);
    expect(s.momentum24h).toBeCloseTo(30, 5);
    expect(s.holderGrowthPct).toBeCloseTo(5.5, 5);
    expect(s.liquidityChangePct).toBeCloseTo(-12, 5);
  });
});

describe("accelFromPct", () => {
  it("maps 'unchanged' to the 1.0 the scorer reads as a normal rate", () => {
    expect(accelFromPct(0)).toBe(1);
  });

  it("floors at 0.1 so a total collapse cannot produce log2(0)", () => {
    // volumeAccel is read through Math.log2. Without the floor a -100% change
    // yields -Infinity and poisons the entire weighted mean.
    expect(accelFromPct(-100)).toBe(0.1);
    expect(Number.isFinite(Math.log2(accelFromPct(-100)!))).toBe(true);
  });

  it("returns undefined rather than a neutral 1.0 for a missing field", () => {
    expect(accelFromPct(undefined)).toBeUndefined();
    expect(accelFromPct(NaN)).toBeUndefined();
  });
});

describe("jupiter — creator history and launch context", () => {
  it("carries the launchpad and the creator's mint count", () => {
    const i = toInfo(FULL);
    expect(i.launchpad).toBe("pump.fun");
    expect(i.devMints).toBe(1);
    expect(i.devMigrations).toBe(1);
    expect(i.graduatedAt).toBe(Date.parse("2026-08-27T00:03:44Z"));
  });

  it("leaves creator history undefined when the audit did not run", () => {
    // Absent must not read as "first-time creator" — that is the reassuring
    // interpretation of a token nobody audited.
    const i = toInfo(SPARSE);
    expect(i.devMints).toBeUndefined();
    expect(i.devMigrations).toBeUndefined();
    expect(i.launchpad).toBeUndefined();
  });

  it("grades an unaudited mint as NOT revoked", () => {
    const i = toInfo(SPARSE);
    expect(i.mintAuthorityRevoked).toBe(false);
    expect(i.freezeAuthorityRevoked).toBe(false);
  });
});
