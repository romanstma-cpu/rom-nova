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
  /**
   * Where the token was launched, when the source names it — "pump.fun",
   * "bonk.fun", and so on. Absent means unknown, NOT self-deployed.
   */
  launchpad?: string;
  /** ms epoch the launchpad bonding curve completed, when it did. */
  graduatedAt?: number;
  /**
   * How many mints this creator has issued, and how many reached a real pool.
   *
   * The single most useful fact about a memecoin deployer and the one no price
   * feed carries: a wallet on its first mint and a wallet on its 873rd are not
   * the same counterparty. Measured live — the trending list routinely carries
   * both. Absent means the source did not say, which is not the same as one.
   */
  devMints?: number;
  devMigrations?: number;
  /**
   * Where the project says it lives, when the source carries it.
   *
   * Not a safety signal — anybody can put a link in token metadata — but a
   * memecoin with no site, no X account and no group is a different object from
   * one with all three, and every reference terminal shows them.
   */
  links?: { twitter?: string; telegram?: string; website?: string };
  /** Hosted logo, when the source has one. Absent falls back to `hue`. */
  icon?: string;
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
  | "uniqueSellers1h"
  /**
   * Price history. Needs candles, and candles are the one call a list of
   * tokens cannot afford — measured at 4.4s each, and zero of twelve returned
   * under any concurrency. Declaring it lets a token be scored on what IS
   * known instead of refused outright.
   */
  | "momentum"
  | "volumeAccel"
  /**
   * POOLED LIQUIDITY. The field this list was built for, and the one it was
   * missing.
   *
   * Jupiter returns `liquidity: undefined` on a freshly-minted token — its
   * indexer has not priced the pool yet — and the snapshot builder coerced that
   * to `0` while the LAUNCH builder in the same file passed it through and
   * rendered "the source has not priced this pool yet". One field, two
   * behaviours, twelve lines apart.
   *
   * The coerced side is the one that reaches the scorer, and a zero there is
   * not a small error. Measured on 747MxrN9…pump at one minute old: "Liquidity
   * Quality -16.4, $0 pooled" against "-1.0, $3.6K pooled" for the same mint
   * minutes later, with Jupiter's API reporting liquidity=3160.13 the whole
   * time. Every new mint's score was depressed by roughly sixteen points by an
   * absence rendered as a confident zero — on precisely the population a
   * launch terminal exists to look at.
   *
   * The liquidity factor also gates `exitDepthUsd`, `regimeOf` and the
   * profiles' `minLiquidityUsd` floor, so this is the widest-blast-radius
   * absence in the vector.
   */
  | "liquidity"
  /**
   * 24h CHANGE in that pool, and in the holder count.
   *
   * Separate from the levels, because a source can publish a level and no
   * history — which is exactly the case on a token minutes old. Both were
   * `?? 0` in `liveFeatures`, so a mint four minutes into its life scored
   * "liquidity +0.0% vs 24h ago" and "holders +0.0% over 24h": measurements of
   * a period that has not happened yet.
   */
  | "liquidityChange"
  | "holderGrowth"
  /**
   * Wallet flow. Real when a flow provider is configured and nothing at all
   * without one — and until it was declarable, the whale and smart-money
   * factors scored their placeholder zeros as "nobody is accumulating this",
   * which is a finding rather than the absence it actually was.
   */
  | "whaleFlow"
  /**
   * Smart money specifically, which stays unmeasured even WITH a flow provider:
   * knowing who moved is not knowing whether they are any good, and no source
   * here carries wallet reputation.
   */
  | "smartMoney"
  /**
   * Mint and freeze authority, together, because one source reads the mint
   * account and gets both or neither.
   *
   * These reached the UI for a long time and never reached the SCORE. The
   * scorer had no field to read them from, so a token whose deployer could
   * still mint at will was graded on liquidity and momentum like any other,
   * and could render POSITIVE inches from a security panel saying the supply
   * was not fixed.
   *
   * Declaring them makes the three states distinct, which is the whole point:
   * REVOKED is a measured good result, LIVE is a measured bad one, and
   * UNVERIFIED is neither — the factor stands down and the engine abstains
   * rather than treating an unexamined mint as a safe one.
   */
  | "authorities"
  /**
   * A permanent delegate — an SPL-2022 extension whose holder can move any
   * balance without permission. Only the risk vendor reports it; every token
   * adapter hardcodes `permanentDelegate: false`, which is a default and not
   * a reading.
   */
  | "permanentDelegate"
  /**
   * Share of the liquidity pool that is locked or burned.
   *
   * The actual rug mechanic. Nothing else in this stack sees it, and the
   * simulator does not model it at all, so a demo vector declares it here
   * rather than inventing a lock.
   */
  | "lpLocked"
  /**
   * How many independent parties provide that liquidity.
   *
   * Without it an unlocked pool reads as "the deployer can withdraw it", which
   * is only true when one party holds the LP. The vendor returns 0 for "not
   * computed" on most mints, so this is unmeasured far more often than not.
   */
  | "lpProviders"
  /**
   * Whether the deployer has been SELLING, as opposed to how much it holds.
   *
   * The simulator knows; nothing live does. It was hardcoded `false` on every
   * live token, which quietly disabled the high-severity "Dev selling" flag,
   * the rug-escalation branch, and half of the dev risk factor — while the
   * invalidation copy promised the reader that flag would appear.
   */
  | "devSold"
  /**
   * How many tokens this deployer has minted, and how many reached a pool.
   *
   * Displayed prominently on the page ("this wallet has issued 19,042 mints…
   * a serial deployer is a warning") and, until it was declared here, invisible
   * to the scorer — the same failure as the authorities, one card over.
   */
  | "devHistory";

/** The four windows every reference terminal breaks activity down by. */
export type TradeWindowKey = "5m" | "1h" | "6h" | "24h";

/**
 * Trade activity in one window, exactly as the source published it.
 *
 * Every field optional and NOTHING defaulted, because this is the panel a
 * reader scans fastest and a zero here is the cheapest possible lie: "0 buys /
 * 0 sells" and "the source does not break this window out" render identically
 * unless the type can tell them apart.
 *
 * `traders` is what DEX Screener and Photon label MAKERS. Jupiter counts it
 * directly (`numTraders`); DEX Screener does not publish it at all, so it stays
 * undefined there rather than being approximated from buys + sells, which would
 * count one wallet that did both twice.
 */
export interface TradeWindow {
  buys?: number;
  sells?: number;
  traders?: number;
  buyVolumeUsd?: number;
  sellVolumeUsd?: number;
}

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
  /**
   * Rate-of-change stats the SOURCE computed, when it publishes them.
   *
   * These exist because of a constraint that shaped this whole app: momentum
   * and volume acceleration were derived only from candles, candles cost ~4.4s
   * each at GeckoTerminal, and twelve of them never arrived — so every row in
   * the scanner rendered a dash in four columns and the two matching factors
   * stood down on every live token the terminal has ever shown.
   *
   * Jupiter publishes priceChange and volumeChange per interval in the SAME
   * response as the token list. That is not a workaround for missing candles;
   * it is a different measurement of the same quantity, taken by someone with
   * better data than a public OHLCV endpoint will hand out for free.
   *
   * Candles still win where both exist — they are bars this app can plot and
   * audit, and `fromCandles` computes over windows it controls. These fill in
   * only when there are none. Absent means the source published nothing, and
   * the field stays in the unmeasured set.
   */
  momentum1h?: number;
  momentum24h?: number;
  momentum5m?: number;
  /**
   * The 6h window, carried because every reference terminal leads with
   * 5m/1h/6h/24h and this was the one of the four nothing here published.
   * `rows.ts` was filling its 6h column with the 24h figure.
   */
  momentum6h?: number;
  /** 6h volume over its trailing baseline; 1.0 is "running at its usual rate". */
  volumeAccel?: number;
  /** 24h change in holder count, percent. */
  holderGrowthPct?: number;
  /** 24h change in pooled liquidity, percent. A draining pool is the rug tell. */
  liquidityChangePct?: number;
  /**
   * Buys, sells and distinct traders per window.
   *
   * The single most-glanced-at block on every reference terminal, and the one
   * thing this app had in its payload and never showed: `buys1h` and `sells1h`
   * were already in the vector, surfaced only as a derived "imbalance %" buried
   * in one audit row. Jupiter ships all four windows in the same response as the
   * price, so this costs nothing extra to carry.
   *
   * Absent when the source publishes no per-window breakdown at all.
   */
  windows?: Partial<Record<TradeWindowKey, TradeWindow>>;
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

// ------------------------------------------------- real wallets, read on-chain
//
// Everything above this line describes a wallet the simulator invented and
// therefore knows completely. The types below describe a wallet that exists,
// which is a different epistemic situation: the chain answers some questions
// exactly, refuses others, and — the part that gets people hurt — looks
// identical either way once a number reaches a table cell.
//
// So a measured value and an absent one are DIFFERENT TYPES here. `priceUsd?:
// number` on a fill is not laziness; it is the difference between "this trade
// went off at four cents" and "we watched tokens move and never saw what was
// paid for them". A zero in that slot reads as free.

/**
 * What a wallet read could not establish.
 *
 * Kept separate from `UnmeasuredField`, which names inputs to the TOKEN scorer
 * and is consumed by factor `needs`. Mixing them would let a wallet-shaped gap
 * silently stand down a token factor that never depended on it.
 */
export type UnmeasuredWalletField =
  /**
   * Entry prices for some or all held tokens were never observed, so the
   * position's cost — and therefore its unrealized PnL — is not knowable.
   * Caused by acquisition before the readable window, or by a transfer in.
   */
  | "costBasis"
  /**
   * Sells landed whose matching buys were outside the window. Their proceeds
   * are real and their PROFIT is not computable, so they are excluded from
   * realized PnL rather than being credited at a cost of zero — which would
   * book the entire proceeds as gain.
   */
  | "realizedPnl"
  /**
   * The wallet's full trading life. No keyless source publishes it: the only
   * public Solana RPC that answers `getSignaturesForAddress` at all retains
   * roughly two days. Everything here is a WINDOW, and this field is set on
   * every real wallet read, always, so nothing downstream can mistake a
   * two-day figure for a lifetime one.
   */
  | "lifetimeHistory"
  /**
   * Whether this wallet is any good in a way that generalises. Win rate over
   * two days is a sample, not a reputation, and no keyless source carries one.
   */
  | "reputation"
  /**
   * The price of at least one observed movement. Tokens moved, no SOL or
   * stablecoin leg belonged to this wallet in that transaction, so there is
   * nothing to divide by.
   */
  | "fillPrice";

/** How a fill's price was established, or why it could not be. */
export type FillPricing =
  /** Paid or received in wrapped SOL, converted at the SOL/USD bar for that hour. */
  | "wsol"
  /** Paid or received in a stablecoin, taken at one dollar. */
  | "stable"
  /** Tokens moved; nothing this wallet owned moved against them. */
  | "unpriced";

/**
 * One observed change in a wallet's holding of one token.
 *
 * Deliberately not `WalletTrade`. A trade has a price by definition and this
 * frequently does not — 46% of the token movements measured across five real
 * wallets had no quote leg belonging to the wallet at all, because they were
 * transfers, claims, or token-for-token rotations routed entirely through
 * pools. Those are real events a reader should see; they are not fills at a
 * price, and the type says so.
 */
export interface WalletFill {
  signature: string;
  slot: number;
  /** ms epoch, from the block. */
  ts: number;
  wallet: string;
  /** The non-quote token that moved. */
  mint: string;
  decimals: number;
  side: "buy" | "sell";
  /** Base tokens moved. Always positive; `side` carries the direction. */
  tokens: number;
  /** wSOL or a stablecoin, when one leg of the swap was the wallet's own. */
  quoteMint?: string;
  /** Quote units paid or received. Always positive. */
  quoteAmount?: number;
  /** USD per base token AT THE FILL. Undefined means nobody saw it. */
  priceUsd?: number;
  /** USD notional of the fill, undefined for the same reason as `priceUsd`. */
  valueUsd?: number;
  pricing: FillPricing;
  /** One short clause the UI can print in place of a dollar figure. */
  unpricedReason?: string;
  classification: TradeClassification;
}

/**
 * Exactly how much of a wallet's life was read, in the read's own terms.
 *
 * The most dangerous number this app can render is a realized-PnL figure over
 * a window presented as a wallet's performance. Every field here exists to
 * make that impossible to do by accident: a caller cannot format the PnL
 * without having the window sitting next to it in the same object.
 */
export interface WalletCoverage {
  /** The adapter that answered — "solana-rpc", never "demo" for a real read. */
  source: string;
  /**
   * Which runtime read this, because the three see different depths.
   *
   * The archival RPC refuses any request carrying an Origin header, so a
   * browser tab is capped at ~2 days while the server route and the desktop
   * shell's main-process proxy reach the whole index. One label over all three
   * would be false for two of them.
   */
  runtime: "node" | "desktop" | "browser";
  /** ms epoch of the newest and oldest transaction actually read. */
  newestTs: number;
  oldestTs: number;
  /** The span the PRICED FILLS below describe. Not the wallet's age. */
  windowHours: number;
  signaturesListed: number;
  transactionsRead: number;
  transactionsFailed: number;
  /**
   * Transactions the fast endpoint no longer holds the body for.
   *
   * Not a failure and not counted as one: measured, publicnode returns null for
   * every signature older than ~2 days while serving recent ones perfectly.
   * The index still counts these, so a wallet can show 5,942 lifetime
   * transactions and 112 priced ones without either number being wrong.
   */
  transactionsUnavailable: number;
  /**
   * How many of `transactionsFailed` were the endpoint's rate limit rather
   * than a genuine miss.
   *
   * Worth its own field because the two have opposite remedies. A refusal is
   * temporary and a reload fixes it; a failure is a transaction this read will
   * never see, and no amount of waiting brings it back.
   */
  transactionsRefused: number;
  /** Our own budget stopped the read before the endpoint ran out of history. */
  cappedByBudget: boolean;
  /**
   * The endpoint returned no signatures older than `oldestTs`.
   *
   * NOT the same as "this wallet has no older history". Measured against a
   * quiet, years-old address, publicnode's oldest signature was 2.02 days back
   * and paging before it returned nothing — a retention edge, not a birth
   * certificate.
   */
  reachedEndpointLimit: boolean;
  /** False on every keyless read. Present so a keyed source could set it true. */
  lifetime: boolean;
  /**
   * True when the SIGNATURE INDEX reached past the ~2-day public window.
   *
   * Deliberately separate from `lifetime`. The index being archival means the
   * wallet's AGE and lifetime transaction COUNT are real; it does not mean the
   * fills are, because the only endpoint serving old transaction bodies allows
   * ten `getTransaction` calls per window.
   */
  indexArchival: boolean;
  /** The index ran out naturally rather than hitting our page cap. */
  indexComplete: boolean;
  /**
   * ms epoch of the OLDEST signature the index reached.
   *
   * With `indexArchival && indexComplete` this is the wallet's first ever
   * transaction. Otherwise it is a lower bound: the wallet is AT LEAST this
   * old. A reader must never be shown the second as though it were the first.
   */
  firstSeenTs: number;
  /** Days since `firstSeenTs`, on the same "at least" caveat. */
  historyDays: number;
  note: string;
}

/** One token the wallet holds right now, with cost basis only if it was seen. */
export interface WalletHolding {
  mint: string;
  symbol?: string;
  decimals: number;
  /** The real balance, read from the chain rather than derived from fills. */
  tokens: number;
  priceUsd?: number;
  valueUsd?: number;
  /** FIFO cost over observed fills. Undefined when the entry was not observed. */
  costBasisUsd?: number;
  unrealizedPnlUsd?: number;
  unrealizedPnlPct?: number;
  /**
   * How many tokens the observed fills account for.
   *
   * The reconciliation that makes the rest trustworthy: when this disagrees
   * with `tokens`, the wallet acquired part of the position where we could not
   * see it, and no cost basis for the position is honest. Most trackers assume
   * instead, which is how a bag bought before their window shows up as pure
   * profit.
   */
  observedTokens: number;
  costBasisKnown: boolean;
  /** Why the cost is unknown, when it is. */
  reason?: string;
  /** Jupiter's own flag for dust and spam airdrops. */
  excludeFromNetWorth?: boolean;
}

/**
 * Performance over the observed window, and nothing beyond it.
 *
 * Every optional field is optional because it genuinely may not exist: a
 * wallet with no completed round trip inside the window has no win rate, and
 * rendering 0% would say it loses every trade.
 */
export interface WalletWindowStats {
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  winRate?: number;
  profitFactor?: number;
  avgWinUsd?: number;
  avgLossUsd?: number;
  medianHoldHours?: number;
  roundTrips: number;
  buys: number;
  sells: number;
  pricedFills: number;
  unpricedFills: number;
  distinctMints: number;
  /** Tokens sold out of lots we never saw bought. Excluded from realized PnL. */
  unmatchedSellTokens: number;
  unmatchedSellMints: number;
  /**
   * Realized PnL from sells that did NOT close a position.
   *
   * `realizedPnlUsd` accumulates on every priced sell, but a round trip is only
   * recorded when the position goes flat — so a wallet that trims twice and
   * never exits has a headline PnL and an empty round-trips table. The blind
   * review hit exactly that: −$4.24 above a table summing to −$0.45, both
   * correct and irreconcilable on screen. This is the difference, named.
   */
  partialExitPnlUsd: number;
  /** How many priced sells reduced a position without closing it. */
  partialExits: number;
}

export interface WalletProfile {
  address: string;
  /**
   * How much of this wallet has been read.
   *
   * "balances" is the fast first paint — identity, holdings and prices, a few
   * hundred milliseconds — with the fill history still outstanding. Every
   * fill-derived figure is absent rather than zero at that point, and the UI
   * must render "reading…" and not "no trades", which are opposite claims.
   */
  stage: "balances" | "full";
  /**
   * What the address turned out to be.
   *
   * A token mint owns token accounts and a program's authority holds balances,
   * so both render as plausible "traders" if nobody checks. The blind review
   * pasted a mint in and got "$520.8K portfolio, 144 positions" with no warning.
   */
  identity: {
    kind: string;
    detail: string;
    profilable: boolean;
    /** For a token account: the wallet that owns it, so the page can link there. */
    holder?: string;
  };
  coverage: WalletCoverage;
  holdings: {
    source: string;
    solBalance: number;
    /**
     * Native SOL valued at the current SOL price, when one was available.
     *
     * Its own field because omitting it was a 52% understatement on the one
     * wallet where it was checked: Binance's hot wallet showed $162.20M of
     * tokens while holding 1,661,879 SOL — $174.9M more — that the headline
     * simply left out. Undefined when no SOL price could be read, which keeps
     * it out of the total rather than adding zero to it.
     */
    solValueUsd?: number;
    /** Mints with a non-zero balance. */
    mints: number;
    /** USD across the mints a price was found for, EXCLUDING native SOL. */
    tokenValueUsd: number;
    /** Tokens plus native SOL — what a reader means by "this wallet is worth". */
    valuedUsd: number;
    pricedMints: number;
    /** Mints held but not valued — the price budget ran out or Jupiter had none. */
    unpricedMints: number;
  } | null;
  positions: WalletHolding[];
  roundTrips: {
    mint: string;
    symbol?: string;
    entryTs: number;
    exitTs: number;
    costUsd: number;
    proceedsUsd: number;
    pnlUsd: number;
    holdHours: number;
  }[];
  fills: WalletFill[];
  stats: WalletWindowStats;
  unmeasured: readonly UnmeasuredWalletField[];
  /** One sentence per claim, naming who answered it. */
  provenance: string[];
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
  | "coordinated_activity"
  /**
   * Nothing matched. Every signal needs a kind, and the fallback used to be
   * `momentum_ignition` — so a token bleeding -51% wore "SIGNAL · MOMENTUM
   * IGNITION" purely because no other archetype claimed it. An archetype is a
   * CLAIM about what the tape is doing, and a default that names one asserts a
   * pattern nobody detected.
   */
  | "no_pattern";

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
  /**
   * Share of supply held by insider-flagged wallets AMONG THE TOP HOLDERS the
   * source published — not of the whole cap table.
   *
   * Named carefully because the two readings contradict each other on screen.
   * RugCheck's graph analysis found three insider networks of twelve wallets on
   * a token whose top-twenty rows carried no insider flag at all, and the
   * factor built on this field said "insider-linked wallets hold ~0% of supply"
   * directly beside it. Zero here means "none of the top holders examined was
   * flagged", never "there are no insiders".
   */
  insiderPct: number;
  bundlerPct: number;
  sniperPct: number;
  devHoldsPct: number;
  devSold: boolean;
  /**
   * Whether a source actually READ the mint account and found the authority
   * null. False means live — the key holder can still inflate supply or freeze
   * balances — and `unmeasured` carrying "authorities" means nobody looked.
   */
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** True when a permanent delegate is SET. */
  permanentDelegate: boolean;
  /** Share of LP locked or burned, 0..1. */
  lpLockedPct: number;
  /**
   * Independent liquidity providers behind that pool.
   *
   * Carried because the lock percentage alone is not the risk. "0.04% locked"
   * across 43 independent providers and "0.04% locked" held by the deployer
   * alone are the same number describing opposite situations.
   */
  lpProviders: number;
  /** Mints this deployer has issued, and how many reached a real pool. */
  devMints: number;
  devMigrations: number;
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

// ---------------------------------------------------------------- launches

/**
 * The outcome of one triage check on a brand-new launch.
 *
 * Six states rather than a boolean, because a launch feed is the place where
 * "we looked and it is fine" and "nobody has looked yet" are hardest to tell
 * apart and most expensive to confuse. A token forty seconds old has had no
 * time to accumulate findings, so an empty risk list is almost always silence
 * rather than a clean bill.
 *
 *   pass       measured, and the measurement is good
 *   warn       measured, and the measurement is soft-bad
 *   fail       measured, and the measurement is bad
 *   unchecked  nobody ran this check — renders as a dash, never as a pass
 *   n/a        the check cannot apply to this token's structure yet, which is
 *              its own answer and not a gap. A pre-graduation bonding-curve
 *              token has no withdrawable LP, so "is the LP locked" has no
 *              meaning for it and must not be answered either way.
 */
export type LaunchCheckState = "pass" | "warn" | "fail" | "unchecked" | "n/a";

export interface LaunchCheck {
  key: string;
  name: string;
  state: LaunchCheckState;
  detail: string;
  /**
   * What a `pass` actually rests on.
   *
   * "reading" — somebody looked at a value and it was good. The mint authority
   * is null; the deployer holds 0.5%.
   *
   * "absence" — nobody found anything, which on a token this young is mostly a
   * statement about how little has had time to happen. A vendor reporting no
   * rug history for a wallet it has never seen produces the identical output to
   * one clearing a wallet it knows well.
   *
   * These were rendered with the same green tick, so a strip reading
   * `✓✓✓✓—··✓` claimed eight findings where two were measurements. The UI now
   * draws them differently, because the difference is the entire subject of
   * this file.
   */
  basis?: "reading" | "absence";
  /**
   * True when the state came from a fail-safe DEFAULT rather than a reading.
   *
   * House rule: absent mint-authority data is graded as not-revoked. That
   * produces a `fail` which is correct to act on and wrong to describe as a
   * measurement, and a reader deciding in ten seconds deserves to know which
   * of the two they are looking at.
   */
  assumed?: boolean;
}

/**
 * The feed's verdict on a launch.
 *
 * There is deliberately NO positive verdict. The best a token seconds old can
 * earn is `unverified` — every check that could run, ran, and none of them
 * found anything, which on a token this young mostly means the evidence does
 * not exist yet. A green "SAFE" here would be the single most dangerous string
 * this app could render.
 */
export type LaunchVerdict = "avoid" | "caution" | "unverified";

export interface LaunchTriage {
  verdict: LaunchVerdict;
  checks: LaunchCheck[];
  /** Checks that produced a real measurement, and how many there were. */
  measured: number;
  /**
   * Of the passes, how many rest on somebody having LOOKED at a value rather
   * than on nobody having found anything. See `LaunchCheck.basis`.
   *
   * On a typical fresh launchpad mint this is two — the mint and freeze
   * authority reads — out of six or seven ticks.
   */
  readings: number;
  total: number;
  /** Checks nobody ran. The honesty number: the headline is meaningless without it. */
  unchecked: number;
  /** Third-party grade, when one arrived. HIGHER IS RISKIER. */
  riskScore?: number;
  riskSource?: string;
  /**
   * ms from `firstSeenAt` to the moment triage finished, or undefined while it
   * is still running. This is the number that says whether the feed is a filter
   * or a firehose: a verdict that lands ninety seconds after the launch is not
   * triage, it is a post-mortem.
   */
  completedInMs?: number;
}

/**
 * One new pool or graduation, as observed.
 *
 * `poolCreatedAt` is the source's claim about the chain; `firstSeenAt` is when
 * this process actually laid eyes on it. Their difference is the feed's real
 * latency, and it is stored per-row rather than asserted once in a doc comment
 * so the page can show its own measured lag instead of a marketing number.
 */
export interface LaunchObservation {
  mint: string;
  name: string;
  symbol: string;
  hue: number;
  decimals: number;
  poolCreatedAt: number;
  firstSeenAt: number;
  /**
   * When the GRADUATION was first sighted, for rows that graduate.
   *
   * Distinct from `firstSeenAt` because a watched curve mint that later
   * graduates keeps its original sighting time — that is the feed's whole
   * reliability story — while `poolCreatedAt` is re-dated to the graduation.
   * Computing graduation lag as `firstSeenAt - poolCreatedAt` on such a
   * promoted row therefore produced a NEGATIVE lag the size of the curve's
   * lifetime (observed live at -90.2s and -158.8s), which contaminated the
   * clock-skew check: on a machine with an accurate clock, one promoted
   * graduation would have fired "clock behind" with a fabricated magnitude.
   *
   * Stamped at promotion time, this is a real sample — how long after the
   * graduation the feed noticed it — instead of an excluded one. Absent means
   * the row was a graduation at first sight, and `firstSeenAt` already IS the
   * graduation sighting.
   */
  gradSeenAt?: number;
  /** "pool" for a fresh mint, "graduation" when a launchpad curve completed. */
  event: "pool" | "graduation";
  /** The AMM or launchpad that hosts the pool, when the source names it. */
  venue?: string;
  launchpad?: string;
  graduatedAt?: number;
  dev?: string;
  devMints?: number;
  devMigrations?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  holders?: number;
  top10Pct?: number;
  devHoldsPct?: number;
  organicScore?: number;
  buys5m?: number;
  sells5m?: number;
  traders5m?: number;
  /**
   * How far along the launchpad's bonding curve this mint is, as a FRACTION
   * 0..1 — the same convention as `top10Pct` and `devHoldsPct`, whose names
   * also say Pct and whose values are also fractions.
   *
   * The source publishes it as a percentage 0..100 and the adapter divides.
   * Worth stating because the mistake is silent: the source's `recent` bucket
   * medians 1.07, so a brand-new mint's raw 0.78 reads perfectly plausibly as
   * "78% of the way to graduating" when it means 0.78%.
   *
   * Undefined means nobody published a figure, and that is NOT the same as
   * zero: a curve at 0% and a curve nobody measured look identical once a
   * default is applied, and the second is the common case because the field
   * only appears on launchpad rows. Absent after graduation too — there is no
   * curve left to be a fraction of — which is why the row's `event` and not
   * this field is what says whether a token has graduated.
   */
  bondingCurvePct?: number;
  /** Jupiter's own "this mint looks suspicious" flag, when it sets one. */
  sus?: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Whether the authority fields above were actually read, or defaulted. */
  authorityKnown: boolean;
  /** Which adapter saw it first. */
  source: string;
}

export type TokenLaunch = LaunchObservation & {
  triage: LaunchTriage;
  /**
   * Other mints in the feed launched under the same name or symbol.
   *
   * Not a property of the token — a property of the FEED, which is why it lives
   * here rather than on the observation. Two different mints both called
   * CASHCOW landing twelve seconds apart is the textbook impersonation play,
   * and it is invisible in any per-token view however carefully audited: each
   * one is individually unremarkable.
   */
  twins?: string[];
};

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
  /**
   * A measured, disqualifying security fact — set only when a source actually
   * READ it and the answer was bad.
   *
   * A weight cannot express this. A live mint authority means the supply can be
   * inflated out from under a holder at any moment, and no amount of liquidity,
   * momentum or organic activity trades that away — but a risk factor worth
   * nine points cannot stop a strong token from rendering POSITIVE. So it is a
   * veto on the LABEL rather than a subtraction from the score, and the score
   * stays an honest weighted mean of what was measured.
   *
   * Absent when the authorities are merely unverified. That is a different
   * state and it routes to abstention, not to a verdict.
   */
  securityVeto?: string;
  /**
   * A measured fact that CAPS the label without disqualifying the token.
   *
   * The middle rung the engine was missing. A live mint authority is a
   * capability — the key exists and can be used unilaterally right now — so it
   * vetoes outright. A deployer who has issued nineteen thousand mints is a
   * base rate, not a capability: it cannot take anyone's money, it only makes
   * this particular mint one attempt among thousands. Those two facts had one
   * mechanism between them (a nine-point penalty) and a token could absorb the
   * penalty and still render POSITIVE under the sentence describing the
   * factory.
   *
   * So this holds the label at WATCH: the tape may be strong and the score says
   * so, but the engine will not call it positive on tape alone.
   */
  labelCap?: string;
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
  /**
   * `unknown` is a real state and the most common one on a cold /status load:
   * the provider is enabled and simply has not been asked anything yet. It used
   * to report `ok`, which is a clean bill of health issued without an
   * examination.
   */
  status: "ok" | "degraded" | "down" | "unknown";
  /** Undefined until at least one request has completed — 0ms is not "fast". */
  latencyMs?: number;
  /** Undefined until at least one request — 0% over zero requests is not "reliable". */
  errorRatePct?: number;
  lastSuccessTs: number;
  lastDataTs: number;
  note?: string;
}

export const ENGINE_VERSION = "1.0.0";
export const FEATURE_SCHEMA_VERSION = "1";
