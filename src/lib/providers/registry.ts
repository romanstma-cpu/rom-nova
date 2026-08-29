// Provider registry. Feature flags + key presence decide which adapters
// serve each capability; anything unconfigured falls back to the demo
// adapters over the synthetic store. /status renders health() directly.

import { getStore } from "../demo/store";
import { HOUR } from "../demo/universe";
import { healthOf } from "./http";
import { JupiterTokenProvider } from "./jupiter";
import { BirdeyeMarketProvider, BirdeyeSecurityProvider } from "./birdeye";
import { HeliusWalletProvider } from "./helius";
import { DexScreenerMarketProvider, DexScreenerTokenProvider } from "./dexscreener";
import { GeckoTerminalMarketProvider, GeckoTerminalTokenProvider } from "./geckoterminal";
import { SolanaRpcSecurityProvider } from "./solana-rpc";
import { SqdFlowProvider } from "./sqd";
import type {
  MarketDataProvider,
  ProviderSet,
  SecurityDataProvider,
  TokenDataProvider,
  WalletDataProvider,
} from "./types";
import type { ProviderHealth } from "../types";

const flag = (name: string, dflt = true) => {
  const v = process.env[name];
  return v === undefined ? dflt : v !== "false" && v !== "0";
};

export const FLAGS = {
  jupiter: () => flag("ENABLE_JUPITER") && Boolean(process.env.JUPITER_API_KEY || process.env.JUPITER_LITE),
  birdeye: () => flag("ENABLE_BIRDEYE") && Boolean(process.env.BIRDEYE_API_KEY),
  helius: () => flag("ENABLE_HELIUS") && Boolean(process.env.HELIUS_API_KEY),
  nansen: () => flag("ENABLE_NANSEN") && Boolean(process.env.NANSEN_API_KEY),
  // Keyless, so on by default. This is what lets a fresh install show real
  // Solana tokens instead of the simulator.
  dexscreener: () => flag("ENABLE_DEXSCREENER"),
  // Solana's own JSON-RPC. Keyless, browser-reachable, and the only free way
  // to know whether a mint's authorities are actually revoked.
  solanaRpc: () => flag("ENABLE_SOLANA_RPC"),
  // SQD's Solana Portal. Keyless and browser-reachable, and the only source in
  // this stack with WALLET-LEVEL FLOW — the gap every live feature vector has
  // carried as a declared zero since the day it was written.
  sqd: () => flag("ENABLE_SQD"),
  // keyless public reference sources — live by default, even in demo mode
  coingecko: () => flag("ENABLE_COINGECKO"),
  cryptocom: () => flag("ENABLE_CRYPTOCOM"),
  infstones: () => flag("ENABLE_INFSTONES") && Boolean(process.env.INFSTONES_API_KEY),
};

// ---------------------------------------------------------------- demo adapters

class DemoTokenProvider implements TokenDataProvider {
  readonly name = "demo";
  async getToken(mint: string) {
    const store = getStore();
    const tok = store.token(mint);
    const snap = store.snapshot(mint);
    return tok && snap ? { ...tok.info, snapshot: snap } : null;
  }
  async getTrendingTokens(limit: number) {
    const store = getStore();
    return store
      .snapshots()
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, limit);
  }
  async getRecentTokens(limit: number) {
    const store = getStore();
    return store
      .tokenList()
      .sort((a, b) => b.info.createdAt - a.info.createdAt)
      .slice(0, limit)
      .map((t) => store.snapshot(t.info.mint)!)
      .filter(Boolean);
  }
  async searchTokens(query: string) {
    const store = getStore();
    const q = query.toLowerCase();
    return store
      .tokenList()
      .filter(
        (t) =>
          t.info.mint === query ||
          t.info.symbol.toLowerCase().includes(q) ||
          t.info.name.toLowerCase().includes(q),
      )
      .slice(0, 20)
      .map((t) => t.info);
  }
}

class DemoMarketProvider implements MarketDataProvider {
  readonly name = "demo";
  async getCandles(mint: string, fromTs: number, toTs: number) {
    return getStore().candles(mint, fromTs, toTs);
  }
  async getPrice(mint: string) {
    return getStore().lastPrice(mint) ?? null;
  }
}

class DemoWalletProvider implements WalletDataProvider {
  readonly name = "demo";
  async getWalletTrades(address: string, limit: number) {
    return getStore().walletTrades(address).slice(-limit);
  }
  async getWalletLabels(address: string) {
    return getStore().wallet(address)?.labels ?? [];
  }
}

class DemoSecurityProvider implements SecurityDataProvider {
  readonly name = "demo";
  async getTokenSecurity(mint: string) {
    const store = getStore();
    const tok = store.token(mint);
    if (!tok) return null;
    const stats = store.tokenStats(tok, store.simulatedUntil);
    const warnings: string[] = [];
    if (!tok.info.mintAuthorityRevoked) warnings.push("mint authority present");
    if (!tok.info.freezeAuthorityRevoked) warnings.push("freeze authority present");
    if (tok.info.permanentDelegate) warnings.push("permanent delegate set");
    return {
      mintAuthorityRevoked: tok.info.mintAuthorityRevoked,
      freezeAuthorityRevoked: tok.info.freezeAuthorityRevoked,
      top10Pct: stats.top10Pct,
      warnings,
    };
  }
}

// ---------------------------------------------------------------- resolution

let cached: ProviderSet | undefined;

/**
 * Resolves each capability to the best source configured for it.
 *
 * The order below is a claim about data quality, not about who was written
 * first. Keyed vendors win where they are configured because they answer
 * questions the keyless ones cannot — Birdeye and Helius see holder
 * distribution and wallet-level flow, which is most of what this app is about.
 *
 * The change that matters is the tail. GeckoTerminal and DEX Screener need no
 * key at all, so an unconfigured install no longer falls all the way back to
 * the simulator for market and token data: it shows Solana. GeckoTerminal
 * takes the market slot ahead of DEX Screener for one specific reason — it is
 * the only keyless source with HISTORY (a thousand hourly bars, some six
 * weeks), and DEX Screener has no OHLCV endpoint at all.
 *
 * Wallet activity has no keyless source, so it stays on the simulator until
 * Helius is configured. That is a real seam and /status names it rather than
 * blending the two silently.
 */
export function getProviders(): ProviderSet {
  if (cached) return cached;
  const liveWallet = FLAGS.helius();

  const token: TokenDataProvider = FLAGS.jupiter()
    ? new JupiterTokenProvider()
    : FLAGS.coingecko()
      ? new GeckoTerminalTokenProvider()
      : FLAGS.dexscreener()
        ? new DexScreenerTokenProvider()
        : new DemoTokenProvider();

  const market: MarketDataProvider = FLAGS.birdeye()
    ? new BirdeyeMarketProvider()
    : FLAGS.coingecko()
      ? new GeckoTerminalMarketProvider()
      : FLAGS.dexscreener()
        ? new DexScreenerMarketProvider()
        : new DemoMarketProvider();

  const anyLive =
    token.name !== "demo" || market.name !== "demo" || liveWallet;

  cached = {
    mode: anyLive ? "live" : "demo",
    token,
    market,
    wallet: liveWallet ? new HeliusWalletProvider() : new DemoWalletProvider(),
    // Birdeye first: it is the only source here with holder distribution, and
    // concentration is the larger half of a security grade.
    //
    // Below it, the chain itself. That slot used to be demo-only, on the
    // reasoning that "a security provider that returns zeros would report every
    // token as having no concentration and revoked authorities" — correct about
    // the danger, and it gave up something real. Solana's public RPC answers
    // mint and freeze authority for free, and until now the app graded BONK as
    // if its deployer could still mint. The zeros problem is handled by
    // `top10Known: false` instead, which keeps concentration unmeasured while
    // letting the authorities be known.
    security: FLAGS.birdeye()
      ? new BirdeyeSecurityProvider()
      : FLAGS.solanaRpc()
        ? new SolanaRpcSecurityProvider()
        : new DemoSecurityProvider(),
    // Left undefined rather than filled with a demo stand-in. There is no
    // synthetic answer to "who bought this", and a caller that finds nothing
    // here should say the flow is unmeasured, not read a simulated one.
    flow: FLAGS.sqd() ? new SqdFlowProvider() : undefined,
    health: providerHealth,
  };
  return cached;
}

/**
 * What is actually real right now, per capability.
 *
 * The nav and the top bar shipped a flat SIMULATED DATA chip whose tooltip
 * said "every token, wallet and trade in this terminal is a deterministic
 * simulation; the SOL reference price is the one live number". That was true
 * when it was written and is now false three times over: the token list is DEX
 * Screener, mint and freeze authorities are read from the chain, and whale flow
 * comes from SQD.
 *
 * A blanket claim in either direction is the problem. Told everything is
 * simulated, a reader discounts a real number; shown one real panel, they trust
 * a synthetic one beside it. So the chip is computed from the same resolution
 * the providers use, and it names which halves are which.
 */
export interface DataMode {
  overall: "live" | "mixed" | "demo";
  live: string[];
  simulated: string[];
}

export function dataMode(): DataMode {
  const p = getProviders();
  const live: string[] = [];
  const simulated: string[] = [];

  (p.token.name === "demo" ? simulated : live).push("tokens");
  (p.market.name === "demo" ? simulated : live).push("prices & candles");
  (p.security.name === "demo" ? simulated : live).push("mint & freeze authority");
  (p.flow ? live : simulated).push("whale flow");
  (p.wallet.name === "demo" ? simulated : live).push("wallet activity");
  // No keyless source publishes holder distribution, and the free RPC blocks
  // the two methods that would give it. Named separately because it is the
  // gap a reader is most likely to assume is covered.
  (FLAGS.birdeye() ? live : simulated).push("holder distribution");
  // Smart money needs wallet reputation, which nothing here carries at all.
  simulated.push("smart-money scoring");

  const overall = live.length === 0 ? "demo" : simulated.length === 0 ? "live" : "mixed";
  return { overall, live, simulated };
}

export function providerHealth(): ProviderHealth[] {
  const store = getStore();
  const demoHealth = (name: string): ProviderHealth => ({
    name,
    mode: "demo",
    status: "ok",
    latencyMs: 1,
    errorRatePct: 0,
    lastSuccessTs: store.simulatedUntil,
    lastDataTs: store.simulatedUntil,
    note: "synthetic data — deterministic demo universe",
  });

  const rows: ProviderHealth[] = [];
  rows.push(FLAGS.jupiter() ? healthOf("jupiter", "live") : { ...demoHealth("jupiter"), mode: "disabled", status: "down", note: "needs server mode + JUPITER_API_KEY — simulated data serves token info" });
  rows.push(FLAGS.birdeye() ? healthOf("birdeye", "live") : { ...demoHealth("birdeye"), mode: "disabled", status: "down", note: "needs server mode + BIRDEYE_API_KEY — simulated data serves market data" });
  rows.push(FLAGS.helius() ? healthOf("helius", "live") : { ...demoHealth("helius"), mode: "disabled", status: "down", note: "needs server mode + HELIUS_API_KEY — simulated data serves wallet activity" });
  rows.push(FLAGS.nansen() ? healthOf("nansen", "live") : { ...demoHealth("nansen"), mode: "disabled", status: "down", note: "optional enrichment — not configured" });
  // These two used to say "adapter ready", not "serving the app", because
  // getProviders() resolved to them and nothing called it. That gap is closed —
  // handlers go through the provider seam now — so the notes below say what
  // each one actually serves, and keep naming what it still cannot.
  rows.push(
    FLAGS.dexscreener()
      ? {
          ...healthOf("dexscreener", "live"),
          note:
            "keyless, and now SERVING THE TOKEN LIST — twelve trending Solana tokens per " +
            "request, scored. Supplies price, pooled liquidity, 24h volume and trade counts " +
            "summed across all Solana pools. Chosen over GeckoTerminal for the list because it " +
            "batches internally: twelve getToken calls at GeckoTerminal took 27s and returned " +
            "two usable rows. No holder data, no OHLCV; and 'trending' is PAID BOOSTS, so it " +
            "is a list of who is advertising rather than a volume ranking",
        }
      : { ...demoHealth("dexscreener"), mode: "disabled", status: "down", note: "disabled via ENABLE_DEXSCREENER" },
  );
  rows.push(
    FLAGS.coingecko()
      ? {
          ...healthOf("coingecko", "live"),
          note:
            "keyless. LIVE NOW: the SOL reference price in the header, and the price chart on " +
            "any token page — ~1,000 hourly on-chain bars, the only keyless source with real " +
            "history. NOT used for the token LIST: it rate-limits hard under concurrency, so " +
            "list rows are scored without candles and declare momentum unmeasured. The " +
            "backtester still takes a DemoStore and cannot use any of it",
        }
      : { ...demoHealth("coingecko"), mode: "disabled", status: "down", note: "disabled via ENABLE_COINGECKO" },
  );
  rows.push(
    FLAGS.sqd()
      ? {
          ...healthOf("sqd", "live"),
          note:
            "keyless Solana Portal, browser-reachable. The only source here with WALLET-LEVEL " +
            "FLOW — preOwner/postOwner balance deltas per mint, which every live feature vector " +
            "has carried as a declared zero until now. Reads are BOUNDED: measured at 26MB for " +
            "80 seconds of wSOL, so a busy mint returns a PARTIAL window and says which blocks " +
            "it covered rather than truncating silently. Most rows are accounts merely touched " +
            "by a transaction (75-93% depending on the mint) and are discarded",
        }
      : { ...demoHealth("sqd"), mode: "disabled", status: "down", note: "disabled via ENABLE_SQD — wallet flow unmeasured" },
  );
  rows.push(
    FLAGS.solanaRpc()
      ? {
          ...healthOf("solana-rpc", "live"),
          note:
            "keyless, reads the chain directly. LIVE NOW when Birdeye is not configured: " +
            "mint and freeze authority, which no other keyless source publishes — before this " +
            "every token was graded as if its deployer could still mint. Holder distribution " +
            "stays UNMEASURED: getTokenSupply and getTokenLargestAccounts return 'Request " +
            "blocked' on the free endpoints. publicnode leads because api.mainnet-beta 403s " +
            "browser origins, and most of this app runs in a tab",
        }
      : { ...demoHealth("solana-rpc"), mode: "disabled", status: "down", note: "disabled via ENABLE_SOLANA_RPC" },
  );
  rows.push(
    FLAGS.cryptocom()
      ? { ...healthOf("cryptocom", "live"), note: "live SOL_USD ticker, Crypto.com Exchange public API" }
      : { ...demoHealth("cryptocom"), mode: "disabled", status: "down", note: "disabled via ENABLE_CRYPTOCOM" },
  );
  rows.push(
    FLAGS.infstones()
      ? { ...healthOf("infstones", "live"), note: "third-opinion price cross-check" }
      : { ...demoHealth("infstones"), mode: "disabled", status: "down", note: "needs server mode + INFSTONES_API_KEY — optional third price opinion" },
  );
  rows.push({ ...demoHealth("demo-universe"), note: `seed ${store.universe.seed} · ${store.tokenList().length} tokens · ${store.walletList().length} wallets · genesis ${new Date(store.universe.genesis).toISOString()}` });
  return rows;
}

export function dataFreshness(ts: number, now = Date.now()): string {
  const age = now - ts;
  if (age < 5_000) return "live";
  if (age < 60_000) return `${Math.round(age / 1000)}s ago`;
  if (age < HOUR) return `${Math.round(age / 60_000)}m ago`;
  if (age < 24 * HOUR) return `${Math.round(age / HOUR)}h ago`;
  return "historical";
}
