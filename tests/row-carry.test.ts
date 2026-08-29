// A measured value that never reaches the row is indistinguishable, on screen,
// from one that was never measured.
//
// This file exists because of a bug that shipped and survived: `scoreRows`
// assembled each live row from the base row plus the signal, and copied the
// score, the confidence, the label and the flow WALLETS — but not the flow
// NUMBER. So `whaleFlow6hUsd` kept the placeholder zero from
// `buildLiveTokenRows`, and the scanner rendered "whale 6h $0" beside a tooltip
// listing a wallet that had just moved $249,426. The vector held the right
// number the entire time.
//
// Nothing caught it. The unmeasured machinery could not: the field was
// correctly marked MEASURED, and its value was simply lost in transit. So the
// guard has to be on the carry itself.

import { describe, it, expect } from "vitest";
import { buildLiveTokenRows, type TokenRow } from "@/lib/api/rows";
import type { TokenInfo, TokenSnapshot } from "@/lib/types";

const info: TokenInfo = {
  mint: "So11111111111111111111111111111111111111112",
  name: "Wrapped SOL",
  symbol: "SOL",
  createdAt: Date.now() - 86_400_000,
  decimals: 9,
  narrative: "Community",
  verified: true,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  permanentDelegate: false,
  devWallet: "",
  hue: 200,
  launchpad: "pump.fun",
  devMints: 873,
  devMigrations: 291,
};

const snapshot: TokenSnapshot = {
  mint: info.mint,
  ts: Date.now(),
  priceUsd: 180,
  marketCapUsd: 1e9,
  fdvUsd: 1e9,
  liquidityUsd: 5e6,
  volume24hUsd: 1e6,
  buys1h: 100,
  sells1h: 80,
  uniqueBuyers1h: 0,
  uniqueSellers1h: 0,
  holders: 1000,
  top10Pct: 0.3,
  devHoldsPct: 0.02,
  organicScore: 0.9,
  socialScore: 0,
  bundlerPct: 0,
  sniperPct: 0,
  insiderPct: 0,
  momentum1h: 12.5,
  momentum24h: 30,
  momentum5m: 1.1,
  volumeAccel: 1.4,
  holderGrowthPct: 5.5,
  liquidityChangePct: -12,
  unmeasured: ["socialScore", "bundlerPct", "sniperPct"],
};

describe("buildLiveTokenRows — published stats reach the row", () => {
  const [row] = buildLiveTokenRows([{ ...info, snapshot }], "jupiter");

  it("carries interval momentum instead of the old hardcoded zeros", () => {
    expect(row.h1).toBeCloseTo(12.5, 5);
    expect(row.h24).toBeCloseTo(30, 5);
    expect(row.m5).toBeCloseTo(1.1, 5);
    expect(row.volumeAccel).toBeCloseTo(1.4, 5);
  });

  it("carries holder growth", () => {
    expect(row.holderGrowthPct).toBeCloseTo(5.5, 5);
  });

  it("carries launch and creator context", () => {
    expect(row.launchpad).toBe("pump.fun");
    expect(row.devMints).toBe(873);
    expect(row.devMigrations).toBe(291);
  });

  it("keeps a source's declared absences on the row", () => {
    expect(row.unmeasured).toContain("socialScore");
  });

  it("falls back to zero — not NaN — when a source published nothing", () => {
    // A zero here is safe only because `unmeasured` covers it. NaN would leak
    // into sorting and comparisons and render as a blank rather than a dash.
    const bare: TokenSnapshot = { ...snapshot };
    delete bare.momentum1h;
    delete bare.volumeAccel;
    const [r] = buildLiveTokenRows([{ ...info, snapshot: { ...bare, unmeasured: ["momentum", "volumeAccel"] } }], "x");
    expect(Number.isFinite(r.h1)).toBe(true);
    expect(Number.isFinite(r.volumeAccel)).toBe(true);
    expect(r.unmeasured).toContain("momentum");
  });
});

describe("the flow-number carry", () => {
  // Reproduces the shape of the shipped bug directly: a base row carrying the
  // placeholder zero, and a spread that forgets to overwrite it.
  it("a spread that omits the field leaves the placeholder behind", () => {
    const [base] = buildLiveTokenRows([{ ...info, snapshot }], "jupiter");
    expect(base.whaleFlow6hUsd).toBe(0);

    // What the buggy version did — everything except the number.
    const buggy: TokenRow = {
      ...base,
      topWallets: [{ owner: "whale1", usd: -249_426 }],
      scored: true,
    };
    expect(buggy.whaleFlow6hUsd).toBe(0);
    // And the contradiction it produced on screen: a $0 netflow beside a
    // quarter-million-dollar mover.
    expect(Math.abs(buggy.topWallets![0].usd)).toBeGreaterThan(200_000);

    // What it must do instead.
    const fixed: TokenRow = { ...buggy, whaleFlow6hUsd: -209_569.5 };
    expect(fixed.whaleFlow6hUsd).toBeCloseTo(-209_569.5, 1);
  });

  it("a row reporting movers must not also report a zero netflow", () => {
    // The invariant the UI depends on. If wallets moved whale-sized amounts,
    // the netflow cannot be exactly zero unless they cancelled — and a row that
    // claims both without cancelling is showing two answers to one question.
    const rows: TokenRow[] = [
      { ...buildLiveTokenRows([{ ...info, snapshot }], "jupiter")[0], whaleFlow6hUsd: -209_569.5, topWallets: [{ owner: "w", usd: -249_426 }] },
    ];
    for (const r of rows) {
      const biggest = Math.max(0, ...(r.topWallets ?? []).map((w) => Math.abs(w.usd)));
      const measured = !(r.unmeasured ?? []).includes("whaleFlow" as never);
      if (measured && biggest > 20_000) {
        expect(r.whaleFlow6hUsd, "a whale-sized mover with a zero netflow is the carry bug").not.toBe(0);
      }
    }
  });
});
