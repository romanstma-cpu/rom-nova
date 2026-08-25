import { describe, it, expect } from "vitest";
import { Rng, fakeAddress } from "@/lib/demo/rng";
import { buildUniverse } from "@/lib/demo/universe";
import { DemoStore } from "@/lib/demo/store";

describe("seeded rng", () => {
  it("is deterministic for the same seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it("forks independent streams", () => {
    const root = new Rng(42);
    const f1 = root.fork("alpha");
    const f2 = root.fork("beta");
    expect(f1.next()).not.toBe(f2.next());
    // forking must not perturb the parent
    const rootAgain = new Rng(42);
    rootAgain.fork("alpha");
    rootAgain.fork("beta");
    expect(root.next()).toBe(rootAgain.next());
  });

  it("produces solana-shaped addresses", () => {
    const addr = fakeAddress(new Rng(7));
    expect(addr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
  });
});

describe("demo universe", () => {
  const u1 = buildUniverse(77);
  const u2 = buildUniverse(77);
  const u3 = buildUniverse(78);

  it("is identical for identical seeds", () => {
    expect([...u1.tokens.keys()]).toEqual([...u2.tokens.keys()]);
    expect(u1.trades.length).toBe(u2.trades.length);
    expect(u1.trades[0].signature).toBe(u2.trades[0].signature);
  });

  it("differs across seeds", () => {
    expect([...u1.tokens.keys()]).not.toEqual([...u3.tokens.keys()]);
  });

  it("has unique trade ids and signatures (dedup keys)", () => {
    const ids = new Set(u1.trades.map((t) => t.id));
    const sigs = new Set(u1.trades.map((t) => t.signature));
    expect(ids.size).toBe(u1.trades.length);
    expect(sigs.size).toBe(u1.trades.length);
  });

  it("keeps trades in ascending time order with sane values", () => {
    let prev = 0;
    for (const t of u1.trades) {
      expect(t.ts).toBeGreaterThanOrEqual(prev);
      prev = t.ts;
      expect(t.amountUsd).toBeGreaterThan(0);
      expect(t.priceUsd).toBeGreaterThan(0);
    }
  });

  it("contains rug archetypes whose liquidity collapsed", () => {
    const rugs = [...u1.tokens.values()].filter((t) => t.archetype === "rug");
    expect(rugs.length).toBeGreaterThan(5);
    for (const rug of rugs) {
      const peak = Math.max(...rug.liquidityUsd);
      const last = rug.liquidityUsd[rug.liquidityUsd.length - 1];
      // either the collapse is visible inside the window, or the token was
      // already rugged before the window and the pool is dead throughout
      expect(last < peak * 0.5 || peak < 25_000).toBe(true);
    }
  });

  it("anchors the SOL path near the real reference price", () => {
    const last = u1.solPath[u1.solPath.length - 1].c;
    expect(last).toBeGreaterThan(50);
    expect(last).toBeLessThan(200);
  });
});

describe("demo store", () => {
  const store = new DemoStore(77);

  it("serves snapshots for every token", () => {
    const snaps = store.snapshots();
    expect(snaps.length).toBe(store.tokenList().length);
    for (const s of snaps) {
      expect(s.priceUsd).toBeGreaterThan(0);
      expect(s.liquidityUsd).toBeGreaterThan(0);
      expect(s.top10Pct).toBeGreaterThan(0);
      expect(s.top10Pct).toBeLessThan(1);
    }
  });

  it("asOf snapshots never read the future", () => {
    const tok = store.tokenList().find((t) => t.candles.length > 200)!;
    const early = tok.candles[50].t;
    const snap = store.snapshot(tok.info.mint, early)!;
    expect(snap.priceUsd).toBeCloseTo(tok.candles[50].c, 10);
    // token that does not exist yet at asOf → undefined
    const before = tok.candles[0].t - 1000;
    expect(store.snapshot(tok.info.mint, before)).toBeUndefined();
  });

  it("measures wallet performance and derives smart-money scores from it", () => {
    const wallets = store.walletList();
    const scored = wallets.filter((w) => w.smartMoney.total > 0);
    expect(scored.length).toBeGreaterThan(10);
    // the smart_trader cohort should on average out-score bots
    const smartAvg = avg(wallets.filter((w) => w.labels.includes("smart_trader")).map((w) => w.smartMoney.total));
    const botAvg = avg(wallets.filter((w) => w.labels.includes("bot")).map((w) => w.smartMoney.total));
    expect(smartAvg).toBeGreaterThan(botAvg);
  });

  it("detects coordinated clusters with evidence", () => {
    expect(store.universe.clusters.length).toBeGreaterThanOrEqual(2);
    for (const c of store.universe.clusters) {
      expect(c.members.length).toBeGreaterThanOrEqual(2);
      expect(c.sharedTokens.length).toBeGreaterThanOrEqual(2);
      expect(c.evidence.length).toBeGreaterThan(0);
    }
  });
});

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
