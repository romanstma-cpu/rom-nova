// Shared API handlers. The Next.js route files and the static-build client
// dispatcher (local.ts) both call these, so server mode and the exported
// browser-only build answer every query with the same code.

import type { DemoStore } from "../demo/store";
import { HOUR } from "../demo/universe";
import { computeSignal, evaluateOutcome, signalsAt, accuracyStats } from "../engine/signals";
import { riskRadar } from "../engine/risk";
import { findSimilar } from "../engine/similarity";
import { runBacktest, DEFAULT_BACKTEST } from "../engine/backtest";
import { placeOrder, portfolioView, type OrderRequest } from "../engine/paper";
import { answerQuestion } from "../engine/research";

/** Total network edges returned to the 3D view. */
const MAX_EDGES = 420;
/** Of that budget, how much is reserved for buy/sell flow rather than holdings.
 *  Reserved rather than shared: the arcs are the only thing that shows movement,
 *  and static positions must not be able to crowd them out. */
const MAX_TRADE_EDGES = 160;
import { buildFlowSeries, buildTokenRows, buildWalletRows } from "./rows";
import { DEMO, LIVE_LIST_LIMIT, candlesFor, measuredInterval, trendingRows, walletProfile } from "./source";
import type { ChartInterval } from "../providers/jupiter-chart";
import { liveTokenDetail } from "./detail";
import { lastLivePass, liveSignalsFor, liveTrackFor, resolveLiveMint } from "../live/signals";
import { noteOutcome } from "../providers/health-log";
import { isPlausibleAddress } from "../providers/wallet-chain";
import { resolveRpcRoute } from "../providers/rpc-endpoint";
import { identifyAccount, isOnCurve, KNOWN_ADDRESSES, type AccountIdentity } from "../providers/account-kind";
import { launchFeed, type LaunchFeed } from "./launches";
import { dataMode, providerHealth } from "../providers/registry";
import type { AlertCondition, BacktestConfig, StrategyProfileId } from "../types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- reads

export function handleMarket(store: DemoStore) {
  return { market: store.marketState(), demo: true };
}

export interface TokensQuery {
  profile?: StrategyProfileId;
  asOf?: number;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
}

/**
 * The token list, real where it can be.
 *
 * Serves live trending Solana tokens when a live token provider is resolved,
 * and the simulator otherwise. `asOf` forces the simulator regardless: it is a
 * request to replay a past moment, and no live source can answer that — silently
 * returning "now" for a scrub back in time would be worse than refusing.
 *
 * Live rows arrive unscored and say why. They are not sorted by score for the
 * obvious reason that they do not have one; newest-first is the honest default
 * for a trending list.
 */
export async function handleTokens(store: DemoStore, q: TokensQuery) {
  const { profile = "balanced", asOf, sort = "signalScore", dir = "desc", limit = 200 } = q;

  if (asOf === undefined) {
    const live = await trendingRows();
    if (live) {
      return {
        // Sorted, because the page says it is.
        //
        // This path returned here, ABOVE the sort block below, from the day the
        // live list was added. Live rows came out in the vendor's trending
        // order while the scanner's own caption read "Ranked by the signal
        // score" and the table carried a rank column, per-row rank-change
        // flashes and a "freeze ranking" button. Measured on production: scores
        // ran 75, 33, 86, 77, 82, 50, 64, 93, 60, 28, 45, 67 — a 93 in eighth
        // place under a heading promising the opposite.
        //
        // The demo path was sorted the whole time, which is why nothing looked
        // wrong in the simulator.
        rows: sortRows(live.data, sort, dir).slice(0, Math.min(limit, 500)),
        asOf: Date.now(),
        provenance: live.provenance,
        demo: false,
      };
    }
  }

  return {
    rows: sortRows(buildTokenRows(store, asOf, profile), sort, dir).slice(0, Math.min(limit, 500)),
    asOf: asOf ?? store.simulatedUntil,
    provenance: DEMO,
    demo: true,
  };
}

/**
 * Order rows by a numeric column, live and simulated alike.
 *
 * Shared so the two paths cannot drift again — one being sorted and the other
 * not is precisely the bug this replaced, and it survived because the two
 * orderings lived in different branches of one function.
 *
 * Unscored rows sink regardless of direction. Their `signalScore` is 0 because
 * the field is not optional, not because the token scored zero, so letting an
 * ascending sort float them to the top would rank "we could not measure this"
 * above every measured token.
 */
function sortRows<T extends { signalScore: number; scored: boolean }>(
  rows: T[],
  sort: string,
  dir: "asc" | "desc",
): T[] {
  const first = rows[0];
  if (!first) return rows;
  const key = sort as keyof T;
  if (!(key in first) || typeof first[key] !== "number") return rows;
  return [...rows].sort((a, b) => {
    if (a.scored !== b.scored) return a.scored ? -1 : 1;
    const av = a[key] as number;
    const bv = b[key] as number;
    return dir === "asc" ? av - bv : bv - av;
  });
}

/**
 * The launch feed. Real or nothing.
 *
 * Every other read in this file falls back to the simulator when no provider
 * answers, and that is right for them: a synthetic price chart is obviously a
 * demonstration and labelled as one. It is wrong here. This page's entire claim
 * is about TIME — a pool that came into existence eleven seconds ago — and the
 * demo universe mints tokens on a schedule that has nothing to do with Solana.
 * A simulated launch feed would be indistinguishable from a real one at a
 * glance while being fiction about the only thing it measures.
 *
 * So the empty state is empty, and it says why.
 */
export async function handleLaunches(): Promise<{ feed: LaunchFeed | null; demo: boolean }> {
  return { feed: await launchFeed(), demo: false };
}

/**
 * One token, in depth — real where it can be.
 *
 * Live first, because every link out of the live scanner points here with a
 * real Solana mint, and the simulator's store has never heard of one. Until
 * this branch existed, clicking any row in the scanner reached "Token not
 * found": the most-clicked path in the app was a dead end.
 *
 * `asOf` forces the simulator for the same reason `handleTokens` does — it is a
 * request to replay a past moment, and no live source can answer that.
 */
/**
 * Whether a string could be a Solana mint at all.
 *
 * Base58 excludes 0, O, I and l, and an address is 32-44 characters. The
 * simulator's own mints are generated from the same alphabet at 44 characters,
 * so this gates nothing legitimate.
 *
 * Checked before the mint reaches the provider stack, and before it can reach a
 * message the page prints verbatim: `/token?m=<script>alert(1)</script>` used
 * to render its own query string back at the reader through the 404 body. React
 * escapes it, so it was never XSS, but a page that will print whatever a link
 * puts in the URL is a phishing surface — and "that is not an address" is a
 * better answer than five network round-trips ending in "unknown mint".
 */
export const MINT_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function handleTokenDetail(
  store: DemoStore,
  mint: string,
  asOf?: number,
  profile: StrategyProfileId = "balanced",
) {
  if (!MINT_SHAPE.test(mint)) {
    throw new ApiError(
      400,
      "that is not a Solana mint address — an address is 32 to 44 base58 characters.",
    );
  }
  // A live FAILURE and an unlisted mint are different answers and used to
  // produce the same one. With the token provider rate-limited, every real mint
  // fell through to a simulator that has never heard of it and the page said
  // "unknown mint" — a permanent-sounding claim about the token standing in for
  // a temporary fact about us. The reason is carried and only surfaces if the
  // simulator misses too, so a demo mint still resolves normally.
  let liveError: string | null = null;
  if (asOf === undefined) {
    try {
      const live = await liveTokenDetail(mint, profile);
      if (live) return { ...live, demo: false };
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    return demoTokenDetail(store, mint, asOf, profile);
  } catch (err) {
    if (liveError && err instanceof ApiError && err.status === 404) {
      throw new ApiError(503, `live data unavailable — ${liveError}. This is a source problem, not a verdict on the token.`);
    }
    // Before giving up: ASK THE CHAIN WHAT THIS ADDRESS IS.
    //
    // "unknown mint" is a definite claim about a token, and the commonest way
    // to reach it is pasting a WALLET into the token page. `/whale` already
    // handles the mirror case — give it a mint and it says "this is a TOKEN
    // MINT, not a wallet" and offers the right page — and this side answered
    // with two words that explain nothing.
    //
    // One RPC call, on a path that is already an error, so it costs nothing in
    // the normal case.
    if (err instanceof ApiError && err.status === 404) {
      const redirect = await whatIsThisAddress(mint);
      if (redirect) throw new ApiError(404, redirect);
    }
    throw err;
  }
}

/**
 * A better sentence than "unknown mint", when the chain can supply one.
 *
 * Returns null when nothing useful can be said — a failed RPC call must not
 * turn into a confident claim about the address, so the caller keeps its
 * original error.
 */
async function whatIsThisAddress(address: string): Promise<string | null> {
  try {
    const route = await resolveRpcRoute();
    if (!route?.transactions) return null;
    // The same endpoint `walletProfile` identifies against, so the two pages
    // cannot disagree about what an address is.
    return addressAnswer(await identifyAccount(address, route.transactions), address);
  } catch {
    return null;
  }
}

/**
 * One identified address to one sentence, or null when nothing can be said.
 *
 * Split from the fetch so the suite can prove every branch — and because a
 * branch went MISSING from this list unnoticed: `program-owned` fell through
 * to null, so an address the chain had reached AND identified surfaced as
 * "token detail unreachable — unknown mint". A transport failure claimed for a
 * lookup that succeeded, and a retry suggested for an answer that can never
 * change.
 */
export function addressAnswer(id: AccountIdentity, address: string): string | null {
  if (id.kind === "wallet") {
    return `that is a WALLET, not a token mint — open it on the wallet page instead: /whale?a=${address}`;
  }
  if (id.kind === "token-account") {
    return `${id.detail}. A token account is not a mint and not a wallet; the owner named above is the address to look up.`;
  }
  if (id.kind === "program" || id.kind === "empty" || id.kind === "invalid") return id.detail;
  if (id.kind === "program-owned") {
    return `${id.detail}. It is not a token mint, so no token page exists for it and none ever will.`;
  }
  // A real mint that nothing lists is the honest original answer, said better.
  if (id.kind === "mint") {
    return "this IS a token mint, but no source in this stack lists it — no pool, no price, no history. That is an absence of coverage, not a verdict on the token.";
  }
  // `unknown` only: the lookup itself failed, and a failed lookup is not
  // evidence about the address.
  return null;
}

function demoTokenDetail(store: DemoStore, mint: string, asOf?: number, profile: StrategyProfileId = "balanced") {
  const tok = store.token(mint);
  const snap = store.snapshot(mint, asOf);
  if (!tok || !snap) throw new ApiError(404, "unknown mint");

  const now = asOf ?? store.simulatedUntil;
  const signal = computeSignal(store, mint, now, profile);
  const risk = riskRadar(store, mint, now);
  const similar = findSimilar(store, mint, now);
  const series = store.holdersSeries(mint).filter((p) => p.ts <= now);
  const trades = store.mintTrades(mint, now - 72 * HOUR, now).slice(-120).reverse();

  const byWallet = new Map<string, { buys: number; sells: number; netUsd: number }>();
  for (const t of store.mintTrades(mint, 0, now)) {
    const e = byWallet.get(t.wallet) ?? { buys: 0, sells: 0, netUsd: 0 };
    if (t.side === "buy") {
      e.buys++;
      e.netUsd -= t.amountUsd;
    } else {
      e.sells++;
      e.netUsd += t.amountUsd;
    }
    byWallet.set(t.wallet, e);
  }
  const topTraders = [...byWallet.entries()]
    .map(([address, e]) => {
      const w = store.wallet(address);
      const pos = store.ledgers.get(address)?.positions.find((p) => p.mint === mint);
      const unrealized = pos ? pos.tokens * (store.lastPrice(mint, asOf) ?? 0) - pos.costBasisUsd : 0;
      return {
        address,
        entity: w?.knownEntity,
        labels: w?.labels ?? [],
        smartMoneyScore: w?.smartMoney.total ?? 0,
        buys: e.buys,
        sells: e.sells,
        netUsd: e.netUsd,
        unrealizedUsd: unrealized,
        holding: Boolean(pos && pos.tokens > 0),
      };
    })
    .sort((a, b) => Math.abs(b.netUsd) + b.unrealizedUsd - (Math.abs(a.netUsd) + a.unrealizedUsd))
    .slice(0, 12);

  return {
    mode: "demo" as const,
    info: tok.info,
    archetype: tok.archetype,
    supply: tok.supply,
    snapshot: snap,
    signal,
    risk,
    similar,
    flow: buildFlowSeries(store, mint, 72, asOf),
    holdersSeries: series.filter((_, i) => i % 2 === 0),
    trades,
    topTraders,
    asOf: now,
    demo: true,
  };
}

/**
 * Candles, from whichever source is configured.
 *
 * The first handler to go through the provider seam rather than reaching into
 * the store. Async because a real adapter is a network call; `demo` is now
 * derived from what actually answered instead of being hardcoded true, and
 * `provenance` travels with the payload so the panel can label itself.
 *
 * `live` is unrelated and keeps its meaning — the simulator's own price tick.
 */
export async function handleCandles(
  store: DemoStore,
  mint: string,
  from?: number,
  to?: number,
  interval: ChartInterval = "1h",
) {
  const { data: candles, provenance } = await candlesFor(store, mint, from, to, interval);
  // The REASON, not a generic 404. "unknown mint or empty range" told a reader
  // nothing about a real Solana token that simply has no OHLCV — measured on
  // SKHY, where GeckoTerminal lists no pool at all — and the panel showing it
  // sat on "LOADING CHART…" forever because it had nothing to print.
  if (!candles.length) {
    throw new ApiError(404, provenance.note ?? `no price history for this mint from ${provenance.source}`);
  }
  return {
    candles,
    live: store.livePrice.get(mint) ?? null,
    provenance,
    demo: !provenance.real,
    // What the bars ARE, measured from their spacing — not what was asked for.
    // At least one path serves coarser than the ask (see measuredInterval),
    // and the chart caption is only allowed to print this field.
    interval: measuredInterval(candles),
  };
}

export function handleWallets(store: DemoStore) {
  return { rows: buildWalletRows(store), demo: true };
}

/**
 * Real wallets, ranked by money they actually moved in the last few minutes.
 *
 * The `/whales` roster is the simulator and its caption claimed the scores were
 * "measured from each wallet's trade history" — true of the generator, false in
 * context, and the blind review called it out. Ranked discovery from real data
 * is the feature traders open GMGN for, so this is the honest version of it.
 *
 * A ranked leaderboard by PnL is NOT feasible keylessly and this does not
 * pretend to be one: profiling a wallet costs ~400 requests against a
 * 2,400/minute budget, so four to six wallets a minute, and ranking any
 * meaningful universe by realized PnL would take days.
 *
 * Ranking by MEASURED FLOW costs nothing extra. The scanner already streams
 * per-token wallet deltas from SQD and caches them for thirty seconds; this
 * aggregates the movers across the trending list. It answers "who is trading
 * real size right now", which is a different question from "who is good" — and
 * the one this stack can actually answer.
 */
export async function handleLiveMovers(limit = 25) {
  const rows = await trendingRows();
  if (!rows) return { movers: [], real: false, note: "no live token source configured", demo: true };

  const byOwner = new Map<string, { owner: string; netUsd: number; grossUsd: number; tokens: Set<string> }>();
  for (const row of rows.data) {
    for (const w of row.topWallets ?? []) {
      // Only addresses a PERSON can hold the key for. This column is headed
      // "Wallet" and its rows link to trader profiles, and it was ranking two
      // AMM pools and the burn address as movers — the pool side of a swap
      // moves size by definition, and the incinerator "receiving $10.4K" is a
      // token being destroyed, not somebody buying. Off-curve is the PDA test
      // and costs no network call; the constants cover the on-curve addresses
      // whose meaning is a chain-wide convention.
      if (KNOWN_ADDRESSES[w.owner] || !isOnCurve(w.owner)) continue;
      let e = byOwner.get(w.owner);
      if (!e) byOwner.set(w.owner, (e = { owner: w.owner, netUsd: 0, grossUsd: 0, tokens: new Set() }));
      e.netUsd += w.usd;
      e.grossUsd += Math.abs(w.usd);
      e.tokens.add(row.symbol || row.mint);
    }
  }

  const movers = [...byOwner.values()]
    .sort((a, b) => b.grossUsd - a.grossUsd)
    .slice(0, limit)
    .map((m) => ({
      owner: m.owner,
      netUsd: m.netUsd,
      grossUsd: m.grossUsd,
      tokens: [...m.tokens],
    }));

  return {
    movers,
    real: true,
    source: rows.provenance.source,
    // The window belongs to the number. These are minutes of flow, not a record.
    note:
      "ranked by USD moved in the last few minutes of SQD flow across the trending list — " +
      "this is size traded right now, NOT a measure of skill, and no PnL is implied. " +
      "Pool authorities, vaults and the burn address are excluded: the pool side of a swap " +
      "moves size by definition, and none of them is a trader",
    demo: false,
  };
}

/**
 * A real Solana address, profiled from the chain.
 *
 * Kept apart from `handleWalletDetail` rather than folded into it, because the
 * two return genuinely different objects and merging them would mean inventing
 * the simulator's fields — smart-money score, behavioural profile, known
 * entity, cluster membership — for a wallet that has none of them. The page
 * renders whichever it gets and says which.
 *
 * A 404 here means "no keyless wallet source is configured", not "no such
 * wallet": an address with nothing in the readable window still returns a
 * profile, with a coverage block that explains the emptiness.
 */
export async function handleWalletProfile(address: string, stage: "balances" | "full" = "full") {
  // Two failures wearing one message, which the blind review flagged as both
  // developer-facing and wrong: it told a trader to "set ENABLE_WALLET_CHAIN"
  // when the source was working perfectly and they had simply mistyped an
  // address. Separated, and phrased for the person reading it.
  if (!isPlausibleAddress(address)) {
    throw new ApiError(
      400,
      "That is not a Solana address. They are 32-44 characters of base58 — no 0, O, I or l.",
    );
  }
  const sourced = await walletProfile(address, stage);
  if (!sourced) {
    throw new ApiError(
      503,
      "Solana could not be reached to read this wallet. The public RPC may be rate-limiting; try again shortly.",
    );
  }
  // `builtAt` travels so a consumer can date the READING rather than the
  // response: this path is cached for 45 seconds, and anything that stamps its
  // own clock on a cached profile overstates how fresh the chain read was.
  return { profile: sourced.data, provenance: sourced.provenance, builtAt: sourced.builtAt, demo: false };
}

export function handleWalletDetail(store: DemoStore, address: string) {
  const info = store.wallet(address);
  const perf = store.perfs.get(address);
  const ledger = store.ledgers.get(address);
  if (!info || !perf || !ledger) throw new ApiError(404, "unknown wallet");

  const trades = store.walletTrades(address).slice(-200).reverse();
  const positions = ledger.positions.map((p) => {
    const px = store.lastPrice(p.mint) ?? 0;
    const tok = store.token(p.mint);
    return {
      ...p,
      symbol: tok?.info.symbol ?? "?",
      priceUsd: px,
      valueUsd: p.tokens * px,
      pnlUsd: p.tokens * px - p.costBasisUsd,
      pnlPct: p.costBasisUsd > 0 ? ((p.tokens * px - p.costBasisUsd) / p.costBasisUsd) * 100 : 0,
    };
  });
  const roundTrips = ledger.roundTrips
    .map((r) => ({ ...r, symbol: store.token(r.mint)?.info.symbol ?? "?" }))
    .sort((a, b) => b.exitTs - a.exitTs);
  const cluster = store.universe.clusters.find((c) => c.members.includes(address));

  return {
    info,
    perf,
    positions,
    roundTrips,
    trades: trades.map((t) => ({ ...t, symbol: store.token(t.mint)?.info.symbol ?? "?" })),
    cluster: cluster ?? null,
    demo: true,
  };
}

/**
 * The signal feed, real where it can be.
 *
 * Live when the token list resolves: the signals are the ones `scoreRows`
 * built for the trending rows, materialised by the live registry with stable
 * ids and a lifecycle across passes. Until this branch existed the terminal
 * served thirty synthetic position-sizing cards under no marker while the
 * scanner beside them scored real tokens — the whole-build review's H5 and
 * H7 in one handler.
 *
 * `asOf` forces the simulator for the same reason it does on `handleTokens`:
 * a replay of a past moment is not something a live source can answer, and
 * the payload says so rather than quietly serving "now".
 *
 * `asOf` in the reply is the PASS time, not the reply time. The list is
 * cached for thirty seconds and served stale after a failed refresh, so the
 * moment the answer was assembled is the only honest date on it.
 */
export async function handleSignals(store: DemoStore, profile: StrategyProfileId = "balanced", asOf?: number) {
  if (asOf === undefined) {
    const live = await trendingRows();
    const feed = live ? liveSignalsFor(profile) : null;
    if (live && feed) {
      return {
        signals: feed.signals,
        asOf: feed.pass.at,
        profile,
        demo: false,
        provenance: live.provenance,
        live: {
          pass: feed.pass,
          stats: feed.stats,
          cadence: feed.cadence,
          corpus: LIVE_LIST_LIMIT,
          // The corpus is twelve trending tokens, and the page must say so:
          // "signals" over a dozen rows is a different claim from signals over
          // the chain, and the review found two pages that never said which.
          note:
            `signals over the ${feed.pass.mints} tokens on ${live.provenance.source}'s trending list ` +
            `(capped at ${LIVE_LIST_LIMIT}) — not the whole chain. A token not on that list has no signal here, ` +
            `which is an absence of coverage, not a verdict`,
        },
      };
    }
    noteOutcome("signals", false, live ? "the list answered but no scored pass was recorded" : "no live token source answered");
  }
  const at = asOf ?? store.simulatedUntil;
  const signals = signalsAt(store, at, profile).map((s) => ({
    ...s,
    symbol: store.token(s.mint)?.info.symbol ?? "?",
    name: store.token(s.mint)?.info.name ?? "?",
    hue: store.token(s.mint)?.info.hue ?? 0,
  }));
  return {
    signals,
    asOf: at,
    profile,
    demo: true,
    provenance: {
      ...DEMO,
      note:
        asOf !== undefined
          ? "a replay of a past moment — no live source can answer that, so this is the simulator, labelled"
          : "live signals unavailable — no live token source answered, so this is the simulator, labelled",
    },
  };
}

/**
 * One signal by id, real where it can be.
 *
 * A live id resolves through the 8-character mint prefix the registry has
 * seen this session, then recomputes the signal on the detail path — the
 * full risk report, the audit, the provenance — because the list pass only
 * ever paid for the summary. The lifecycle comes from the registry, so a
 * link to a signal that has since expired shows the expiry and points at the
 * current one rather than pretending the old label still holds.
 *
 * A live failure and an unknown id are different answers: the first is a
 * 503 carrying the reason, the second falls to the simulator's own lookup.
 */
export async function handleSignalById(store: DemoStore, id: string) {
  const m = id.match(/^sig-([A-Za-z0-9]{8})-(\d+)-([a-z_]+)$/);
  if (!m) throw new ApiError(400, "malformed signal id");
  const [, mint8, bucketStr, profileRaw] = m;
  const profile = profileRaw as StrategyProfileId;

  let mint = resolveLiveMint(mint8);
  if (!mint) {
    // A cold tab with a bookmarked id: one list pass may put the mint back
    // in reach. Null from here means the simulator gets its turn.
    await trendingRows();
    mint = resolveLiveMint(mint8);
  }
  if (mint) {
    let liveError: string | null = null;
    try {
      const detail = await liveTokenDetail(mint, profile);
      if (detail) {
        const active = liveTrackFor(mint, profile);
        const named = liveTrackFor(mint, profile, id) ?? active;
        return {
          signal: {
            ...detail.signal,
            id,
            createdAt: named?.createdAt ?? detail.asOf,
            updatedAt: detail.asOf,
            lifecycle: named?.lifecycle ?? [
              {
                state: "created" as const,
                ts: detail.asOf,
                note:
                  "scored on demand — this session has not carried this mint on the live list under this " +
                  "profile, so there is no earlier history to show",
              },
            ],
          },
          symbol: detail.info.symbol,
          name: detail.info.name,
          hue: detail.info.hue,
          demo: false,
          provenance: detail.provenance,
          source: detail.source,
          audit: detail.audit,
          live: {
            asOf: detail.asOf,
            passes: named?.passes ?? 0,
            expiredAt: named?.expiredAt,
            /** The signal that replaced this one, when the requested id has ended. */
            currentId: active && active.id !== id ? active.id : undefined,
            authorityChecked: detail.authorityChecked,
            authoritySource: detail.authoritySource,
            // No outcome is graded here. The simulator can read its own
            // future candles; the live path cannot, and the page that can —
            // against real later prices, by whole passes — is Track Record.
            measuredOn: "/track",
          },
        };
      }
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
    throw new ApiError(
      503,
      `live data unavailable — ${liveError ?? "the token provider no longer lists this mint"}. ` +
        "This is a source problem, not a verdict on the signal.",
    );
  }

  const tok = store.tokenList().find((t) => t.info.mint.startsWith(mint8));
  if (!tok) throw new ApiError(404, "unknown signal token");
  const asOf = Number(bucketStr) * 2 * HOUR + 1;
  let sig = computeSignal(store, tok.info.mint, Math.min(asOf, store.simulatedUntil), profile);
  if (!sig) throw new ApiError(404, "signal not computable");
  sig = evaluateOutcome(store, sig);
  return { signal: sig, symbol: tok.info.symbol, name: tok.info.name, demo: true, provenance: DEMO };
}

/**
 * Accuracy, without fabrication.
 *
 * The simulator grades itself against its own future candles, and that is a
 * fine demonstration of the METHOD. It is not a measurement of the live
 * signals, and once a live pass has landed this handler refuses to hand back
 * synthetic statistics under a live page. The live accuracy is measured on
 * the Track Record page — every live score this browser recorded, against
 * the real price 1h, 6h and 24h later, resampled by whole scan passes, and
 * allowed to answer "no edge" — so this points there instead.
 *
 * `scope: "simulated"` lets a page that is itself showing the simulator ask
 * for the simulator's numbers explicitly, labelled. It cannot ask for live
 * numbers here; there are none to give.
 */
export function handleAccuracy(
  store: DemoStore,
  profile: StrategyProfileId = "balanced",
  scope: "auto" | "simulated" = "auto",
) {
  const pass = lastLivePass();
  if (scope === "auto" && pass) {
    return {
      stats: null,
      demo: false,
      measuredOn: {
        href: "/track",
        label: "Track Record",
        note:
          "Live signal accuracy is not computed here, and never from the simulator. The Track Record page " +
          "grades every live score this browser has recorded against the real price 1h, 6h and 24h later, " +
          "resampled by whole scan passes, and is allowed to say there is no edge.",
      },
      pass: { at: pass.at, source: pass.source },
    };
  }
  return {
    stats: accuracyStats(store, profile),
    demo: true,
    note: "measured on synthetic data — the simulator grading itself; the method is the product, not the numbers",
  };
}

export function handleNetwork(store: DemoStore, asOf?: number) {
  const at = asOf ?? store.simulatedUntil;
  const isHistorical = asOf !== undefined;

  const signals = signalsAt(store, at, "balanced");
  const scoreOf = new Map(signals.map((s) => [s.mint, s]));

  const tokens = store
    .tokenList()
    .map((t) => ({ t, snap: store.snapshot(t.info.mint, asOf) }))
    .filter((x) => x.snap)
    .sort((a, b) => b.snap!.volume24hUsd - a.snap!.volume24hUsd)
    .slice(0, 64)
    .map(({ t, snap }) => {
      const sig = scoreOf.get(t.info.mint);
      return {
        id: t.info.mint,
        kind: "token" as const,
        symbol: t.info.symbol,
        narrative: t.info.narrative,
        hue: t.info.hue,
        marketCapUsd: snap!.marketCapUsd,
        liquidityUsd: snap!.liquidityUsd,
        volume24hUsd: snap!.volume24hUsd,
        momentum24h: sig?.features.momentum24h ?? 0,
        signalScore: sig?.score ?? 50,
        riskHigh: (sig?.risks.filter((r) => r.severity === "high").length ?? 0) >= 2,
      };
    });
  const tokenSet = new Set(tokens.map((t) => t.id));

  const wallets = store.walletList().map((w) => ({
    id: w.address,
    kind: "wallet" as const,
    entity: w.knownEntity,
    labels: w.labels,
    smartMoneyScore: w.smartMoney.total,
    solBalance: w.solBalance,
    cluster: store.universe.clusters.find((c) => c.members.includes(w.address))?.id ?? null,
  }));

  type Edge = { from: string; to: string; kind: "position" | "buy" | "sell"; usd: number; ts: number };

  const positionEdges: Edge[] = [];
  for (const [addr, ledger] of store.ledgers) {
    for (const p of ledger.positions) {
      if (!tokenSet.has(p.mint)) continue;
      const px = store.lastPrice(p.mint, asOf) ?? 0;
      positionEdges.push({ from: addr, to: p.mint, kind: "position", usd: p.tokens * px, ts: p.openedAt });
    }
  }

  const from = at - 24 * HOUR;
  const windowTrades = [...store.universe.trades, ...(isHistorical ? [] : store.liveTrades)].filter(
    (t) => t.ts >= from && t.ts <= at && tokenSet.has(t.mint),
  );
  const tradeEdges: Edge[] = windowTrades
    .slice(-MAX_TRADE_EDGES)
    .map((t) => ({ from: t.wallet, to: t.mint, kind: t.side, usd: t.amountUsd, ts: t.ts }));

  return {
    asOf: at,
    historical: isHistorical,
    tokens,
    wallets,
    // Budgeted separately rather than concatenated and truncated. Trades used
    // to be appended after positions and the lot sliced to a flat 420, so a
    // universe with enough open positions would silently eat the whole budget
    // and every buy/sell edge would fall off the end — taking the whale arcs in
    // the 3D view with them. Today it is 175 positions to 160 trades, which is
    // under the cap by luck rather than design.
    edges: [...positionEdges.slice(0, MAX_EDGES - MAX_TRADE_EDGES), ...tradeEdges],
    clusters: store.universe.clusters,
    demo: true,
  };
}

export function handleEvents(store: DemoStore, limit = 60) {
  return {
    events: store.recentEvents(Math.min(200, limit)).map((e) => ({
      ...e,
      symbol: e.mint ? store.token(e.mint)?.info.symbol : undefined,
    })),
    demo: true,
  };
}

export function handleStatus(store: DemoStore) {
  const mode = dataMode();
  return {
    providers: providerHealth(),
    // What is actually real, per capability, so the chrome can stop making a
    // blanket claim in either direction.
    dataMode: mode,
    engine: {
      version: "1.0.0",
      tokens: store.tokenList().length,
      wallets: store.walletList().length,
      historicalTrades: store.universe.trades.length,
      liveTrades: store.liveTrades.length,
      eventsBuffered: store.events.length,
      simulatedUntil: store.simulatedUntil,
      genesis: store.universe.genesis,
      seed: store.universe.seed,
    },
    // Computed, not asserted. This endpoint describing itself as fully demo
    // while its own provider rows say otherwise is the contradiction the
    // dataMode summary exists to remove.
    demo: mode.overall === "demo",
  };
}

export function handleFlow(store: DemoStore, mint: string | null, hours = 72) {
  if (mint && !store.token(mint)) throw new ApiError(404, "unknown mint");
  return { flow: buildFlowSeries(store, mint, Math.min(24 * 14, hours)), demo: true };
}

export function handleClusters(store: DemoStore) {
  const clusters = store.universe.clusters.map((c) => ({
    ...c,
    memberDetails: c.members.map((m) => {
      const w = store.wallet(m);
      return { address: m, entity: w?.knownEntity, smartMoneyScore: w?.smartMoney.total ?? 0, labels: w?.labels ?? [] };
    }),
    sharedTokenDetails: c.sharedTokens.map((mint) => ({ mint, symbol: store.token(mint)?.info.symbol ?? "?" })),
  }));
  return { clusters, demo: true };
}

export function handleSearch(store: DemoStore, qRaw: string) {
  const q = qRaw.trim().toLowerCase();
  if (!q) return { tokens: [], wallets: [] };
  const tokens = store
    .tokenList()
    .filter(
      (t) =>
        t.info.mint.toLowerCase().startsWith(q) ||
        t.info.symbol.toLowerCase().includes(q) ||
        t.info.name.toLowerCase().includes(q),
    )
    .slice(0, 8)
    .map((t) => ({
      mint: t.info.mint,
      symbol: t.info.symbol,
      name: t.info.name,
      hue: t.info.hue,
      priceUsd: store.lastPrice(t.info.mint) ?? 0,
    }));
  const wallets = store
    .walletList()
    .filter(
      (w) =>
        w.address.toLowerCase().startsWith(q) ||
        (w.knownEntity ?? "").toLowerCase().includes(q) ||
        w.labels.some((l) => l.includes(q)),
    )
    .slice(0, 8)
    .map((w) => ({ address: w.address, entity: w.knownEntity, labels: w.labels, smartMoneyScore: w.smartMoney.total }));
  return { tokens, wallets };
}

export function handleWatchlists(store: DemoStore) {
  const watchlists = store.watchlists.map((wl) => ({
    ...wl,
    items: wl.items.map((it) => {
      if (it.kind === "token") {
        const tok = store.token(it.ref);
        const snap = store.snapshot(it.ref);
        return { ...it, symbol: tok?.info.symbol, priceUsd: snap?.priceUsd, marketCapUsd: snap?.marketCapUsd };
      }
      const w = store.wallet(it.ref);
      const perf = store.perfs.get(it.ref);
      return { ...it, entity: w?.knownEntity, smartMoneyScore: w?.smartMoney.total, realizedPnlUsd: perf?.realizedPnlUsd };
    }),
  }));
  return { watchlists, demo: true };
}

export function handleAlertsGet(store: DemoStore) {
  return { rules: store.alertRules, events: store.alertEvents.slice(0, 100), demo: true };
}

export function handlePaperGet(store: DemoStore) {
  return { portfolios: store.portfolios.map((p) => portfolioView(store, p)), demo: true };
}

export function handleResearchGet(store: DemoStore) {
  return {
    notes: store.research.map((n) => ({
      ...n,
      symbol: store.token(n.mint)?.info.symbol ?? "?",
      priceNowUsd: store.lastPrice(n.mint) ?? 0,
      outcomePct:
        n.snapshot.priceUsd > 0
          ? (((store.lastPrice(n.mint) ?? n.snapshot.priceUsd) - n.snapshot.priceUsd) / n.snapshot.priceUsd) * 100
          : 0,
    })),
    demo: true,
  };
}

// ---------------------------------------------------------------- writes

export function handleBacktest(store: DemoStore, cfg: Partial<BacktestConfig>) {
  const result = runBacktest(store, { ...DEFAULT_BACKTEST, ...cfg });
  return { result: { ...result, trades: result.trades.slice(-100) }, demo: true };
}

export type WatchlistOp =
  | { op: "create"; name: string }
  | { op: "add"; id: string; kind: "token" | "wallet"; ref: string }
  | { op: "remove"; id: string; ref: string }
  | { op: "delete"; id: string };

export function handleWatchlistOp(store: DemoStore, body: WatchlistOp) {
  if (body.op === "create") {
    const wl = { id: store.nextId("wl"), name: body.name, items: [], createdAt: Date.now() };
    store.watchlists.push(wl);
    store.persistUserState();
    return { watchlist: wl };
  }
  const wl = store.watchlists.find((w) => w.id === body.id);
  if (!wl) throw new ApiError(404, "watchlist not found");
  if (body.op === "add") {
    const valid = body.kind === "token" ? Boolean(store.token(body.ref)) : Boolean(store.wallet(body.ref));
    if (!valid) throw new ApiError(404, `unknown ${body.kind}`);
    if (!wl.items.some((i) => i.ref === body.ref)) wl.items.push({ kind: body.kind, ref: body.ref, addedAt: Date.now() });
  } else if (body.op === "remove") {
    wl.items = wl.items.filter((i) => i.ref !== body.ref);
  } else if (body.op === "delete") {
    store.watchlists = store.watchlists.filter((w) => w.id !== body.id);
  }
  store.persistUserState();
  return { ok: true };
}

export type AlertOp =
  | { op: "create"; name: string; condition: AlertCondition }
  | { op: "toggle"; id: string }
  | { op: "delete"; id: string }
  | { op: "mark_read" };

export function handleAlertOp(store: DemoStore, body: AlertOp) {
  if (body.op === "create") {
    const rule = {
      id: store.nextId("al"),
      name: body.name,
      condition: body.condition,
      channels: ["in_app" as const],
      enabled: true,
      createdAt: Date.now(),
    };
    store.alertRules.push(rule);
    store.persistUserState();
    return { rule };
  }
  if (body.op === "toggle") {
    const rule = store.alertRules.find((r) => r.id === body.id);
    if (!rule) throw new ApiError(404, "rule not found");
    rule.enabled = !rule.enabled;
    store.persistUserState();
    return { rule };
  }
  if (body.op === "delete") {
    store.alertRules = store.alertRules.filter((r) => r.id !== body.id);
    store.persistUserState();
    return { ok: true };
  }
  for (const e of store.alertEvents) e.read = true;
  store.persistUserState();
  return { ok: true };
}

export function handlePaperOrder(store: DemoStore, req: OrderRequest) {
  const res = placeOrder(store, req);
  const pf = store.portfolios.find((p) => p.id === req.portfolioId);
  store.persistUserState();
  return {
    status: res.error ? 422 : 200,
    body: {
      order: res.order,
      fill: res.fill ?? null,
      error: res.error ?? null,
      portfolio: pf ? portfolioView(store, pf) : null,
      demo: true,
    },
  };
}

export function handleResearchNote(store: DemoStore, mint: string, note: string) {
  const snapshot = store.snapshot(mint);
  if (!snapshot) throw new ApiError(404, "unknown mint");
  const entry = { id: store.nextId("rn"), mint, ts: Date.now(), note, snapshot };
  store.research.unshift(entry);
  store.persistUserState();
  return { note: entry };
}

export function handleResearchAsk(store: DemoStore, question: string) {
  return { ...answerQuestion(store, question), demo: true };
}
