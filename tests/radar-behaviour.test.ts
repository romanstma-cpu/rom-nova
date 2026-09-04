// Wallet intelligence: labels earned from fills, consistency and drawdown
// on the realized curve, and the behaviour reads that fire once.

import { describe, expect, it } from "vitest";
import { applyFill, consistencyOf, newWallet, walletRow, avgHoldMs } from "../src/lib/radar/engine/score.js";
import {
  ACCUM_MIN_BUYS,
  classifyWallet,
  detectBehaviour,
  DORMANT_MS,
  WASH_MIN_LEGS,
} from "../src/lib/radar/engine/behaviour.js";
import { RadarState } from "../src/lib/radar/engine/state.js";

const T0 = 1_788_000_000_000;
const buy = (mint: string, sol: number, tokens: number, ts: number) => ({ mint, isBuy: true, sol, tokens, ts });
const sell = (mint: string, sol: number, tokens: number, ts: number) => ({ mint, isBuy: false, sol, tokens, ts });

/** A wallet with n round trips of the given hold, each returning `roi`. */
function tripper(n: number, holdMs: number, roi = 0.5) {
  const w = newWallet(T0);
  for (let i = 0; i < n; i++) {
    const t = T0 + i * 3 * holdMs + 3 * 3_600_000 * i;
    applyFill(w, buy(`M${i}`, 10, 1000, t));
    applyFill(w, sell(`M${i}`, 10 * (1 + roi), 1000, t + holdMs));
  }
  return w;
}

describe("classifyWallet", () => {
  it("earns sniper, flipper and holder from the median settled hold, after three sells", () => {
    expect(classifyWallet(tripper(2, 5_000))).toEqual([]);
    expect(classifyWallet(tripper(3, 5_000))).toEqual(["sniper"]);
    expect(classifyWallet(tripper(3, 10 * 60_000))).toEqual(["flipper"]);
    expect(classifyWallet(tripper(3, 3_600_000))).toEqual([]);
    expect(classifyWallet(tripper(3, 30 * 3_600_000))).toEqual(["holder"]);
  });

  it("marks a dev from what the state knows, and an accumulator from buys with no sell", () => {
    const w = newWallet(T0);
    for (let i = 0; i < ACCUM_MIN_BUYS; i++) applyFill(w, buy("ACC", 2, 100, T0 + i * 60_000));
    expect(classifyWallet(w)).toEqual(["accumulator"]);
    expect(classifyWallet(w, { isDev: true })).toEqual(["dev", "accumulator"]);
    applyFill(w, sell("ACC", 1, 50, T0 + 4 * 60_000));
    expect(classifyWallet(w)).toEqual([]);
  });

  it("marks a distributor when recent sells dominate, and wash-like on flat alternating legs", () => {
    const w = newWallet(T0);
    for (let i = 0; i < 4; i++) applyFill(w, sell(`D${i}`, 1, 10, T0 + i * 1000)); // unmeasured sells, still fills
    expect(classifyWallet(w)).toEqual(["distributor"]);
    const x = newWallet(T0);
    for (let i = 0; i < WASH_MIN_LEGS; i++) {
      applyFill(x, i % 2 === 0 ? buy("W", 1, 100, T0 + i * 30_000) : sell("W", 1, 100, T0 + i * 30_000));
    }
    expect(classifyWallet(x)).toContain("wash-like");
    // The same legs spread over an hour are not a wash read.
    const y = newWallet(T0);
    for (let i = 0; i < WASH_MIN_LEGS; i++) {
      applyFill(y, i % 2 === 0 ? buy("W", 1, 100, T0 + i * 20 * 60_000) : sell("W", 1, 100, T0 + i * 20 * 60_000));
    }
    expect(classifyWallet(y)).not.toContain("wash-like");
  });
});

describe("consistency and drawdown", () => {
  it("needs five settled sells, then reads mean over spread; a flat record has no ratio", () => {
    expect(consistencyOf(tripper(4, 1000))).toBeNull();
    const flat = tripper(5, 1000, 0.5);
    expect(consistencyOf(flat)).toMatchObject({ mean: 0.5, sd: 0, ratio: null });
    const w = newWallet(T0);
    const rois = [0.5, -0.2, 0.3, 0.1, 0.4];
    rois.forEach((r, i) => {
      applyFill(w, buy(`M${i}`, 10, 1000, T0 + i * 10_000));
      applyFill(w, sell(`M${i}`, 10 * (1 + r), 1000, T0 + i * 10_000 + 1000));
    });
    const c = consistencyOf(w)!;
    expect(c.mean).toBeCloseTo(0.22, 6);
    expect(c.ratio).toBeGreaterThan(0.5);
    expect(walletRow("W", w).consistency).toBeCloseTo(c.ratio!, 3);
  });

  it("tracks the deepest fall of realized PNL from its high-water mark", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 10, 1000, T0));
    applyFill(w, sell("A", 20, 1000, T0 + 1)); // +10 → peak 10
    applyFill(w, buy("B", 10, 1000, T0 + 2));
    applyFill(w, sell("B", 4, 1000, T0 + 3)); // −6 → dd 6
    applyFill(w, buy("C", 10, 1000, T0 + 4));
    applyFill(w, sell("C", 7, 1000, T0 + 5)); // −3 → dd 9
    applyFill(w, buy("D", 10, 1000, T0 + 6));
    applyFill(w, sell("D", 30, 1000, T0 + 7)); // +20 → new peak, dd stays 9
    expect(w.maxDrawdownSol).toBeCloseTo(9, 6);
    const row = walletRow("W", w);
    expect(row.max_drawdown_sol).toBeCloseTo(9, 6);
    expect(row.avg_hold_ms).toBe(1);
    expect(avgHoldMs(w)).toBe(1);
    expect(walletRow("W", newWallet(T0)).consistency).toBeNull();
  });
});

describe("detectBehaviour", () => {
  it("fires dormant_buy on a big buy after a week of silence, and only then", () => {
    const w = newWallet(T0);
    applyFill(w, buy("A", 1, 10, T0));
    const prev = w.lastFillTs;
    const late = buy("B", 6, 10, T0 + DORMANT_MS + 1);
    applyFill(w, late);
    expect(detectBehaviour(w, late, prev)).toEqual([{ kind: "dormant_buy", gapMs: DORMANT_MS + 1 }]);
    const small = buy("C", 1, 10, T0 + 2 * DORMANT_MS + 5);
    const prev2 = w.lastFillTs;
    applyFill(w, small);
    expect(detectBehaviour(w, small, prev2)).toEqual([]);
  });

  it("fires accumulation on exactly the third buy, distribution on the third bare sell, wash on the fourth leg", () => {
    const w = newWallet(T0);
    const reads: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = buy("ACC", 1, 10, T0 + i * 1000);
      const prev = w.lastFillTs;
      applyFill(w, f);
      reads.push(...detectBehaviour(w, f, prev).map((r) => r.kind));
    }
    expect(reads).toEqual(["accumulation"]);
    const d = newWallet(T0);
    const dreads: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = sell("DIS", 1, 10, T0 + i * 1000);
      const prev = d.lastFillTs;
      applyFill(d, f);
      dreads.push(...detectBehaviour(d, f, prev).map((r) => r.kind));
    }
    expect(dreads).toEqual(["distribution"]);
    const x = newWallet(T0);
    const xreads: string[] = [];
    for (let i = 0; i < 8; i++) {
      const f = i % 2 === 0 ? buy("W", 1, 100, T0 + i * 30_000) : sell("W", 1, 100, T0 + i * 30_000);
      const prev = x.lastFillTs;
      applyFill(x, f);
      xreads.push(...detectBehaviour(x, f, prev).map((r) => r.kind));
    }
    expect(xreads).toEqual(["wash_like"]);
  });
});

describe("state: dev label and behaviour effects", () => {
  it("labels a tracked wallet that created a launch the radar saw, and emits behaviour effects", () => {
    const effects: { kind: string; behaviour?: string; row?: { labels: string[] } }[] = [];
    const state = new RadarState(
      { whaleThresholdSol: 10, whaleWindowMs: 600_000, signalMinScore: 70, signalMinSettled: 3, signalMinBuySol: 1 },
      200,
      (e) => effects.push(e),
    );
    state.onLaunch({ mint: "MINT1", dev: "WHALE1" }, T0);
    const fill = (over: Record<string, unknown>) => ({
      mint: "MINT1",
      user: "WHALE1",
      isBuy: true,
      sol: 12,
      tokens: 1000,
      priceSol: 0.012,
      chainTs: T0 + 30_000,
      vSol: 40,
      signature: `s${Math.random()}`,
      ...over,
    });
    state.onTrade(fill({}));
    const walletEffect = effects.find((e) => e.kind === "wallet");
    expect(walletEffect?.row?.labels).toEqual(["dev"]);
    // Two more buys of the same mint: accumulation fires once.
    state.onTrade(fill({ chainTs: T0 + 40_000 }));
    state.onTrade(fill({ chainTs: T0 + 50_000 }));
    state.onTrade(fill({ chainTs: T0 + 60_000 }));
    const beh = effects.filter((e) => e.kind === "behaviour").map((e) => e.behaviour);
    expect(beh).toEqual(["accumulation"]);
    expect(state.counts.behaviours).toBe(1);
    expect(state.top(1)[0].labels).toEqual(["dev", "accumulator"]);
  });
});
