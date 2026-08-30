// DEX Screener adapter — keyless public API.
//   GET /latest/dex/tokens/{mint}        pairs for a mint
//   GET /latest/dex/search?q=            search
//   GET /token-boosts/top/v1             currently promoted tokens
//   GET /token-profiles/latest/v1        most recently listed profiles
//
// This is the only provider that needs no key, which makes it the difference
// between ROM Nova showing a synthetic universe and showing Solana. What it
// cannot do is history: there is no OHLCV endpoint (verified — /candles,
// /chart and /ohlcv all 404), so `getCandles` returns nothing and the
// backtester keeps running on the simulator until a candle source exists.
//
// Everything it DOES publish is a snapshot: price, liquidity, volume, trade
// counts, market cap, pool age. Nothing about supply distribution, holders, or
// who is behind the wallets. Those gaps are declared per snapshot rather than
// filled with zeros — see UnmeasuredField.

import { providerFetch } from "./http";
import { hueOf, narrativeOf } from "./classify";
import type { MarketDataProvider, TokenDataProvider } from "./types";
import type {
  Candle,
  TokenInfo,
  TokenSnapshot,
  TradeWindow,
  TradeWindowKey,
  UnmeasuredField,
} from "../types";

const BASE = "https://api.dexscreener.com";
const SOLANA = "solana";

/** Everything DEX Screener structurally cannot tell us about a token. */
const DEX_UNMEASURED: readonly UnmeasuredField[] = [
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
  // No authority state, no token extensions, no LP lock. The adapter's
  // hardcoded not-revoked flags are a fail-safe default, not a reading, and
  // declaring that keeps the scorer from treating either as measured.
  "authorities",
  "permanentDelegate",
  "lpLocked",
  // Nor who provides that liquidity, nor what else the deployer has minted.
  // Both are undeclared zeros otherwise, and both of those zeros read as
  // findings: "one party holds the pool" and "first mint from this wallet".
  "lpProviders",
  "devHistory",
  // No 24h history for the pool or the holder base. Both were `?? 0` at the
  // engine seam, which scored "flat" — a measurement of a trend nobody
  // published, and on a token minutes old, of a day that has not happened.
  "liquidityChange",
  "holderGrowth",
];

interface DexPair {
  chainId: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: Record<string, { buys?: number; sells?: number }>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { socials?: { type?: string }[]; websites?: unknown[] };
}

interface BoostRow {
  chainId?: string;
  tokenAddress?: string;
  description?: string;
}

/**
 * Every Solana pool for a mint, deepest first.
 *
 * A token does not trade in one place. BONK returns thirty pools here, and the
 * deepest carries 19% of the day's volume and 20% of the pooled liquidity —
 * so reading the top pool alone understates activity by a factor of five.
 * Measured across three tokens the deepest pool held 19%, 42% and 78% of
 * volume, which is exactly the kind of spread that makes a single-pool number
 * look plausible and be wrong.
 *
 * Price still comes from the deepest pool, because a price is a quote and a
 * thin pool's quote is noise. Volume and liquidity are sums, because those are
 * quantities and the rest of the token's trading is not somebody else's.
 */
function solanaPools(pairs: DexPair[] | null | undefined): DexPair[] {
  return (pairs ?? [])
    .filter((p) => p.chainId === SOLANA && Number(p.liquidity?.usd) > 0)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
}

function deepest(pairs: DexPair[] | null | undefined): DexPair | null {
  return solanaPools(pairs)[0] ?? null;
}

const sumBy = (pools: DexPair[], pick: (p: DexPair) => number | undefined): number =>
  pools.reduce((s, p) => s + (pick(p) ?? 0), 0);

function toInfo(p: DexPair, mint: string): TokenInfo {
  const name = p.baseToken?.name ?? mint.slice(0, 6);
  const symbol = p.baseToken?.symbol ?? "?";
  return {
    mint,
    name,
    symbol,
    createdAt: p.pairCreatedAt ?? 0,
    decimals: 9,
    narrative: narrativeOf(name, symbol),
    // "verified" here means DEX Screener carries socials or a website for it.
    // That is a much weaker claim than an on-chain verification and must not
    // be read as one; it is the strongest signal this source actually has.
    verified: Boolean(p.info?.websites?.length || p.info?.socials?.length),
    // Authority state is an on-chain fact this API never returns. Reported as
    // NOT revoked, because a token whose authorities are unknown must not be
    // graded as safely renounced.
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: false,
    permanentDelegate: false,
    devWallet: "",
    hue: hueOf(mint),
  };
}

/**
 * `pools` must be every Solana pool for the mint, deepest first — quantities
 * are summed across all of them and only the quote is taken from the top.
 *
 * Note this is still a floor: DEX Screener returns at most thirty pairs per
 * token, and GeckoTerminal's token-level aggregate came in 1.0-1.5x higher on
 * the three tokens tested, which is roughly the tail this cap truncates.
 */
function toSnapshot(pools: DexPair[], mint: string): TokenSnapshot {
  const p = pools[0];
  const h1 = pools.map((x) => x.txns?.h1 ?? {});
  return {
    mint,
    ts: Date.now(),
    priceUsd: Number(p.priceUsd) || 0,
    marketCapUsd: p.marketCap ?? 0,
    fdvUsd: p.fdv ?? p.marketCap ?? 0,
    liquidityUsd: sumBy(pools, (x) => x.liquidity?.usd),
    volume24hUsd: sumBy(pools, (x) => x.volume?.h24),
    buys1h: h1.reduce((s, t) => s + (t.buys ?? 0), 0),
    sells1h: h1.reduce((s, t) => s + (t.sells ?? 0), 0),
    // Trade COUNTS are published; distinct WALLET counts are not. Zero here
    // means unknown, which is why the field is declared unmeasured below.
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
    // Buys and sells per window, summed across every pool the way volume and
    // liquidity already are. `traders` is deliberately absent: this API counts
    // transactions, not distinct wallets, and buys + sells would double-count
    // anyone who did both.
    windows: dexWindows(pools),
    unmeasured: DEX_UNMEASURED,
  };
}

/** Buys and sells per window, summed over every pool. */
function dexWindows(pools: DexPair[]): Partial<Record<TradeWindowKey, TradeWindow>> | undefined {
  const keys: [TradeWindowKey, string][] = [
    ["5m", "m5"],
    ["1h", "h1"],
    ["6h", "h6"],
    ["24h", "h24"],
  ];
  const out: Partial<Record<TradeWindowKey, TradeWindow>> = {};
  for (const [key, api] of keys) {
    // Present only when at least one pool broke the window out at all — an
    // absent window and a genuinely quiet one must not look the same.
    if (!pools.some((p) => p.txns?.[api])) continue;
    // Volume is published per window but NOT split by side, so the two volume
    // fields stay undefined rather than being halved into a fiction.
    out[key] = {
      buys: sumBy(pools, (p) => p.txns?.[api]?.buys),
      sells: sumBy(pools, (p) => p.txns?.[api]?.sells),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export class DexScreenerTokenProvider implements TokenDataProvider {
  readonly name = "dexscreener";

  async getToken(mint: string): Promise<(TokenInfo & { snapshot: TokenSnapshot }) | null> {
    const res = await providerFetch<{ pairs: DexPair[] | null }>(
      this.name,
      `${BASE}/latest/dex/tokens/${encodeURIComponent(mint)}`,
    );
    const pools = solanaPools(res.pairs);
    if (!pools.length) return null;
    return { ...toInfo(pools[0], mint), snapshot: toSnapshot(pools, mint) };
  }

  /**
   * Boosted tokens stand in for "trending".
   *
   * Worth being clear about what that means: boosts are PAID promotion, not a
   * volume ranking, so this is a list of who is advertising. It is the only
   * discovery feed this API offers, and treating a paid slot as organic
   * momentum would be exactly the kind of quiet lie the unmeasured machinery
   * exists to prevent — so /status labels this source for what it is.
   */
  async getTrendingTokens(limit: number): Promise<TokenSnapshot[]> {
    const rows = await providerFetch<BoostRow[]>(this.name, `${BASE}/token-boosts/top/v1`);
    return this.snapshotsFor(rows, limit);
  }

  async getRecentTokens(limit: number): Promise<TokenSnapshot[]> {
    const rows = await providerFetch<BoostRow[]>(this.name, `${BASE}/token-profiles/latest/v1`);
    return this.snapshotsFor(rows, limit);
  }

  /** Resolves a discovery list to real snapshots, dropping anything unpriced. */
  private async snapshotsFor(rows: BoostRow[], limit: number): Promise<TokenSnapshot[]> {
    const mints = (Array.isArray(rows) ? rows : [])
      .filter((r) => r.chainId === SOLANA && r.tokenAddress)
      .map((r) => r.tokenAddress!)
      .slice(0, Math.max(0, limit));
    if (mints.length === 0) return [];

    // One request per mint, but bounded by `limit` and run in small batches so
    // a trending panel cannot open thirty sockets at once.
    const out: TokenSnapshot[] = [];
    for (let i = 0; i < mints.length; i += 5) {
      const batch = await Promise.allSettled(mints.slice(i, i + 5).map((m) => this.getToken(m)));
      for (const r of batch) {
        if (r.status === "fulfilled" && r.value) out.push(r.value.snapshot);
      }
    }
    return out;
  }

  async searchTokens(query: string): Promise<TokenInfo[]> {
    const res = await providerFetch<{ pairs: DexPair[] | null }>(
      this.name,
      `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`,
    );
    const seen = new Set<string>();
    const out: TokenInfo[] = [];
    for (const p of res.pairs ?? []) {
      const mint = p.baseToken?.address;
      if (p.chainId !== SOLANA || !mint || seen.has(mint)) continue;
      seen.add(mint);
      out.push(toInfo(p, mint));
      if (out.length >= 20) break;
    }
    return out;
  }
}

export class DexScreenerMarketProvider implements MarketDataProvider {
  readonly name = "dexscreener";

  async getPrice(mint: string): Promise<number | null> {
    const res = await providerFetch<{ pairs: DexPair[] | null }>(
      this.name,
      `${BASE}/latest/dex/tokens/${encodeURIComponent(mint)}`,
    );
    const p = deepest(res.pairs);
    return p ? Number(p.priceUsd) || null : null;
  }

  /**
   * There is no public OHLCV endpoint — /latest/dex/candles, /chart and
   * /ohlcv were all tried against the live API and all 404.
   *
   * Returning [] rather than synthesising bars from the h1/h6/h24 percentage
   * changes is deliberate. Four points of percentage drift can be drawn as a
   * candle series that looks exactly like history and is not one, and the
   * backtester would then report a return computed from a shape this provider
   * invented. Empty is a fact; a fabricated chart is a lie with axes on it.
   */
  async getCandles(): Promise<Candle[]> {
    return [];
  }
}
