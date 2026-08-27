import { describe, it, expect } from "vitest";
import { DemoStore } from "@/lib/demo/store";
import { runBacktest, DEFAULT_BACKTEST } from "@/lib/engine/backtest";

/**
 * The backtester's job is to be pessimistic in the places a backtest is
 * tempted to be generous. These are the two places.
 *
 * Prices here are hourly candles, so between two samples there is no way to
 * know whether the stop or the target came first. Booking a stop at exactly
 * the stop price when the hour opened well below it, or crediting a target
 * with a gap it did not sit still for, both turn a losing rule into a winning
 * chart. Neither is allowed to happen again without a test failing.
 */
describe("backtest exit fills", () => {
  const seeds = [77, 1234, 2026];

  it("never fills a stop above the stop price", () => {
    for (const seed of seeds) {
      const store = new DemoStore(seed);
      const r = runBacktest(store, DEFAULT_BACKTEST);
      for (const t of r.trades) {
        if (t.exitReason !== "stop") continue;
        const stopPrice = t.entryPrice * (1 - DEFAULT_BACKTEST.stopLossPct / 100);
        // Floating-point room only; a fill above the stop is free money.
        expect(t.exitPrice).toBeLessThanOrEqual(stopPrice * 1.000001);
      }
    }
  });

  it("never credits a target with more than the target", () => {
    for (const seed of seeds) {
      const store = new DemoStore(seed);
      const r = runBacktest(store, DEFAULT_BACKTEST);
      for (const t of r.trades) {
        if (t.exitReason !== "target") continue;
        const targetPrice = t.entryPrice * (1 + DEFAULT_BACKTEST.takeProfitPct / 100);
        expect(t.exitPrice).toBeLessThanOrEqual(targetPrice * 1.000001);
      }
    }
  });

  it("counts a stop that gapped through as gapped", () => {
    for (const seed of seeds) {
      const store = new DemoStore(seed);
      const r = runBacktest(store, DEFAULT_BACKTEST);
      const gapped = r.trades.filter((t) => {
        if (t.exitReason !== "stop") return false;
        const stopPrice = t.entryPrice * (1 - DEFAULT_BACKTEST.stopLossPct / 100);
        return t.exitPrice < stopPrice * 0.999999;
      }).length;
      expect(r.gappedExits).toBe(gapped);
    }
  });

  it("sees the intra-hour range, not only the close", () => {
    // A run that only ever compared closing prices would miss every barrier
    // touched and given back inside an hour. Across three worlds at a 40%
    // target, at least one such exit has to exist — if none does, the range is
    // not being read.
    let barrierExits = 0;
    for (const seed of seeds) {
      const store = new DemoStore(seed);
      const r = runBacktest(store, DEFAULT_BACKTEST);
      barrierExits += r.trades.filter((t) => t.exitReason !== "time").length;
    }
    expect(barrierExits).toBeGreaterThan(0);
  });
});

/**
 * The attribution is the thing that keeps a good return here from reading as a
 * performance claim: this market is generated, and the features the engine
 * scores are generated from the same archetype label it is effectively
 * recovering. If the breakdown ever stops adding up to the trades it describes,
 * it has become decoration.
 */
describe("backtest attribution", () => {
  const store = new DemoStore(1234);
  const result = runBacktest(store, DEFAULT_BACKTEST);

  it("accounts for every trade exactly once", () => {
    const counted = result.attribution.reduce((a, x) => a + x.trades, 0);
    expect(counted).toBe(result.trades.length);
  });

  it("accounts for every dollar", () => {
    const counted = result.attribution.reduce((a, x) => a + x.pnlUsd, 0);
    const actual = result.trades.reduce((a, t) => a + t.pnlUsd, 0);
    expect(counted).toBeCloseTo(actual, 1);
  });

  it("separates the archetypes the generator planted", () => {
    // The point of the panel is that the scores are not flat across kinds of
    // token. A rug and a moonshot scoring alike would mean the engine is
    // reading noise; scoring differently is what makes the return a statement
    // about label recovery rather than about markets.
    const scores = result.attribution.filter((a) => a.candidates >= 20).map((a) => a.meanScore);
    expect(scores.length).toBeGreaterThan(1);
    expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThan(10);
  });
});
