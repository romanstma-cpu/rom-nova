// Where a payload actually came from.
//
// The provider layer has been finished and correct for a while: `types.ts`
// declares the contracts, `registry.ts` resolves each capability to the best
// configured adapter, and the demo adapters implement the same interfaces over
// the synthetic store. Its own header says the app depends on those interfaces
// only.
//
// That was aspirational. Every handler took a concrete `DemoStore`, so
// `getProviders()` resolved to keyless live adapters that nothing ever called,
// and `/status` had to describe them as "tested and NOT YET CONSUMED". This is
// the seam that lets a handler ask for data without knowing who answers.
//
// WHY PROVENANCE TRAVELS WITH THE DATA
//
// Nova is published with a global SIMULATED DATA chip in the nav and the top
// bar. That chip is honest today because everything except the SOL reference
// price is synthetic. The moment one panel is real it becomes the dangerous
// kind of wrong — a reader who has been told the whole screen is a simulation
// will discount a real number, and a reader who notices one real panel will
// trust a synthetic one beside it.
//
// So nothing here returns bare data. Every answer carries the adapter that
// produced it and whether it is real, and a fallback is required to SAY it fell
// back. Silent degradation to the simulator, wearing a live label, is the one
// outcome this file exists to make impossible.

import type { Candle, TokenInfo, TokenSnapshot, WalletProfile } from "../types";
import type { MarketDataProvider } from "../providers/types";
import type { DemoStore } from "../demo/store";
import { FLAGS, getProviders } from "../providers/registry";
import { DexScreenerTokenProvider } from "../providers/dexscreener";
import { JupiterTokenProvider } from "../providers/jupiter";
import { ChainWalletProvider, isPlausibleAddress } from "../providers/wallet-chain";
import { assembleProfile } from "../engine/wallet-profile";
import { liveSignal } from "../engine/live-features";
import { buildLiveTokenRows, riskLevelOf, type TokenRow } from "./rows";

export interface Provenance {
  /** The adapter that actually answered. "demo" is the simulator. */
  source: string;
  /** True only when real market data served this payload. */
  real: boolean;
  /** Present when the answer is not the one the configuration implies. */
  note?: string;
}

export interface Sourced<T> {
  data: T;
  provenance: Provenance;
}

export const DEMO: Provenance = {
  source: "demo",
  real: false,
  note: "deterministic synthetic universe",
};

/**
 * Candles for a mint, from the best configured source.
 *
 * GeckoTerminal is the only keyless adapter with history — roughly a thousand
 * hourly bars — which is why candles are the first capability through this
 * seam. DEX Screener has no OHLCV endpoint at all, so with only it configured
 * the market slot stays on the simulator and says so.
 *
 * A live source that answers with nothing is treated as a miss, not as an empty
 * truth. A brand-new mint with no pool history and a rate-limited request look
 * identical from here, and both should show the reader a simulator label rather
 * than an empty chart captioned "live".
 */
export async function candlesFor(
  store: DemoStore,
  mint: string,
  from?: number,
  to?: number,
): Promise<Sourced<Candle[]>> {
  const market = getProviders().market;
  const fallback = (note?: string): Sourced<Candle[]> => ({
    data: store.candles(mint, from, to),
    provenance: note ? { ...DEMO, note } : DEMO,
  });

  if (market.name === "demo") return fallback();

  try {
    // The provider contract takes a closed range; the store's is open-ended, so
    // an absent bound becomes the widest window the adapter will serve rather
    // than being passed through as undefined.
    const candles = await market.getCandles(mint, from ?? 0, to ?? Date.now());
    if (candles.length > 0) {
      return { data: candles, provenance: { source: market.name, real: true } };
    }
    return fallback(`${market.name} returned no history for this mint`);
  } catch (err) {
    // The reason is kept rather than swallowed. A provider failing silently
    // behind a demo label is indistinguishable from one that is working, which
    // is how a dead integration survives for weeks.
    //
    // But a 404 is not a failure and must not be reported as one. Every mint in
    // the synthetic universe 404s by construction — it does not exist on
    // Solana — so labelling that "coingecko unavailable" would tell a reader
    // the integration is broken on every demo token they open, which is both
    // false and the fastest way to teach them to ignore the chip.
    const why = err instanceof Error ? err.message : String(err);
    const missing = /\b404\b/.test(why);
    return fallback(
      missing
        ? `not listed on ${market.name} — no on-chain history for this mint`
        : `${market.name} unavailable — ${why}`,
    );
  }
}

/** Bounded fan-out. Unbounded would be a rate limit wearing a stack trace. */
async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * How many token detail calls one list is allowed to make.
 *
 * `getToken` measured ~320ms against GeckoTerminal, so a dozen at four-way
 * concurrency is a couple of seconds. Candles are the expensive call and this
 * path deliberately never makes one.
 */
export const LIVE_LIST_LIMIT = 12;
const LIVE_LIST_CONCURRENCY = 4;

/**
 * Real trending Solana tokens, or null when no live token provider is resolved.
 *
 * Two cheap calls per row rather than one expensive one: `getTrendingTokens`
 * gives the mints, then `getToken` fills in name, symbol and the market
 * snapshot. Neither touches OHLCV, which is what makes this affordable — and
 * also what makes the rows unscored, which `buildLiveTokenRows` states outright.
 */
/**
 * How long a scanned list stays fresh enough to reuse.
 *
 * The scanner polls every eight seconds, and one uncached list is now about
 * twenty-five network calls — a trending fetch, twelve token lookups and twelve
 * flow streams. Served straight through, a single open scanner tab would issue
 * around ten thousand requests an hour and rate-limit itself into the demo
 * fallback within minutes, which is the worst outcome: the page would look like
 * it was scanning while quietly showing a simulation.
 *
 * Thirty seconds decouples the poll rate from the fetch rate. The UI keeps its
 * responsiveness and the providers see one pass every half minute.
 */
export const LIST_CACHE_MS = 30_000;

let listCache: { at: number; value: Sourced<TokenRow[]> } | null = null;
/** In-flight de-duplication, so a burst of polls shares one fetch. */
let listInFlight: Promise<Sourced<TokenRow[]> | null> | null = null;

/** Age of the cached scan in ms, or null when nothing is cached. */
export function listCacheAge(): number | null {
  return listCache ? Date.now() - listCache.at : null;
}

export async function trendingRows(
  limit = LIVE_LIST_LIMIT,
): Promise<Sourced<TokenRow[]> | null> {
  if (listCache && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.value;
  // Two polls landing together must not both fetch. Without this the scanner's
  // own interval races itself the moment a pass takes longer than the gap.
  if (listInFlight) return listInFlight;
  listInFlight = fetchTrendingRows(limit).finally(() => {
    listInFlight = null;
  });
  const fresh = await listInFlight;
  if (fresh) listCache = { at: Date.now(), value: fresh };
  // A failed refresh serves the last good scan rather than dropping to the
  // simulator — stale real data beats fresh fake data, as long as the age is
  // reported, which `listCacheAge` exists for.
  return fresh ?? listCache?.value ?? null;
}

async function fetchTrendingRows(
  limit = LIVE_LIST_LIMIT,
): Promise<Sourced<TokenRow[]> | null> {
  // Jupiter for the LIST. This slot has now been held by three adapters and the
  // reason keeps being the same one: how many requests a list of twelve costs.
  //
  // GeckoTerminal lost it because twelve getToken calls took 27 seconds and
  // returned two usable rows. DEX Screener won it by batching internally, at
  // one trending call plus twelve lookups. Jupiter returns all twelve tokens
  // FULLY POPULATED in a single ~30KB response — and populated with the fields
  // the other two do not have at all: holder count, top-holder share, dev
  // balance, organic score, creator mint history, and per-interval price and
  // volume change.
  //
  // That last one is why the rows look different now. Momentum and volume
  // acceleration were derived only from candles, and candles are what a list
  // cannot afford, so those columns were dashed on every row this app ever
  // showed. Jupiter publishes them in the same payload as the price.
  const jup = FLAGS.jupiter() ? new JupiterTokenProvider() : null;
  const token = jup ?? (FLAGS.dexscreener() ? new DexScreenerTokenProvider() : getProviders().token);
  if (token.name === "demo") return null;

  try {
    const wanted = Math.min(limit, LIVE_LIST_LIMIT);
    let entries: (TokenInfo & { snapshot: TokenSnapshot })[];

    if (jup) {
      // One request, no fan-out.
      entries = await jup.getTrendingDetailed(wanted);
    } else {
      const trending = await token.getTrendingTokens(wanted);
      if (trending.length === 0) return null;
      const detailed = await pooled(trending, LIVE_LIST_CONCURRENCY, async (snap) => {
        try {
          return await token.getToken(snap.mint);
        } catch {
          // One unreachable token must not cost the other eleven.
          return null;
        }
      });
      entries = detailed.filter((d): d is NonNullable<typeof d> => d !== null);
    }
    if (entries.length === 0) return null;

    const scored = await scoreRows(entries, token.name);
    return {
      data: scored,
      provenance: { source: token.name, real: true },
    };
  } catch {
    // Caller falls back to the simulator and says so.
    return null;
  }
}

/**
 * A market provider that never fetches candles, for the list view.
 *
 * The candle call is the one this path cannot afford — 4.4 seconds each, and
 * zero of twelve arrive under any concurrency. Now that `liveFeatures` declares
 * momentum unmeasured instead of refusing, the honest move is to not ask at all
 * rather than to ask and be rate-limited into the same answer more slowly.
 *
 * Named so the provenance says why the bars are missing. Attributing it to
 * "coingecko" would read as an outage at a vendor that was never called.
 */
const NO_CANDLES: MarketDataProvider = {
  name: "none (list view — candles not fetched)",
  getCandles: async () => [],
  getPrice: async () => null,
};

/**
 * Scores live rows on everything except price history.
 *
 * A list row now carries a real signal built from liquidity, trade imbalance,
 * age, the chain-read authorities and — where a flow provider is configured —
 * actual whale movement. Momentum and volume acceleration step aside and the
 * confidence falls by their weight, which is the difference between a score
 * that is partial and one that is invented.
 */
async function scoreRows(
  entries: (TokenInfo & { snapshot: TokenSnapshot })[],
  source: string,
): Promise<TokenRow[]> {
  const rows = buildLiveTokenRows(entries, source);
  const providers = getProviders();

  const signals = await pooled(entries, LIVE_LIST_CONCURRENCY, async (e) => {
    try {
      return await liveSignal(e.mint, {
        token: { ...providers.token, getToken: async () => e },
        market: NO_CANDLES,
        security: providers.security,
        flow: providers.flow,
        // Summary only — `liveSignal`'s detailedRisk stays false here. The full
        // report is 80KB to 1.6MB per token, and twelve of those in one pass
        // would undo everything the single-call list just bought.
        risk: providers.risk,
      });
    } catch {
      return null;
    }
  });

  return rows.map((row, i) => {
    const s = signals[i];
    if (!s) return row;
    const missing = s.result.features.unmeasured ?? [];
    const flow = s.result.flow;
    const decimals = entries[i].decimals ?? 9;
    const price = entries[i].snapshot.priceUsd;
    // The addresses behind the netflow number, biggest absolute move first.
    // A reader can check any of these on a block explorer, which a summary
    // figure does not allow.
    const topWallets = (flow?.largest ?? [])
      .map((m) => ({ owner: m.owner, usd: (Number(m.deltaUnits) / 10 ** decimals) * price }))
      .filter((w) => Number.isFinite(w.usd) && Math.abs(w.usd) >= 1)
      .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))
      .slice(0, 6);
    const risk = s.result.risk;
    return {
      ...row,
      topWallets,
      // The measured flow, carried onto the row.
      //
      // Without these three lines the row kept `buildLiveTokenRows`'s
      // placeholder zeros while `topWallets` beside them listed real movers, so
      // the scanner rendered "whale 6h $0" on a token whose biggest wallet had
      // just moved a quarter of a million dollars. The vector had the number the
      // whole time; nothing copied it across. A zero presented as a measurement
      // is the failure this codebase is built to prevent, and it was sitting in
      // the most prominent flow column in the app.
      whaleFlow6hUsd: s.result.features.whaleNetFlowUsd,
      smFlow6hUsd: s.result.features.smartMoneyNetFlowUsd,
      smWallets: s.result.features.smartMoneyWallets,
      flowMinutes: flow ? Math.round(flow.blocksCovered / 150) : undefined,
      flowComplete: flow?.complete,
      // The vendor's grade travels beside the score, never inside it. A reader
      // must be able to tell "Nova rates this 62" from "RugCheck rates this 44
      // risk" — they are different claims by different parties.
      riskScore: risk?.score,
      lpLockedPct: risk?.lpLockedPct,
      riskFlags: risk?.risks.filter((r) => r.level === "danger").map((r) => r.name),
      riskSource: risk?.source,
      scored: true,
      signalScore: s.signal.score,
      signalLabel: s.signal.label,
      signalKind: s.signal.kind,
      signalId: s.signal.id,
      confidence: s.signal.confidence,
      riskLevel: riskLevelOf(s.signal),
      // Carried through so a reader can see WHICH factors stood down; a score
      // of 41 at 0.4 confidence and one at 0.9 are not the same claim.
      unmeasured: missing,
      unscoredReason: undefined,
    };
  });
}

/**
 * A short human label for a provenance, for the chip a panel renders.
 *
 * Deliberately names the vendor rather than saying "LIVE". "LIVE" is a claim
 * about freshness; "geckoterminal" is a claim about origin, and origin is what
 * a reader needs to judge the number.
 */
export function provenanceLabel(p: Provenance): string {
  return p.real ? p.source.toUpperCase() : "SIMULATED";
}

// -------------------------------------------------------------- real wallets

/**
 * How long a wallet profile stays fresh enough to reuse.
 *
 * One profile is a signature page plus up to six hundred `getTransaction`
 * calls plus a balance read plus four price batches. The wallet page polls, so
 * without this a single open tab would re-issue several hundred requests a
 * minute at one public endpoint and get itself throttled into the fallback —
 * which on this page means showing a simulated wallet under a real address.
 */
export const WALLET_CACHE_MS = 45_000;

const walletCache = new Map<string, { at: number; value: Sourced<WalletProfile> }>();
const walletInFlight = new Map<string, Promise<Sourced<WalletProfile> | null>>();

/**
 * The realest thing in this app: a Solana address the user typed, profiled.
 *
 * Returns null when there is no keyless wallet source configured, which the
 * caller answers by falling back to the simulator AND SAYING SO. It does not
 * return null for a wallet with no trades — an address that has done nothing in
 * the readable window is a real answer, and the coverage block says so more
 * usefully than a 404 would.
 */
export async function walletProfile(address: string): Promise<Sourced<WalletProfile> | null> {
  if (!isPlausibleAddress(address)) return null;
  const providers = getProviders();
  if (providers.wallet.name !== "solana-rpc") return null;

  const hit = walletCache.get(address);
  if (hit && Date.now() - hit.at < WALLET_CACHE_MS) return hit.value;
  const flying = walletInFlight.get(address);
  if (flying) return flying;

  const job = buildWalletProfile(address).finally(() => walletInFlight.delete(address));
  walletInFlight.set(address, job);
  const fresh = await job;
  if (fresh) walletCache.set(address, { at: Date.now(), value: fresh });
  // A failed refresh serves the last good profile rather than dropping to the
  // simulator, on the same reasoning as the token list: stale real beats fresh
  // fake, and the coverage block already carries the timestamps.
  return fresh ?? hit?.value ?? null;
}

async function buildWalletProfile(address: string): Promise<Sourced<WalletProfile> | null> {
  const providers = getProviders();
  const chain = new ChainWalletProvider();

  // Both reads at once. They are independent measurements of the same wallet
  // and neither blocks the other; sequencing them would double the wait for no
  // benefit, and the balance read is the slower of the two.
  const [activity, holdings] = await Promise.all([
    chain.getActivity(address).catch(() => null),
    providers.holdings?.getHoldings(address).catch(() => null) ?? Promise.resolve(null),
  ]);
  if (!activity) return null;

  // Price the traded mints first, then the rest of the bag. The price budget is
  // finite, and a reader asking about a wallet cares about what it just bought
  // before it cares about the dust it has been sitting on.
  const traded: string[] = [];
  const seen = new Set<string>();
  for (const f of activity.fills) {
    if (seen.has(f.mint)) continue;
    seen.add(f.mint);
    traded.push(f.mint);
  }
  for (const t of holdings?.tokens ?? []) {
    if (seen.has(t.mint)) continue;
    seen.add(t.mint);
    traded.push(t.mint);
  }
  const prices = providers.holdings
    ? await providers.holdings.priceMints(traded).catch(() => new Map<string, number>())
    : new Map<string, number>();

  // Symbols are cosmetic and must never gate a figure, so one failed lookup is
  // an address on screen instead of a missing row.
  const symbols = new Map<string, string>();
  const profile = assembleProfile({
    address,
    fills: activity.fills,
    coverage: activity.coverage,
    holdings: holdings ? { source: holdings.source, solBalance: holdings.solBalance, tokens: holdings.tokens } : null,
    prices,
    symbols,
  });

  return {
    data: profile,
    provenance: {
      source: activity.coverage.source,
      real: true,
      note: activity.coverage.note,
    },
  };
}

/** Tests and probes reach for this; the app should not. */
export function __resetWalletCache(): void {
  walletCache.clear();
  walletInFlight.clear();
}
