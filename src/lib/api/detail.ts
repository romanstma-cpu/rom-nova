// The token detail page's payload, assembled from live providers.
//
// WHY THIS FILE EXISTS
//
// The scanner has shown real Solana mints for a while, and every row linked to
// `/token?m=<mint>`. That page called `handleTokenDetail`, which reads the
// simulator's store, which has never heard of a real mint — so every link out of
// the live scanner landed on "Token not found." The most-clicked path in the app
// was a dead end, and nothing failed loudly enough to say so.
//
// WHAT THIS DELIBERATELY DOES NOT FETCH
//
// Candles. `liveFeatures` will pull ~1,000 hourly bars if given a market
// provider, and GeckoTerminal is metered hard enough that the repo serialises it
// with a 2.1s gap — measured, two calls (pool lookup, then OHLCV) take three to
// five seconds, and a burst answers 429 with an error body. Paying that before
// showing the score, the holders and the security panel would triple the time to
// anything useful. The chart keeps its own endpoint and its own provenance chip,
// which is the pattern the page already used.
//
// The cost of that split is stated rather than hidden: with no bars, momentum
// and volume acceleration come from the token provider's own published interval
// stats, and the audit table names which. A reader must not be left to assume
// the bars above the score fed the score.
//
// WHERE TWO SOURCES DISAGREE
//
// Three parties answer overlapping questions here — the token provider, the
// chain, and the risk vendor — and on live data they do not always agree.
// Measured across today's trending list: Jupiter counted 135,714 holders of PUMP
// where RugCheck counted 505,751, and 547,888 of PENGU against 1,961,156. Their
// top-10 shares matched to a tenth of a point on two tokens and were 6 and 55
// points apart on two others. Picking a winner silently is the failure this
// codebase keeps having to unlearn, so disagreements are collected and printed.

import type { Signal, TokenInfo, TokenSnapshot } from "../types";
import type { MarketDataProvider, TokenFlow, TokenRisk } from "../providers/types";
import { auditFactors, type ScoreAudit } from "../engine/signals";
import { liveSignal } from "../engine/live-features";
import { getProviders } from "../providers/registry";
import type { StrategyProfileId } from "../types";

/**
 * One line of the holder table, as published, with the vendor's label where it
 * had one and nothing invented where it did not.
 */
export interface HolderRow {
  rank: number;
  /** The wallet that owns the balance. Checkable on any block explorer. */
  owner: string;
  /** The token account holding it, when the source published one. */
  account?: string;
  /** Share of supply, 0..1. */
  pct: number;
  /** "Meteora DLMM Pool", "Raydium Authority V4" — absent when unlabelled. */
  label?: string;
  insider: boolean;
  /** True when this row is the deployer the risk vendor named. */
  isCreator: boolean;
}

export interface HolderTable {
  rows: HolderRow[];
  /** How many rows carried a label. The denominator is `rows.length`. */
  labelled: number;
  /** Who published the table, so the labels are never mistaken for Nova's. */
  source?: string;
  /** The vendor's own total holder count, which is not the table's length. */
  totalHolders?: number;
  /** Sum of the published rows, 0..1 — the vendor's arithmetic, not a model. */
  listedPct: number;
}

/** A wallet that actually moved the token in the flow window. */
export interface FlowMover {
  owner: string;
  /** Net change in USD over the window. Negative is distribution. */
  usd: number;
  /** Net change in whole tokens, for a reader who wants the raw quantity. */
  tokens: number;
}

export interface FlowPanel {
  source: string;
  movers: FlowMover[];
  buyers: number;
  sellers: number;
  /** Balance changes counted, after discarding accounts merely touched. */
  movements: number;
  touchedNotMoved: number;
  wallets: number;
  minutesRequested: number;
  minutesCovered: number;
  /** False when the byte budget cut the window short. */
  complete: boolean;
  megabytesRead: number;
}

/**
 * Two or more sources answering one question differently.
 *
 * Never resolved here. The page prints every claim with its source attached,
 * because a terminal that averages two irreconcilable holder counts has
 * manufactured a third number nobody measured.
 */
export interface SourceDisagreement {
  question: string;
  claims: { source: string; value: string }[];
  note: string;
}

export interface CreatorPanel {
  /** Deployer per the token provider, when it named one. */
  address?: string;
  /** Deployer per the risk vendor, when it named one. */
  vendorAddress?: string;
  /** Total mints by this creator, per the token provider. */
  mints?: number;
  /** How many of them reached a real pool. */
  migrations?: number;
  /** Dev balance as a share of supply, per the token provider. */
  holdsPct?: number;
  /** The same, per the risk vendor's own two fields. */
  vendorHoldsPct?: number;
  launchpad?: string;
  graduatedAt?: number;
  /** True when the deployer's dev balance was never published by anyone. */
  holdsUnmeasured: boolean;
}

export interface LiveTokenDetail {
  mode: "live";
  info: TokenInfo;
  snapshot: TokenSnapshot;
  signal: Signal;
  audit: ScoreAudit;
  risk?: TokenRisk;
  holders: HolderTable;
  creator: CreatorPanel;
  flow?: FlowPanel;
  /** Whether a source actually read the mint and freeze authorities. */
  authorityChecked: boolean;
  authoritySource?: string;
  disagreements: SourceDisagreement[];
  provenance: string[];
  /** Which adapter answered for the market numbers. */
  source: string;
  asOf: number;
}

/**
 * A market provider that fetches nothing, named so the provenance explains
 * itself.
 *
 * `liveFeatures` prints its market source by name, and a line reading
 * "coingecko: NO candles" would report an outage at a vendor this path never
 * called. Naming it after the decision keeps the provenance narrative true.
 */
const NO_CANDLES: MarketDataProvider = {
  name: "none (detail view — bars are fetched separately for the chart)",
  getCandles: async () => [],
  getPrice: async () => null,
};

/** Solana produces a block roughly every 400ms; the flow window is in blocks. */
const BLOCKS_PER_MINUTE = 150;
/** Matches the window `liveFeatures` asks its flow provider for. */
const FLOW_MINUTES = 10;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * How long an assembled detail stays fresh enough to re-serve.
 *
 * The page polls, and one uncached assembly pulls the risk vendor's FULL
 * report — measured between 54KB and 1.1MB. Served straight through, an open
 * token tab would re-download a megabyte every refresh and rate-limit itself
 * into the simulator fallback, which is the worst outcome: a page that looks
 * live while quietly showing synthetic data.
 *
 * Twenty seconds decouples the poll rate from the fetch rate without letting a
 * price go visibly stale.
 */
export const DETAIL_CACHE_MS = 20_000;

const cache = new Map<string, { at: number; value: LiveTokenDetail }>();
/** In-flight de-duplication, so two polls landing together share one assembly. */
const inFlight = new Map<string, Promise<LiveTokenDetail | null>>();

/** Bound on the cache, so a session that opens hundreds of tokens does not grow
 *  a megabyte of holder tables per mint forever. */
const MAX_CACHED = 24;

/**
 * Builds the detail payload for a real mint, or null when no live token
 * provider is configured or the mint is not listed.
 *
 * Null is not an error. It means the caller should fall back to the simulator,
 * which is the right answer for a demo mint and the honest answer for a mint
 * nobody lists.
 */
export async function liveTokenDetail(
  mint: string,
  profile: StrategyProfileId = "balanced",
  now = Date.now(),
): Promise<LiveTokenDetail | null> {
  const key = `${mint}:${profile}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < DETAIL_CACHE_MS) return hit.value;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = assemble(mint, profile, now).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  const fresh = await run;
  if (fresh) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now, value: fresh });
  }
  // A failed refresh serves the last good assembly rather than dropping to the
  // simulator: stale real data beats fresh fake data, and `asOf` carries its age.
  return fresh ?? hit?.value ?? null;
}

async function assemble(
  mint: string,
  profile: StrategyProfileId,
  now: number,
): Promise<LiveTokenDetail | null> {
  const providers = getProviders();
  if (providers.token.name === "demo") return null;

  const scored = await liveSignal(
    mint,
    {
      token: providers.token,
      market: NO_CANDLES,
      security: providers.security.name === "demo" ? undefined : providers.security,
      flow: providers.flow,
      risk: providers.risk,
    },
    profile,
    now,
    // The full report, which is what a detail page is for: top holders with
    // per-holder shares, the label map, the insider graph and the creator.
    true,
  ).catch(() => null);
  if (!scored) return null;

  const { signal, result } = scored;
  const risk = result.risk;

  return {
    mode: "live",
    info: result.info,
    snapshot: result.snapshot,
    signal,
    audit: auditFactors(signal),
    risk,
    holders: holderTable(risk),
    creator: creatorPanel(result.info, result.snapshot, risk),
    flow: flowPanel(result.flow, result.info.decimals, result.snapshot.priceUsd),
    authorityChecked: result.authorityChecked,
    authoritySource: result.authoritySource,
    disagreements: findDisagreements(
      providers.token.name,
      result.info,
      result.snapshot,
      risk,
      result.authorityChecked,
      result.authoritySource,
    ),
    provenance: result.provenance,
    source: providers.token.name,
    asOf: now,
  };
}

export function holderTable(risk: TokenRisk | undefined): HolderTable {
  const published = risk?.topHolders ?? [];
  const rows: HolderRow[] = published.map((h, i) => ({
    rank: i + 1,
    owner: h.owner,
    account: h.account,
    pct: h.pct,
    label: h.label,
    insider: h.insider === true,
    isCreator: h.isCreator === true,
  }));
  return {
    rows,
    labelled: risk?.labelledHolders ?? rows.filter((r) => r.label).length,
    source: rows.length ? risk?.source : undefined,
    totalHolders: risk?.totalHolders,
    listedPct: rows.reduce((s, r) => s + r.pct, 0),
  };
}

export function creatorPanel(
  info: TokenInfo,
  snapshot: TokenSnapshot,
  risk: TokenRisk | undefined,
): CreatorPanel {
  const devUnmeasured = (snapshot.unmeasured ?? []).includes("devHoldsPct");
  return {
    address: info.devWallet || undefined,
    vendorAddress: risk?.creator,
    mints: info.devMints,
    migrations: info.devMigrations,
    // A declared-unmeasured dev balance must not reach the panel as its
    // placeholder zero. "Dev holds 0.0%" is the most reassuring sentence on the
    // page and here it would mean nobody published the number.
    holdsPct: devUnmeasured ? undefined : snapshot.devHoldsPct,
    vendorHoldsPct: risk?.creatorHoldsPct,
    launchpad: info.launchpad ?? risk?.launchpad,
    graduatedAt: info.graduatedAt,
    holdsUnmeasured: devUnmeasured && risk?.creatorHoldsPct === undefined,
  };
}

export function flowPanel(
  flow: TokenFlow | undefined,
  decimals: number,
  priceUsd: number,
): FlowPanel | undefined {
  if (!flow) return undefined;
  const movers: FlowMover[] = flow.largest
    .map((m) => {
      const tokens = Number(m.deltaUnits) / 10 ** (decimals ?? 9);
      return { owner: m.owner, tokens, usd: tokens * priceUsd };
    })
    // Sub-dollar dust is not flow, and twenty rows of it would bury the wallet
    // that actually moved size.
    .filter((m) => Number.isFinite(m.usd) && Math.abs(m.usd) >= 1)
    .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))
    .slice(0, 20);
  return {
    source: flow.source,
    movers,
    buyers: flow.buyers,
    sellers: flow.sellers,
    movements: flow.movements,
    touchedNotMoved: flow.touchedNotMoved,
    wallets: flow.wallets,
    minutesRequested: FLOW_MINUTES,
    // The window actually covered, not the one requested. A byte budget that
    // stopped at four minutes must not be printed as ten.
    minutesCovered: flow.blocksCovered / BLOCKS_PER_MINUTE,
    complete: flow.complete,
    megabytesRead: flow.bytesRead / 1048576,
  };
}

/**
 * How far two counts of the same thing may drift before it is worth saying.
 *
 * Holder counts came back 3.6x apart on PENGU, so this is not a rounding
 * tolerance — it is set loose enough that ordinary indexing lag stays quiet and
 * a genuine methodological split does not.
 */
export const HOLDER_DISAGREEMENT_RATIO = 1.25;
/** Percentage POINTS of supply. Jupiter and RugCheck matched to 0.1 on two
 *  tokens and were 6 and 55 points apart on two others. */
export const CONCENTRATION_DISAGREEMENT_PP = 3;

export function findDisagreements(
  tokenSource: string,
  info: TokenInfo,
  snapshot: TokenSnapshot,
  risk: TokenRisk | undefined,
  authorityChecked: boolean,
  authoritySource: string | undefined,
): SourceDisagreement[] {
  const out: SourceDisagreement[] = [];
  const unmeasured = snapshot.unmeasured ?? [];
  if (!risk) return out;

  // ---- how many people hold this
  const jupHolders = unmeasured.includes("holders") ? undefined : snapshot.holders;
  if (jupHolders !== undefined && jupHolders > 0 && risk.totalHolders !== undefined && risk.totalHolders > 0) {
    const ratio = Math.max(jupHolders, risk.totalHolders) / Math.min(jupHolders, risk.totalHolders);
    if (ratio >= HOLDER_DISAGREEMENT_RATIO) {
      out.push({
        question: "How many wallets hold this token",
        claims: [
          { source: tokenSource, value: jupHolders.toLocaleString() },
          { source: risk.source, value: risk.totalHolders.toLocaleString() },
        ],
        note:
          `${ratio.toFixed(1)}x apart. The two count different things — one appears to exclude ` +
          `zero-balance and program-owned accounts and the other does not — and neither publishes ` +
          `its rule, so this app shows both rather than averaging them into a number nobody measured.`,
      });
    }
  }

  // ---- how much the top ten hold
  //
  // The vendor's own rows, added up. Not the rejected "concentration excluding
  // pools" derivation — no row is dropped and no account is judged, this is
  // arithmetic on one source used only to check it against another.
  const rcTop10 = risk.topHolders?.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const jupTop10 = unmeasured.includes("top10Pct") ? undefined : snapshot.top10Pct;
  if (jupTop10 !== undefined && rcTop10 !== undefined && risk.topHolders && risk.topHolders.length >= 10) {
    const gap = Math.abs(jupTop10 - rcTop10) * 100;
    if (gap >= CONCENTRATION_DISAGREEMENT_PP) {
      out.push({
        question: "What share of supply the top 10 wallets hold",
        claims: [
          { source: tokenSource, value: pct(jupTop10) },
          { source: `${risk.source} (its own 10 largest rows, summed)`, value: pct(rcTop10) },
        ],
        note:
          `${gap.toFixed(1)} percentage points apart. The score uses the ${tokenSource} figure ` +
          `because that is the field the feature vector reads; the holder table below is the ` +
          `${risk.source} rows, so the two panels can differ and this says why.`,
      });
    }
  }

  // ---- can the supply still be inflated, and can balances be frozen
  //
  // The authority flags are the loudest safety facts about an SPL token, and
  // three parties answer them. Reported only where a source genuinely READ the
  // mint: the keyless token providers report "not revoked" whether they looked
  // or not, so treating that default as a claim would manufacture a conflict.
  const chainSource = authorityChecked ? (authoritySource ?? "chain") : null;
  const pairs: [string, boolean | null, boolean | undefined][] = [
    [
      "Is the mint authority revoked",
      chainSource ? info.mintAuthorityRevoked : null,
      risk.mintAuthority === undefined ? undefined : risk.mintAuthority === null,
    ],
    [
      "Is the freeze authority revoked",
      chainSource ? info.freezeAuthorityRevoked : null,
      risk.freezeAuthority === undefined ? undefined : risk.freezeAuthority === null,
    ],
  ];
  for (const [question, chain, vendor] of pairs) {
    if (chain === null || vendor === undefined || chain === vendor) continue;
    out.push({
      question,
      claims: [
        { source: chainSource!, value: chain ? "revoked" : "LIVE" },
        { source: risk.source, value: vendor ? "revoked" : "LIVE" },
      ],
      note:
        "Two reads of the same mint account disagree. Treat the more dangerous answer as the " +
        "operative one until one of them updates — an authority reported LIVE by anybody can " +
        "inflate supply or freeze balances.",
    });
  }

  // ---- who deployed it
  if (info.devWallet && risk.creator && info.devWallet !== risk.creator) {
    out.push({
      question: "Which wallet deployed this token",
      claims: [
        { source: tokenSource, value: info.devWallet },
        { source: risk.source, value: risk.creator },
      ],
      note:
        "Different addresses. One is likely the launchpad's deploy account and the other the " +
        "wallet that paid it, but nothing here can say which, so both are shown.",
    });
  }

  return out;
}
