// The Radar's two gates, cornered.

import { describe, expect, it } from "vitest";
import { isSignalBuy, isWhaleBuy } from "../worker/src/classify.js";

const GATES = {
  whaleThresholdSol: 10,
  whaleWindowMs: 10 * 60_000,
  signalMinScore: 70,
  signalMinSettled: 3,
  signalMinBuySol: 1,
};

const T0 = 1_788_000_000_000;

describe("isWhaleBuy", () => {
  const buy = (sol: number, atMs: number) => ({ isBuy: true, sol, chainTs: atMs });

  it("passes a threshold buy inside the window of a seen launch", () => {
    expect(isWhaleBuy(buy(10, T0 + 60_000), T0, GATES)).toBe(true);
  });

  it("rejects below the threshold", () => {
    expect(isWhaleBuy(buy(9.99, T0 + 60_000), T0, GATES)).toBe(false);
  });

  it("rejects sells regardless of size — exiting big is not entering", () => {
    expect(isWhaleBuy({ isBuy: false, sol: 500, chainTs: T0 + 60_000 }, T0, GATES)).toBe(false);
  });

  it("rejects a mint whose launch was never seen", () => {
    expect(isWhaleBuy(buy(50, T0), undefined, GATES)).toBe(false);
  });

  it("rejects past the window", () => {
    expect(isWhaleBuy(buy(50, T0 + 10 * 60_000 + 1), T0, GATES)).toBe(false);
  });

  it("tolerates a slightly negative age — the push clock can beat the chain clock", () => {
    expect(isWhaleBuy(buy(50, T0 - 2_000), T0, GATES)).toBe(true);
  });
});

describe("isSignalBuy", () => {
  const buy = { isBuy: true, sol: 5 };

  it("fires for a proven wallet buying meaningfully", () => {
    expect(isSignalBuy(buy, { score: 71, settledSells: 6 }, GATES)).toBe(true);
  });

  it("never fires for an untracked wallet", () => {
    expect(isSignalBuy(buy, undefined, GATES)).toBe(false);
  });

  it("requires the score STRICTLY above the gate", () => {
    expect(isSignalBuy(buy, { score: 70, settledSells: 6 }, GATES)).toBe(false);
  });

  it("requires the settled floor even if a score sneaks high", () => {
    expect(isSignalBuy(buy, { score: 90, settledSells: 2 }, GATES)).toBe(false);
  });

  it("ignores dust buys from proven wallets", () => {
    expect(isSignalBuy({ isBuy: true, sol: 0.5 }, { score: 90, settledSells: 9 }, GATES)).toBe(false);
  });

  it("never fires on a sell", () => {
    expect(isSignalBuy({ isBuy: false, sol: 50 }, { score: 90, settledSells: 9 }, GATES)).toBe(false);
  });
});
