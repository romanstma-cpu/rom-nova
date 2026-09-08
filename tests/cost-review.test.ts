import { describe, expect, it } from "vitest";
import { costReview } from "@/lib/engine/cost-review";
import type { Observation } from "@/lib/engine/track-record";

const first: Observation = { mint: "test", symbol: "TEST", ts: 1000, score: 75, confidence: .8, priceUsd: 100, profile: "balanced", unmeasuredCount: 0 };
const later = { ...first, ts: 3_601_000, priceUsd: 101 };
describe("after-cost research", () => {
  it("turns a small gross gain into a loss after costs", () => {
    const r = costReview([first, later], "1h", "70+", 2, later.ts);
    expect(r.grossMeanPct).toBeCloseTo(1);
    expect(r.netMeanPct).toBeCloseTo(-1.02);
    expect(r.positiveRate).toBe(0);
    expect(r.enough).toBe(false);
  });
  it("does not substitute zero for missing or unmeasured outcomes", () => {
    expect(costReview([], "1h", "70+", 2).netMeanPct).toBeNull();
    expect(costReview([{ ...first, unmeasuredCount: 2 }, later], "1h", "70+", 2, later.ts).count).toBe(0);
  });
  it("counts correlated token observations as one pass", () => {
    const r = costReview([first, later, { ...first, mint: "second" }, { ...later, mint: "second" }], "1h", "70+", 0, later.ts);
    expect(r.count).toBe(2); expect(r.passes).toBe(1);
  });
  it.each([NaN, Infinity, -1, 100])("refuses invalid costs %s", cost => {
    expect(() => costReview([], "1h", "70+", cost)).toThrow();
  });
});
