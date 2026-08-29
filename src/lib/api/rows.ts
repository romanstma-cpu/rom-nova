// Row builders shared by dashboard, screener, scanner and API responses.
// Rows are assembled from the signal batch (already cached per time bucket)
// so a request renders one consistent world-state instead of re-deriving
// each column separately.

import type { DemoStore } from "../demo/store";
import { HOUR } from "../demo/universe";
import { signalsAt } from "../engine/signals";
import type {
  RiskLevel,
  Signal,
  StrategyProfileId,
  TokenInfo,
  TokenSnapshot,
  UnmeasuredField,
} from "../types";

export interface TokenRow {
  mint: string;
  symbol: string;
  name: string;
  narrative: string;
  hue: number;
  verified: boolean;
  archetype?: string;
  ageHours: number;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  m5: number;
  h1: number;
  h6: number;
  h24: number;
  buys1h: number;
  sells1h: number;
  holders: number;
  holderGrowthPct: number;
  top10Pct: number;
  organicScore: number;
  socialScore: number;
  volumeAccel: number;
  whaleFlow6hUsd: number;
  smFlow6hUsd: number;
  smWallets: number;
  signalScore: number;
  signalLabel: string;
  signalKind: string;
  signalId: string;
  confidence: number;
  riskLevel: RiskLevel;
  dataTs: number;
  /**
   * Whether a signal was actually computed for this row.
   *
   * False is NOT a low score and must never render as one. A live token from a
   * keyless source has no wallet-flow or holder data behind it, so the engine
   * refuses to build a vector at all rather than emit zeros that would read as
   * flat momentum over a clean cap table. `signalScore` is 0 on those rows
   * because the field is not optional, and every reader of it must consult this
   * flag first.
   */
  scored: boolean;
  /** Why there is no score, for the cell's tooltip. */
  unscoredReason?: string;
  /**
   * Columns this row's source could not supply. Same contract as
   * TokenSnapshot.unmeasured: a listed field is absent, not zero.
   */
  unmeasured?: readonly UnmeasuredField[];
  /** Which adapter produced the market numbers. "demo" is the simulator. */
  source: string;
}

/** Numeric columns a keyless snapshot cannot fill without candle history. */
export const NO_CANDLE_COLUMNS = ["m5", "h1", "h6", "h24", "volumeAccel"] as const;

export function riskLevelOf(s: Signal): RiskLevel {
  const high = s.risks.filter((r) => r.severity === "high").length;
  const med = s.risks.filter((r) => r.severity === "medium").length;
  return high >= 2 ? "high" : high === 1 || med >= 3 ? "medium" : "low";
}

export function buildTokenRows(
  store: DemoStore,
  asOf?: number,
  profile: StrategyProfileId = "balanced",
): TokenRow[] {
  const now = asOf ?? store.simulatedUntil;
  const signals = signalsAt(store, now, profile);
  const rows: TokenRow[] = [];
  for (const s of signals) {
    const tok = store.token(s.mint);
    const snap = store.snapshot(s.mint, asOf);
    if (!tok || !snap) continue;
    const f = s.features;
    const candles = tok.candles;
    const i = candles.length - 1;
    const h6 =
      i >= 6 && candles[i - 6].c > 0 ? (snap.priceUsd / candles[Math.max(0, i - 6)].c - 1) * 100 : f.momentum24h;
    rows.push({
      mint: s.mint,
      symbol: tok.info.symbol,
      name: tok.info.name,
      narrative: tok.info.narrative,
      hue: tok.info.hue,
      verified: tok.info.verified,
      archetype: tok.archetype,
      ageHours: f.ageHours,
      priceUsd: snap.priceUsd,
      marketCapUsd: snap.marketCapUsd,
      liquidityUsd: snap.liquidityUsd,
      volume24hUsd: snap.volume24hUsd,
      m5: f.momentum5m,
      h1: f.momentum1h,
      h6,
      h24: f.momentum24h,
      buys1h: snap.buys1h,
      sells1h: snap.sells1h,
      holders: snap.holders,
      holderGrowthPct: f.holderGrowthPct,
      top10Pct: snap.top10Pct,
      organicScore: snap.organicScore,
      socialScore: snap.socialScore,
      volumeAccel: f.volumeAccel,
      whaleFlow6hUsd: f.whaleNetFlowUsd,
      smFlow6hUsd: f.smartMoneyNetFlowUsd,
      smWallets: f.smartMoneyWallets,
      signalScore: s.score,
      signalLabel: s.label,
      signalId: s.id,
      signalKind: s.kind,
      confidence: s.confidence,
      riskLevel: riskLevelOf(s),
      dataTs: snap.ts,
      scored: true,
      source: "demo",
    });
  }
  return rows;
}

/**
 * Rows for REAL Solana tokens, from a live token provider.
 *
 * Deliberately unscored. `liveFeatures` needs candle history to build a vector
 * and refuses without it — and a scored live list turned out to be impossible
 * rather than merely slow: measured over twelve trending tokens, GeckoTerminal
 * rate-limits under any concurrency and returned zero usable candle sets in
 * thirty-seven seconds (`npm run probe:list`). Raising concurrency made
 * per-token latency worse, which is a rate limit rather than a slow endpoint.
 *
 * So this returns what a single cheap call per token really knows — price,
 * market cap, liquidity, 24h volume, and the 1h trade counts — and names
 * everything else absent. Opening one token still scores it properly, because
 * one candle fetch is affordable where twelve are not.
 */
export function buildLiveTokenRows(
  entries: (TokenInfo & { snapshot: TokenSnapshot })[],
  source: string,
  now = Date.now(),
): TokenRow[] {
  return entries.map((e) => {
    const snap = e.snapshot;
    const unmeasured = snap.unmeasured ?? [];
    return {
      mint: e.mint,
      symbol: e.symbol,
      name: e.name,
      narrative: e.narrative,
      hue: e.hue,
      verified: e.verified,
      ageHours: e.createdAt > 0 ? (now - e.createdAt) / 3_600_000 : 0,
      priceUsd: snap.priceUsd,
      marketCapUsd: snap.marketCapUsd,
      liquidityUsd: snap.liquidityUsd,
      volume24hUsd: snap.volume24hUsd,
      // Momentum needs candles, and candles are what this path cannot afford.
      // Zero here means "not fetched"; NO_CANDLE_COLUMNS is what says so.
      m5: 0,
      h1: 0,
      h6: 0,
      h24: 0,
      volumeAccel: 0,
      buys1h: snap.buys1h,
      sells1h: snap.sells1h,
      holders: snap.holders,
      holderGrowthPct: 0,
      top10Pct: snap.top10Pct,
      organicScore: snap.organicScore,
      socialScore: snap.socialScore,
      // No keyless source sees wallet-level flow. Declared, not faked.
      whaleFlow6hUsd: 0,
      smFlow6hUsd: 0,
      smWallets: 0,
      signalScore: 0,
      signalLabel: "not scored",
      signalKind: "none",
      signalId: "",
      confidence: 0,
      riskLevel: "medium" as RiskLevel,
      dataTs: snap.ts,
      scored: false,
      unscoredReason:
        `${source} supplies price and liquidity but no candle history, holder ` +
        `distribution or wallet flow — the scorer refuses a vector rather than ` +
        `read those absences as zeros. Open the token to score it.`,
      unmeasured,
      source,
    };
  });
}

export interface WalletRow {
  address: string;
  displayName?: string;
  knownEntity?: string;
  labels: string[];
  smartMoneyScore: number;
  smartMoney: import("../types").SmartMoneyScore;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  roiPct: number;
  winRate: number;
  profitFactor: number;
  trades: number;
  medianHoldHours: number;
  openPositions: number;
  lastActive: number;
  solBalance: number;
}

export function buildWalletRows(store: DemoStore): WalletRow[] {
  const rows: WalletRow[] = [];
  for (const w of store.walletList()) {
    const perf = store.perfs.get(w.address);
    const ledger = store.ledgers.get(w.address);
    if (!perf || !ledger) continue;
    const liveLast = store.liveTrades.filter((t) => t.wallet === w.address).at(-1)?.ts;
    rows.push({
      address: w.address,
      displayName: w.displayName,
      knownEntity: w.knownEntity,
      labels: w.labels,
      smartMoneyScore: w.smartMoney.total,
      smartMoney: w.smartMoney,
      realizedPnlUsd: perf.realizedPnlUsd,
      unrealizedPnlUsd: perf.unrealizedPnlUsd,
      roiPct: perf.roiPct,
      winRate: perf.winRate,
      profitFactor: perf.profitFactor,
      trades: perf.trades,
      medianHoldHours: perf.medianHoldHours,
      openPositions: ledger.positions.length,
      lastActive: liveLast ?? w.lastActive,
      solBalance: w.solBalance,
    });
  }
  return rows.sort((a, b) => b.smartMoneyScore - a.smartMoneyScore);
}

/** hourly net-flow buckets for the flow charts */
export interface FlowPoint {
  ts: number;
  whaleBuyUsd: number;
  whaleSellUsd: number;
  smNetUsd: number;
  priceUsd: number;
}

export function buildFlowSeries(store: DemoStore, mint: string | null, hours = 72, asOf?: number): FlowPoint[] {
  const now = asOf ?? store.simulatedUntil;
  const from = now - hours * HOUR;
  const points = new Map<number, FlowPoint>();
  for (let h = 0; h <= hours; h++) {
    const ts = Math.floor((from + h * HOUR) / HOUR) * HOUR;
    points.set(ts, { ts, whaleBuyUsd: 0, whaleSellUsd: 0, smNetUsd: 0, priceUsd: 0 });
  }
  const trades = mint
    ? store.mintTrades(mint, from, now)
    : [...store.universe.trades, ...store.liveTrades].filter((t) => t.ts >= from && t.ts <= now);
  for (const t of trades) {
    const bucket = Math.floor(t.ts / HOUR) * HOUR;
    const pt = points.get(bucket);
    if (!pt) continue;
    const w = store.wallet(t.wallet);
    const isWhale = (w && w.labels.includes("whale")) || t.amountUsd >= 20_000;
    if (isWhale) {
      if (t.side === "buy") pt.whaleBuyUsd += t.amountUsd;
      else pt.whaleSellUsd += t.amountUsd;
    }
    if (w && w.smartMoney.total >= 65) pt.smNetUsd += t.side === "buy" ? t.amountUsd : -t.amountUsd;
  }
  if (mint) {
    for (const pt of points.values()) pt.priceUsd = store.lastPrice(mint, pt.ts) ?? 0;
  }
  return [...points.values()].sort((a, b) => a.ts - b.ts);
}
