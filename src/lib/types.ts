// Domain types for ROM Nova. Everything downstream — providers, engine,
// API, UI — speaks these shapes. Live provider adapters normalize INTO
// these types; nothing outside src/lib/providers may depend on a vendor
// payload shape.

// ---------------------------------------------------------------- tokens

export type Narrative =
  | "AI"
  | "Dogs"
  | "Cats"
  | "Politics"
  | "Gaming"
  | "Celebrity"
  | "Internet"
  | "DeFi"
  | "Community";

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  /** ms epoch of first pool creation */
  createdAt: number;
  decimals: number;
  narrative: Narrative;
  verified: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  permanentDelegate: boolean;
  devWallet: string;
  /** deterministic hue 0-360 used instead of a hosted logo in demo mode */
  hue: number;
}

/**
 * Inputs a data source may simply not have.
 *
 * The simulator knows everything about its own universe, so until real
 * providers arrived every field below was always populated and "absent" was
 * not a state the engine could be in. It is now, and absence is dangerous in
 * one specific direction: DEX Screener publishes price, liquidity and trade
 * counts but nothing about who holds the supply. Left as zeros, a token with
 * unknown concentration scores `clamp(1 - (0 - 0.1) / 0.5)` = a PERFECT
 * distribution mark, raises no concentration flag, and reports no insiders, no
 * bundlers and no snipers — the most reassuring possible reading of a token
 * nobody has checked.
 *
 * So absence is named rather than defaulted. A factor whose input is listed
 * here is dropped from the score instead of scored as zero, and the confidence
 * falls by the weight that went unmeasured.
 */
export type UnmeasuredField =
  | "top10Pct"
  | "devHoldsPct"
  | "insiderPct"
  | "bundlerPct"
  | "sniperPct"
  | "organicScore"
  | "socialScore"
  | "holders"
  | "uniqueBuyers1h"
  | "uniqueSellers1h";

/** Point-in-time market state for a token. `ts` is when it was observed. */
export interface TokenSnapshot {
  /** Fields this source could not supply. Absent or empty means all present. */
  unmeasured?: readonly UnmeasuredField[];
  mint: string;
  ts: number;
  priceUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  /** trailing 1h trade counts */
  buys1h: number;
  sells1h: number;
  uniqueBuyers1h: number;
  uniqueSellers1h: number;
  holders: number;
  /** share of supply held by top 10 wallets, 0..1 */
  top10Pct: number;
  devHoldsPct: number;
  /** 0..1 — how organic trading looks (wash/bot activity lowers it) */
  organicScore: number;
  /** 0..1 — social attention level */
  socialScore: number;
  bundlerPct: number;
  sniperPct: number;
  insiderPct: number;
}

export interface Candle {
  /** ms epoch, open time */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** USD volume in the bar */
  v: number;
}

// ---------------------------------------------------------------- wallets

export type WalletLabel =
  | "smart_trader"
  | "whale"
  | "insider"
  | "dev"
  | "sniper"
  | "bundler"
  | "fund"
  | "bot"
  | "exchange"
  | "fresh";

export interface SmartMoneyScore {
  total: number; // 0..100
  performance: number;
  timing: number;
  consistency: number;
  riskManagement: number;
  diversification: number;
  dataConfidence: number;
}

export interface WalletBehavior {
  /** 0..1 tendency to enter within the first hours of a token's life */
  earlyBird: number;
  /** 0..1 momentum chasing vs mean reversion (1 = pure chaser) */
  momentumBias: number;
  /** typical entry market cap, USD */
  typicalEntryMcap: number;
  /** typical exit multiple on winners */
  typicalExitMultiple: number;
  /** median holding period, hours */
  medianHoldHours: number;
  preferredDex: Dex;
  smallCapPreference: number; // 0..1
}

export interface WalletInfo {
  address: string;
  displayName?: string;
  labels: WalletLabel[];
  knownEntity?: string;
  fundingSource?: string;
  firstSeen: number;
  lastActive: number;
  solBalance: number;
  smartMoney: SmartMoneyScore;
  behavior: WalletBehavior;
}

export interface WalletPerformance {
  address: string;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  roiPct: number;
  winRate: number; // 0..1
  profitFactor: number;
  avgWinUsd: number;
  avgLossUsd: number;
  maxDrawdownPct: number;
  sharpeLike: number;
  medianHoldHours: number;
  trades: number;
}

export type Dex = "Raydium" | "Orca" | "Meteora" | "Pump.fun" | "Phoenix";

export type TradeClassification =
  | "open"
  | "add"
  | "reduce"
  | "exit"
  | "rotate"
  | "transfer"
  | "lp"
  | "unknown";

export interface WalletTrade {
  id: string;
  signature: string;
  wallet: string;
  mint: string;
  ts: number;
  side: "buy" | "sell";
  amountUsd: number;
  amountTokens: number;
  priceUsd: number;
  dex: Dex;
  classification: TradeClassification;
  /** 0..1 — how confident the pipeline is in wallet attribution + classification */
  confidence: number;
}

export interface WalletPosition {
  wallet: string;
  mint: string;
  tokens: number;
  costBasisUsd: number;
  openedAt: number;
  lastChangedAt: number;
}

export interface WalletCluster {
  id: string;
  name: string;
  members: string[];
  sharedTokens: string[];
  /** median seconds between correlated entries */
  entryLagSec: number;
  /** 0..1 evidence strength */
  cohesion: number;
  detectedAt: number;
  evidence: string[];
}

// ---------------------------------------------------------------- signals

export type SignalKind =
  | "early_accumulation"
  | "momentum_ignition"
  | "whale_breakout"
  | "smart_money_rotation"
  | "liquidity_expansion"
  | "holder_expansion"
  | "volume_dislocation"
  | "social_momentum"
  | "mean_reversion"
  | "whale_exit_warning"
  | "distribution_warning"
  | "rug_risk_escalation"
  | "liquidity_collapse"
  | "coordinated_activity";

export type SignalLabel =
  | "EXTREME POSITIVE"
  | "STRONG POSITIVE"
  | "POSITIVE"
  | "WATCH"
  | "NEUTRAL"
  | "WEAK"
  | "NEGATIVE"
  | "EXTREME RISK"
  | "NO TRADE";

export type StrategyProfileId =
  | "conservative"
  | "balanced"
  | "aggressive"
  | "early_gem"
  | "smart_money"
  | "momentum"
  | "mean_reversion"
  | "whale_shadow"
  | "high_risk";

/** Everything the engine measured for one token at one moment. All values
 * are the RAW measurements; normalization happens inside the engine and is
 * stored per-factor so any historical score can be reproduced. */
export interface FeatureVector {
  asOf: number;
  mint: string;
  smartMoneyNetFlowUsd: number;
  smartMoneyWallets: number;
  whaleNetFlowUsd: number;
  whaleBuys: number;
  whaleSells: number;
  momentum1h: number; // pct
  momentum5m: number;
  momentum24h: number;
  volumeAccel: number; // ratio of recent vs prior window volume
  liquidityUsd: number;
  liquidityChangePct: number;
  holderGrowthPct: number;
  top10Pct: number;
  organicScore: number;
  socialScore: number;
  socialAccel: number;
  ageHours: number;
  buySellImbalance: number; // -1..1
  insiderPct: number;
  bundlerPct: number;
  sniperPct: number;
  devHoldsPct: number;
  devSold: boolean;
  exitDepthUsd: number; // how much can exit within 5% impact
  regime: MarketRegime;
  /** count of independent data points behind this vector */
  sampleSize: number;
  /** ms since the stalest input */
  worstStalenessMs: number;
  /**
   * Fields carried through from the snapshot that no provider could supply.
   * The scorer drops the factors that depend on them rather than reading their
   * zeros as good news.
   */
  unmeasured?: readonly UnmeasuredField[];
}

export interface SignalFactor {
  key: string;
  name: string;
  raw: number;
  normalized: number; // 0..1
  weight: number;
  /** signed points contributed to the 0-100 score */
  contribution: number;
  explanation: string;
}

export interface RiskFlag {
  key: string;
  name: string;
  severity: "low" | "medium" | "high";
  detail: string;
}

export type SignalLifecycleState =
  | "created"
  | "confirmed"
  | "strengthened"
  | "weakened"
  | "invalidated"
  | "triggered"
  | "expired";

export interface SignalLifecycleEvent {
  state: SignalLifecycleState;
  ts: number;
  note?: string;
}

export interface SignalOutcome {
  evaluatedAt: number;
  return1h: number | null;
  return24h: number | null;
  maxFavorable: number | null;
  maxAdverse: number | null;
  hit: boolean | null;
}

export interface Signal {
  id: string;
  mint: string;
  kind: SignalKind;
  createdAt: number;
  updatedAt: number;
  score: number; // 0..100
  confidence: number; // 0..1
  label: SignalLabel;
  /**
   * Why the engine abstained, when it did.
   *
   * The label already says NO TRADE; this says which gate closed — confidence
   * below the profile floor, liquidity too thin, or the newer one that matters
   * on live data: too much of the model unavailable. Abstaining is a headline
   * property of this engine and it was previously unauditable, because the
   * reason was computed, used to pick a label, and thrown away.
   */
  noTradeReason?: string;
  profile: StrategyProfileId;
  factors: SignalFactor[];
  risks: RiskFlag[];
  invalidation: string[];
  bearCase: string[];
  why: string[];
  engineVersion: string;
  features: FeatureVector;
  lifecycle: SignalLifecycleEvent[];
  outcome?: SignalOutcome;
}

// ---------------------------------------------------------------- risk

export interface RiskRadar {
  mint: string;
  overall: RiskLevel;
  security: RiskLevel;
  liquidity: RiskLevel;
  concentration: RiskLevel;
  dev: RiskLevel;
  bundler: RiskLevel;
  organic: RiskLevel;
  structure: RiskLevel;
  notes: string[];
}

export type RiskLevel = "low" | "medium" | "high";

// ---------------------------------------------------------------- market

export type MarketRegime =
  | "risk_on"
  | "neutral"
  | "risk_off"
  | "meme_mania"
  | "low_liquidity"
  | "high_volatility"
  | "rotation"
  | "distribution";

export interface MarketState {
  ts: number;
  solPriceUsd: number;
  solChange24hPct: number;
  regime: MarketRegime;
  regimeConfidence: number;
  memeMomentumIndex: number; // 0..100
  netSmartMoneyFlowUsd: number;
  activeWhales24h: number;
  slot: number;
}

// ---------------------------------------------------------------- events

export type LiveEventKind =
  | "whale_buy"
  | "whale_sell"
  | "smart_money_buy"
  | "smart_money_sell"
  | "new_position"
  | "position_exit"
  | "cluster_detected"
  | "liquidity_add"
  | "liquidity_remove"
  | "risk_event"
  | "signal_created"
  | "signal_invalidated"
  | "new_token";

export interface LiveEvent {
  id: string;
  kind: LiveEventKind;
  ts: number;
  mint?: string;
  wallet?: string;
  amountUsd?: number;
  headline: string;
  detail: string;
  confidence?: number;
  signature?: string;
}

// ---------------------------------------------------------------- user state

export interface WatchlistItem {
  kind: "token" | "wallet";
  ref: string;
  addedAt: number;
  note?: string;
}

export interface Watchlist {
  id: string;
  name: string;
  items: WatchlistItem[];
  createdAt: number;
}

export type AlertCondition =
  | { type: "whale_buy"; minUsd: number; mint?: string }
  | { type: "whale_sell"; minUsd: number; mint?: string }
  | { type: "signal_score_above"; threshold: number; mint?: string }
  | { type: "risk_score_above"; threshold: number; mint?: string }
  | { type: "volume_spike"; multiple: number; mint?: string }
  | { type: "liquidity_drop"; pct: number; mint?: string }
  | { type: "wallet_activity"; wallet: string };

export interface AlertRule {
  id: string;
  name: string;
  condition: AlertCondition;
  channels: ("in_app" | "browser" | "webhook")[];
  enabled: boolean;
  createdAt: number;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ts: number;
  headline: string;
  detail: string;
  mint?: string;
  wallet?: string;
  read: boolean;
}

// ---------------------------------------------------------------- paper

export interface PaperOrder {
  id: string;
  portfolioId: string;
  mint: string;
  side: "buy" | "sell";
  requestedUsd: number;
  ts: number;
  status: "filled" | "rejected";
  rejectReason?: string;
}

export interface PaperFill {
  orderId: string;
  ts: number;
  priceUsd: number;
  tokens: number;
  usd: number;
  feeUsd: number;
  slippagePct: number;
  priceImpactPct: number;
}

export interface PaperPosition {
  mint: string;
  tokens: number;
  costBasisUsd: number;
  openedAt: number;
  stopLossPct?: number;
  takeProfitPct?: number;
}

export interface PaperPortfolio {
  id: string;
  name: string;
  createdAt: number;
  startingUsd: number;
  cashUsd: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  fills: PaperFill[];
  realizedPnlUsd: number;
}

// ---------------------------------------------------------------- backtest

export interface BacktestConfig {
  profile: StrategyProfileId;
  days: number;
  minLiquidityUsd: number;
  maxMarketCapUsd: number;
  minScore: number;
  minConfidence: number;
  holdHours: number;
  stopLossPct: number;
  takeProfitPct: number;
  positionUsd: number;
  maxConcurrent: number;
  slippagePct: number;
  feePct: number;
  entryDelayMin: number;
}

export interface BacktestTrade {
  mint: string;
  symbol: string;
  signalScore: number;
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  exitReason: "stop" | "target" | "time";
  pnlUsd: number;
  pnlPct: number;
}

/**
 * Where the result came from, in the simulation's own terms.
 *
 * Every token in this market is generated from an archetype the generator
 * chose in advance — moonshot, rug, chopper, and so on — and the features the
 * signal engine reads are generated from that same archetype. So a good
 * backtest return here is not evidence that the strategy works; it is evidence
 * that the engine can recover the label the generator assigned. Showing that
 * breakdown next to the return is the difference between a demonstration and a
 * performance claim.
 */
export interface BacktestAttribution {
  archetype: string;
  trades: number;
  wins: number;
  pnlUsd: number;
  /** Mean signal score across every token of this archetype the engine saw. */
  meanScore: number;
  /** How many of that archetype existed to be bought. */
  candidates: number;
}

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  ranAt: number;
  startingUsd: number;
  endingUsd: number;
  totalReturnPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeLike: number;
  trades: BacktestTrade[];
  equityCurve: { ts: number; equity: number }[];
  attribution: BacktestAttribution[];
  /** Exits that could not fill at the barrier because the hour gapped past it. */
  gappedExits: number;
  integrity: {
    lookaheadChecksPassed: boolean;
    notes: string[];
  };
}

// ---------------------------------------------------------------- providers

export interface ProviderHealth {
  name: string;
  mode: "live" | "demo" | "disabled";
  status: "ok" | "degraded" | "down";
  latencyMs: number;
  errorRatePct: number;
  lastSuccessTs: number;
  lastDataTs: number;
  note?: string;
}

export const ENGINE_VERSION = "1.0.0";
export const FEATURE_SCHEMA_VERSION = "1";
