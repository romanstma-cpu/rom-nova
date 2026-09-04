// The Radar pipeline end to end: launch in, trades in, effects out.
// RadarState is the worker's whole decision path with the I/O stripped off,
// so this file is the closest thing to running the worker in a bottle.

import { beforeEach, describe, expect, it } from "vitest";
import { applyFill } from "../worker/src/score.js";
import { RadarState } from "../worker/src/state.js";

const GATES = {
  whaleThresholdSol: 10,
  whaleWindowMs: 10 * 60_000,
  signalMinScore: 70,
  signalMinSettled: 3,
  signalMinBuySol: 1,
};

const T0 = 1_788_000_000_000;

/** The effect union onEffect fans out — typed loosely but without `any`. */
interface Effect {
  kind: string;
  wallet?: string;
  sol?: number;
  launchAgeMs?: number | null;
  trade?: { buy_or_sell: string; venue: string; signature: string | null };
  signal?: { wallet_address: string; wallet_score: number; token_name: string | null; buy_amount_sol: number };
  row?: { wallet_address: string; score: number };
}

let effects: Effect[] = [];
let state: RadarState;

interface FillShape {
  mint: string;
  user: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  priceSol: number;
  chainTs: number;
  vSol: number;
  signature: string;
}

const fill = (over: Partial<FillShape> = {}): FillShape => ({
  mint: "MINT1",
  user: "WHALE1",
  isBuy: true,
  sol: 12,
  tokens: 1000,
  priceSol: 0.012,
  chainTs: T0 + 30_000,
  vSol: 40,
  signature: "sig-" + Math.random().toString(36).slice(2),
  ...over,
});

beforeEach(() => {
  effects = [];
  state = new RadarState(GATES, 200, (e) => effects.push(e));
});

const kinds = () => effects.map((e) => e.kind);

describe("RadarState pipeline", () => {
  it("emits one launch effect per new mint and ignores repeats", () => {
    state.onLaunch({ mint: "MINT1", name: "Test", symbol: "TST", vSol: 30 }, T0);
    state.onLaunch({ mint: "MINT1" }, T0 + 5);
    expect(kinds()).toEqual(["launch"]);
    expect(state.counts.launches).toBe(1);
  });

  it("discovers a whale on a threshold buy into a seen launch, then journals it", () => {
    state.onLaunch({ mint: "MINT1", name: "Test" }, T0);
    state.onTrade(fill());
    expect(kinds()).toEqual(["launch", "whale", "trade", "wallet"]);
    const whale = effects[1];
    expect(whale.wallet).toBe("WHALE1");
    expect(whale.sol).toBe(12);
    expect(whale.launchAgeMs).toBe(30_000);
    expect(state.tracked.has("WHALE1")).toBe(true);
    const trade = effects[2].trade!;
    expect(trade.buy_or_sell).toBe("buy");
    expect(trade.venue).toBe("pumpfun");
    expect(trade.signature).toBeTruthy();
  });

  it("ignores big buys into launches it never saw", () => {
    state.onTrade(fill({ mint: "UNSEEN" }));
    expect(effects).toEqual([]);
  });

  it("ignores trades by wallets it does not track", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    state.onTrade(fill({ sol: 2, user: "SMALLFRY" })); // under the whale gate
    expect(kinds()).toEqual(["launch"]);
  });

  it("dedupes the same fill arriving from two streams", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    const f = fill({ signature: "SAME" });
    state.onTrade(f);
    state.onTrade({ ...f });
    expect(effects.filter((e) => e.kind === "trade")).toHaveLength(1);
  });

  it("keeps a same-signature buy and sell distinct — one-transaction arbs keep both legs", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    state.onTrade(fill({ signature: "SAME" }));
    state.onTrade(fill({ signature: "SAME", isBuy: false, sol: 13 }));
    expect(effects.filter((e) => e.kind === "trade")).toHaveLength(2);
  });

  it("fires a signal only on the score the wallet had BEFORE the buy", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    state.onTrade(fill()); // discovery
    // Prove the wallet by feeding its ledger six settled winners directly.
    const w = state.tracked.get("WHALE1")!;
    for (let i = 0; i < 6; i++) {
      applyFill(w, { mint: `P${i}`, isBuy: true, sol: 10, tokens: 1000, ts: T0 + i * 10 });
      applyFill(w, { mint: `P${i}`, isBuy: false, sol: 25, tokens: 1000, ts: T0 + i * 10 + 5 });
    }
    effects = [];
    state.onLaunch({ mint: "MINT2", name: "Next" }, T0 + 60_000);
    state.onTrade(fill({ mint: "MINT2", sol: 4, chainTs: T0 + 90_000, signature: "sig-next" }));
    const signal = effects.find((e) => e.kind === "signal")?.signal;
    expect(signal).toBeTruthy();
    expect(signal!.wallet_address).toBe("WHALE1");
    expect(signal!.token_name).toBe("Next");
    expect(signal!.buy_amount_sol).toBe(4);
    expect(signal!.wallet_score).toBeGreaterThan(70);
    expect(state.counts.signals).toBe(1);
  });

  it("does not signal an unproven wallet, however fresh its discovery", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    state.onTrade(fill()); // discovery buy — score is still 0
    expect(effects.some((e) => e.kind === "signal")).toBe(false);
  });

  it("evicts the longest-idle wallet past the cap", () => {
    const tiny = new RadarState(GATES, 2, () => {});
    tiny.onLaunch({ mint: "M1" }, T0);
    tiny.onTrade(fill({ user: "W1", mint: "M1", chainTs: T0 + 1000, signature: "a" }));
    tiny.onTrade(fill({ user: "W2", mint: "M1", chainTs: T0 + 2000, signature: "b" }));
    tiny.onTrade(fill({ user: "W3", mint: "M1", chainTs: T0 + 3000, signature: "c" }));
    expect(tiny.tracked.has("W1")).toBe(false);
    expect(tiny.tracked.size).toBe(2);
  });

  it("ranks the leaderboard by score, then activity", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    state.onTrade(fill({ user: "W1", signature: "s1" }));
    state.onTrade(fill({ user: "W2", signature: "s2", chainTs: T0 + 31_000 }));
    const w2 = state.tracked.get("W2")!;
    applyFill(w2, { mint: "X", isBuy: true, sol: 10, tokens: 100, ts: T0 });
    applyFill(w2, { mint: "X", isBuy: false, sol: 30, tokens: 100, ts: T0 + 1 });
    const top = state.top(10);
    expect(top[0].wallet_address).toBe("W2");
    expect(top[0].score).toBeGreaterThan(0);
  });
});
