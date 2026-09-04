// The Radar pipeline end to end: launch in, trades in, effects out.
// RadarState is the worker's whole decision path with the I/O stripped off,
// so this file is the closest thing to running the worker in a bottle.

import { beforeEach, describe, expect, it } from "vitest";
import { applyFill } from "../src/lib/radar/engine/score.js";
import { RadarState } from "../src/lib/radar/engine/state.js";

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
  mint?: string;
  sol?: number;
  launchAgeMs?: number | null;
  trade?: { buy_or_sell: string; venue: string; signature: string | null };
  signal?: {
    wallet_address: string;
    wallet_score: number;
    token_name: string | null;
    buy_amount_sol: number;
    price_at_signal: number;
    signal_key: string;
  };
  row?: { wallet_address: string; score: number; follow_ret_5m: number | null; median_hold_ms: number | null; signals_graded: number };
  // signal_outcome
  signal_key?: string;
  horizon?: string;
  ret?: number;
  peak_ret?: number;
  stale?: boolean;
  done?: boolean;
  // exit
  fraction?: number | null;
  first?: boolean;
  after_ms?: number;
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

// ---------------------------------------------------------------------------
// The copy desk: signals get graded from the stream that produced them, and
// the wallet's exit is heard.

/** A wallet with six settled winners: score 100, well past every gate. */
function prove(address: string): void {
  const w = state.tracked.get(address)!;
  for (let i = 0; i < 6; i++) {
    applyFill(w, { mint: `P${i}`, isBuy: true, sol: 10, tokens: 1000, ts: T0 + i * 10 });
    applyFill(w, { mint: `P${i}`, isBuy: false, sol: 25, tokens: 1000, ts: T0 + i * 10 + 5 });
  }
}

const SIG_AT = T0 + 90_000;

/** Discovery, proof, and one signal buy on MINT2 at 0.01 SOL/token. Returns the signal effect. */
function fireSignal(): Effect {
  state.onLaunch({ mint: "MINT1" }, T0);
  state.onTrade(fill()); // discovery
  prove("WHALE1");
  state.onLaunch({ mint: "MINT2", name: "Next" }, T0 + 60_000);
  effects = [];
  state.onTrade(fill({ mint: "MINT2", sol: 4, tokens: 400, priceSol: 0.01, chainTs: SIG_AT, signature: "sig-signal" }));
  return effects.find((e) => e.kind === "signal")!;
}

/** Someone else trading MINT2 — a price mark, never a whale (dust, and past the window). */
const mark = (priceSol: number, chainTs: number, n: number) =>
  fill({ user: "RANDO", mint: "MINT2", sol: 0.2, tokens: 0.2 / priceSol, priceSol, chainTs, signature: `mark-${n}` });

describe("signal grading", () => {
  it("stamps the signal with its fill price and a key", () => {
    const s = fireSignal().signal!;
    expect(s.price_at_signal).toBeCloseTo(0.01, 9);
    expect(s.signal_key).toBe(`WHALE1:MINT2:${new Date(SIG_AT).toISOString()}`);
  });

  it("grades each horizon at the first trade at or after it, and folds +5m into the wallet", () => {
    fireSignal();
    effects = [];
    state.onTrade(mark(0.012, SIG_AT + 61_000, 1));
    let out = effects.filter((e) => e.kind === "signal_outcome");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ horizon: "m1", ret: 0.2, stale: false, done: false, wallet: "WHALE1", mint: "MINT2" });

    effects = [];
    state.onTrade(mark(0.015, SIG_AT + 301_000, 2));
    out = effects.filter((e) => e.kind === "signal_outcome");
    expect(out[0]).toMatchObject({ horizon: "m5", ret: 0.5, peak_ret: 0.5 });
    const walletEffect = effects.find((e) => e.kind === "wallet" && e.row?.wallet_address === "WHALE1");
    expect(walletEffect?.row?.follow_ret_5m).toBeCloseTo(0.5, 4);
    expect(walletEffect?.row?.signals_graded).toBe(1);

    effects = [];
    state.onTrade(mark(0.009, SIG_AT + 901_000, 3));
    expect(effects.find((e) => e.kind === "signal_outcome")).toMatchObject({ horizon: "m15", ret: -0.1, peak_ret: 0.5 });

    effects = [];
    state.onTrade(mark(0.02, SIG_AT + 3_601_000, 4));
    expect(effects.find((e) => e.kind === "signal_outcome")).toMatchObject({ horizon: "h1", ret: 1, peak_ret: 1, done: true });
    // Nothing left to grade, nothing pinned: the mint is forgotten.
    expect(state.watched.has("MINT2")).toBe(false);
    expect(state.counts.graded).toBe(4);
  });

  it("marks a horizon to the last trade seen when the token goes quiet, and says so", () => {
    fireSignal();
    state.onTrade(mark(0.02, SIG_AT + 30_000, 1));
    effects = [];
    state.tick(SIG_AT + 60_000 + 44_000); // inside the grace: nothing yet
    expect(effects.some((e) => e.kind === "signal_outcome")).toBe(false);
    state.tick(SIG_AT + 60_000 + 46_000);
    const out = effects.find((e) => e.kind === "signal_outcome");
    expect(out).toMatchObject({ horizon: "m1", ret: 1, stale: true });
  });

  it("grades flat and stale when no trade ever followed the signal", () => {
    fireSignal();
    effects = [];
    state.tick(SIG_AT + 3_600_000 + 60_000);
    const outs = effects.filter((e) => e.kind === "signal_outcome");
    expect(outs.map((o) => o.horizon)).toEqual(["m1", "m5", "m15", "h1"]);
    expect(outs.every((o) => o.ret === 0 && o.stale)).toBe(true);
  });

  it("resumes a journaled signal with its resolved horizons skipped", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    state.onTrade(fill());
    prove("WHALE1");
    state.registerSignal(
      { signal_key: "k1", wallet_address: "WHALE1", token_address: "MINT2" },
      SIG_AT,
      0.01,
      { resolved: { m1: true, m5: true }, peak: 0.03 },
    );
    effects = [];
    state.onTrade(mark(0.011, SIG_AT + 3_601_000, 1));
    const outs = effects.filter((e) => e.kind === "signal_outcome");
    expect(outs.map((o) => o.horizon)).toEqual(["m15", "h1"]);
    expect(outs[1]).toMatchObject({ signal_key: "k1", ret: 0.1, peak_ret: 2, done: true });
  });
});

describe("exits", () => {
  it("hears the signal wallet sell, sized by what it held, and stops after it is flat", () => {
    fireSignal();
    effects = [];
    state.onTrade(fill({ mint: "MINT2", isBuy: false, sol: 3, tokens: 200, priceSol: 0.015, chainTs: SIG_AT + 120_000, signature: "x1" }));
    const first = effects.find((e) => e.kind === "exit");
    expect(first).toMatchObject({ signal_key: `WHALE1:MINT2:${new Date(SIG_AT).toISOString()}`, fraction: 0.5, ret: 0.5, first: true, after_ms: 120_000 });

    effects = [];
    state.onTrade(fill({ mint: "MINT2", isBuy: false, sol: 3, tokens: 200, priceSol: 0.015, chainTs: SIG_AT + 130_000, signature: "x2" }));
    const second = effects.find((e) => e.kind === "exit");
    expect(second).toMatchObject({ fraction: 1, first: false });

    effects = [];
    state.onTrade(fill({ mint: "MINT2", isBuy: false, sol: 1, tokens: 100, priceSol: 0.015, chainTs: SIG_AT + 140_000, signature: "x3" }));
    expect(effects.some((e) => e.kind === "exit")).toBe(false);
    expect(state.counts.exits).toBe(2);
  });

  it("a sell with no signal behind it is not an exit", () => {
    state.onLaunch({ mint: "MINT1" }, T0);
    state.onTrade(fill());
    effects = [];
    state.onTrade(fill({ isBuy: false, sol: 5, tokens: 500, chainTs: T0 + 40_000, signature: "plain-sell" }));
    expect(effects.some((e) => e.kind === "exit")).toBe(false);
  });

  it("drops an exit watch after a day", () => {
    fireSignal();
    state.tick(SIG_AT + 25 * 3_600_000);
    expect(state.openSignals.has("WHALE1:MINT2")).toBe(false);
  });
});

describe("pinned mints", () => {
  it("keeps the last price of a followed mint until unpinned", () => {
    state.pinMint("M9");
    expect(state.lastPrice("M9")).toBeNull();
    state.onTrade(fill({ user: "ANY", mint: "M9", sol: 0.1, tokens: 10, priceSol: 0.01, chainTs: T0 + 5000, signature: "p1" }));
    expect(state.lastPrice("M9")).toEqual({ priceSol: 0.01, at: T0 + 5000 });
    state.pinMint("M9", false);
    expect(state.lastPrice("M9")).toBeNull();
  });
});

describe("marks from outside the stream", () => {
  it("asks for a lookup when a horizon passed with no trade since, and for quiet pinned mints", () => {
    fireSignal();
    expect(state.marksWanted(SIG_AT + 30_000)).toEqual([]);
    // One minute on, nothing traded since the signal: the mint wants a mark.
    expect(state.marksWanted(SIG_AT + 61_000)).toEqual(["MINT2"]);
    // A trade at the horizon satisfies it.
    state.onTrade(mark(0.011, SIG_AT + 62_000, 1));
    expect(state.marksWanted(SIG_AT + 63_000)).toEqual([]);
    // A pinned mint quiet for half a minute wants one too.
    state.pinMint("M9");
    state.onTrade(fill({ user: "ANY", mint: "M9", sol: 0.1, tokens: 10, priceSol: 0.01, chainTs: SIG_AT + 63_000, signature: "p1" }));
    expect(state.marksWanted(SIG_AT + 70_000)).toEqual([]);
    expect(state.marksWanted(SIG_AT + 63_000 + 31_000)).toEqual(["M9"]);
  });

  it("resolves due horizons from an external quote, tagged as a lookup, never as stale", () => {
    fireSignal();
    effects = [];
    state.markExternal("MINT2", 0.02, SIG_AT + 301_000);
    const outs = effects.filter((e) => e.kind === "signal_outcome");
    expect(outs.map((o) => o.horizon)).toEqual(["m1", "m5"]);
    expect(outs[1]).toMatchObject({ ret: 1, stale: false, source: "lookup" });
    expect(state.lastPrice("MINT2")).toEqual({ priceSol: 0.02, at: SIG_AT + 301_000 });
    // A stream trade at the horizon is tagged as such.
    effects = [];
    state.onTrade(mark(0.03, SIG_AT + 901_000, 1));
    expect(effects.find((e) => e.kind === "signal_outcome")).toMatchObject({ horizon: "m15", source: "stream", stale: false });
    // And the tick's fallback says last-mark.
    effects = [];
    state.tick(SIG_AT + 3_600_000 + 46_000);
    expect(effects.find((e) => e.kind === "signal_outcome")).toMatchObject({ horizon: "h1", source: "last-mark", stale: true, ret: 2 });
  });

  it("ignores a lookup older than the last trade seen", () => {
    fireSignal();
    state.onTrade(mark(0.03, SIG_AT + 10_000, 1));
    state.markExternal("MINT2", 0.001, SIG_AT + 5_000);
    expect(state.lastPrice("MINT2")).toEqual({ priceSol: 0.03, at: SIG_AT + 10_000 });
  });
});

describe("marksFromBody", () => {
  it("takes the deepest SOL-quoted pair per mint and skips the rest", async () => {
    const { marksFromBody } = await import("../src/lib/radar/engine/pricelookup.js");
    const WSOL = "So11111111111111111111111111111111111111112";
    const body = {
      pairs: [
        { chainId: "solana", baseToken: { address: "A" }, quoteToken: { address: WSOL }, priceNative: "0.002", liquidity: { usd: 1000 } },
        { chainId: "solana", baseToken: { address: "A" }, quoteToken: { address: WSOL }, priceNative: "0.003", liquidity: { usd: 50_000 } },
        { chainId: "solana", baseToken: { address: "A" }, quoteToken: { address: "USDC" }, priceNative: "0.5", liquidity: { usd: 90_000 } },
        { chainId: "ethereum", baseToken: { address: "B" }, quoteToken: { address: WSOL }, priceNative: "1" },
        { chainId: "solana", baseToken: { address: "C" }, quoteToken: { address: WSOL }, priceNative: "0" },
      ],
    };
    const marks = marksFromBody(body, ["A", "B", "C", "D"]);
    expect([...marks.entries()]).toEqual([["A", 0.003]]);
    expect(marksFromBody(null, ["A"]).size).toBe(0);
  });
});
