// Wallet performance measurement. Works from the raw trade log — the same
// math runs against demo trades and live-provider trades. Smart-money
// scores are DERIVED from measured performance, never asserted.

import type {
  SmartMoneyScore,
  WalletPerformance,
  WalletPosition,
  WalletTrade,
} from "../types";

interface Lot {
  tokens: number;
  costPerToken: number;
  ts: number;
}

export interface RoundTrip {
  mint: string;
  entryTs: number;
  exitTs: number;
  costUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  holdHours: number;
}

export interface WalletLedger {
  address: string;
  positions: WalletPosition[];
  roundTrips: RoundTrip[];
  realizedPnlUsd: number;
}

/** FIFO replay of one wallet's trades into open positions + closed round trips. */
export function replayWallet(address: string, trades: WalletTrade[]): WalletLedger {
  const lots = new Map<string, Lot[]>();
  const opened = new Map<string, number>();
  const roundTrips: RoundTrip[] = [];
  let realized = 0;

  for (const t of trades) {
    if (t.wallet !== address) continue;
    if (t.side === "buy") {
      const arr = lots.get(t.mint) ?? [];
      if (arr.length === 0) opened.set(t.mint, t.ts);
      arr.push({ tokens: t.amountTokens, costPerToken: t.priceUsd, ts: t.ts });
      lots.set(t.mint, arr);
    } else {
      const arr = lots.get(t.mint) ?? [];
      let remaining = t.amountTokens;
      let cost = 0;
      let sold = 0;
      while (remaining > 1e-9 && arr.length > 0) {
        const lot = arr[0];
        const take = Math.min(lot.tokens, remaining);
        cost += take * lot.costPerToken;
        sold += take;
        lot.tokens -= take;
        remaining -= take;
        if (lot.tokens <= 1e-9) arr.shift();
      }
      if (sold > 1e-9) {
        const proceeds = sold * t.priceUsd;
        realized += proceeds - cost;
        if (arr.length === 0) {
          const entryTs = opened.get(t.mint) ?? t.ts;
          roundTrips.push({
            mint: t.mint,
            entryTs,
            exitTs: t.ts,
            costUsd: cost,
            proceedsUsd: proceeds,
            pnlUsd: proceeds - cost,
            holdHours: (t.ts - entryTs) / 3_600_000,
          });
          opened.delete(t.mint);
        }
      }
    }
  }

  const positions: WalletPosition[] = [];
  for (const [mint, arr] of lots) {
    const tokens = arr.reduce((s, l) => s + l.tokens, 0);
    if (tokens <= 1e-9) continue;
    positions.push({
      wallet: address,
      mint,
      tokens,
      costBasisUsd: arr.reduce((s, l) => s + l.tokens * l.costPerToken, 0),
      openedAt: opened.get(mint) ?? arr[0].ts,
      lastChangedAt: arr[arr.length - 1].ts,
    });
  }

  return { address, positions, roundTrips, realizedPnlUsd: realized };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function measurePerformance(
  ledger: WalletLedger,
  priceOf: (mint: string) => number | undefined,
): WalletPerformance {
  const wins = ledger.roundTrips.filter((r) => r.pnlUsd > 0);
  const losses = ledger.roundTrips.filter((r) => r.pnlUsd <= 0);
  const grossWin = wins.reduce((s, r) => s + r.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnlUsd, 0));

  let unrealized = 0;
  let openCost = 0;
  for (const p of ledger.positions) {
    const px = priceOf(p.mint);
    if (px !== undefined) unrealized += p.tokens * px - p.costBasisUsd;
    openCost += p.costBasisUsd;
  }

  const totalCost = ledger.roundTrips.reduce((s, r) => s + r.costUsd, 0) + openCost;
  const totalPnl = ledger.realizedPnlUsd + unrealized;

  // equity curve over round trips for drawdown / sharpe-like
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const rets: number[] = [];
  for (const r of [...ledger.roundTrips].sort((a, b) => a.exitTs - b.exitTs)) {
    equity += r.pnlUsd;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / Math.max(peak, 1));
    if (r.costUsd > 0) rets.push(r.pnlUsd / r.costUsd);
  }
  const meanRet = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - meanRet) ** 2, 0) / (rets.length - 1)) : 0;

  return {
    address: ledger.address,
    realizedPnlUsd: ledger.realizedPnlUsd,
    unrealizedPnlUsd: unrealized,
    roiPct: totalCost > 0 ? (totalPnl / totalCost) * 100 : 0,
    winRate: ledger.roundTrips.length ? wins.length / ledger.roundTrips.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    avgWinUsd: wins.length ? grossWin / wins.length : 0,
    avgLossUsd: losses.length ? -grossLoss / losses.length : 0,
    maxDrawdownPct: maxDd * 100,
    sharpeLike: sd > 0 ? meanRet / sd : 0,
    medianHoldHours: median(ledger.roundTrips.map((r) => r.holdHours)),
    trades: ledger.roundTrips.length,
  };
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/** Smart-money score from measured performance. Sample size gates the
 * ceiling: one lucky trade cannot mint a 90. */
export function smartMoneyScore(perf: WalletPerformance, ledger: WalletLedger): SmartMoneyScore {
  const n = ledger.roundTrips.length;
  const dataConfidence = clamp(n / 10) * clamp(0.6 + n / 24, 0, 1);

  // performance: profit factor and ROI on scales that keep discriminating
  // well past "pretty good" (PF 6 must not read the same as PF 9)
  const performance = clamp(0.6 * clamp(perf.profitFactor / 8) + 0.4 * clamp(perf.roiPct / 200 + 0.5));

  // timing: win rate, convex so coin-flip traders sit low
  const timing = clamp(0.1 + Math.pow(perf.winRate, 1.5));

  // consistency: penalize a single trade dominating pnl
  const pnls = ledger.roundTrips.map((r) => r.pnlUsd);
  const totalAbs = pnls.reduce((s, x) => s + Math.abs(x), 0);
  const biggest = pnls.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const dominance = totalAbs > 0 ? biggest / totalAbs : 1;
  const consistency = clamp(1 - dominance) * clamp(0.3 + n / 15);

  // risk management: drawdown + avg loss vs avg win
  const lossRatio = perf.avgWinUsd > 0 ? Math.abs(perf.avgLossUsd) / perf.avgWinUsd : 1;
  const riskManagement = clamp(1 - perf.maxDrawdownPct / 100) * clamp(1.2 - lossRatio * 0.5);

  // diversification: distinct tokens traded
  const tokens = new Set(ledger.roundTrips.map((r) => r.mint)).size;
  const diversification = clamp(tokens / 10);

  // data confidence dampens rather than multiplies — a thin history caps
  // the score at half, it does not zero out demonstrated skill; and skill
  // components (performance, timing) carry most of the weight so sample
  // size alone can never outrank results.
  const total =
    100 *
    (0.35 * performance + 0.3 * timing + 0.1 * consistency + 0.1 * riskManagement + 0.15 * diversification) *
    (0.5 + 0.5 * dataConfidence);

  return {
    total: Math.round(total),
    performance: Math.round(performance * 100),
    timing: Math.round(timing * 100),
    consistency: Math.round(consistency * 100),
    riskManagement: Math.round(riskManagement * 100),
    diversification: Math.round(diversification * 100),
    dataConfidence: Math.round(dataConfidence * 100),
  };
}
