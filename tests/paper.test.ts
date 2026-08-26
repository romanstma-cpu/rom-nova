import { describe, it, expect } from "vitest";
import { DemoStore } from "@/lib/demo/store";
import { enforceStops, maxOrderUsd, placeOrder } from "@/lib/engine/paper";

/** A store with one portfolio holding a position big enough to move its pool. */
function storeWithHeavyPosition() {
  const store = new DemoStore(77);
  // Pick the thinnest pool in the universe so a normal-sized position is
  // genuinely more than it can absorb.
  const mints = store.tokenList().map((t) => t.info.mint);
  const thinnest = mints
    .map((m) => ({ m, liq: store.snapshot(m)?.liquidityUsd ?? Infinity }))
    .sort((a, b) => a.liq - b.liq)[0];
  const mint = thinnest.m;
  const px = store.lastPrice(mint)!;
  const cap = maxOrderUsd(store, mint);

  store.portfolios = [
    {
      id: "pf1",
      name: "test",
      createdAt: 0,
      startingUsd: 1_000_000,
      cashUsd: 1_000_000,
      realizedPnlUsd: 0,
      positions: [
        {
          mint,
          // Deliberately several times what the pool will take in one order.
          tokens: (cap * 6) / px,
          // Bought at twice the current price, so the position is ~50% down and
          // the 1% stop is unambiguously triggered.
          costBasisUsd: cap * 12,
          openedAt: 0,
          stopLossPct: 1,
        },
      ],
      orders: [],
      fills: [],
    },
  ];
  return { store, mint, cap, px };
}

describe("paper stops on an illiquid position", () => {
  it("refuses a single order larger than the pool can absorb", () => {
    const { store, mint, cap } = storeWithHeavyPosition();
    const res = placeOrder(store, { portfolioId: "pf1", mint, side: "sell", usd: cap * 6 });
    expect(res.fill).toBeUndefined();
    expect(res.error).toMatch(/pool depth/);
  });

  it("still exits the position instead of reporting a stop that never filled", () => {
    const { store, mint } = storeWithHeavyPosition();
    const pf = store.portfolios[0];
    const before = pf.positions[0].tokens;

    const fired = enforceStops(store);

    // It must actually have sold something...
    expect(fired.length).toBe(1);
    expect(fired[0].mint).toBe(mint);
    expect(pf.positions[0].tokens).toBeLessThan(before);
    // ...and every order it filed must be a fill, not a rejection. The old code
    // pushed a rejected order and claimed the stop had fired anyway.
    expect(pf.orders.every((o) => o.status === "filled")).toBe(true);
    expect(pf.fills.length).toBe(1);
    expect(fired[0].reason).toMatch(/pool could absorb/);
  });

  it("terminates: repeated ticks close the position rather than looping forever", () => {
    const { store } = storeWithHeavyPosition();
    const pf = store.portfolios[0];

    let ticks = 0;
    while (pf.positions.length > 0 && ticks < 200) {
      enforceStops(store);
      ticks++;
    }

    // The bug was an infinite loop: the stop fired every tick and the position
    // never shrank. It should drain in a handful of passes.
    expect(pf.positions.length).toBe(0);
    expect(ticks).toBeLessThan(200);
    expect(pf.orders.every((o) => o.status === "filled")).toBe(true);
  });

  it("leaves a position alone when the pool cannot absorb anything at all", () => {
    const { store, mint } = storeWithHeavyPosition();
    const pf = store.portfolios[0];
    // No snapshot -> no depth -> maxOrderUsd 0. Nothing should be filed.
    const original = store.snapshot.bind(store);
    store.snapshot = ((m: string, asOf?: number) =>
      m === mint ? undefined : original(m, asOf)) as typeof store.snapshot;

    const fired = enforceStops(store);
    expect(fired.length).toBe(0);
    expect(pf.orders.length).toBe(0);
  });
});

describe("a full-size exit on a deep pool", () => {
  it("closes in one order and is not reported as partial", () => {
    const store = new DemoStore(77);
    const mints = store.tokenList().map((t) => t.info.mint);
    const deepest = mints
      .map((m) => ({ m, liq: store.snapshot(m)?.liquidityUsd ?? 0 }))
      .sort((a, b) => b.liq - a.liq)[0].m;
    const px = store.lastPrice(deepest)!;
    const small = maxOrderUsd(store, deepest) / 10;

    store.portfolios = [
      {
        id: "pf1", name: "t", createdAt: 0, startingUsd: 1_000_000, cashUsd: 1_000_000, realizedPnlUsd: 0,
        // Cost basis at twice the current value, so the 1% stop is triggered.
        positions: [{ mint: deepest, tokens: small / px, costBasisUsd: small * 2, openedAt: 0, stopLossPct: 1 }],
        orders: [], fills: [],
      },
    ];

    const fired = enforceStops(store);
    expect(fired.length).toBe(1);
    expect(fired[0].reason).not.toMatch(/pool could absorb/);
    expect(store.portfolios[0].positions.length).toBe(0);
  });
});
