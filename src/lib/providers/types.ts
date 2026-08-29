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

export interface ProviderSet {
  mode: "demo" | "live";
  token: TokenDataProvider;
  market: MarketDataProvider;
  wallet: WalletDataProvider;
  security: SecurityDataProvider;
  health(): ProviderHealth[];
}
