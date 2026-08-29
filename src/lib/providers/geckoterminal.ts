// CoinGecko's on-chain API (GeckoTerminal) — keyless, and the only source
// wired here that has HISTORY.
//
//   GET /networks/solana/tokens/{mint}?include=top_pools
//   GET /networks/solana/pools/{pool}/ohlcv/{hour|minute|day}?limit=1000
//   GET /networks/solana/trending_pools
//   GET /networks/solana/new_pools
//
// That second line is the important one. DEX Screener publishes a rich
// snapshot and no past; every candle endpoint it might have was tried and
// 404s. GeckoTerminal returns [ts, o, h, l, c, volumeUsd] tuples — Nova's
// Candle shape almost exactly — and measured against the live API gives 1,000
// hourly bars (41.6 days), 181 daily bars (180 days), or 1,000 minute bars.
//
// Which is the difference between a backtester that can only ever replay the
// simulator and one that can replay Solana.
//
// The free tier is metered and answered a burst with 429 during exactly this
// kind of probing, so every call goes through a queue below rather than
// trusting callers to be polite.

import { providerFetch } from "./http";
import { hueOf, narrativeOf } from "./classify";
import type { MarketDataProvider, TokenDataProvider } from "./types";
import type { Candle, TokenInfo, TokenSnapshot, UnmeasuredField } from "../types";

const BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";

/**
 * Supply distribution, holder counts and wallet-level attribution are not in
 * this API either. Same declaration as DEX Screener, for the same reason: a
 * zero here would read as "no insiders, perfectly distributed".
 */
const GT_UNMEASURED: readonly UnmeasuredField[] = [
  "top10Pct",
  "devHoldsPct",
  "insiderPct",
  "bundlerPct",
  "sniperPct",
  "organicScore",
  "socialScore",
  "holders",
  "uniqueBuyers1h",
  "uniqueSellers1h",
];

// ---------------------------------------------------------------- rate limit

/**
 * The free tier allows roughly thirty calls a minute and answers a burst with
 * 429. A single serialised queue with a minimum gap is cruder than a token
 * bucket and has the property that matters: no amount of concurrent callers
 * upstream can turn into concurrent requests here.
 */
const MIN_GAP_MS = 2_100;
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function queued<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return run();
  });
  // Keep the chain alive after a rejection, or one failed call stalls every
  // request that follows it for the life of the process.
  chain = next.catch(() => undefined);
  return next;
}

const gtFetch = <T>(path: string) =>
  queued(() => providerFetch<T>("coingecko", `${BASE}${path}`, { timeoutMs: 12_000 }));

// ---------------------------------------------------------------- shapes

interface GtToken {
  data?: {
    attributes?: {
      address?: string;
      name?: string;
      symbol?: string;
      decimals?: number;
      price_usd?: string;
      fdv_usd?: string;
      market_cap_usd?: string | null;
      total_reserve_in_usd?: string;
      volume_usd?: { h24?: string };
      coingecko_coin_id?: string | null;
    };
  };
  included?: {
    type?: string;
    id?: string;
    attributes?: {
      address?: string;
      name?: string;
      pool_created_at?: string;
      reserve_in_usd?: string;
      volume_usd?: { h24?: string };
      transactions?: Record<string, { buys?: number; sells?: number }>;
      price_change_percentage?: Record<string, string>;
    };
  }[];
}

interface GtOhlcv {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

interface GtPools {
  data?: {
    id?: string;
    attributes?: {
      address?: string;
      name?: string;
      pool_created_at?: string;
      reserve_in_usd?: string;
      base_token_price_usd?: string;
      fdv_usd?: string;
      market_cap_usd?: string | null;
      volume_usd?: { h24?: string };
      transactions?: Record<string, { buys?: number; sells?: number }>;
    };
    relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } };
  }[];
}

/**
 * A pool that did not exist a minute ago.
 *
 * Deliberately not a TokenSnapshot. A snapshot describes a token's market; this
 * describes a POOL COMING INTO EXISTENCE, and the pool's own address, its DEX
 * and its creation time are the whole point. On Solana the dex field is what
 * separates the two kinds of launch this feed cares about: `pump-fun` is a new
 * bonding curve, and `pumpswap` / `meteora-*` / `raydium-*` is a pool that had
 * to be funded — which for a pump.fun token means the curve completed and it
 * GRADUATED.
 */
export interface NewPool {
  poolAddress: string;
  /** Base token of the pair. The quote is nearly always wSOL. */
  mint: string;
  /** GeckoTerminal's own pair label, e.g. "JAMU / SOL". */
  pairName: string;
  dex: string;
  createdAt: number;
  priceUsd: number;
  liquidityUsd: number;
  buys5m: number;
  sells5m: number;
}

/**
 * DEX ids that mean "this pool had to be funded by somebody".
 *
 * Measured on one page of `new_pools`: 13 `pump-fun`, 3 `pumpswap`, 2
 * `meteora-damm-v2`, 2 `meteora-dbc`. The pump-fun rows duplicate what Jupiter
 * already delivers two seconds sooner, so they are not what this source is for.
 * The rest are the ones Jupiter's launchpad-shaped `recent` feed never shows.
 */
export const GRADUATION_DEXES = /^(pumpswap|raydium|meteora|orca|whirlpool|lifinity|fluxbeam)/;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** GeckoTerminal ids look like "solana_<address>". */
const addressOf = (id: string | undefined): string => (id ?? "").split("_").pop() ?? "";

// ---------------------------------------------------------------- providers

export class GeckoTerminalMarketProvider implements MarketDataProvider {
  readonly name = "coingecko";

  /** mint -> deepest pool address. Pools rarely move; the lookup costs a call. */
  private pools = new Map<string, string>();

  private async poolFor(mint: string): Promise<string | null> {
    const cached = this.pools.get(mint);
    if (cached) return cached;
    const res = await gtFetch<GtToken>(
      `/networks/${NETWORK}/tokens/${encodeURIComponent(mint)}?include=top_pools`,
    );
    const pools = (res.included ?? []).filter((x) => x.type === "pool");
    if (!pools.length) return null;
    // Deepest reserve is the pool whose prints actually mean something.
    pools.sort((a, b) => num(b.attributes?.reserve_in_usd) - num(a.attributes?.reserve_in_usd));
    const addr = pools[0].attributes?.address ?? addressOf(pools[0].id);
    if (!addr) return null;
    this.pools.set(mint, addr);
    return addr;
  }

  /**
   * Real hourly candles, trimmed to the window asked for.
   *
   * Hourly rather than minute because the backtester steps in hours and 1,000
   * hourly bars reach back six weeks where 1,000 minute bars reach back
   * seventeen hours. GeckoTerminal returns newest-first; callers downstream
   * assume ascending time, so it is reversed here rather than in each of them.
   */
  async getCandles(mint: string, fromTs: number, toTs: number): Promise<Candle[]> {
    const pool = await this.poolFor(mint);
    if (!pool) return [];
    const res = await gtFetch<GtOhlcv>(
      `/networks/${NETWORK}/pools/${pool}/ohlcv/hour?limit=1000&currency=usd`,
    );
    const rows = res.data?.attributes?.ohlcv_list ?? [];
    return rows
      .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v }))
      .filter((c) => c.t >= fromTs && c.t <= toTs && Number.isFinite(c.c))
      .sort((a, b) => a.t - b.t);
  }

  async getPrice(mint: string): Promise<number | null> {
    const res = await gtFetch<GtToken>(`/networks/${NETWORK}/tokens/${encodeURIComponent(mint)}`);
    const p = num(res.data?.attributes?.price_usd);
    return p > 0 ? p : null;
  }
}

export class GeckoTerminalTokenProvider implements TokenDataProvider {
  readonly name = "coingecko";

  async getToken(mint: string): Promise<(TokenInfo & { snapshot: TokenSnapshot }) | null> {
    const res = await gtFetch<GtToken>(
      `/networks/${NETWORK}/tokens/${encodeURIComponent(mint)}?include=top_pools`,
    );
    const a = res.data?.attributes;
    if (!a) return null;

    const pools = (res.included ?? []).filter((x) => x.type === "pool");
    pools.sort((a2, b) => num(b.attributes?.reserve_in_usd) - num(a2.attributes?.reserve_in_usd));
    const top = pools[0]?.attributes;
    const h1 = top?.transactions?.h1 ?? {};
    const name = a.name ?? mint.slice(0, 6);
    const symbol = a.symbol ?? "?";

    return {
      mint,
      name,
      symbol,
      createdAt: top?.pool_created_at ? Date.parse(top.pool_created_at) : 0,
      decimals: a.decimals ?? 9,
      narrative: narrativeOf(name, symbol),
      // Being listed on CoinGecko proper is a real curation step and the best
      // proxy this source offers. It is not on-chain verification.
      verified: Boolean(a.coingecko_coin_id),
      // Authority state is never returned. Reported as NOT revoked so a token
      // nobody has checked is never graded as safely renounced.
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      permanentDelegate: false,
      devWallet: "",
      hue: hueOf(mint),
      snapshot: {
        mint,
        ts: Date.now(),
        priceUsd: num(a.price_usd),
        marketCapUsd: num(a.market_cap_usd) || num(a.fdv_usd),
        fdvUsd: num(a.fdv_usd),
        // Token-level reserve first: it aggregates every pool, where the top
        // pool alone can be a fifth of the real depth. The deepest pool is
        // only a fallback for tokens the aggregate is missing.
        liquidityUsd: num(a.total_reserve_in_usd) || num(top?.reserve_in_usd),
        volume24hUsd: num(a.volume_usd?.h24),
        buys1h: h1.buys ?? 0,
        sells1h: h1.sells ?? 0,
        uniqueBuyers1h: 0,
        uniqueSellers1h: 0,
        holders: 0,
        top10Pct: 0,
        devHoldsPct: 0,
        organicScore: 0,
        socialScore: 0,
        bundlerPct: 0,
        sniperPct: 0,
        insiderPct: 0,
        unmeasured: GT_UNMEASURED,
      },
    };
  }

  /** Trending pools, mapped back to their base tokens. */
  async getTrendingTokens(limit: number): Promise<TokenSnapshot[]> {
    return this.fromPools(`/networks/${NETWORK}/trending_pools`, limit);
  }

  async getRecentTokens(limit: number): Promise<TokenSnapshot[]> {
    return this.fromPools(`/networks/${NETWORK}/new_pools`, limit);
  }

  /**
   * Pool creations, as pool creations rather than as token snapshots.
   *
   * This is the second launch source, and it exists for one thing Jupiter's
   * `recent` cannot do: Jupiter indexes MINTS on a launchpad, so a pump.fun
   * token that completes its curve months after minting never reappears there.
   * GeckoTerminal indexes POOLS, and a graduation is a new PumpSwap pool.
   *
   * MEASURED, and it dictates the cadence: this endpoint returns 20 rows per
   * page spanning about 55 seconds, and it is 32-55 seconds behind the chain —
   * an order of magnitude slower than Jupiter, which is why it is the secondary
   * source and never the primary. Four requests with no gap returned 200, 200,
   * 200, 200 and then four straight 429s, so it goes through the same
   * serialised 2.1s queue as everything else in this file.
   */
  async getNewPools(page = 1): Promise<NewPool[]> {
    const res = await gtFetch<GtPools>(`/networks/${NETWORK}/new_pools?page=${page}`);
    const out: NewPool[] = [];
    for (const row of res.data ?? []) {
      const a = row.attributes;
      const mint = addressOf(row.relationships?.base_token?.data?.id);
      const created = Date.parse(a?.pool_created_at ?? "");
      if (!a || !mint || !Number.isFinite(created)) continue;
      const m5 = a.transactions?.m5 ?? {};
      out.push({
        poolAddress: a.address ?? addressOf(row.id),
        mint,
        pairName: a.name ?? "",
        dex: row.relationships?.dex?.data?.id ?? "",
        createdAt: created,
        priceUsd: num(a.base_token_price_usd),
        liquidityUsd: num(a.reserve_in_usd),
        buys5m: m5.buys ?? 0,
        sells5m: m5.sells ?? 0,
      });
    }
    return out;
  }

  /**
   * Builds snapshots straight from the pool listing.
   *
   * Deliberately does NOT call getToken per row. A twenty-row trending panel
   * would be twenty more metered calls at two seconds apart — forty seconds to
   * paint a list — and the pool record already carries price, reserve, volume
   * and trade counts. The only thing lost is the token's decimals and its
   * CoinGecko listing status, neither of which a snapshot carries.
   */
  private async fromPools(path: string, limit: number): Promise<TokenSnapshot[]> {
    const res = await gtFetch<GtPools>(`${path}?limit=${Math.min(Math.max(limit, 1), 20)}`);
    const out: TokenSnapshot[] = [];
    for (const row of res.data ?? []) {
      const mint = addressOf(row.relationships?.base_token?.data?.id);
      const a = row.attributes;
      if (!mint || !a) continue;
      const h1 = a.transactions?.h1 ?? {};
      out.push({
        mint,
        ts: Date.now(),
        priceUsd: num(a.base_token_price_usd),
        marketCapUsd: num(a.market_cap_usd) || num(a.fdv_usd),
        fdvUsd: num(a.fdv_usd),
        liquidityUsd: num(a.reserve_in_usd),
        volume24hUsd: num(a.volume_usd?.h24),
        buys1h: h1.buys ?? 0,
        sells1h: h1.sells ?? 0,
        uniqueBuyers1h: 0,
        uniqueSellers1h: 0,
        holders: 0,
        top10Pct: 0,
        devHoldsPct: 0,
        organicScore: 0,
        socialScore: 0,
        bundlerPct: 0,
        sniperPct: 0,
        insiderPct: 0,
        unmeasured: GT_UNMEASURED,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** GeckoTerminal has no token search; DEX Screener covers this capability. */
  async searchTokens(): Promise<TokenInfo[]> {
    return [];
  }
}
