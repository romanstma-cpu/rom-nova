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
  /**
   * Net whale movement over the window the flow read ACTUALLY covered.
   *
   * Called `whaleFlow6hUsd` until now, under a column header reading "Whale
   * 6h", fed by a chain scan whose window is ten minutes. The token page
   * said so in as many words — "the flow window is ten minutes, not the life of
   * the chart" — while the scanner beside it promised six hours.
   *
   * Six hours is not available at any price this app pays: ten minutes of
   * balance deltas costs ~0.3MB and the scan is byte-budgeted. So the NAME
   * changed rather than the window, and `flowMinutes` below carries what was
   * really covered, per row, because a truncated read covers less than it asked
   * for.
   */
  whaleFlowUsd: number;
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
  /**
   * The wallets that actually moved this token in the flow window, biggest
   * first, with their net change in USD.
   *
   * A netflow figure is a summary; these are the addresses behind it, and a
   * reader can paste one into a block explorer and check. Empty when no flow
   * provider is configured — which is not the same as nobody trading.
   */
  topWallets?: { owner: string; usd: number }[];
  /** Minutes of chain actually covered by the flow read, when one happened. */
  flowMinutes?: number;
  /** False when the flow read hit its byte budget and stopped early. */
  flowComplete?: boolean;

  // ---- context a reader needs to judge the row, rather than more numbers ----

  /**
   * Where the token launched, when the source names it. "pump.fun" beside a
   * six-hour-old token says more about what a reader is looking at than any
   * factor weight does.
   */
  launchpad?: string;
  /**
   * The creator's mint history: total mints, and how many reached a real pool.
   *
   * The single most useful fact about a memecoin deployer, and today's trending
   * list carries wallets on their 1st mint and wallets on their 873rd side by
   * side. Undefined means the source did not say — never assume one.
   */
  devMints?: number;
  devMigrations?: number;
  /** Third-party risk score, 0-100, HIGHER IS RISKIER. Undefined = ungraded. */
  riskScore?: number;
  /** Share of LP locked or burned, 0..1. Undefined = the vendor did not report. */
  lpLockedPct?: number;
  /** Names of the vendor's critical findings, for the row's tooltip. */
  riskFlags?: string[];
  /** Who graded it, so the score is never mistaken for Nova's own. */
  riskSource?: string;
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
      whaleFlowUsd: f.whaleNetFlowUsd,
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
 * The doc comment here used to explain why these rows were "deliberately
 * unscored", and then why they were scored but dashed in four columns: momentum
 * and volume acceleration came only from candles, candles cost ~4.4s each at
 * GeckoTerminal, and twelve never arrived under any concurrency.
 *
 * That constraint is gone rather than worked around. A source that publishes
 * its own per-interval price and volume change answers the same question in the
 * same payload as the price, so those columns now carry numbers on every row
 * whose source supplies them — and still dash, honestly, on every row whose
 * source does not.
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
      // Whatever the source published. A zero that survives here is still
      // covered by `unmeasured`, which the UI consults before rendering a cell —
      // "+0.0%" must never stand in for "nobody looked".
      m5: snap.momentum5m ?? 0,
      h1: snap.momentum1h ?? 0,
      // The real 6h window now that the snapshot carries one. This used to be
      // the 24h figure standing in for it, which is a different measurement
      // wearing the wrong label.
      h6: snap.momentum6h ?? 0,
      h24: snap.momentum24h ?? 0,
      volumeAccel: snap.volumeAccel ?? 0,
      buys1h: snap.buys1h,
      sells1h: snap.sells1h,
      holders: snap.holders,
      holderGrowthPct: snap.holderGrowthPct ?? 0,
      top10Pct: snap.top10Pct,
      organicScore: snap.organicScore,
      socialScore: snap.socialScore,
      // No keyless source sees wallet-level flow. Declared, not faked.
      whaleFlowUsd: 0,
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
      launchpad: e.launchpad,
      devMints: e.devMints,
      devMigrations: e.devMigrations,
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
