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
import { JupiterChartProvider, type ChartInterval } from "../providers/jupiter-chart";
import { noteOutcome } from "../providers/health-log";
import { ChainWalletProvider, isPlausibleAddress, WSOL } from "../providers/wallet-chain";
import { resolveRpcRoute, type RpcRuntime } from "../providers/rpc-endpoint";
import { identifyAccount, isOnCurve, KNOWN_ADDRESSES } from "../providers/account-kind";
import { getSolReference } from "../providers/reference";
import { assembleProfile } from "../engine/wallet-profile";
import type { WalletCoverage } from "../types";
import { liveSignal, type LiveFeatureResult } from "../engine/live-features";
import { observeLivePass } from "../live/signals";
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
  /**
   * When this payload was actually ASSEMBLED, as opposed to when it was handed
   * to the current caller.
   *
   * Set by the caching seams and preserved across cache hits, which is the
   * entire point: a wallet profile served from the 45-second cache is a
   * reading of the chain from up to 45 seconds ago, and a consumer that stamps
   * its own clock on it overstates the freshness of everything derived from
   * it. The alert monitor learned this the hard way — its wallet alerts
   * claimed "data as of" the moment the alert fired, for fills that had been
   * sitting in a cached profile since before the pass began.
   */
  builtAt?: number;
}

export const DEMO: Provenance = {
  source: "demo",
  real: false,
  note: "deterministic synthetic universe",
};

/** What the last candle fetch did, so the nav chip can stop guessing from the
 *  provider's name. Recorded in a leaf module the registry can also read. */
const noteCandleOutcome = (ok: boolean, note?: string) => noteOutcome("candles", ok, note);

/**
 * The second history source, tried only when the first gives nothing.
 *
 * Ordered rather than replacing: GeckoTerminal serves ~1,000 hourly bars and
 * works whenever it is not throttled, and swapping out a source that works is
 * not a fix for a source that is throttled.
 */
async function tryChartFallback(
  mint: string,
  from?: number,
  to?: number,
): Promise<Sourced<Candle[]> | null> {
  try {
    const alt = new JupiterChartProvider();
    const candles = await alt.getCandles(mint, from ?? 0, to ?? Date.now());
    if (candles.length === 0) return null;
    noteCandleOutcome(true);
    return {
      data: candles,
      provenance: {
        source: alt.name,
        real: true,
        note: "the primary history source returned nothing or was rate-limited; these bars are Jupiter's",
      },
    };
  } catch {
    // A failing fallback is not worth its own error surface — the caller
    // already has the primary's reason, which is the one a reader can act on.
    return null;
  }
}

/**
 * What granularity a set of bars actually is, measured from the bars.
 *
 * Declared nowhere, computed always: the request's interval is an ASK, and at
 * least one path serves something else — a 45-day window through the Jupiter
 * fallback comes back as 4-hour bars because hourly would blow the bar cap,
 * while the chart's caption said "hourly" the whole time. The median step
 * between consecutive bars is what the reader is looking at, so it is the only
 * thing the caption is allowed to claim.
 *
 * Median, not first-delta: a gap where nobody traded widens one step, not the
 * typical one. Null when there are too few bars to measure or the step matches
 * no bucket this app plots.
 */
export function measuredInterval(candles: Candle[]): ChartInterval | null {
  if (candles.length < 3) return null;
  const deltas = [];
  for (let i = 1; i < candles.length; i++) deltas.push(candles[i].t - candles[i - 1].t);
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const buckets: [ChartInterval, number][] = [
    ["1m", 60_000],
    ["5m", 300_000],
    ["15m", 900_000],
    ["1h", 3_600_000],
    ["4h", 14_400_000],
    ["1d", 86_400_000],
  ];
  for (const [name, ms] of buckets) if (median === ms) return name;
  return null;
}

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
 *
 * `interval` other than hourly routes to Jupiter's chart endpoint DIRECTLY:
 * it is the only keyless source that serves named minute buckets (probed, not
 * assumed — see jupiter-chart.ts), and GeckoTerminal's 2.1-second serialised
 * queue is exactly the wrong place to put a reader flipping between 1m and 5m.
 * When the finer ask comes back empty the request degrades to the hourly path
 * below and the provenance note says so; the caption reads the bars either
 * way, so it can never claim a granularity the reader is not looking at.
 */
export async function candlesFor(
  store: DemoStore,
  mint: string,
  from?: number,
  to?: number,
  interval: ChartInterval = "1h",
): Promise<Sourced<Candle[]>> {
  const market = getProviders().market;
  const fallback = (note?: string): Sourced<Candle[]> => ({
    data: store.candles(mint, from, to),
    provenance: note ? { ...DEMO, note } : DEMO,
  });

  if (interval !== "1h" && market.name !== "demo") {
    try {
      const jup = new JupiterChartProvider();
      const fine = await jup.getCandlesAt(mint, interval, from ?? 0, to ?? Date.now());
      if (fine.length > 0) {
        noteCandleOutcome(true);
        return { data: fine, provenance: { source: jup.name, real: true } };
      }
    } catch {
      // Degradation below carries the story; Jupiter's own error adds nothing
      // a reader can act on beyond "the finer bars were not there".
    }
    // Degrade to hourly rather than to a blank panel — an empty fine-grained
    // answer usually means the mint has no recent tape at that resolution —
    // and SAY so: the switcher snaps back to what is actually plotted, and
    // this note is the reason it did.
    const hourly = await candlesFor(store, mint, from, to, "1h");
    return {
      ...hourly,
      provenance: {
        ...hourly.provenance,
        note:
          `no ${interval} bars for this mint from jupiter-charts — ` +
          (hourly.provenance.note ?? "showing the hourly history instead"),
      },
    };
  }

  if (market.name === "demo") return fallback();

  try {
    // The provider contract takes a closed range; the store's is open-ended, so
    // an absent bound becomes the widest window the adapter will serve rather
    // than being passed through as undefined.
    const candles = await market.getCandles(mint, from ?? 0, to ?? Date.now());
    if (candles.length > 0) {
      noteCandleOutcome(true);
      return { data: candles, provenance: { source: market.name, real: true } };
    }
    // Empty is not necessarily "no such pool" — try the second source before
    // deciding, for the same reason the throw path does.
    const second = await tryChartFallback(mint, from, to);
    if (second) return second;
    noteCandleOutcome(false, `${market.name} returned no history`);
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
    // The SECOND source, before the simulator. This is the branch that matters:
    // a throttled GeckoTerminal answers 429 with no ACAO header, which a browser
    // reports as `TypeError: Failed to fetch` — indistinguishable from an
    // outage, and it took every chart in the app down with it.
    if (!missing) {
      const second = await tryChartFallback(mint, from, to);
      if (second) {
        return {
          ...second,
          provenance: {
            ...second.provenance,
            note: `${market.name} failed (${why}); these bars are Jupiter's`,
          },
        };
      }
    }
    noteCandleOutcome(!missing ? false : true, missing ? undefined : why);
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
  if (fresh) {
    const at = Date.now();
    // `builtAt` travels with the payload so a cache hit reports the scan's
    // real age. `handleTokens` used to stamp `asOf: Date.now()` on every
    // response, so a thirty-second-old scan — or an arbitrarily old one
    // served after a failed refresh — rendered "updated now", unconditionally.
    listCache = { at, value: { ...fresh, builtAt: at } };
    return listCache.value;
  }
  // A failed refresh serves the last good scan rather than dropping to the
  // simulator — stale real data beats fresh fake data, as long as the age is
  // reported. It is reported twice: `builtAt` dates it, and the provenance
  // note says the refresh that should have replaced it did not happen.
  if (listCache) {
    const age = Math.round((Date.now() - listCache.at) / 1000);
    return {
      ...listCache.value,
      provenance: {
        ...listCache.value.provenance,
        note: `refresh failed — showing the scan from ${age}s ago`,
      },
    };
  }
  return null;
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
  // ONE clock reading for the whole pass. Twelve rows read off one cached
  // list are one observation of the market; a per-row `Date.now()` inside
  // `liveSignal` scattered one pass across twelve `asOf`s, and the live
  // signal feed needs the rows to share a timestamp for the same reason the
  // track ledger does — a pass is the unit everything downstream reasons in.
  const passAt = Date.now();
  const rows = buildLiveTokenRows(entries, source, passAt);
  const providers = getProviders();

  const signals = await pooled(entries, LIVE_LIST_CONCURRENCY, async (e) => {
    try {
      return await liveSignal(
        e.mint,
        {
          token: { ...providers.token, getToken: async () => e },
          market: NO_CANDLES,
          security: providers.security,
          flow: providers.flow,
          // Summary only — `liveSignal`'s detailedRisk stays false here. The full
          // report is 80KB to 1.6MB per token, and twelve of those in one pass
          // would undo everything the single-call list just bought.
          risk: providers.risk,
        },
        "balanced",
        passAt,
      );
    } catch {
      return null;
    }
  });

  // The vectors become the live signal feed. Everything `/signals` serves on
  // the live path descends from this call; the rows below only ever carried
  // six fields of it. Ids come back so a row links to the signal the feed
  // will actually serve, not to a bucket-of-the-moment id that goes stale.
  const stableIds = observeLivePass({
    at: passAt,
    source,
    rows: signals.flatMap((s): LiveFeatureResult[] => (s ? [s.result] : [])),
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
    //
    // People only. The largest movers on any active mint routinely include the
    // pool's own authority — the pool side of every swap moves size by
    // definition — and the scanner's Buyers column was offering those as named
    // buyers whose links landed on the wallet page's refusal to profile them.
    // Off-curve is the PDA test and costs nothing; the netflow figure above is
    // untouched, this only decides who is worth naming as a person.
    const topWallets = (flow?.largest ?? [])
      .filter((m) => !KNOWN_ADDRESSES[m.owner] && isOnCurve(m.owner))
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
      whaleFlowUsd: s.result.features.whaleNetFlowUsd,
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
      signalId: stableIds.get(row.mint) ?? s.signal.id,
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
/**
 * How much of a wallet to read.
 *
 * Two stages rather than one, because they cost two orders of magnitude apart
 * and the cheap one is what a reader looks at first. Identity and balances are
 * three requests and a few hundred milliseconds; the fill history is up to four
 * hundred and measured at 28.7 seconds in its worst case. Blocking the first on
 * the second is what made the page feel broken.
 */
export type WalletStage =
  /** Identity, balances, prices. No signatures, no transactions. */
  | "balances"
  /** Everything, including the fills and every figure derived from them. */
  | "full";

export async function walletProfile(
  address: string,
  stage: WalletStage = "full",
): Promise<Sourced<WalletProfile> | null> {
  if (!isPlausibleAddress(address)) return null;
  // Gated on the FLAG, not on the `wallet` provider slot. The chain reader does
  // not implement `WalletDataProvider` — it cannot, because that interface has
  // no way to express "this movement had no price" — so it never occupies that
  // slot, and keying off it here silently disabled the entire feature.
  if (!FLAGS.walletChain()) return null;

  const key = `${stage}:${address}`;
  const hit = walletCache.get(key);
  if (hit && Date.now() - hit.at < WALLET_CACHE_MS) return hit.value;
  const flying = walletInFlight.get(key);
  if (flying) return flying;

  const job = buildWalletProfile(address, stage).finally(() => walletInFlight.delete(key));
  walletInFlight.set(key, job);
  const fresh = await job;
  // Stamped once, at assembly, and carried by the cached copy from then on —
  // so a consumer can always tell how old the READING is rather than how
  // recently it was handed the answer.
  if (fresh) {
    const at = Date.now();
    fresh.builtAt = at;
    walletCache.set(key, { at, value: fresh });
  }
  // A failed refresh serves the last good profile rather than dropping to the
  // simulator, on the same reasoning as the token list: stale real beats fresh
  // fake, and the coverage block already carries the timestamps.
  return fresh ?? hit?.value ?? null;
}

async function buildWalletProfile(
  address: string,
  stage: WalletStage,
): Promise<Sourced<WalletProfile> | null> {
  const providers = getProviders();
  const chain = new ChainWalletProvider();
  const route = await resolveRpcRoute();

  // What the address IS, before spending four hundred requests profiling a
  // token mint as a trader. One `getAccountInfo`, and it runs concurrently with
  // nothing else because everything else depends on the answer.
  const identity = await identifyAccount(address, route.transactions);
  if (!identity.profilable && identity.kind !== "unknown") {
    // Still returns a profile rather than an error: the page renders the
    // identity banner and a route to the right screen, which is more useful
    // than "not tracked" and is what Solscan and GMGN do.
    return {
      data: assembleProfile({
        address,
        fills: [],
        coverage: emptyCoverage(route.runtime, identity.detail),
        holdings: null,
        prices: new Map(),
        identity,
      }),
      provenance: { source: "solana-rpc", real: true, note: identity.detail },
    };
  }

  // Both reads at once. They are independent measurements of the same wallet
  // and neither blocks the other; sequencing them would double the wait for no
  // benefit, and the balance read is the slower of the two.
  const [activity, holdings] = await Promise.all([
    stage === "full"
      ? chain.getActivity(address, { route, identity }).catch(() => null)
      : Promise.resolve(null),
    providers.holdings?.getHoldings(address).catch(() => null) ?? Promise.resolve(null),
  ]);
  // What each read DID, for the "what is real" panel — which decided these
  // two capabilities from configuration while their /status rows said "not
  // asked yet". Recorded per capability, the way candles already are.
  if (stage === "full") noteOutcome("wallet activity", Boolean(activity), activity ? undefined : "the chain read returned nothing");
  if (providers.holdings) noteOutcome("wallet positions", Boolean(holdings), holdings ? undefined : "the balance read returned nothing");
  // The full stage needs the chain read; the balances stage never asked for one
  // and reports a coverage block that says exactly that, so nothing downstream
  // reads its empty fill list as "this wallet has never traded".
  if (stage === "full" && !activity) return null;

  // Price the traded mints first, then the rest of the bag. The price budget is
  // finite, and a reader asking about a wallet cares about what it just bought
  // before it cares about the dust it has been sitting on.
  const traded: string[] = [];
  const seen = new Set<string>();
  for (const f of activity?.fills ?? []) {
    if (seen.has(f.mint)) continue;
    seen.add(f.mint);
    traded.push(f.mint);
  }
  for (const t of holdings?.tokens ?? []) {
    if (seen.has(t.mint)) continue;
    seen.add(t.mint);
    traded.push(t.mint);
  }
  // The SOL price comes with them: native SOL is not a token account, so it was
  // missing from the portfolio total entirely — a 52% understatement on a
  // wallet holding 1.66M SOL.
  const [prices, solRef, symbols] = await Promise.all([
    providers.holdings
      ? providers.holdings.priceMints(traded).catch(() => new Map<string, number>())
      : Promise.resolve(new Map<string, number>()),
    getSolReference().catch(() => null),
    // Symbols are cosmetic and must never gate a figure, so one failed lookup
    // is an address on screen instead of a missing row. `traded` is already in
    // priority order — the mints the wallet actually traded before its dust —
    // so the one-request cap drops the right end.
    providers.holdings?.symbolsFor?.(traded).catch(() => new Map<string, string>()) ??
      Promise.resolve(new Map<string, string>()),
  ]);
  const profile = assembleProfile({
    address,
    fills: activity?.fills ?? [],
    coverage:
      activity?.coverage ??
      emptyCoverage(
        route.runtime,
        "balances only — the trade history has not been read yet, so no figure below is derived from fills",
      ),
    holdings: holdings ? { source: holdings.source, solBalance: holdings.solBalance, tokens: holdings.tokens } : null,
    prices,
    solPriceUsd: solRef?.priceUsd ?? prices.get(WSOL),
    identity: activity?.identity ?? identity,
    stage,
    symbols,
  });

  return {
    data: profile,
    provenance: {
      source: activity?.coverage.source ?? holdings?.source ?? "solana-rpc",
      real: true,
      note: profile.coverage.note,
    },
  };
}

/**
 * Coverage for an address that was never profiled.
 *
 * Zeros here are not measurements standing in for absences — they describe a
 * read that deliberately did not happen, and `note` says which address type
 * caused it. Every consumer keys off `identity.profilable` before touching them.
 */
function emptyCoverage(runtime: RpcRuntime, note: string): WalletCoverage {
  return {
    source: "solana-rpc",
    runtime,
    newestTs: 0,
    oldestTs: 0,
    windowHours: 0,
    signaturesListed: 0,
    transactionsRead: 0,
    transactionsFailed: 0,
    transactionsRefused: 0,
    transactionsUnavailable: 0,
    cappedByBudget: false,
    reachedEndpointLimit: false,
    lifetime: false,
    indexArchival: false,
    indexComplete: false,
    firstSeenTs: 0,
    historyDays: 0,
    note,
  };
}

/** Tests and probes reach for this; the app should not. */
export function __resetWalletCache(): void {
  walletCache.clear();
  walletInFlight.clear();
}
