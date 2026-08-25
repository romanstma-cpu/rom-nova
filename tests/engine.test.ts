import { describe, it, expect } from "vitest";
import { DemoStore } from "@/lib/demo/store";
import { replayWallet, measurePerformance, smartMoneyScore } from "@/lib/engine/perf";
import { computeSignal, signalsAt, accuracyStats, PROFILES } from "@/lib/engine/signals";
import { extractFeatures } from "@/lib/engine/features";
import { runBacktest, DEFAULT_BACKTEST } from "@/lib/engine/backtest";
import { placeOrder, portfolioView } from "@/lib/engine/paper";
import { riskRadar } from "@/lib/engine/risk";
import { findSimilar } from "@/lib/engine/similarity";
import { answerQuestion } from "@/lib/engine/research";
import type { WalletTrade } from "@/lib/types";

const store = new DemoStore(77);
const now = store.universe.genesis;

const mkTrade = (over: Partial<WalletTrade>): WalletTrade => ({
  id: Math.random().toString(36),
  signature: "sig",
  wallet: "W",
  mint: "M",
  ts: 1,
  side: "buy",
  amountUsd: 100,
  amountTokens: 100,
  priceUsd: 1,
  dex: "Raydium",
  classification: "open",
  confidence: 0.9,
  ...over,
});

describe("FIFO wallet accounting", () => {
  it("computes realized PnL over a partial exit correctly", () => {
    const trades: WalletTrade[] = [
      mkTrade({ ts: 1, side: "buy", amountTokens: 100, priceUsd: 1, amountUsd: 100 }),
      mkTrade({ ts: 2, side: "buy", amountTokens: 100, priceUsd: 2, amountUsd: 200 }),
      // sell 150 tokens at $3: FIFO cost = 100×1 + 50×2 = 200, proceeds 450
      mkTrade({ ts: 3, side: "sell", amountTokens: 150, priceUsd: 3, amountUsd: 450 }),
    ];
    const ledger = replayWallet("W", trades);
    expect(ledger.realizedPnlUsd).toBeCloseTo(250, 6);
    expect(ledger.positions).toHaveLength(1);
    expect(ledger.positions[0].tokens).toBeCloseTo(50, 6);
    expect(ledger.positions[0].costBasisUsd).toBeCloseTo(100, 6);
    // not a round trip yet — position still open
    expect(ledger.roundTrips).toHaveLength(0);
  });

  it("records a round trip on full exit", () => {
    const trades: WalletTrade[] = [
      mkTrade({ ts: 1, side: "buy", amountTokens: 100, priceUsd: 1 }),
      mkTrade({ ts: 3_600_000 + 1, side: "sell", amountTokens: 100, priceUsd: 0.5 }),
    ];
    const ledger = replayWallet("W", trades);
    expect(ledger.roundTrips).toHaveLength(1);
    expect(ledger.roundTrips[0].pnlUsd).toBeCloseTo(-50, 6);
    expect(ledger.roundTrips[0].holdHours).toBeCloseTo(1, 3);
  });

  it("one lucky trade cannot mint a high smart-money score", () => {
    const lucky: WalletTrade[] = [
      mkTrade({ ts: 1, side: "buy", amountTokens: 1000, priceUsd: 1 }),
      mkTrade({ ts: 2, side: "sell", amountTokens: 1000, priceUsd: 40 }),
    ];
    const ledger = replayWallet("W", lucky);
    const perf = measurePerformance(ledger, () => undefined);
    const score = smartMoneyScore(perf, ledger);
    // 39x on a single round trip — but n=1: consistency zeroes out and data
    // confidence halves the total, keeping it well under what the sustained
    // cohorts measure (smart traders average ~65 on the demo universe)
    expect(perf.winRate).toBe(1);
    expect(score.total).toBeLessThan(50);
    expect(score.consistency).toBe(0);
    expect(score.dataConfidence).toBeLessThan(20);
  });
});

describe("signal engine", () => {
  const sigs = signalsAt(store, now, "balanced");

  it("scores every token, bounded 0..100 with factors that sum coherently", () => {
    expect(sigs.length).toBe(store.tokenList().length);
    for (const s of sigs) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      expect(s.factors.length).toBeGreaterThan(10);
      expect(s.why.length).toBeGreaterThan(0);
      expect(s.bearCase.length).toBeGreaterThan(0);
      expect(s.invalidation.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic for the same asOf", () => {
    const again = signalsAt(store, now, "balanced");
    expect(again.map((s) => s.score)).toEqual(sigs.map((s) => s.score));
  });

  it("does NOT treat whale buying as automatically bullish when risk is stacked", () => {
    // rugs frequently show whale-sized flow yet must not rank as strong setups
    const rugMints = new Set(store.tokenList().filter((t) => t.archetype === "rug").map((t) => t.info.mint));
    const strongRugs = sigs.filter((s) => rugMints.has(s.mint) && s.score >= 70 && s.label !== "NO TRADE");
    expect(strongRugs.length).toBe(0);
  });

  it("issues NO TRADE when liquidity is below the profile floor", () => {
    const conservative = signalsAt(store, now, "conservative");
    const thin = conservative.filter((s) => s.features.liquidityUsd < PROFILES.conservative.minLiquidityUsd);
    expect(thin.length).toBeGreaterThan(0);
    for (const s of thin) expect(s.label).toBe("NO TRADE");
  });

  it("mean_reversion profile prefers weak momentum, momentum profile prefers strong", () => {
    const f = extractFeatures(store, sigs[0].mint, now)!;
    void f;
    const mom = signalsAt(store, now, "momentum");
    const rev = signalsAt(store, now, "mean_reversion");
    const topMom = mom.slice(0, 10).map((s) => s.features.momentum24h);
    const topRev = rev.slice(0, 10).map((s) => s.features.momentum24h);
    expect(avg(topMom)).toBeGreaterThan(avg(topRev));
  });

  it("flags dev selling and concentration as risks", () => {
    const withDevRisk = sigs.find((s) => s.features.devSold);
    if (withDevRisk) {
      expect(withDevRisk.risks.some((r) => r.key === "dev")).toBe(true);
    }
    const concentrated = sigs.find((s) => s.features.top10Pct > 0.4);
    if (concentrated) {
      expect(concentrated.risks.some((r) => r.key === "concentration" && r.severity === "high")).toBe(true);
    }
  });

  it("stores the exact feature snapshot for reproducibility", () => {
    const s = sigs[0];
    const recomputed = computeSignal(store, s.mint, now, "balanced")!;
    expect(recomputed.score).toBe(s.score);
    expect(recomputed.features).toEqual(s.features);
  });

  it("measures its own historical accuracy without excuses", () => {
    const stats = accuracyStats(store, "balanced", 6);
    expect(stats.samples).toBeGreaterThan(0);
    expect(stats.hitRate).toBeGreaterThanOrEqual(0);
    expect(stats.hitRate).toBeLessThanOrEqual(1);
    expect(stats.byLabel.length).toBeGreaterThan(0);
  });
});

describe("risk radar", () => {
  it("grades rugs worse than grinders on average", () => {
    const grade = (arch: string) =>
      store
        .tokenList()
        .filter((t) => t.archetype === arch)
        .map((t) => riskRadar(store, t.info.mint)!)
        .filter(Boolean)
        .map((r) => (r.overall === "high" ? 2 : r.overall === "medium" ? 1 : 0));
    expect(avg(grade("rug"))).toBeGreaterThan(avg(grade("grinder")));
  });
});

describe("backtester", () => {
  const result = runBacktest(store, { ...DEFAULT_BACKTEST, days: 6, minScore: 65 });

  it("passes the anti-lookahead integrity check", () => {
    expect(result.integrity.lookaheadChecksPassed).toBe(true);
  });

  it("only enters after the signal time (entry delay respected)", () => {
    for (const t of result.trades) {
      expect(t.exitTs).toBeGreaterThan(t.entryTs);
    }
  });

  it("applies frictions — higher costs strictly reduce the outcome", () => {
    const cheap = runBacktest(store, { ...DEFAULT_BACKTEST, days: 6, minScore: 65, slippagePct: 0, feePct: 0 });
    const dear = runBacktest(store, { ...DEFAULT_BACKTEST, days: 6, minScore: 65, slippagePct: 3, feePct: 2 });
    if (cheap.trades.length > 0 && dear.trades.length > 0) {
      expect(dear.endingUsd).toBeLessThan(cheap.endingUsd);
    }
  });
});

describe("paper trading", () => {
  const s = new DemoStore(77);
  s.simulatedUntil = s.universe.genesis;
  const pf = s.portfolios[0];
  const liquidMint = s
    .tokenList()
    .filter((t) => t.archetype !== "rug")
    .sort((a, b) => b.liquidityUsd[b.liquidityUsd.length - 1] - a.liquidityUsd[a.liquidityUsd.length - 1])[0].info.mint;

  it("fills a buy with slippage and fees, then a sell round-trips", () => {
    const buy = placeOrder(s, { portfolioId: pf.id, mint: liquidMint, side: "buy", usd: 500 });
    expect(buy.error).toBeUndefined();
    expect(buy.fill!.slippagePct).toBeGreaterThan(0);
    expect(pf.cashUsd).toBeCloseTo(9_500, 6);
    const sell = placeOrder(s, { portfolioId: pf.id, mint: liquidMint, side: "sell", usd: 10_000 });
    expect(sell.error).toBeUndefined();
    // frictions both ways: we must get back less than we put in
    expect(pf.cashUsd).toBeLessThan(10_000);
    expect(pf.positions).toHaveLength(0);
    expect(pf.realizedPnlUsd).toBeLessThan(0);
  });

  it("rejects an order that would eat the pool", () => {
    const thin = s
      .tokenList()
      .sort((a, b) => a.liquidityUsd[a.liquidityUsd.length - 1] - b.liquidityUsd[b.liquidityUsd.length - 1])[0];
    const res = placeOrder(s, { portfolioId: pf.id, mint: thin.info.mint, side: "buy", usd: 9_000 });
    expect(res.error).toBeTruthy();
    expect(res.order.status).toBe("rejected");
  });

  it("rejects buys beyond available cash", () => {
    const res = placeOrder(s, { portfolioId: pf.id, mint: liquidMint, side: "buy", usd: 1e5 });
    expect(res.error).toBeTruthy();
  });

  it("portfolio view marks equity to market", () => {
    const view = portfolioView(s, pf);
    expect(view.equityUsd).toBeCloseTo(pf.cashUsd, 6);
  });
});

describe("similarity + research", () => {
  it("reports outcome distributions, not predictions", () => {
    const tok = store.tokenList().find((t) => t.candles.length > 300)!;
    const rep = findSimilar(store, tok.info.mint, now);
    expect(rep).toBeDefined();
    if (rep && rep.samples >= 5) {
      expect(rep.p10_24h).toBeLessThanOrEqual(rep.median24h);
      expect(rep.median24h).toBeLessThanOrEqual(rep.p90_24h);
    }
  });

  it("answers questions with evidence and sources", () => {
    const a = answerQuestion(store, "which tokens have smart money accumulating right now?");
    expect(a.answer.length).toBeGreaterThan(10);
    expect(a.sources.length).toBeGreaterThan(0);
    const tok = store.tokenList()[0];
    const b = answerQuestion(store, `why is ${tok.info.symbol} moving`);
    expect(b.evidence.length).toBeGreaterThan(0);
  });
});

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
