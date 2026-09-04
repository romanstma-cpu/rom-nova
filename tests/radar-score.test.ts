// The Radar worker's ledger: average-cost PNL over observed fills only,
// the unmeasured-sell refusal, and the sample-size-shrunk score.

import { describe, expect, it } from "vitest";
import {
  applyFill,
  avgRoiOf,
  FULL_CONFIDENCE_SELLS,
  newWallet,
  profitFactorOf,
  scoreOf,
  walletRow,
  winRateOf,
} from "../worker/src/score.js";

const T0 = 1_788_000_000_000;
const buy = (mint: string, sol: number, tokens: number, ts = T0) => ({ mint, isBuy: true, sol, tokens, ts });
const sell = (mint: string, sol: number, tokens: number, ts = T0 + 1000) => ({ mint, isBuy: false, sol, tokens, ts });

describe("applyFill", () => {
  it("realizes profit against average cost", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000)); // 0.01 SOL per token
    const r = applyFill(w, sell("A", 15, 1000));
    expect(r.settled).toBe(true);
    expect(r.realized).toBeCloseTo(5, 9);
    expect(w.wins).toBe(1);
    expect(w.realizedSol).toBeCloseTo(5, 9);
    expect(w.grossProfitSol).toBeCloseTo(5, 9);
  });

  it("averages the cost across multiple buys", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000)); // 0.010
    applyFill(w, buy("A", 30, 1000)); // avg now 0.020
    const r = applyFill(w, sell("A", 30, 1000));
    expect(r.realized).toBeCloseTo(30 - 20, 9);
  });

  it("books a loss on the loss side, positive", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000));
    const r = applyFill(w, sell("A", 4, 1000));
    expect(r.realized).toBeCloseTo(-6, 9);
    expect(w.grossLossSol).toBeCloseTo(6, 9);
    expect(w.wins).toBe(0);
  });

  it("refuses to score a sell with no observed buys behind it", () => {
    const w = newWallet(T0);
    const r = applyFill(w, sell("A", 50, 1000));
    expect(r.settled).toBe(false);
    expect(r.realized).toBeNull();
    expect(w.unmeasuredSells).toBe(1);
    expect(w.realizedSol).toBe(0);
  });

  it("treats a partially-covered sell as unmeasured WHOLE — no half-guessed basis", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000));
    const r = applyFill(w, sell("A", 40, 2000)); // sold twice what we saw bought
    expect(r.settled).toBe(false);
    expect(w.unmeasuredSells).toBe(1);
    expect(w.settledSells).toBe(0);
  });

  it("keeps working per-mint — positions do not bleed into each other", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000));
    applyFill(w, buy("B", 5, 500));
    applyFill(w, sell("A", 20, 1000));
    expect(w.settledSells).toBe(1);
    expect(w.realizedSol).toBeCloseTo(10, 9);
    expect(w.positions.get("B")!.heldTok).toBeCloseTo(500, 9);
  });

  it("counts every fill in totalTrades, settled or not", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000));
    applyFill(w, sell("B", 5, 100)); // unmeasured
    expect(w.totalTrades).toBe(2);
  });
});

describe("scoreOf", () => {
  const winner = (settles: number) => {
    const w = newWallet(T0);
    for (let i = 0; i < settles; i++) {
      applyFill(w, buy(`M${i}`, 10, 1000, T0 + i * 10));
      applyFill(w, sell(`M${i}`, 25, 1000, T0 + i * 10 + 5)); // 150% ROI every time
    }
    return w;
  };

  it("is 0 with nothing settled, whatever was journaled", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 100, 1000));
    expect(scoreOf(w)).toBe(0);
  });

  it("shrinks by sample size: two perfect exits cannot cross a 70 gate", () => {
    expect(scoreOf(winner(2))).toBeLessThan(70);
  });

  it("reaches full confidence at FULL_CONFIDENCE_SELLS settled sells", () => {
    const full = winner(FULL_CONFIDENCE_SELLS);
    expect(scoreOf(full)).toBeGreaterThan(70);
    expect(scoreOf(full)).toBeLessThanOrEqual(100);
    // More of the same record must not score lower.
    expect(scoreOf(winner(FULL_CONFIDENCE_SELLS + 4))).toBeGreaterThanOrEqual(scoreOf(full));
  });

  it("caps profit factor at 99 when there are no losses", () => {
    expect(profitFactorOf(winner(3))).toBe(99);
  });

  it("scores a chronic loser near zero even with many settles", () => {
    const w = newWallet(T0);
    for (let i = 0; i < 10; i++) {
      applyFill(w, buy(`M${i}`, 10, 1000, T0 + i * 10));
      applyFill(w, sell(`M${i}`, 5, 1000, T0 + i * 10 + 5));
    }
    expect(winRateOf(w)).toBe(0);
    expect(scoreOf(w)).toBe(0);
  });
});

describe("walletRow", () => {
  it("maps the ledger to the tracked_wallets columns, honesty fields included", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000));
    applyFill(w, sell("A", 15, 1000, T0 + 5000));
    applyFill(w, sell("B", 3, 10, T0 + 6000)); // unmeasured
    const row = walletRow("WALLET", w);
    expect(row.wallet_address).toBe("WALLET");
    expect(row.total_trades).toBe(3);
    expect(row.settled_sells).toBe(1);
    expect(row.unmeasured_sells).toBe(1);
    expect(row.realized_pnl).toBeCloseTo(5, 6);
    expect(row.win_rate).toBeCloseTo(1, 4);
    expect(row.avg_roi).toBeCloseTo(0.5, 4);
    expect(row.first_seen).toBe(new Date(T0).toISOString());
    expect(row.last_active).toBe(new Date(T0 + 6000).toISOString());
    expect(avgRoiOf(w)).toBeCloseTo(0.5, 9);
  });
});
