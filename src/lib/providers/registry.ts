// Provider registry. Feature flags + key presence decide which adapters
// serve each capability; anything unconfigured falls back to the demo
// adapters over the synthetic store. /status renders health() directly.

import { getStore } from "../demo/store";
import { HOUR } from "../demo/universe";
import { healthOf } from "./http";
import { JupiterTokenProvider } from "./jupiter";
import { BirdeyeMarketProvider, BirdeyeSecurityProvider } from "./birdeye";
import { HeliusWalletProvider } from "./helius";
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
  dexscreener: () => flag("ENABLE_DEXSCREENER", false),
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

export function getProviders(): ProviderSet {
  if (cached) return cached;
  const liveToken = FLAGS.jupiter();
  const liveMarket = FLAGS.birdeye();
  const liveWallet = FLAGS.helius();
  const anyLive = liveToken || liveMarket || liveWallet;

  cached = {
    mode: anyLive ? "live" : "demo",
    token: liveToken ? new JupiterTokenProvider() : new DemoTokenProvider(),
    market: liveMarket ? new BirdeyeMarketProvider() : new DemoMarketProvider(),
    wallet: liveWallet ? new HeliusWalletProvider() : new DemoWalletProvider(),
    security: liveMarket ? new BirdeyeSecurityProvider() : new DemoSecurityProvider(),
    health: providerHealth,
  };
  return cached;
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
  rows.push(FLAGS.dexscreener() ? healthOf("dexscreener", "live") : { ...demoHealth("dexscreener"), mode: "disabled", status: "down", note: "fallback source — not enabled" });
  rows.push(
    FLAGS.coingecko()
      ? { ...healthOf("coingecko", "live"), note: "live SOL reference price (keyless public API)" }
      : { ...demoHealth("coingecko"), mode: "disabled", status: "down", note: "disabled via ENABLE_COINGECKO" },
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
