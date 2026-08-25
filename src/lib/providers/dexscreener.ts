// DEX Screener adapter — keyless public API, used as market-data fallback.
//   GET https://api.dexscreener.com/latest/dex/tokens/{mint}
//   GET https://api.dexscreener.com/token-boosts/top/v1

import { providerFetch } from "./http";
import type { MarketDataProvider } from "./types";
import type { Candle } from "../types";

const BASE = "https://api.dexscreener.com";

interface DexPair {
  chainId: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h1?: number; h24?: number };
  pairCreatedAt?: number;
}

export class DexScreenerMarketProvider implements MarketDataProvider {
  readonly name = "dexscreener";

  async getPrice(mint: string): Promise<number | null> {
    const res = await providerFetch<{ pairs: DexPair[] | null }>(this.name, `${BASE}/latest/dex/tokens/${mint}`);
    const sol = (res.pairs ?? []).filter((p) => p.chainId === "solana");
    if (!sol.length) return null;
    // deepest pool wins
    sol.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return Number(sol[0].priceUsd) || null;
  }

  // DEX Screener has no public OHLCV endpoint; candles fall through to the
  // next provider in the chain.
  async getCandles(): Promise<Candle[]> {
    return [];
  }
}
