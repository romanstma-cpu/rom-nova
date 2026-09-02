// Jupiter Tokens V2 — the keyless source that closes most of Nova's gaps.
//
//   GET https://lite-api.jup.ag/tokens/v2/search?query=<mint|symbol|name>
//   GET https://lite-api.jup.ag/tokens/v2/toptrending/{5m|1h|6h|24h}?limit=N
//   GET https://lite-api.jup.ag/tokens/v2/toptraded/{interval}?limit=N
//   GET https://lite-api.jup.ag/tokens/v2/toporganicscore/{interval}?limit=N
//   GET https://lite-api.jup.ag/tokens/v2/recent?limit=N
//
// WHY THIS FILE CHANGED
//
// It was written against api.jup.ag behind JUPITER_API_KEY and gated off
// without one, so it never ran. The free tier serves the identical paths from
// lite-api.jup.ag with no key at all — measured 86-290ms, and it reflects the
// caller's Origin, including the `app://rom-nova` the Electron shell uses. So
// this is not an adapter waiting for a key; it is the best source in the stack
// and it is free.
//
// What it answers that nothing else keyless does:
//
//   holderCount                    holder count, and its 24h change
//   audit.topHoldersPercentage     concentration — previously UNMEASURED on
//                                  every live token this app has ever shown
//   audit.devBalancePercentage     what the deployer still holds
//   audit.devMints / devMigrations the creator's history: first mint, or 873rd
//   organicScore                   a real 0-100, replacing a hardcoded 50
//   stats5m/1h/6h/24h              priceChange and volumeChange per interval
//   launchpad / graduatedAt        pump.fun and friends, and when it graduated
//
// The last one is the structural win. Momentum and volume acceleration were
// derived only from candles; candles cost ~4.4s each and twelve never arrived,
// so the scanner dashed four columns on every row and two factors stood down
// on every live token. These stats arrive in the SAME response as the list.
//
// ONE CAVEAT, STATED HERE BECAUSE IT IS EASY TO MISREAD
//
// `topHoldersPercentage` counts AMM pool accounts as holders. A token showing
// 74% in the top ten may have most of that sitting in a Meteora pool, which is
// the opposite of a concentrated cap table. This adapter reports the number as
// published and does not pretend to know the split; `rugcheck.ts` is what
// labels pool accounts, and where both are configured the risk overlay is the
// one that can tell a whale from a liquidity pool.

import { providerFetch } from "./http";
import type { TokenDataProvider } from "./types";
import type {
  LaunchObservation,
  TokenInfo,
  TokenSnapshot,
  TradeWindow,
  TradeWindowKey,
  UnmeasuredField,
} from "../types";

interface JupStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numNetBuyers?: number;
}

interface JupMint {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  createdAt?: string;
  dev?: string;
  icon?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  /**
   * The authority ADDRESSES, present only when they are still live.
   *
   * Undocumented and easy to miss, and it is what makes this adapter a real
   * authority reader rather than a fail-safe default: SKHY carries both fields
   * and carries NO `audit.mintAuthorityDisabled` at all, so reading the audit
   * block alone reported "unknown" for a token whose mint authority is
   * demonstrably live. Verified against the chain on the same mint.
   */
  mintAuthority?: string;
  freezeAuthority?: string;
  holderCount?: number;
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  launchpad?: string;
  graduatedAt?: string;
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMints?: number;
    devMigrations?: number;
    /**
     * Jupiter's own "this mint looks off" bit. Only ever seen SET, never seen
     * set to false, so a missing key means nothing was flagged rather than
     * "checked and clean" — the same shape as everything else in this block.
     */
    isSus?: boolean;
  };
  stats5m?: JupStats;
  stats1h?: JupStats;
  stats6h?: JupStats;
  stats24h?: JupStats;
  firstPool?: { createdAt?: string };
}

/**
 * A pool row from `datapi.jup.ag`'s `gems` buckets.
 *
 * A different host and a different shape from the `tokens/v2` rows above: the
 * POOL is the record and the token hangs off it as `baseAsset`, which is the
 * right way round for a feed about pools coming into existence.
 */
interface GemsPool {
  id: string;
  /** "Meteora", "swap.pump.fun", "pump.fun" — the venue, not the launchpad. */
  dex?: string;
  /** "pumpfun-amm", "meteora-damm-v2", "pumpfun" — the pool program. */
  type?: string;
  createdAt?: string;
  liquidity?: number;
  /**
   * Curve completion as a PERCENTAGE, 0..100 — not a fraction, which is the
   * easy way to be wrong by two orders of magnitude here.
   *
   * The `recent` bucket is full of values below 1 because a mint seconds old
   * is a fraction of one percent along its curve, and reading 0.78 as "78%"
   * looks entirely plausible on a single row. Measured across all three
   * buckets, which is what settles it:
   *
   *   aboutToGraduate  n=30  min 65.76  median 74.58  max 91.49
   *   recent           n=30  min  0.00  median  1.07  max 47.39
   *   graduated        n=30  field absent entirely
   *
   * Absent once the curve has completed, which is the right shape: after
   * graduation there is no curve left to be a fraction of.
   */
  bondingCurve?: number;
  volume24h?: number;
  baseAsset?: JupMint & { graduatedAt?: string; graduatedPool?: string };
}

interface GemsBucket {
  pools?: GemsPool[];
  total?: number;
}

interface GemsResponse {
  recent?: GemsBucket;
  graduated?: GemsBucket;
  aboutToGraduate?: GemsBucket;
}

/** Which interval rankings this adapter will accept. */
export type JupInterval = "5m" | "1h" | "6h" | "24h";

/**
 * Jupiter's pool-shaped API. A different host from `tokens/v2` above, keyless
 * the same way, and it reflects `app://rom-nova` on both the preflight and the
 * POST — see `getGems` for the measurements.
 */
const DATAPI = "https://datapi.jup.ag/v1";

export function baseUrl(): string {
  return process.env.JUPITER_API_KEY
    ? "https://api.jup.ag/tokens/v2"
    : "https://lite-api.jup.ag/tokens/v2";
}

function headers(): Record<string, string> {
  return process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
}

/**
 * A percent change into the ratio the scorer wants.
 *
 * `volumeAccel` is read as "1.0 means running at its usual rate", and the
 * factor takes log2 of it, so the floor matters: a token whose volume fell
 * 100% would otherwise produce log2(0) = -Infinity and poison the whole score.
 */
export function accelFromPct(pct: number | undefined): number | undefined {
  if (pct === undefined || !Number.isFinite(pct)) return undefined;
  return Math.max(0.1, 1 + pct / 100);
}

/** Jupiter reports shares as percentages; the engine stores fractions. */
function frac(pct: number | undefined): number | undefined {
  if (pct === undefined || !Number.isFinite(pct)) return undefined;
  return pct / 100;
}

/**
 * One interval's stats block as a TradeWindow, or undefined when the source
 * said nothing about that window.
 *
 * Nothing is coerced to zero. A brand-new mint genuinely has windows with no
 * trades, and a five-minute-old token has no 24h window at all — those are
 * different facts and the panel prints them differently.
 */
function windowOf(s: JupStats | undefined): TradeWindow | undefined {
  if (!s) return undefined;
  const w: TradeWindow = {
    buys: Number.isFinite(s.numBuys) ? s.numBuys : undefined,
    sells: Number.isFinite(s.numSells) ? s.numSells : undefined,
    traders: Number.isFinite(s.numTraders) ? s.numTraders : undefined,
    buyVolumeUsd: Number.isFinite(s.buyVolume) ? s.buyVolume : undefined,
    sellVolumeUsd: Number.isFinite(s.sellVolume) ? s.sellVolume : undefined,
  };
  return Object.values(w).some((v) => v !== undefined) ? w : undefined;
}

/**
 * Whether the mint and freeze authorities are revoked, and whether this payload
 * actually SAYS.
 *
 * Two independent signals, and both are needed. `audit.mintAuthorityDisabled`
 * answers when the audit ran; the top-level `mintAuthority` address answers
 * when it did not, because Jupiter only emits that field while the authority is
 * live. Measured across the trending list: PUMP and ANSEM answer through the
 * audit block, SKHY answers only through the addresses — and SKHY is the one
 * where the answer is dangerous, which is the worst possible token to report as
 * unknown.
 *
 * `known: false` keeps "authorities" in the unmeasured set, so the scorer drops
 * the two authority factors and the engine abstains instead of grading an
 * unexamined mint. The revoked flags still fail safe for anything that reads
 * them directly.
 */
export function authorityState(m: {
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean };
  mintAuthority?: string;
  freezeAuthority?: string;
}): { mintRevoked: boolean; freezeRevoked: boolean; known: boolean } {
  const read = (disabled: boolean | undefined, liveAddress: string | undefined) => {
    if (liveAddress) return { revoked: false, known: true };
    if (disabled !== undefined) return { revoked: disabled, known: true };
    return { revoked: false, known: false };
  };
  const mint = read(m.audit?.mintAuthorityDisabled, m.mintAuthority);
  const freeze = read(m.audit?.freezeAuthorityDisabled, m.freezeAuthority);
  return {
    mintRevoked: mint.revoked,
    freezeRevoked: freeze.revoked,
    // One mint account read yields both, so a payload that answers only half of
    // it has not answered. Treated as unknown rather than half-trusted.
    known: mint.known && freeze.known,
  };
}

/**
 * The stand-in colour for a mint with no hosted logo.
 *
 * Exported rather than inlined at each call site because `classify.ts` already
 * warns about this exact failure: a token that is one colour on the scanner and
 * another on the launch feed is a bug nobody would think to look for. Most rows
 * in both lists come out of this file, and the launch feed's GeckoTerminal
 * fallback path — which builds a row for a mint Jupiter does not index — has to
 * agree with them.
 *
 * Not `classify.ts`'s `hueOf`, which uses a different hash. Switching would
 * recolour every token in the 3D scene for no gain.
 */
export function jupHue(mint: string): number {
  return Math.abs([...mint].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 360;
}

export function toInfo(m: JupMint): TokenInfo {
  const graduated = m.graduatedAt ? Date.parse(m.graduatedAt) : NaN;
  const authority = authorityState(m);
  return {
    mint: m.id,
    name: m.name,
    symbol: m.symbol,
    createdAt: Date.parse(m.firstPool?.createdAt ?? m.createdAt ?? "") || Date.now(),
    decimals: m.decimals,
    narrative: "Community",
    verified: Boolean(m.isVerified),
    // Jupiter is the only keyless source that ships these in the same payload
    // as the price. Where it says nothing the flags fail safe to not-revoked
    // AND the snapshot declares "authorities" unmeasured, so nothing downstream
    // can mistake the default for a reading.
    mintAuthorityRevoked: authority.mintRevoked,
    freezeAuthorityRevoked: authority.freezeRevoked,
    // Never reported here. The risk vendor's token_extensions block is the only
    // source in this stack that sees it, and the snapshot says so.
    permanentDelegate: false,
    icon: m.icon,
    links:
      m.twitter || m.telegram || m.website
        ? { twitter: m.twitter, telegram: m.telegram, website: m.website }
        : undefined,
    devWallet: m.dev ?? "",
    hue: jupHue(m.id),
    launchpad: m.launchpad,
    graduatedAt: Number.isFinite(graduated) ? graduated : undefined,
    devMints: m.audit?.devMints,
    devMigrations: m.audit?.devMigrations,
  };
}

/**
 * A snapshot, plus an honest account of what this payload did not carry.
 *
 * The old version of this function defaulted every gap: `devHoldsPct: 0`,
 * `bundlerPct: 0`, `sniperPct: 0`, `insiderPct: 0`, and — worst — an
 * `organicScore` that fell back to a hardcoded 50 when the field was missing.
 * Each of those is a reading the scorer treats as a measurement: zero insiders,
 * no bundlers, a clean dev wallet, average organic activity. None of it was
 * ever looked up. Every one of them is declared below instead.
 */
export function toSnapshot(m: JupMint, now = Date.now()): TokenSnapshot {
  const s1h = m.stats1h ?? {};
  const s24h = m.stats24h ?? {};
  const s6h = m.stats6h ?? {};
  const s5m = m.stats5m ?? {};

  const unmeasured: UnmeasuredField[] = [];
  const push = (f: UnmeasuredField) => unmeasured.push(f);

  // POOLED LIQUIDITY, declared like everything else rather than coerced.
  //
  // This adapter had two answers for one field: the launch builder below passes
  // `m.liquidity` through undefined and the feed prints "the source has not
  // priced this pool yet", while the snapshot coerced the same undefined to a
  // zero that the SCORER reads. Measured on 747MxrN9…pump at one minute old,
  // Liquidity Quality charged -16.4 for "$0 pooled" while Jupiter's own API was
  // reporting liquidity=3160.13 for that mint.
  const liquidity = Number.isFinite(m.liquidity) ? m.liquidity : undefined;
  if (liquidity === undefined) push("liquidity");
  // And the two 24h CHANGES. A token four minutes old has no 24h history, and
  // "+0.0% vs 24h ago" is a measurement of a period that has not happened.
  if (s24h.liquidityChange === undefined) push("liquidityChange");
  if (s24h.holderChange === undefined) push("holderGrowth");

  const top10 = frac(m.audit?.topHoldersPercentage);
  if (top10 === undefined) push("top10Pct");
  const devHolds = frac(m.audit?.devBalancePercentage);
  if (devHolds === undefined) push("devHoldsPct");
  if (m.holderCount === undefined) push("holders");
  const organic = m.organicScore === undefined ? undefined : m.organicScore / 100;
  if (organic === undefined) push("organicScore");

  // Momentum needs at least one interval to have reported a price change.
  // 1h and 24h are the two the factor actually reads.
  const hasMomentum = s1h.priceChange !== undefined || s24h.priceChange !== undefined;
  if (!hasMomentum) push("momentum");
  const accel = accelFromPct(s6h.volumeChange ?? s1h.volumeChange);
  if (accel === undefined) push("volumeAccel");

  // Jupiter counts traders, not buyers and sellers separately. `numNetBuyers`
  // is a net, and a net cannot be unpacked into two counts without inventing
  // the split.
  push("uniqueBuyers1h");
  push("uniqueSellers1h");
  // No social product behind this API, and no wallet forensics.
  push("socialScore");
  push("insiderPct");
  push("bundlerPct");
  push("sniperPct");
  // The security facts, declared the same way as every other gap. Until these
  // existed the scorer had no field to read the authorities from at all, so a
  // token whose deployer could still mint was graded purely on its tape.
  if (!authorityState(m).known) push("authorities");
  // Neither of these is in this payload at any depth.
  push("permanentDelegate");
  push("lpLocked");
  // Nor is the LP PROVIDER COUNT, which is the other half of the lock figure.
  // Only the risk vendor publishes it, and `liveFeatures` removes this from the
  // set when that vendor actually returns a count — so an absent count keeps
  // the LP penalty at full weight rather than buying a dispersion discount off
  // a zero nobody computed.
  push("lpProviders");
  // The deployer's track record. Present on most pump.fun mints and absent on
  // plenty of others, and the difference matters: an absent devMints arriving
  // as zero makes `max(1, 0)` and reads as "first mint from this deployer — no
  // track record either way", which is a claim about the wallet rather than an
  // admission that nothing was published about it.
  if (m.audit?.devMints === undefined) push("devHistory");

  return {
    mint: m.id,
    ts: now,
    priceUsd: m.usdPrice ?? 0,
    marketCapUsd: m.mcap ?? 0,
    fdvUsd: m.fdv ?? m.mcap ?? 0,
    // Still a number, because the field is not optional — but it is declared
    // unmeasured above when it is this default, so nothing scores it.
    liquidityUsd: liquidity ?? 0,
    // Real 24h volume, both sides, rather than a figure divided down from it.
    volume24hUsd: (s24h.buyVolume ?? 0) + (s24h.sellVolume ?? 0),
    // Genuine 1h counts. The previous version divided 24h counts by 24, which
    // reports a token's average hour as though it were this one — the exact
    // opposite of what a scanner is for.
    buys1h: s1h.numBuys ?? 0,
    sells1h: s1h.numSells ?? 0,
    uniqueBuyers1h: 0,
    uniqueSellers1h: 0,
    holders: m.holderCount ?? 0,
    top10Pct: top10 ?? 0,
    devHoldsPct: devHolds ?? 0,
    organicScore: organic ?? 0,
    socialScore: 0,
    bundlerPct: 0,
    sniperPct: 0,
    insiderPct: 0,
    momentum1h: s1h.priceChange,
    momentum24h: s24h.priceChange,
    momentum5m: s5m.priceChange,
    momentum6h: s6h.priceChange,
    volumeAccel: accel,
    holderGrowthPct: s24h.holderChange,
    liquidityChangePct: s24h.liquidityChange,
    // All four windows, carried whole. `buys1h`/`sells1h` above are the two the
    // feature vector reads; these are the twelve figures a reader actually
    // scans, and they were already in this payload being thrown away.
    windows: windowsOf(m),
    unmeasured,
  };
}

/** Every interval this payload broke out, or undefined if it broke out none. */
function windowsOf(m: JupMint): Partial<Record<TradeWindowKey, TradeWindow>> | undefined {
  const out: Partial<Record<TradeWindowKey, TradeWindow>> = {};
  const pairs: [TradeWindowKey, JupStats | undefined][] = [
    ["5m", m.stats5m],
    ["1h", m.stats1h],
    ["6h", m.stats6h],
    ["24h", m.stats24h],
  ];
  for (const [key, stats] of pairs) {
    const w = windowOf(stats);
    if (w) out[key] = w;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A `recent` row as a launch observation.
 *
 * Deliberately NOT routed through `toSnapshot`. A snapshot is a market state
 * and it throws away exactly what a launch feed lives on: `audit.isSus`, the
 * deployer address, whether the authority fields were READ or merely absent,
 * and the separation between "the pool was created at T" and "we saw it at U".
 *
 * `authorityKnown` is the field that keeps rule two honest. `toInfo` coerces a
 * missing `mintAuthorityDisabled` to `false`, which is the right grade and an
 * indistinguishable one — a token whose authority was read as live and a token
 * nobody audited both come out `mintAuthorityRevoked: false`. Downstream triage
 * needs to say "LIVE" for the first and "assumed live, unaudited" for the
 * second, so the distinction is carried rather than flattened.
 */
/**
 * A polled observation is always dated: the source publishes a creation time
 * for every row, and where it somehow does not, the sighting stands in and
 * says so below. Only a socket push arrives undated (see `observeLaunchPush`).
 */
export type DatedLaunch = LaunchObservation & { poolCreatedAt: number };

export function toLaunch(m: JupMint, seenAt: number, source = "jupiter"): DatedLaunch {
  const pool = Date.parse(m.firstPool?.createdAt ?? m.createdAt ?? "");
  const graduated = m.graduatedAt ? Date.parse(m.graduatedAt) : NaN;
  const a = m.audit ?? {};
  const s5 = m.stats5m ?? {};
  return {
    mint: m.id,
    // A pump.fun mint can reach the feed before its metadata does; measured on
    // the freshest rows, name and symbol are sometimes empty strings. A blank
    // cell is honest, a fabricated ticker is not, so the mint prefix stands in
    // and the UI can say why.
    name: m.name || "",
    symbol: m.symbol || "",
    hue: jupHue(m.id),
    decimals: m.decimals,
    poolCreatedAt: Number.isFinite(pool) ? pool : seenAt,
    firstSeenAt: seenAt,
    event: Number.isFinite(graduated) ? "graduation" : "pool",
    venue: m.launchpad,
    launchpad: m.launchpad,
    graduatedAt: Number.isFinite(graduated) ? graduated : undefined,
    dev: m.dev,
    devMints: a.devMints,
    devMigrations: a.devMigrations,
    priceUsd: m.usdPrice,
    liquidityUsd: m.liquidity,
    // Already parsed for the scanner's snapshot; it was simply never carried
    // onto a launch. On a token minutes old it is the one number that separates
    // a $3.2k curve everyone ignores from one people are actually buying.
    marketCapUsd: m.mcap ?? m.fdv,
    holders: m.holderCount,
    top10Pct: frac(a.topHoldersPercentage),
    devHoldsPct: frac(a.devBalancePercentage),
    organicScore: m.organicScore === undefined ? undefined : m.organicScore / 100,
    buys5m: s5.numBuys,
    sells5m: s5.numSells,
    traders5m: s5.numTraders,
    sus: a.isSus === true ? true : undefined,
    mintAuthorityRevoked: a.mintAuthorityDisabled === true,
    freezeAuthorityRevoked: a.freezeAuthorityDisabled === true,
    authorityKnown: a.mintAuthorityDisabled !== undefined && a.freezeAuthorityDisabled !== undefined,
    source,
  };
}

/**
 * A `gems` pool row as a launch observation.
 *
 * Deliberately routed through `toLaunch` rather than reimplemented. The audit
 * reading — and in particular `authorityKnown`, which is what separates "the
 * mint authority is LIVE" from "nobody audited this mint" — lives in exactly
 * one place, and a second hand-rolled copy of it here is how a token nobody
 * looked at eventually gets graded as safely renounced.
 *
 * Only the POOL facts are overridden afterwards, because they are the facts
 * `toLaunch` cannot know from a token payload alone.
 */
export function gemsToLaunch(p: GemsPool, seenAt: number): DatedLaunch | null {
  const base = p.baseAsset;
  if (!base?.id) return null;
  const obs = toLaunch(base, seenAt, "jupiter-datapi");

  // Which moment this row is ABOUT.
  //
  // `toLaunch` reports `firstPool.createdAt`, which for a graduated mint is
  // when its bonding curve opened — measured 33 seconds before graduation on
  // one row and potentially months before on another. The event being reported
  // here is the AMM pool opening, so the graduation time wins where there is
  // one, and the pool's own creation time is the fallback.
  const poolAt = Date.parse(base.graduatedAt ?? p.createdAt ?? "");

  return {
    ...obs,
    poolCreatedAt: Number.isFinite(poolAt) ? poolAt : obs.poolCreatedAt,
    // The venue is the pool's DEX ("swap.pump.fun", "Meteora"), which is what
    // a graduation row is about; `launchpad` still carries where it started.
    venue: p.dex ?? obs.venue,
    // The pool's own depth beats the token aggregate on a pool seconds old,
    // for the same reason the GeckoTerminal path prefers it. Zero is not a
    // reading here: an unpriced pool must stay undefined or it renders as a
    // dead one and sails through a minimum-liquidity filter.
    liquidityUsd: p.liquidity || obs.liquidityUsd,
    // Percent to fraction, the same conversion `frac` does for every other
    // share in this file. The suffix says Pct and the value is a fraction
    // because that is the convention `top10Pct` and `devHoldsPct` already set.
    bondingCurvePct: curveFraction(p.bondingCurve),
  };
}

/** A 0..100 curve percentage as a 0..1 fraction, or nothing at all. */
function curveFraction(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v / 100 : undefined;
}

type Detailed = TokenInfo & { snapshot: TokenSnapshot };

export class JupiterTokenProvider implements TokenDataProvider {
  readonly name = "jupiter";

  private async list(path: string): Promise<JupMint[]> {
    const rows = await providerFetch<JupMint[]>(this.name, `${baseUrl()}/${path}`, {
      headers: headers(),
    });
    // A malformed body must not crash a list render. `.map` on a non-array is
    // the kind of failure that surfaces three screens away from its cause.
    return Array.isArray(rows) ? rows : [];
  }

  async getToken(mint: string): Promise<Detailed | null> {
    const rows = await this.list(`search?query=${encodeURIComponent(mint)}`);
    // Exact mint only. `search` is a fuzzy endpoint and will happily answer a
    // mint address with a token whose NAME resembles it; returning that as the
    // requested token would put one coin's holder data under another's chart.
    const m = rows.find((r) => r.id === mint);
    return m ? { ...toInfo(m), snapshot: toSnapshot(m) } : null;
  }

  async getTrendingTokens(limit: number) {
    return (await this.list(`toptrending/1h?limit=${limit}`)).map((m) => toSnapshot(m));
  }

  /**
   * The whole list — info AND snapshot — in a single request.
   *
   * This is the point of the adapter. The previous list path made one trending
   * call plus twelve token lookups plus twelve flow reads, roughly twenty-five
   * requests, which is why it needed a thirty-second cache to avoid
   * rate-limiting itself. Jupiter returns twelve fully-populated tokens in one
   * ~30KB response, so the fan-out that made the list expensive is gone
   * entirely and the rows come back richer than the fan-out ever made them.
   */
  async getTrendingDetailed(limit: number, interval: JupInterval = "1h"): Promise<Detailed[]> {
    const rows = await this.list(`toptrending/${interval}?limit=${limit}`);
    const now = Date.now();
    return rows.map((m) => ({ ...toInfo(m), snapshot: toSnapshot(m, now) }));
  }

  /** Freshly-listed mints — the launch feed, same one-call shape. */
  async getRecentDetailed(limit: number): Promise<Detailed[]> {
    const rows = await this.list(`recent?limit=${limit}`);
    const now = Date.now();
    return rows.map((m) => ({ ...toInfo(m), snapshot: toSnapshot(m, now) }));
  }

  /**
   * The launch feed proper: brand-new mints, as observations rather than
   * snapshots.
   *
   * MEASURED PROPERTIES OF THIS ENDPOINT, because they set the whole design:
   *
   *   It caps at THIRTY rows. `?limit=50`, `100` and `200` each returned
   *   exactly thirty, byte-identical, so `RECENT_WINDOW_ROWS` is a ceiling and
   *   not a parameter. At the observed launch rate those thirty rows spanned 43
   *   seconds of Solana, and that is the entire history this endpoint will ever
   *   show. Poll slower than that window and launches fall off the back unseen:
   *   nothing queues them anywhere.
   *
   *   It runs 1-3 seconds behind the chain. The freshest row in a sampled page
   *   carried a `firstPool.createdAt` one second old.
   *
   *   Roughly 28 of 30 rows carry price and liquidity. The freshest one or two
   *   usually do not, because Jupiter has not priced them yet, and those come
   *   back with the fields undefined rather than zeroed.
   */
  async getRecentLaunches(seenAt = Date.now()): Promise<DatedLaunch[]> {
    const rows = await this.list("recent");
    return rows.map((m) => toLaunch(m, seenAt));
  }

  /**
   * Full rows for a specific set of mints, in ONE request.
   *
   * `search` accepts comma-joined mints: measured up to 100 in a single 207ms
   * call, returning all 100 and only the ones asked for. That is what makes a
   * second launch source affordable. GeckoTerminal's new-pool feed names the
   * pool and its base mint and carries no audit block at all, so every pool it
   * finds would otherwise need its own lookup; batched, a whole page of them
   * costs one Jupiter call.
   */
  async getLaunchesByMint(mints: string[], seenAt = Date.now()): Promise<Map<string, DatedLaunch>> {
    const out = new Map<string, DatedLaunch>();
    if (mints.length === 0) return out;
    const rows = await this.list(`search?query=${mints.slice(0, 100).join(",")}`);
    for (const m of rows) out.set(m.id, toLaunch(m, seenAt));
    return out;
  }

  /**
   * Graduations, and curve progress for the mints still climbing — one POST.
   *
   * THIS IS THE FIX FOR THE FEED'S WORST NUMBER, AND IT WAS FREE.
   *
   * Graduations used to arrive only through GeckoTerminal's `new_pools`, whose
   * own index runs 18-94s behind the chain before any polling interval is
   * added. Clock-corrected, that put graduations on screen at a p50 of about
   * two minutes while Axiom's "Migrated" column is in seconds. It was the
   * single largest competitive gap in the feed.
   *
   * `datapi.jup.ag/v1/pools/gems` is the same vendor already serving the mint
   * feed, keyless, and it publishes a `graduated` bucket directly. Measured:
   *
   *   preflight OPTIONS      204, access-control-allow-origin: app://rom-nova,
   *                          access-control-allow-headers: content-type
   *   POST with that Origin  200
   *   106 requests           zero 429s (6 with no gap, 60 at 1/s, 40 at 1/3s),
   *                          p50 117ms
   *
   * WHY NOT pump.fun's OWN API, which is fresher still
   *
   * Because it cannot be read from a browser, and the measurement that says
   * otherwise is the one that is easy to run. Re-verified here rather than
   * taken on trust:
   *
   *   no Origin header             200   (this is the misleading result)
   *   Origin: app://rom-nova       403   {"message":"Not allowed by CORS"}
   *   Origin: https://romapps.xyz  403   same
   *   Origin: https://pump.fun     200   acao: https://pump.fun
   *   OPTIONS preflight            403
   *
   * It allowlists its own origin and nothing else. `Origin` is a forbidden
   * header name, so a page cannot set it and a browser always sends the real
   * one — there is no arrangement of client code that reaches the 200. Nova is
   * a static export running in the visitor's tab, so "works from curl" is not
   * a category of working.
   *
   * The other two buckets come back in the same response and are requested for
   * one field the `tokens/v2` feed does not carry at all: `bondingCurve`, how
   * far a launchpad mint is along its curve. They cost nothing extra.
   *
   * BOTH are needed, and `aboutToGraduate` is the one that matters. The
   * `recent` bucket medians 1.07% because its rows are seconds old, so a curve
   * column fed from it alone would be a page of near-zeroes and a
   * "near graduation" filter that matched nothing. `aboutToGraduate` is where
   * the 65-91% rows live — the mints actually close to completing.
   */
  async getGems(seenAt = Date.now()): Promise<{ graduations: DatedLaunch[]; curves: Map<string, number> }> {
    const res = await providerFetch<GemsResponse>(this.name, `${DATAPI}/pools/gems`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers() },
      // `limit` is sent but not honoured — 3, 5 and 30 all returned 30 rows.
      // Asked for anyway so the intent is on the record if it starts being read.
      body: JSON.stringify({
        recent: { timeframe: "24h", limit: 30 },
        aboutToGraduate: { timeframe: "24h", limit: 30 },
        graduated: { timeframe: "24h", limit: 30 },
      }),
      timeoutMs: 10_000,
    });

    const graduations: DatedLaunch[] = [];
    for (const p of res.graduated?.pools ?? []) {
      // A graduated row carrying no parseable graduation time is dropped rather
      // than dated. `toLaunch` falls back to `seenAt` when a payload has no
      // usable timestamp, which is harmless for a row that only needs to exist
      // and is NOT harmless here: it would enter the graduation statistic
      // reporting a lag of zero and flatter the exact number this source was
      // added to fix. Better to miss one graduation than to invent a fast one.
      if (!Number.isFinite(Date.parse(p.baseAsset?.graduatedAt ?? p.createdAt ?? ""))) continue;
      const obs = gemsToLaunch(p, seenAt);
      if (obs) graduations.push({ ...obs, event: "graduation" });
    }

    const curves = new Map<string, number>();
    for (const p of [...(res.recent?.pools ?? []), ...(res.aboutToGraduate?.pools ?? [])]) {
      const mint = p.baseAsset?.id;
      const frac = curveFraction(p.bondingCurve);
      if (mint && frac !== undefined) curves.set(mint, frac);
    }
    return { graduations, curves };
  }

  async getRecentTokens(limit: number) {
    return (await this.list(`recent?limit=${limit}`)).map((m) => toSnapshot(m));
  }

  async searchTokens(query: string) {
    return (await this.list(`search?query=${encodeURIComponent(query)}`)).map(toInfo);
  }
}
