// Provider abstraction. The app depends on these interfaces only; vendors
// plug in behind them. Demo adapters implement the same contracts over the
// synthetic store, so flipping demo → live is configuration, not a rewrite.

import type {
  Candle,
  ProviderHealth,
  TokenInfo,
  TokenSnapshot,
  WalletTrade,
} from "../types";

export interface TokenDataProvider {
  readonly name: string;
  getToken(mint: string): Promise<(TokenInfo & { snapshot: TokenSnapshot }) | null>;
  getTrendingTokens(limit: number): Promise<TokenSnapshot[]>;
  getRecentTokens(limit: number): Promise<TokenSnapshot[]>;
  searchTokens(query: string): Promise<TokenInfo[]>;
}

export interface MarketDataProvider {
  readonly name: string;
  getCandles(mint: string, fromTs: number, toTs: number): Promise<Candle[]>;
  getPrice(mint: string): Promise<number | null>;
}

export interface WalletDataProvider {
  readonly name: string;
  getWalletTrades(address: string, limit: number): Promise<WalletTrade[]>;
  getWalletLabels(address: string): Promise<string[]>;
}

/**
 * A wallet's CURRENT token balances, read rather than replayed.
 *
 * Separate from `WalletDataProvider` because the two questions turned out to
 * be answered by different vendors and neither can answer the other. Solana's
 * public RPC hands out a wallet's transactions for free and returns 403 to
 * `getTokenAccountsByOwner`; Jupiter returns the balances in one call and
 * knows nothing about how they were acquired.
 *
 * Keeping them apart is also what makes the reconciliation in
 * `engine/wallet-profile.ts` possible: a position derived from trades and a
 * position read from the chain are independent measurements, and their
 * DISAGREEMENT is the signal that a cost basis is not knowable.
 */
export interface WalletHoldingsProvider {
  readonly name: string;
  getHoldings(address: string): Promise<{
    source: string;
    address: string;
    solBalance: number;
    tokens: { mint: string; tokens: number; decimals: number; frozen: boolean; excludeFromNetWorth: boolean }[];
  } | null>;
  /** USD prices for as many of these mints as the budget reaches, in order. */
  priceMints(mints: string[]): Promise<Map<string, number>>;
}

export interface SecurityDataProvider {
  readonly name: string;
  getTokenSecurity(mint: string): Promise<{
    mintAuthorityRevoked: boolean;
    freezeAuthorityRevoked: boolean;
    top10Pct: number;
    /**
     * Whether `top10Pct` was actually read.
     *
     * A security provider can close some gaps without closing all of them: the
     * chain gives authorities away for free but puts holder distribution behind
     * endpoints the public RPCs block. Absent means yes, for the keyed
     * providers that were written before this existed and do supply it. Explicit
     * `false` keeps top10Pct in the unmeasured set, so a zero is never read as
     * a perfectly distributed cap table.
     */
    top10Known?: boolean;
    warnings: string[];
  } | null>;
}

/**
 * Aggregated wallet flow for one token over a bounded window.
 *
 * Amounts are RAW base units as strings: they are bigint-sized, they mean
 * nothing without the mint's decimals, and nothing in USD without a price. A
 * provider that guessed either would be inventing the number.
 */
export interface TokenFlow {
  mint: string;
  source: string;
  fromBlock: number;
  toBlock: number;
  /** The last block actually seen — below `toBlock` when a budget cut the read. */
  reachedBlock: number;
  blocksRequested: number;
  blocksCovered: number;
  /** Unix seconds of the last block seen, 0 when none carried one. */
  lastTimestamp: number;
  /**
   * False when the read stopped early. The rows counted are still real; the
   * WINDOW is smaller than requested, and a caller that prints the requested
   * window instead of `blocksCovered` is reporting a number it did not measure.
   */
  complete: boolean;
  bytesRead: number;
  /** Balance changes actually counted. */
  movements: number;
  /**
   * Rows discarded because the balance did not change. Usually the majority —
   * measured at 75% on wSOL and 93% on a trending memecoin.
   */
  touchedNotMoved: number;
  /** Distinct owners with any net change. */
  wallets: number;
  netUnits: string;
  inflowUnits: string;
  outflowUnits: string;
  buyers: number;
  sellers: number;
  /** Biggest accumulators and distributors — whale candidates. */
  largest: { owner: string; deltaUnits: string }[];
}

export interface TokenFlowProvider {
  readonly name: string;
  getTokenFlow(
    mint: string,
    opts?: { minutes?: number; byteBudget?: number; topMovers?: number; signal?: AbortSignal },
  ): Promise<TokenFlow | null>;
}

/**
 * A published risk assessment for one mint.
 *
 * Deliberately NOT merged into SecurityDataProvider. Security answers factual
 * chain questions — is the mint authority revoked, what share do the top ten
 * hold — and the answers are checkable. This is somebody else's OPINION, with
 * their own scoring, and the two should never be indistinguishable in the UI.
 */
export interface TokenRisk {
  mint: string;
  source: string;
  /** Vendor's normalised score. HIGHER IS RISKIER — 1 is clean, 44 is not. */
  score: number;
  risks: {
    name: string;
    level: "danger" | "warn" | "info";
    detail: string;
    /** The vendor's own figure for this risk, e.g. "52.85%". */
    value?: string;
  }[];
  /**
   * Share of LP tokens locked or burned, 0..1.
   *
   * The actual rug mechanic, and nothing else in this stack can see it: a
   * deployer who can withdraw the pool does not need a mint authority to take
   * the money. Undefined when the vendor did not report it.
   */
  lpLockedPct?: number;
  /** Total holders per the vendor's own count, when the full report was read. */
  totalHolders?: number;
  /** Whether the vendor has flagged this mint as already rugged. */
  rugged?: boolean;
  /**
   * The deployer, per the vendor, and what it still holds.
   *
   * A second opinion on the two facts the token provider also publishes. They
   * do not always agree, and a detail page that shows one without the other is
   * picking a winner silently.
   */
  creator?: string;
  /** Creator balance as a share of supply, 0..1, from the vendor's own two fields. */
  creatorHoldsPct?: number;
  /**
   * Mint and freeze authority ADDRESSES, null when revoked.
   *
   * A third answer to the question the token provider and the chain both
   * answer. Kept as the address rather than a boolean because "revoked" and
   * "held by 2cVYpag…" are different amounts of information, and the address is
   * the half a reader can check.
   */
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  /**
   * A permanent delegate, when the mint has one — an SPL-2022 extension that
   * lets its holder move any balance without permission.
   *
   * No other source in this stack reports it, and `TokenInfo.permanentDelegate`
   * is hardcoded false by every adapter that fills it.
   */
  permanentDelegate?: string | null;
  /** Transfer fee the mint charges, 0..1 of the transferred amount. */
  transferFeePct?: number;
  /** Pools the vendor found, and the liquidity it totals across them. */
  markets?: number;
  totalMarketLiquidityUsd?: number;
  /**
   * How many independent parties provide that liquidity.
   *
   * The other half of `lpLockedPct`, and without it that figure is unreadable:
   * "0.04% locked" held by the deployer alone and "0.04% locked" spread over
   * forty-three separate providers are the same number describing opposite
   * situations. Undefined when the vendor returned no count — which, measured,
   * is most freshly-listed mints.
   */
  totalLpProviders?: number;
  /** Circulating supply in whole tokens, when the vendor read the mint. */
  supply?: number;
  /** Launchpad name per the vendor, when it names one. */
  launchpad?: string;
  /**
   * Insider clusters the vendor's graph analysis found, and how many wallets.
   *
   * Separate from `insiderPct`, which only counts insiders inside the TOP
   * holders. A network of thirteen coordinated wallets none of which cracks the
   * top twenty is invisible to that percentage and visible here.
   */
  insiderNetworks?: number;
  graphInsiders?: number;
  /**
   * The top holders, as published, with a label WHERE ONE EXISTS.
   *
   * No derived "concentration excluding pools" figure accompanies this, and
   * that omission is deliberate and measured. RugCheck's knownAccounts labelled
   * 12 of 20 top holders for one trending token, 1 of 20 for another and ZERO
   * of 20 for two more — including the two largest, whose biggest holders are
   * self-evidently pools and staking contracts. A pool-excluded percentage
   * computed from that coverage would have reported RAY as 83% wallet-held.
   * The labels are worth showing; a summary statistic built on them is not.
   */
  topHolders?: {
    owner: string;
    /**
     * The token ACCOUNT holding the balance, when published.
     *
     * Distinct from the owner and worth carrying: the vendor's label map is
     * keyed by both, and a reader checking a holder on an explorer wants the
     * account that actually holds the tokens.
     */
    account?: string;
    pct: number;
    /** "Meteora DLMM Pool", "Streamflow Vault", "Creator" — undefined if unknown. */
    label?: string;
    insider?: boolean;
    /** True when this row's owner or account IS the deployer the vendor named. */
    isCreator?: boolean;
  }[];
  /** How many of `topHolders` carried a label, so a reader can judge the rest. */
  labelledHolders?: number;
  /**
   * Insider-linked share of supply, 0..1.
   *
   * Only ever set from the full report, where the graph analysis is present and
   * its absence of findings is a result rather than a silence.
   */
  insiderPct?: number;
  /** False when only the cheap summary was read. */
  detailed: boolean;
}

export interface TokenRiskProvider {
  readonly name: string;
  /**
   * @param detailed Fetch the full report. Costs 80KB-1.6MB against a summary's
   * ~300B, so lists must leave this false and detail pages may set it.
   */
  getTokenRisk(mint: string, detailed?: boolean): Promise<TokenRisk | null>;
}

export interface ProviderSet {
  mode: "demo" | "live";
  token: TokenDataProvider;
  market: MarketDataProvider;
  wallet: WalletDataProvider;
  security: SecurityDataProvider;
  /**
   * Optional because no keyless source offered wallet flow until SQD, and the
   * demo set has nothing to put here. Callers must handle its absence — that
   * absence IS the honest state when it is not configured.
   */
  flow?: TokenFlowProvider;
  /**
   * Optional third-party risk opinion. Absent means no one graded this token,
   * which a caller must render as silence rather than as a clean bill.
   */
  risk?: TokenRiskProvider;
  /**
   * Optional balance reader. Absent means positions can only be DERIVED from
   * the trade window, which makes them as incomplete as the window is — and a
   * caller must say so rather than presenting a partial position as a holding.
   */
  holdings?: WalletHoldingsProvider;
  health(): ProviderHealth[];
}
