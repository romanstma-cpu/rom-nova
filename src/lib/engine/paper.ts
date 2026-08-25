// Paper trading. Fills are honest about frictions: slippage scales with
// order size vs pool depth, fees apply both ways, and an order larger than
// the pool can absorb is rejected instead of magically filled.

import type { DemoStore } from "../demo/store";
import type { PaperFill, PaperOrder, PaperPortfolio } from "../types";

const FEE_PCT = 0.5;

export interface OrderRequest {
  portfolioId: string;
  mint: string;
  side: "buy" | "sell";
  usd: number;
  stopLossPct?: number;
  takeProfitPct?: number;
}

export function placeOrder(store: DemoStore, req: OrderRequest): { order: PaperOrder; fill?: PaperFill; error?: string } {
  const pf = store.portfolios.find((p) => p.id === req.portfolioId);
  const now = store.simulatedUntil;
  const mk = (status: PaperOrder["status"], rejectReason?: string): PaperOrder => ({
    id: store.nextId("ord"),
    portfolioId: req.portfolioId,
    mint: req.mint,
    side: req.side,
    requestedUsd: req.usd,
    ts: now,
    status,
    rejectReason,
  });

  if (!pf) return { order: mk("rejected", "portfolio not found"), error: "portfolio not found" };
  const snap = store.snapshot(req.mint);
  const price = store.lastPrice(req.mint);
  if (!snap || !price) return { order: mk("rejected", "no market data"), error: "no market data" };
  if (req.usd <= 0) return { order: mk("rejected", "amount must be positive"), error: "amount must be positive" };

  // price impact from pool depth; refuse orders that would eat the pool
  const depth = Math.max(snap.liquidityUsd * 0.5, 1);
  const impactPct = Math.min(45, (req.usd / depth) * 100 * 0.9);
  if (impactPct > 12) {
    const order = mk("rejected", `order is ${((req.usd / depth) * 100).toFixed(1)}% of usable pool depth — impact ~${impactPct.toFixed(1)}%`);
    pf.orders.push(order);
    return { order, error: order.rejectReason };
  }
  const slippagePct = 0.3 + impactPct * 0.6;

  if (req.side === "buy") {
    if (pf.cashUsd < req.usd) {
      const order = mk("rejected", "insufficient cash");
      pf.orders.push(order);
      return { order, error: "insufficient cash" };
    }
    const effPrice = price * (1 + slippagePct / 100);
    const feeUsd = req.usd * (FEE_PCT / 100);
    const tokens = (req.usd - feeUsd) / effPrice;
    pf.cashUsd -= req.usd;
    const pos = pf.positions.find((p) => p.mint === req.mint);
    if (pos) {
      pos.tokens += tokens;
      pos.costBasisUsd += req.usd;
      if (req.stopLossPct !== undefined) pos.stopLossPct = req.stopLossPct;
      if (req.takeProfitPct !== undefined) pos.takeProfitPct = req.takeProfitPct;
    } else {
      pf.positions.push({
        mint: req.mint,
        tokens,
        costBasisUsd: req.usd,
        openedAt: now,
        stopLossPct: req.stopLossPct,
        takeProfitPct: req.takeProfitPct,
      });
    }
    const order = mk("filled");
    const fill: PaperFill = { orderId: order.id, ts: now, priceUsd: effPrice, tokens, usd: req.usd, feeUsd, slippagePct, priceImpactPct: impactPct };
    pf.orders.push(order);
    pf.fills.push(fill);
    return { order, fill };
  }

  // sell
  const pos = pf.positions.find((p) => p.mint === req.mint);
  if (!pos || pos.tokens <= 0) {
    const order = mk("rejected", "no position");
    pf.orders.push(order);
    return { order, error: "no position" };
  }
  const effPrice = price * (1 - slippagePct / 100);
  const posValue = pos.tokens * effPrice;
  const sellUsd = Math.min(req.usd, posValue);
  const tokens = sellUsd / effPrice;
  const shareOfPos = tokens / pos.tokens;
  const costOut = pos.costBasisUsd * shareOfPos;
  const feeUsd = sellUsd * (FEE_PCT / 100);
  pos.tokens -= tokens;
  pos.costBasisUsd -= costOut;
  pf.cashUsd += sellUsd - feeUsd;
  pf.realizedPnlUsd += sellUsd - feeUsd - costOut;
  if (pos.tokens * effPrice < 0.5) pf.positions = pf.positions.filter((p) => p !== pos);

  const order = mk("filled");
  const fill: PaperFill = { orderId: order.id, ts: now, priceUsd: effPrice, tokens, usd: sellUsd, feeUsd, slippagePct, priceImpactPct: impactPct };
  pf.orders.push(order);
  pf.fills.push(fill);
  return { order, fill };
}

export interface PortfolioView extends PaperPortfolio {
  equityUsd: number;
  unrealizedPnlUsd: number;
  totalReturnPct: number;
  positionViews: {
    mint: string;
    symbol: string;
    tokens: number;
    priceUsd: number;
    valueUsd: number;
    costBasisUsd: number;
    pnlUsd: number;
    pnlPct: number;
    stopLossPct?: number;
    takeProfitPct?: number;
  }[];
}

export function portfolioView(store: DemoStore, pf: PaperPortfolio): PortfolioView {
  let value = 0;
  const positionViews = pf.positions.map((p) => {
    const px = store.lastPrice(p.mint) ?? 0;
    const v = p.tokens * px;
    value += v;
    return {
      mint: p.mint,
      symbol: store.token(p.mint)?.info.symbol ?? "?",
      tokens: p.tokens,
      priceUsd: px,
      valueUsd: v,
      costBasisUsd: p.costBasisUsd,
      pnlUsd: v - p.costBasisUsd,
      pnlPct: p.costBasisUsd > 0 ? ((v - p.costBasisUsd) / p.costBasisUsd) * 100 : 0,
      stopLossPct: p.stopLossPct,
      takeProfitPct: p.takeProfitPct,
    };
  });
  const equity = pf.cashUsd + value;
  return {
    ...pf,
    equityUsd: equity,
    unrealizedPnlUsd: positionViews.reduce((s, p) => s + p.pnlUsd, 0),
    totalReturnPct: (equity / pf.startingUsd - 1) * 100,
    positionViews,
  };
}

/** Check stops/targets against current prices; returns triggered sells. */
export function enforceStops(store: DemoStore): { portfolioId: string; mint: string; reason: string }[] {
  const fired: { portfolioId: string; mint: string; reason: string }[] = [];
  for (const pf of store.portfolios) {
    for (const pos of [...pf.positions]) {
      const px = store.lastPrice(pos.mint);
      if (!px || pos.costBasisUsd <= 0) continue;
      const avg = pos.costBasisUsd / pos.tokens;
      const ret = (px / avg - 1) * 100;
      if (pos.stopLossPct !== undefined && ret <= -pos.stopLossPct) {
        placeOrder(store, { portfolioId: pf.id, mint: pos.mint, side: "sell", usd: pos.tokens * px });
        fired.push({ portfolioId: pf.id, mint: pos.mint, reason: `stop loss ${pos.stopLossPct}% hit` });
      } else if (pos.takeProfitPct !== undefined && ret >= pos.takeProfitPct) {
        placeOrder(store, { portfolioId: pf.id, mint: pos.mint, side: "sell", usd: pos.tokens * px });
        fired.push({ portfolioId: pf.id, mint: pos.mint, reason: `take profit ${pos.takeProfitPct}% hit` });
      }
    }
  }
  return fired;
}
