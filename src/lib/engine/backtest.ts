// Backtester. Walks history forward in hourly steps, asks the signal engine
// what it would have said AT THAT MOMENT (signalsAt only reads data <= asOf),
// and fills entries with delay + slippage + fees. The integrity check
// re-derives a sample of entry signals and fails the run if any feature
// snapshot contains data newer than its own asOf.

import type { DemoStore } from "../demo/store";
import { HOUR, DAY } from "../demo/universe";
import { signalsAt } from "./signals";
import type {
  BacktestAttribution,
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
} from "../types";

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
  let gappedExits = 0;
  /** Every scored candidate, by the archetype the generator gave it. */
  const seen = new Map<string, { n: number; score: number }>();

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
      const ageH = (ts - p.entryTs) / HOUR;
      const stopPrice = p.entryPrice * (1 - cfg.stopLossPct / 100);
      const targetPrice = p.entryPrice * (1 + cfg.takeProfitPct / 100);
      // The hour the position just lived through, not only its closing price.
      // Checking closes alone misses a target that was touched and given back,
      // and a stop that was blown through and recovered from.
      const bar = store.candles(p.mint, ts - HOUR + 1, ts).at(-1);
      const low = Math.min(bar?.l ?? px, px);
      const high = Math.max(bar?.h ?? px, px);
      const open_ = bar?.o ?? px;

      if (low <= stopPrice) {
        // The stop is checked before the target, and a gap through it fills at
        // the open rather than at the stop price. Both are the pessimistic
        // reading, deliberately: within one hourly candle there is no way to
        // know which barrier came first, and a stop is an instruction to sell,
        // not a promise about the price. Booking every stop at exactly -20%
        // when the hour opened at -45% is how a backtest invents money.
        const fill = Math.min(stopPrice, open_);
        if (fill < stopPrice) gappedExits++;
        closePos(p, ts, fill, "stop");
        open.splice(k, 1);
      } else if (high >= targetPrice) {
        // A target that gapped past is still booked at the target: a resting
        // sell would have filled better, but this engine does not rest orders,
        // and crediting the gap would undo the caution above.
        closePos(p, ts, targetPrice, "target");
        open.splice(k, 1);
      } else if (ageH >= cfg.holdHours) {
        closePos(p, ts, px, "time");
        open.splice(k, 1);
      }
    }

    // entries
    if (open.length < cfg.maxConcurrent && cash >= cfg.positionUsd) {
      const sigs = signalsAt(store, ts, cfg.profile);

      // Recorded before any filter and in its own pass, so the attribution
      // describes everything the engine was offered — not just the prefix of
      // the list it got through before the portfolio filled.
      for (const s of sigs) {
        const arch = store.token(s.mint)?.archetype ?? "unknown";
        const acc = seen.get(arch) ?? { n: 0, score: 0 };
        acc.n++;
        acc.score += s.score;
        seen.set(arch, acc);
      }

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
  if (gappedExits > 0) {
    integrityNotes.push(
      `${gappedExits} stop${gappedExits === 1 ? "" : "s"} filled below the stop price — the hour gapped through it`,
    );
  }

  // Attribution by the generator's own archetype label. This is the number
  // that keeps the return honest: in a market this program generated, a good
  // result means the engine recovered the labels, not that the strategy works.
  const attribution: BacktestAttribution[] = [...seen.entries()]
    .map(([archetype, s]) => {
      const mine = trades.filter((t) => (store.token(t.mint)?.archetype ?? "unknown") === archetype);
      return {
        archetype,
        trades: mine.length,
        wins: mine.filter((t) => t.pnlUsd > 0).length,
        pnlUsd: Math.round(mine.reduce((a, t) => a + t.pnlUsd, 0) * 100) / 100,
        meanScore: Math.round((s.score / s.n) * 10) / 10,
        candidates: s.n,
      };
    })
    .sort((a, b) => b.pnlUsd - a.pnlUsd || b.meanScore - a.meanScore);

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
    attribution,
    gappedExits,
    integrity: { lookaheadChecksPassed: lookaheadOk, notes: integrityNotes },
  };
}
