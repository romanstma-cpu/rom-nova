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
import { RugCheckRiskProvider } from "./rugcheck";
import { JupiterHoldingsProvider } from "./holdings";
import { lastOutcome } from "./health-log";
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
  // Keyless and ON. This used to require JUPITER_API_KEY, which meant the best
  // source in the stack never ran: lite-api.jup.ag serves the identical paths
  // free, in under 300ms, and reflects the caller's Origin — including the
  // `app://rom-nova` the Electron shell loads from. A key upgrades the rate
  // limit and changes nothing else.
  jupiter: () => flag("ENABLE_JUPITER"),
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
  // RugCheck. Keyless, CORS `*`, and the only source here that can see whether
  // the liquidity pool is locked — the mechanic behind most memecoin losses,
  // which no amount of supply analysis catches.
  rugcheck: () => flag("ENABLE_RUGCHECK"),
  // Solana's own RPC, read for WALLET HISTORY rather than mint metadata.
  // Keyless and browser-reachable, and it closes the last entirely synthetic
  // capability in the app: every wallet used to come from the demo universe
  // with an invented name. Its ceiling is retention, measured at ~2 days, so it
  // serves a WINDOW and every figure derived from it names that window.
  walletChain: () => flag("ENABLE_WALLET_CHAIN"),
  // Jupiter's Ultra holdings endpoint. Keyless, and the only way to read a
  // wallet's balances at all — getTokenAccountsByOwner returns 403 on every
  // free RPC. Without it, positions could only be replayed out of the trade
  // window, which would make them exactly as incomplete as the window is.
  walletHoldings: () => flag("ENABLE_WALLET_HOLDINGS"),
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
 * The change that matters is the tail. Jupiter, GeckoTerminal and DEX Screener
 * need no key at all, so an unconfigured install no longer falls all the way
 * back to the simulator for market and token data: it shows Solana.
 *
 * Jupiter takes the token slot outright. The ordering above says keyed vendors
 * win "because they answer questions the keyless ones cannot", and Jupiter is
 * the case that broke the rule — it answers holder count, top-holder share, dev
 * balance, organic activity and creator mint history for free, which is most of
 * what Birdeye was wanted for. GeckoTerminal keeps the MARKET slot for the one
 * thing Jupiter has no equivalent of: real OHLCV, a thousand hourly bars.
 *
 * Wallet activity used to say "has no keyless source, so it stays on the
 * simulator until Helius is configured". That was true when it was written and
 * is now false. Solana's public RPC answers `getSignaturesForAddress` and
 * `getTransaction` for free, from a browser origin, and balance deltas out of
 * `jsonParsed` transactions ARE the wallet's fills. Helius still wins the slot
 * where it is configured, because its retention is not two days.
 *
 * That retention limit is the whole caveat and it does not go away: the
 * keyless path serves a WINDOW. It is wired in anyway because a real
 * forty-eight hours beats a synthetic eternity, and because every number built
 * on it carries the window with it.
 */
export function getProviders(): ProviderSet {
  if (cached) return cached;
  const liveWallet = FLAGS.helius() || FLAGS.walletChain();

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
    // Helius where a key exists. Below it the DEMO adapter, deliberately: the
    // keyless chain reader does not implement `WalletDataProvider` at all.
    //
    // That interface promises `WalletTrade[]`, and a WalletTrade requires a
    // price — but at least 46% of a real wallet's movements have none (that is
    // the measured no-quote-leg rate; the unpriced set is larger), and the adapter
    // that satisfied the interface did so by silently dropping them and
    // labelling every remaining fill `dex: "Raydium"` because the union has no
    // honest member. Nothing called it. The real reader is reached through
    // `walletProfile()` in api/source.ts, which returns a shape that can say
    // "no price observed", and `dataMode()` reports it separately.
    wallet: FLAGS.helius() ? new HeliusWalletProvider() : new DemoWalletProvider(),
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
    // Same contract as flow: absent means nobody graded this token, which the
    // UI must render as silence and never as a clean bill of health.
    risk: FLAGS.rugcheck() ? new RugCheckRiskProvider() : undefined,
    // No demo stand-in here either. Without a balance read there is no
    // independent check on the fill-derived positions, and the reconciliation
    // that makes a cost basis trustworthy stops being possible — which a caller
    // must report as "cost basis unknown", not paper over with the simulator.
    holdings: FLAGS.walletHoldings() ? new JupiterHoldingsProvider() : undefined,
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
  /**
   * Real, and narrower than a reader would assume.
   *
   * A third column, because two were not enough once wallet history arrived.
   * "Wallet activity — simulated" was honest. "Wallet activity — live" would
   * not be: it is live for about forty-eight hours and silent before that, and
   * a reader who sees LIVE beside a realized-PnL figure will read it as the
   * wallet's performance rather than as two days of it. Listing it as live and
   * saying nothing would be the most damaging kind of true.
   */
  bounded: string[];
}

export function dataMode(): DataMode {
  const p = getProviders();
  const live: string[] = [];
  const simulated: string[] = [];
  const bounded: string[] = [];

  (p.token.name === "demo" ? simulated : live).push("tokens");
  // Signals descend from the token list, so they are live exactly when it is
  // — and, like candles below, the last OUTCOME wins where there is one. The
  // live path records an outcome on every pass; a failed one moves this to
  // the bounded column with its reason, because /signals is then serving the
  // simulator under a SIMULATED label and the chip must not say otherwise.
  //
  // Configuration first, outcome second, deliberately: the nav chip fetches
  // /status once on mount, before any list pass has landed, and a rule of
  // "simulated until the first pass answers" would freeze a wrong label on the
  // chip for the whole session while the dashboard beside it rendered live
  // signals under a vendor's name.
  if (p.token.name === "demo") {
    simulated.push("signals");
  } else {
    const sig = lastOutcome("signals");
    if (sig && !sig.ok) {
      bounded.push(
        `signals — the last live scan FAILED${sig.note ? ` (${sig.note})` : ""}; ` +
          "/signals is on the simulator and says so",
      );
    } else {
      live.push("signals");
    }
  }
  // Candles are the one capability here whose CONFIGURATION and whose BEHAVIOUR
  // routinely disagree. The provider name says a real adapter is wired; it says
  // nothing about whether the vendor is answering, and GeckoTerminal rate-limits
  // easily enough that this repo already serialises it behind a 2.1s gap. Worse,
  // its 429 carries no `access-control-allow-origin` header, so a browser sees
  // `TypeError: Failed to fetch` — an outage, as far as anything downstream can
  // tell. The chip went on advertising "prices & candles — LIVE" while every
  // chart on the site was quietly rendering the simulator.
  //
  // So this reads the last actual OUTCOME where there is one, and falls back to
  // the configuration only before anything has been fetched.
  if (p.market.name === "demo") {
    simulated.push("prices & candles");
  } else {
    const health = lastOutcome("candles");
    if (health && !health.ok) {
      bounded.push(
        `price history — the last candle request to ${p.market.name} FAILED` +
          (health.note ? ` (${health.note})` : "") +
          "; charts are falling back, and a rate-limited response is indistinguishable from an outage from a browser",
      );
    } else {
      live.push("prices & candles");
    }
  }
  (p.security.name === "demo" ? simulated : live).push("mint & freeze authority");
  // The same observation-over-configuration rule candles get, applied to the
  // three capabilities whose /status rows said "not asked yet" while this
  // panel called them LIVE. Configuration decides until something has been
  // tried; after that, the last outcome decides.
  const failedLately = (capability: string): string | null => {
    const h = lastOutcome(capability);
    return h && !h.ok ? h.note ?? "the last request failed" : null;
  };
  if (!p.flow) {
    simulated.push("whale flow");
  } else {
    const why = failedLately("whale flow");
    if (why) bounded.push(`whale flow — the last SQD read FAILED (${why}); rows declare it unmeasured until one succeeds`);
    else live.push("whale flow");
  }
  // Wallet activity is real whenever the chain reader is on, whatever the
  // `wallet` provider slot holds — that slot is the WalletTrade contract, which
  // the chain reader deliberately does not implement. See getProviders().
  if (FLAGS.walletChain() || p.wallet.name !== "demo") {
    const why = failedLately("wallet activity");
    if (why) bounded.push(`wallet activity — the last chain read FAILED (${why})`);
    else live.push("wallet activity");
    if (FLAGS.walletChain() && !FLAGS.helius()) {
      // Two depths, and one label over both would be false for one of them.
      bounded.push(
        "wallet FILLS & PnL — last ~2 days in every runtime (the only endpoint serving older " +
          "transaction bodies allows ten getTransaction calls per window)",
      );
      bounded.push(
        "wallet AGE & lifetime transaction count — full index in the desktop app and server " +
          "mode; not readable from a browser tab, which cannot omit the Origin header",
      );
    }
  } else {
    simulated.push("wallet activity");
  }
  if (p.holdings) {
    const why = failedLately("wallet positions");
    if (why) bounded.push(`wallet positions — the last balance read FAILED (${why}); positions fall back to the trade window`);
    else live.push("wallet positions");
  } else {
    bounded.push("wallet positions — derived from the trade window, not read whole");
  }
  // This line used to read `FLAGS.birdeye()` and put holder distribution in the
  // simulated column on every keyless install, with the note that "no keyless
  // source publishes holder distribution". Jupiter does — holderCount, its 24h
  // change, and the top-holder share — so the claim was true when written and
  // is now false.
  (FLAGS.birdeye() || FLAGS.jupiter() ? live : simulated).push("holder distribution");
  (p.risk ? live : simulated).push("rug & LP-lock risk");
  // The launch feed refuses to fall back at all — see handleLaunches — so this
  // line is not "which source is serving it" but "does the page exist". Listed
  // because a reader looking at /status to work out what is real deserves to
  // see the newest capability rather than infer it from the nav.
  (FLAGS.jupiter() ? live : simulated).push("new-pool launch feed");
  // Smart money still needs wallet reputation, which nothing here carries. Real
  // fills changed what can be MEASURED about a wallet and not what can be
  // CLAIMED about it: win rate over two days is a sample. The real wallet
  // provider returns no labels at all rather than minting one.
  simulated.push("smart-money scoring");

  // The old rule was `simulated.length === 0` for "live". With a bounded
  // capability present that would call the whole terminal live while one of its
  // headline numbers covers two days, so a bound keeps it at "mixed".
  const overall =
    live.length === 0 ? "demo" : simulated.length === 0 && bounded.length === 0 ? "live" : "mixed";
  return { overall, live, simulated, bounded };
}

export function providerHealth(): ProviderHealth[] {
  const store = getStore();
  /**
   * A row for a provider nobody has called, with NOTHING measured in it.
   *
   * This used to hardcode `latencyMs: 1`, `errorRatePct: 0` and `lastDataTs:
   * now` — three measurements nobody took, rendered four rows apart from the
   * live rows that correctly dash all three for the same condition. A
   * disabled provider has no latency, no error rate over zero requests and
   * no last data, least of all "now". The table already knows how to render
   * absence; it just has to be handed one.
   */
  const demoHealth = (name: string): ProviderHealth => ({
    name,
    mode: "demo",
    status: "ok",
    lastSuccessTs: 0,
    lastDataTs: 0,
    note: "synthetic data — deterministic demo universe",
  });

  const rows: ProviderHealth[] = [];
  rows.push(
    FLAGS.jupiter()
      ? {
          ...healthOf("jupiter", "live"),
          note:
            "keyless (lite-api.jup.ag), and now SERVING THE TOKEN LIST in ONE request — the " +
            "previous path made a trending call plus twelve token lookups. Supplies what no " +
            "other keyless source here does: holder count and its 24h change, top-holder " +
            "share, dev balance, a real organic-activity score, the launchpad, and the " +
            "creator's mint history — a wallet on its first token and one on its 873rd are " +
            "both in today's trending list. Its per-interval priceChange and volumeChange " +
            "also give momentum and volume acceleration WITHOUT candles, which is what un-" +
            "dashed four scanner columns. CAVEAT: topHoldersPercentage counts AMM pools as " +
            "holders, so a high figure can mean deep liquidity rather than a whale. ALSO SERVING " +
            "THE LAUNCH FEED: its /recent endpoint carries brand-new mints at a measured p50 of " +
            "about 5.7s behind pool creation (2.3s at BEST, and the median is what a reader " +
            "experiences), the freshest keyless view of a launch found here — but it caps at 30 " +
            "rows with no cursor, so whatever falls off that page is gone. AND GRADUATIONS: the " +
            "same vendor's datapi.jup.ag/v1/pools/gems publishes a graduated list that reflects " +
            "this app's origin on both the preflight and the POST, measured at p50 3.0s against " +
            "GeckoTerminal's 40.0s over the same seven minutes — it replaced GeckoTerminal as the " +
            "graduation path, which was the single worst latency in the feed at roughly two minutes" +
            (process.env.JUPITER_API_KEY ? " · API key present, higher rate limit" : ""),
        }
      : { ...demoHealth("jupiter"), mode: "disabled", status: "down", note: "disabled via ENABLE_JUPITER" },
  );
  rows.push(FLAGS.birdeye() ? healthOf("birdeye", "live") : { ...demoHealth("birdeye"), mode: "disabled", status: "down", note: "needs server mode + BIRDEYE_API_KEY — simulated data serves market data" });
  rows.push(
    FLAGS.helius()
      ? healthOf("helius", "live")
      : {
          ...demoHealth("helius"),
          mode: "disabled",
          status: "down",
          note:
            "needs server mode + HELIUS_API_KEY. No longer the only route to wallet activity — " +
            "the keyless chain read serves it now — but still the only route to a wallet's FULL " +
            "history, which public RPC retention puts out of reach",
        },
  );
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
            "keyless. FALLBACK for the token list now that Jupiter serves it — it held that " +
            "slot because it batches where GeckoTerminal rate-limits, and it lost it because " +
            "Jupiter returns the same twelve rows in ONE call WITH holder and audit data. " +
            "Supplies price, pooled liquidity, 24h volume and trade counts summed across all " +
            "Solana pools. No holder data, no OHLCV; and its 'trending' is PAID BOOSTS, so it " +
            "is a list of who is advertising rather than a volume ranking",
        }
      : { ...demoHealth("dexscreener"), mode: "disabled", status: "down", note: "disabled via ENABLE_DEXSCREENER" },
  );
  // Two hosts that used to share one row. The SOL reference ping never
  // rate-limits and the OHLCV host throttles hard, so a combined row read
  // "● ok" on the strength of the endpoint nobody worries about.
  rows.push(
    FLAGS.coingecko()
      ? {
          ...healthOf("coingecko", "live"),
          note:
            "keyless, api.coingecko.com. ONLY the SOL reference price in the header (cross-checked " +
            "against Crypto.com). Nothing else in the app reads this host — the price chart is " +
            "geckoterminal and jupiter-charts, two rows down",
        }
      : { ...demoHealth("coingecko"), mode: "disabled", status: "down", note: "disabled via ENABLE_COINGECKO" },
  );
  rows.push(
    FLAGS.coingecko()
      ? {
          ...healthOf("geckoterminal", "live"),
          note:
            "keyless, api.geckoterminal.com. The HOURLY view of a token's price chart — ~1,000 " +
            "hourly on-chain bars — and the new-pool sweep behind the launch feed's direct-AMM " +
            "rows. It rate-limits hard under concurrency (four no-gap calls: 200 ×4 then 429 ×4, " +
            "and the 429 carries no CORS header, so a browser sees a network error), so it is " +
            "serialised behind a 2.1s gap, NOT used for the token list, and the chart falls back " +
            "to jupiter-charts when it throttles. The chart names whichever host drew it",
        }
      : { ...demoHealth("geckoterminal"), mode: "disabled", status: "down", note: "disabled via ENABLE_COINGECKO" },
  );
  rows.push(
    FLAGS.jupiter()
      ? {
          ...healthOf("jupiter-charts", "live"),
          note:
            "keyless, datapi.jup.ag/v2/charts. The DEFAULT price chart on a token page — the 15m view " +
            "a first visit opens with — and every minute-granularity bucket (1m/5m/15m/4h/1d), plus the " +
            "fallback for the hourly view when geckoterminal throttles. Its volume field's unit could " +
            "not be established (see jupiter-chart.ts), so the chart carries it unlabelled. This row " +
            "did not exist while the token page already credited the chart to it",
        }
      : { ...demoHealth("jupiter-charts"), mode: "disabled", status: "down", note: "disabled via ENABLE_JUPITER" },
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
    FLAGS.rugcheck()
      ? {
          ...healthOf("rugcheck", "live"),
          note:
            "keyless, CORS open to any origin. Supplies the one risk nothing else here can " +
            "see: whether the LIQUIDITY POOL IS LOCKED. Every other risk signal in this app " +
            "is about supply, and a deployer who can withdraw the pool does not need a mint " +
            "authority to take the money. Also a normalised 0-100 risk score and named, " +
            "readable risks. The cheap summary (~300B) serves list rows; the full report " +
            "(80KB-1.6MB) is fetched only when a token is opened. NOT used to compute a " +
            "pool-excluded concentration figure — measured across five trending tokens, its " +
            "account labels covered 12 of 20 top holders on one and ZERO of 20 on two others, " +
            "so that number would have been most wrong on the largest tokens",
        }
      : { ...demoHealth("rugcheck"), mode: "disabled", status: "down", note: "disabled via ENABLE_RUGCHECK — LP lock state and third-party risk scoring unavailable" },
  );
  rows.push(
    FLAGS.walletChain()
      ? {
          ...healthOf("solana-rpc-wallet", "live"),
          note:
            "keyless wallet history, straight off the chain. THE LAST SYNTHETIC CAPABILITY IN THE " +
            "APP: until now every wallet came from the demo universe with an invented name. Reads " +
            "getSignaturesForAddress plus getTransaction and recovers fills from pre/post token " +
            "balance deltas — real entries, real exits, real prices. HARD CEILING: publicnode " +
            "retains ~2 days of signatures (measured: a quiet years-old address stopped at 2.02 " +
            "days and paging further returned nothing), and it is the ONLY keyless endpoint that " +
            "answers the method at all — mainnet-beta, Ankr, drpc, solflare, onfinality and " +
            "BlockPI all refuse. So this is a WINDOW, never a lifetime, and every figure built on " +
            "it carries its coverage. Measured across five real wallets, 46% of token movements " +
            "had no quote leg belonging to the wallet at all and are recorded UNPRICED; the " +
            "unpriced set is larger than that, because a movement can have a quote leg and still " +
            "be unpriceable. Every movement states its own reason rather than being counted under " +
            "a summary that guesses",
        }
      : {
          ...demoHealth("solana-rpc-wallet"),
          mode: "disabled",
          status: "down",
          note: "disabled via ENABLE_WALLET_CHAIN — wallet activity falls back to the simulator",
        },
  );
  rows.push(
    FLAGS.walletHoldings()
      ? {
          ...healthOf("jupiter-holdings", "live"),
          note:
            "keyless wallet balances (lite-api.jup.ag/ultra), ~150ms, CORS reflects app://rom-nova. " +
            "The only source here that can read what a wallet HOLDS: getTokenAccountsByOwner is " +
            "403 on publicnode and on every other free RPC tried. Its real job is the " +
            "reconciliation — a position read whole, set against a position replayed from a " +
            "two-day window, is what proves whether a cost basis is knowable at all",
        }
      : {
          ...demoHealth("jupiter-holdings"),
          mode: "disabled",
          status: "down",
          note: "disabled via ENABLE_WALLET_HOLDINGS — positions can only be derived from the trade window",
        },
  );
  rows.push(
    FLAGS.cryptocom()
      ? {
          ...healthOf("cryptocom", "live"),
          note:
            "live SOL_USD ticker, Crypto.com Exchange public API — and now the HOURLY SOL/USD " +
            "series that prices SOL-denominated wallet fills at the hour they happened. SOL moved " +
            "$74 to $105 across the bars this reads, so valuing an old entry at today's price " +
            "would put the whole error into the PnL. Binance is the obvious alternative and is " +
            "geo-blocked with no CORS header at all; Coinbase is the fallback",
        }
      : { ...demoHealth("cryptocom"), mode: "disabled", status: "down", note: "disabled via ENABLE_CRYPTOCOM" },
  );
  rows.push(
    FLAGS.infstones()
      ? { ...healthOf("infstones", "live"), note: "third-opinion price cross-check" }
      : { ...demoHealth("infstones"), mode: "disabled", status: "down", note: "needs server mode + INFSTONES_API_KEY — optional third price opinion" },
  );
  // The simulator's heartbeat is a real timestamp — the moment the universe
  // was last advanced — so that one field is filled. Latency and error rate
  // stay absent: an in-process function has neither in any sense the other
  // rows mean.
  rows.push({
    ...demoHealth("demo-universe"),
    lastSuccessTs: store.simulatedUntil,
    lastDataTs: store.simulatedUntil,
    note: `seed ${store.universe.seed} · ${store.tokenList().length} tokens · ${store.walletList().length} wallets · genesis ${new Date(store.universe.genesis).toISOString()}`,
  });
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
