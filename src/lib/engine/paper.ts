// Paper trading. Fills are honest about frictions: slippage scales with
// order size vs pool depth, fees apply both ways, and an order larger than
// the pool can absorb is rejected instead of magically filled.

import type { DemoStore } from "../demo/store";
import type { PaperFill, PaperOrder, PaperPortfolio } from "../types";

const FEE_PCT = 0.5;
/** Price impact above which an order is refused rather than magically filled. */
const MAX_IMPACT_PCT = 12;

/** Usable depth behind a mint — half the pool, the same figure placeOrder uses. */
function usableDepth(store: DemoStore, mint: string): number {
  const snap = store.snapshot(mint);
  if (!snap) return 0;
  return Math.max(snap.liquidityUsd * 0.5, 1);
}

/**
 * Largest order this pool can absorb without tripping the impact guard.
 *
 * `impactPct = (usd / depth) * 100 * 0.9`, solved for MAX_IMPACT_PCT and shaded
 * just under it so a float landing exactly on the boundary is not rejected.
 */
export function maxOrderUsd(store: DemoStore, mint: string): number {
  return ((usableDepth(store, mint) * MAX_IMPACT_PCT) / 90) * 0.99;
}

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
  if (impactPct > MAX_IMPACT_PCT) {
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

/**
 * Check stops/targets against current prices; returns the sells that filled.
 *
 * Exits are capped to what the pool can absorb. Asking to dump a whole position
 * at once used to trip placeOrder's own impact guard, and the rejection was
 * discarded: the caller was told the stop had fired, the position stayed fully
 * open, a rejected order was appended to the ledger — and because the trigger
 * condition was still true, the whole thing repeated on the next simulator
 * tick, four seconds later, forever.
 *
 * Selling what the pool will take instead is both honest and terminating: the
 * position bleeds down across ticks and eventually closes, which is what
 * exiting an illiquid position actually looks like.
 */
export function enforceStops(store: DemoStore): { portfolioId: string; mint: string; reason: string }[] {
  const fired: { portfolioId: string; mint: string; reason: string }[] = [];
  for (const pf of store.portfolios) {
    for (const pos of [...pf.positions]) {
      const px = store.lastPrice(pos.mint);
      if (!px || pos.costBasisUsd <= 0 || pos.tokens <= 0) continue;
      const avg = pos.costBasisUsd / pos.tokens;
      const ret = (px / avg - 1) * 100;

      const reason =
        pos.stopLossPct !== undefined && ret <= -pos.stopLossPct
          ? `stop loss ${pos.stopLossPct}% hit`
          : pos.takeProfitPct !== undefined && ret >= pos.takeProfitPct
            ? `take profit ${pos.takeProfitPct}% hit`
            : null;
      if (!reason) continue;

      const wantUsd = pos.tokens * px;
      const usd = Math.min(wantUsd, maxOrderUsd(store, pos.mint));
      // A pool too thin to absorb anything at all: leave the position alone
      // rather than filing a rejection every four seconds.
      if (usd <= 0) continue;

      const res = placeOrder(store, { portfolioId: pf.id, mint: pos.mint, side: "sell", usd });
      if (!res.fill) continue; // rejected for some other reason; do not claim it fired

      const partial = usd < wantUsd * 0.999;
      fired.push({
        portfolioId: pf.id,
        mint: pos.mint,
        reason: partial
          ? `${reason} — sold what the pool could absorb, the rest follows`
          : reason,
      });
    }
  }
  return fired;
}
