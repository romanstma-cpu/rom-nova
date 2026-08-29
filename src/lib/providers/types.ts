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
  health(): ProviderHealth[];
}
