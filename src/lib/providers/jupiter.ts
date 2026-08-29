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
import type { TokenInfo, TokenSnapshot, UnmeasuredField } from "../types";

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
  };
  stats5m?: JupStats;
  stats1h?: JupStats;
  stats6h?: JupStats;
  stats24h?: JupStats;
  firstPool?: { createdAt?: string };
}

/** Which interval rankings this adapter will accept. */
export type JupInterval = "5m" | "1h" | "6h" | "24h";

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

export function toInfo(m: JupMint): TokenInfo {
  const graduated = m.graduatedAt ? Date.parse(m.graduatedAt) : NaN;
  return {
    mint: m.id,
    name: m.name,
    symbol: m.symbol,
    createdAt: Date.parse(m.firstPool?.createdAt ?? m.createdAt ?? "") || Date.now(),
    decimals: m.decimals,
    narrative: "Community",
    verified: Boolean(m.isVerified),
    // Jupiter's audit block is the only keyless source that ships these in the
    // same payload as the price. Absent means the audit did not run, which is
    // graded as not-revoked — an unexamined token must never read as safe.
    mintAuthorityRevoked: Boolean(m.audit?.mintAuthorityDisabled),
    freezeAuthorityRevoked: Boolean(m.audit?.freezeAuthorityDisabled),
    permanentDelegate: false,
    devWallet: m.dev ?? "",
    hue: Math.abs([...m.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 360,
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

  return {
    mint: m.id,
    ts: now,
    priceUsd: m.usdPrice ?? 0,
    marketCapUsd: m.mcap ?? 0,
    fdvUsd: m.fdv ?? m.mcap ?? 0,
    liquidityUsd: m.liquidity ?? 0,
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
    volumeAccel: accel,
    holderGrowthPct: s24h.holderChange,
    liquidityChangePct: s24h.liquidityChange,
    unmeasured,
  };
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

  async getRecentTokens(limit: number) {
    return (await this.list(`recent?limit=${limit}`)).map((m) => toSnapshot(m));
  }

  async searchTokens(query: string) {
    return (await this.list(`search?query=${encodeURIComponent(query)}`)).map(toInfo);
  }
}
