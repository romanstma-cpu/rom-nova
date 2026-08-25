// Jupiter Tokens V2 adapter. Current API (Ultra is superseded):
//   GET https://api.jup.ag/tokens/v2/search?query=<mint|symbol|name>
//   GET https://api.jup.ag/tokens/v2/toptrending/{5m|1h|6h|24h}?limit=N
//   GET https://api.jup.ag/tokens/v2/recent
// Keyed tier uses api.jup.ag with an x-api-key header; the free tier is
// served from lite-api.jup.ag with the same paths.

import { providerFetch } from "./http";
import type { TokenDataProvider } from "./types";
import type { TokenInfo, TokenSnapshot } from "../types";

interface JupMint {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  createdAt?: string;
  dev?: string;
  holderCount?: number;
  organicScore?: number;
  isVerified?: boolean;
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
  };
  stats24h?: {
    priceChange?: number;
    holderChange?: number;
    liquidityChange?: number;
    buyVolume?: number;
    sellVolume?: number;
    numBuys?: number;
    numSells?: number;
    numTraders?: number;
  };
  firstPool?: { createdAt?: string };
}

function baseUrl(): string {
  return process.env.JUPITER_API_KEY ? "https://api.jup.ag/tokens/v2" : "https://lite-api.jup.ag/tokens/v2";
}

function headers(): Record<string, string> {
  return process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
}

function toInfo(m: JupMint): TokenInfo {
  return {
    mint: m.id,
    name: m.name,
    symbol: m.symbol,
    createdAt: Date.parse(m.firstPool?.createdAt ?? m.createdAt ?? "") || Date.now(),
    decimals: m.decimals,
    narrative: "Community",
    verified: Boolean(m.isVerified),
    mintAuthorityRevoked: Boolean(m.audit?.mintAuthorityDisabled),
    freezeAuthorityRevoked: Boolean(m.audit?.freezeAuthorityDisabled),
    permanentDelegate: false,
    devWallet: m.dev ?? "",
    hue: Math.abs([...m.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 360,
  };
}

function toSnapshot(m: JupMint): TokenSnapshot {
  const buys = m.stats24h?.numBuys ?? 0;
  const sells = m.stats24h?.numSells ?? 0;
  return {
    mint: m.id,
    ts: Date.now(),
    priceUsd: m.usdPrice ?? 0,
    marketCapUsd: m.mcap ?? 0,
    fdvUsd: m.fdv ?? m.mcap ?? 0,
    liquidityUsd: m.liquidity ?? 0,
    volume24hUsd: (m.stats24h?.buyVolume ?? 0) + (m.stats24h?.sellVolume ?? 0),
    buys1h: Math.round(buys / 24),
    sells1h: Math.round(sells / 24),
    uniqueBuyers1h: Math.round((m.stats24h?.numTraders ?? 0) / 24),
    uniqueSellers1h: Math.round((m.stats24h?.numTraders ?? 0) / 24),
    holders: m.holderCount ?? 0,
    top10Pct: (m.audit?.topHoldersPercentage ?? 0) / 100,
    devHoldsPct: 0,
    organicScore: (m.organicScore ?? 50) / 100,
    socialScore: 0.5,
    bundlerPct: 0,
    sniperPct: 0,
    insiderPct: 0,
  };
}

export class JupiterTokenProvider implements TokenDataProvider {
  readonly name = "jupiter";

  async getToken(mint: string) {
    const rows = await providerFetch<JupMint[]>(this.name, `${baseUrl()}/search?query=${encodeURIComponent(mint)}`, {
      headers: headers(),
    });
    const m = rows.find((r) => r.id === mint) ?? rows[0];
    return m ? { ...toInfo(m), snapshot: toSnapshot(m) } : null;
  }

  async getTrendingTokens(limit: number) {
    const rows = await providerFetch<JupMint[]>(this.name, `${baseUrl()}/toptrending/1h?limit=${limit}`, {
      headers: headers(),
    });
    return rows.map(toSnapshot);
  }

  async getRecentTokens(limit: number) {
    const rows = await providerFetch<JupMint[]>(this.name, `${baseUrl()}/recent?limit=${limit}`, {
      headers: headers(),
    });
    return rows.map(toSnapshot);
  }

  async searchTokens(query: string) {
    const rows = await providerFetch<JupMint[]>(this.name, `${baseUrl()}/search?query=${encodeURIComponent(query)}`, {
      headers: headers(),
    });
    return rows.map(toInfo);
  }
}
