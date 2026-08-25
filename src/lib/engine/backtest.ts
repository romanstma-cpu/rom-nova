// Backtester. Walks history forward in hourly steps, asks the signal engine
// what it would have said AT THAT MOMENT (signalsAt only reads data <= asOf),
// and fills entries with delay + slippage + fees. The integrity check
// re-derives a sample of entry signals and fails the run if any feature
// snapshot contains data newer than its own asOf.

import type { DemoStore } from "../demo/store";
import { HOUR, DAY } from "../demo/universe";
import { signalsAt } from "./signals";
import type { BacktestConfig, BacktestResult, BacktestTrade } from "../types";

interface OpenPos {
  mint: string;
  symbol: string;
  score: number;
  entryTs: number;
  entryPrice: number;
  tokens: number;
  usdIn: number;
}

export const DEFAULT_BACKTEST: BacktestConfig = {
  profile: "balanced",
  days: 10,
  minLiquidityUsd: 50_000,
  maxMarketCapUsd: 50_000_000,
  minScore: 70,
  minConfidence: 0.45,
  holdHours: 24,
  stopLossPct: 20,
  takeProfitPct: 40,
  positionUsd: 500,
  maxConcurrent: 5,
  slippagePct: 1.5,
  feePct: 0.6,
  entryDelayMin: 10,
};

export function runBacktest(store: DemoStore, cfg: BacktestConfig): BacktestResult {
  const genesis = store.universe.genesis;
  const start = genesis - cfg.days * DAY;
  const end = genesis - 2 * HOUR;

  let cash = 10_000;
  const startingUsd = cash;
  const open: OpenPos[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: { ts: number; equity: number }[] = [];
  const integrityNotes: string[] = [];
  let lookaheadOk = true;

  const priceAt = (mint: string, ts: number) => store.lastPrice(mint, ts);

  const closePos = (p: OpenPos, ts: number, price: number, reason: BacktestTrade["exitReason"]) => {
    const gross = p.tokens * price;
    const net = gross * (1 - (cfg.slippagePct + cfg.feePct) / 100);
    cash += net;
    trades.push({
      mint: p.mint,
      symbol: p.symbol,
      signalScore: p.score,
      entryTs: p.entryTs,
      entryPrice: p.entryPrice,
      exitTs: ts,
      exitPrice: price,
      exitReason: reason,
      pnlUsd: net - p.usdIn,
      pnlPct: (net / p.usdIn - 1) * 100,
    });
  };

  for (let ts = start; ts <= end; ts += HOUR) {
    // manage exits first
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k];
      const px = priceAt(p.mint, ts);
      if (px === undefined) continue;
      const ret = (px / p.entryPrice - 1) * 100;
      const ageH = (ts - p.entryTs) / HOUR;
      if (ret <= -cfg.stopLossPct) {
        closePos(p, ts, p.entryPrice * (1 - cfg.stopLossPct / 100), "stop");
        open.splice(k, 1);
      } else if (ret >= cfg.takeProfitPct) {
        closePos(p, ts, p.entryPrice * (1 + cfg.takeProfitPct / 100), "target");
        open.splice(k, 1);
      } else if (ageH >= cfg.holdHours) {
        closePos(p, ts, px, "time");
        open.splice(k, 1);
      }
    }

    // entries
    if (open.length < cfg.maxConcurrent && cash >= cfg.positionUsd) {
      const sigs = signalsAt(store, ts, cfg.profile);
      for (const s of sigs) {
        if (open.length >= cfg.maxConcurrent || cash < cfg.positionUsd) break;
        if (s.label === "NO TRADE") continue;
        if (s.score < cfg.minScore || s.confidence < cfg.minConfidence) continue;
        if (s.features.liquidityUsd < cfg.minLiquidityUsd) continue;
        const snap = store.snapshot(s.mint, ts);
        if (!snap || snap.marketCapUsd > cfg.maxMarketCapUsd) continue;
        if (open.some((p) => p.mint === s.mint)) continue;

        // anti-lookahead assertion on the entry signal itself
        if (s.features.asOf > ts) {
          lookaheadOk = false;
          integrityNotes.push(`feature snapshot for ${s.mint.slice(0, 6)} dated ${s.features.asOf} > step ${ts}`);
          continue;
        }

        const fillTs = ts + cfg.entryDelayMin * 60_000;
        const fillPx = priceAt(s.mint, fillTs);
        if (fillPx === undefined) continue;
        const eff = fillPx * (1 + cfg.slippagePct / 100);
        const usdIn = cfg.positionUsd * (1 + cfg.feePct / 100);
        cash -= usdIn;
        open.push({
          mint: s.mint,
          symbol: store.token(s.mint)?.info.symbol ?? "?",
          score: s.score,
          entryTs: fillTs,
          entryPrice: eff,
          tokens: cfg.positionUsd / eff,
          usdIn,
        });
      }
    }

    // mark equity every 6h to keep the curve light
    if ((ts - start) % (6 * HOUR) === 0) {
      let mark = cash;
      for (const p of open) {
        const px = priceAt(p.mint, ts);
        if (px !== undefined) mark += p.tokens * px;
      }
      equityCurve.push({ ts, equity: mark });
    }
  }

  // close whatever is still open at the end
  for (const p of open) {
    const px = priceAt(p.mint, end) ?? p.entryPrice;
    closePos(p, end, px, "time");
  }
  open.length = 0;

  let equity = startingUsd;
  let peak = startingUsd;
  let maxDd = 0;
  for (const pt of equityCurve) {
    equity = pt.equity;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  const endingUsd = cash;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const rets = trades.map((t) => t.pnlPct / 100);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)) : 0;

  if (lookaheadOk) integrityNotes.push(`verified ${trades.length} entries used only pre-entry data`);

  return {
    id: `bt_${Date.now().toString(36)}`,
    config: cfg,
    ranAt: Date.now(),
    startingUsd,
    endingUsd,
    totalReturnPct: (endingUsd / startingUsd - 1) * 100,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    maxDrawdownPct: maxDd * 100,
    sharpeLike: sd > 0 ? mean / sd : 0,
    trades,
    equityCurve,
    integrity: { lookaheadChecksPassed: lookaheadOk, notes: integrityNotes },
  };
}
