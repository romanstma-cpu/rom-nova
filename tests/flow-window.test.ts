// One engine, one stated window per number.
//
// The whole-build review (M2) found every simulated signal's invalidation line
// saying "a ten-minute chain scan, not a 6h window" while the feature snapshot
// seven lines below it was captioned "whale net 6h" — and the snapshot was
// right: `extractFeatures` computes the flow fields over a trailing six hours.
// The live copy had been applied to both paths.
//
// Now the window travels on the vector and every sentence reads it from there.

import { describe, it, expect } from "vitest";
import { DemoStore } from "@/lib/demo/store";
import { computeSignal, scoreFeatures } from "@/lib/engine/signals";
import { extractFeatures, DEMO_FLOW_WINDOW_MS } from "@/lib/engine/features";
import { flowWindowLabel, isChainScanWindow } from "@/lib/engine/flow-window";
import type { FeatureVector } from "@/lib/types";

const store = new DemoStore(77);
const now = store.universe.genesis;
const mint = store.tokenList()[0].info.mint;

/** A vector shaped like the live path produces: a short chain scan. */
function liveShaped(over: Partial<FeatureVector> = {}): FeatureVector {
  return {
    ...extractFeatures(store, mint, now)!,
    whaleNetFlowUsd: 120_000,
    whaleBuys: 3,
    whaleSells: 1,
    flowWindowMs: 10 * 60_000,
    unmeasured: ["smartMoney"],
    ...over,
  };
}

describe("flowWindowLabel — says the window, whatever it is", () => {
  it("prints hours for a trailing window and minutes for a scan", () => {
    expect(flowWindowLabel(6 * 3_600_000)).toBe("6h");
    expect(flowWindowLabel(10 * 60_000)).toBe("10 min");
    // A byte-budgeted read that stopped at 4.2 minutes covered 4.2, not four.
    expect(flowWindowLabel(4.2 * 60_000)).toBe("4.2 min");
    expect(flowWindowLabel(1.5 * 3_600_000)).toBe("1.5h");
  });

  it("refuses to name a window nobody read", () => {
    expect(flowWindowLabel(undefined)).toBe("no window");
    expect(flowWindowLabel(0)).toBe("no window");
  });

  it("knows a scan from a trailing read", () => {
    expect(isChainScanWindow(10 * 60_000)).toBe(true);
    expect(isChainScanWindow(6 * 3_600_000)).toBe(false);
    expect(isChainScanWindow(undefined)).toBe(false);
  });
});

describe("the simulator's vector carries its own six-hour window", () => {
  it("stamps the window it computed over", () => {
    const f = extractFeatures(store, mint, now)!;
    expect(f.flowWindowMs).toBe(DEMO_FLOW_WINDOW_MS);
    expect(DEMO_FLOW_WINDOW_MS).toBe(6 * 3_600_000);
  });

  it("names six hours in the invalidation copy and never calls it a ten-minute scan", () => {
    const s = computeSignal(store, mint, now, "balanced")!;
    const whaleLine = s.invalidation.find((i) => /whale netflow/.test(i));
    expect(whaleLine).toBeTruthy();
    expect(whaleLine).toMatch(/6h/);
    expect(whaleLine).not.toMatch(/ten-minute|10 min|chain scan/);
  });

  it("names the same window in the smart-money factor's explanation", () => {
    const s = computeSignal(store, mint, now, "balanced")!;
    const sm = s.factors.find((x) => x.key === "smart_money")!;
    // Only when there was activity to describe; the empty case has no window.
    if (s.features.smartMoneyWallets > 0) expect(sm.explanation).toMatch(/in 6h$/);
  });
});

describe("a live-shaped vector says chain scan, and how long", () => {
  it("names the scan and disowns the six-hour reading", () => {
    const s = scoreFeatures(liveShaped(), mint, now, "balanced");
    const whaleLine = s.invalidation.find((i) => /whale netflow/.test(i))!;
    expect(whaleLine).toMatch(/10 min chain scan/);
    expect(whaleLine).toMatch(/not a six-hour window/);
  });

  it("reports the window actually covered when the read was truncated", () => {
    const s = scoreFeatures(liveShaped({ flowWindowMs: 4.2 * 60_000 }), mint, now, "balanced");
    const whaleLine = s.invalidation.find((i) => /whale netflow/.test(i))!;
    expect(whaleLine).toMatch(/4\.2 min chain scan/);
  });

  it("keeps the watch condition, with its window, when the scan held no whale", () => {
    const s = scoreFeatures(liveShaped({ unmeasured: ["smartMoney", "whaleFlow"] }), mint, now, "balanced");
    const line = s.invalidation.find((i) => /whale flow becomes observable/.test(i))!;
    expect(line).toMatch(/10 min chain window/);
  });

  // A condition nobody can observe does not belong on a list of things to
  // watch for — the same rule the smart-money line already follows.
  it("omits the whale line entirely when no flow source read anything", () => {
    const s = scoreFeatures(
      liveShaped({ unmeasured: ["smartMoney", "whaleFlow"], flowWindowMs: undefined }),
      mint,
      now,
      "balanced",
    );
    expect(s.invalidation.some((i) => /whale/.test(i))).toBe(false);
  });
});
