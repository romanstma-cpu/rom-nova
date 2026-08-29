// Does the signal score actually predict anything?
//
// Nova scores tokens and, until this file existed, nothing ever checked. A
// number between 0 and 100 appeared beside every row, sorted the whole scanner,
// and no part of the app could say whether a 70 had ever done better than a 40.
// That is the state most token scanners ship in permanently, and it is why the
// honest claim on the site has had to stay so thin.
//
// This is the forward test. Every scan pass writes down what it saw and what it
// cost; later passes supply the price that resolves it. Nothing is fetched for
// this and nothing is uploaded — the ledger is a by-product of scanning that
// was previously thrown away.
//
// THE STATISTICS ARE THE POINT, AND THEY ARE THE EASY PART TO GET WRONG
//
// Twelve tokens observed in one pass are not twelve independent trials. They
// share a market, an hour, and usually a direction: when Solana rips, all
// twelve go up and a naive interval reports a discovery. So resampling happens
// over PASSES, never over rows, and a pass enters or leaves the resample whole.
// This is the same correction that dismantled seven straight "profitable"
// strategies in ROM Trader, where row-wise intervals had been overstating
// confidence by an unearned root-N.
//
// And the comparison that matters is not "did high scores go up". In a rising
// market everything goes up. It is whether high scores beat the average of
// EVERYTHING THIS TERMINAL LOOKED AT over the same window — the zero-skill
// baseline of buying whatever the scanner happened to list.

import type { StrategyProfileId } from "../types";

/** One token, as it looked at one instant, with the price that dates it. */
export interface Observation {
  mint: string;
  symbol: string;
  /** ms epoch of the scan pass. Rows sharing this value are ONE cluster. */
  ts: number;
  score: number;
  confidence: number;
  priceUsd: number;
  profile: StrategyProfileId | string;
  /** How many inputs were missing when this score was formed. */
  unmeasuredCount: number;
}

export interface Horizon {
  label: string;
  ms: number;
}

export const HORIZONS: Horizon[] = [
  { label: "1h", ms: 3_600_000 },
  { label: "6h", ms: 6 * 3_600_000 },
  { label: "24h", ms: 24 * 3_600_000 },
];

/**
 * How much later than the horizon a resolving price may be.
 *
 * A closed laptop is the normal case, not an edge case. If the app is shut for
 * two days, the next sighting of a mint is not its "1h return" — and silently
 * using it would fill the ledger with mislabelled horizons that all quietly
 * lengthen in a bull week. Outside the window an observation EXPIRES, and
 * expiry is reported separately from still-pending so the reader can tell "not
 * yet" from "we were not watching".
 */
export function toleranceFor(h: Horizon): number {
  return Math.max(h.ms, 30 * 60_000);
}

export interface Resolved {
  obs: Observation;
  horizon: string;
  /** Percent change from the observed price to the resolving one. */
  returnPct: number;
  /** ms actually elapsed — inside [horizon, horizon + tolerance]. */
  elapsedMs: number;
}

export interface ResolveResult {
  resolved: Resolved[];
  pending: number;
  expired: number;
}

/**
 * Match each observation to a later price of the same mint.
 *
 * Deliberately uses nothing but the ledger itself. A resolver that went and
 * fetched the current price would answer "what is it worth now", which is a
 * different and much less useful question than "what was it worth one hour
 * after we scored it".
 */
export function resolveOutcomes(
  ledger: readonly Observation[],
  horizons: readonly Horizon[] = HORIZONS,
  now = Date.now(),
): ResolveResult {
  const byMint = new Map<string, Observation[]>();
  for (const o of ledger) {
    const arr = byMint.get(o.mint);
    if (arr) arr.push(o);
    else byMint.set(o.mint, [o]);
  }
  for (const arr of byMint.values()) arr.sort((a, b) => a.ts - b.ts);

  const resolved: Resolved[] = [];
  let pending = 0;
  let expired = 0;

  for (const o of ledger) {
    if (!(o.priceUsd > 0)) continue;
    const series = byMint.get(o.mint)!;
    for (const h of horizons) {
      const target = o.ts + h.ms;
      const limit = target + toleranceFor(h);
      // The first sample at or after the horizon. Later ones are worse answers
      // to the same question, so the search stops at the first hit.
      const hit = series.find((s) => s.ts >= target && s.ts <= limit && s.priceUsd > 0);
      if (hit) {
        resolved.push({
          obs: o,
          horizon: h.label,
          returnPct: (hit.priceUsd / o.priceUsd - 1) * 100,
          elapsedMs: hit.ts - o.ts,
        });
      } else if (now < limit) {
        // The window is still open; it may yet resolve.
        pending++;
      } else {
        expired++;
      }
    }
  }
  return { resolved, pending, expired };
}

// ------------------------------------------------------------------ buckets

export interface Bucket {
  label: string;
  min: number;
  max: number;
}

/**
 * Score bands.
 *
 * Fixed rather than quantile-derived on purpose: quantile buckets move as the
 * data arrives, so a token's band would change without its score changing, and
 * two runs of the report would not be comparable.
 */
export const BUCKETS: Bucket[] = [
  { label: "0-39", min: 0, max: 40 },
  { label: "40-54", min: 40, max: 55 },
  { label: "55-69", min: 55, max: 70 },
  { label: "70+", min: 70, max: 101 },
];

export function bucketOf(score: number): Bucket | undefined {
  return BUCKETS.find((b) => score >= b.min && score < b.max);
}

// ------------------------------------------------- seeded resampling helpers

/** mulberry32 — so two runs of the same report produce the same interval. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Percentile interval over CLUSTERS, not over rows.
 *
 * `groups` is one array per scan pass. A resample draws whole passes with
 * replacement, so the correlation inside a pass is preserved instead of being
 * averaged away — which is exactly what a row-wise bootstrap does, and why a
 * row-wise interval on this data would be far too narrow to mean anything.
 *
 * Returns null below `minGroups`: an interval computed from four passes is not
 * a wide interval, it is a meaningless one, and printing it invites exactly the
 * over-reading this whole module exists to prevent.
 */
export function clusterBootstrapCI(
  groups: readonly (readonly number[])[],
  statFn: (xs: number[]) => number,
  opts: { iterations?: number; alpha?: number; seed?: number; minGroups?: number } = {},
): [number, number] | null {
  const { iterations = 2000, alpha = 0.05, seed = 12345, minGroups = 8 } = opts;
  const usable = groups.filter((g) => g.length > 0);
  if (usable.length < minGroups) return null;

  const rand = seededRandom(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const pooled: number[] = [];
    for (let j = 0; j < usable.length; j++) {
      const g = usable[Math.floor(rand() * usable.length)];
      for (const v of g) pooled.push(v);
    }
    if (pooled.length > 0) stats.push(statFn(pooled));
  }
  if (stats.length === 0) return null;
  stats.sort((a, b) => a - b);
  const lo = stats[Math.floor((alpha / 2) * stats.length)];
  const hi = stats[Math.min(stats.length - 1, Math.floor((1 - alpha / 2) * stats.length))];
  return [lo, hi];
}

// -------------------------------------------------------------- the report

export interface BandResult {
  bucket: string;
  n: number;
  passes: number;
  meanReturnPct: number;
  medianReturnPct: number;
  /** Share of observations that finished above water, 0..1. */
  hitRate: number;
  /**
   * Mean return minus the all-tokens mean over the same horizon.
   *
   * This is the only number here worth acting on. A band can be up 6% in a week
   * where everything the scanner listed was up 7%, and calling that a good
   * score would be crediting the market to the model.
   */
  liftPct: number;
  /** 95% cluster-bootstrap interval on the lift, or null below eight passes. */
  liftCI: [number, number] | null;
}

export interface HorizonResult {
  horizon: string;
  n: number;
  passes: number;
  baselineMeanPct: number;
  bands: BandResult[];
  /** True when at least one band's lift interval excludes zero. */
  anyBandSeparates: boolean;
}

export interface TrackReport {
  observations: number;
  mints: number;
  passes: number;
  firstTs: number;
  lastTs: number;
  pending: number;
  expired: number;
  horizons: HorizonResult[];
  /** Plain-language state, for a UI that must not overstate a thin ledger. */
  verdict: string;
}

/**
 * Below this many resolved passes the report refuses to draw conclusions.
 *
 * Mirrors ROM Trader's MIN_EVENTS_TO_SIZE and exists for the same reason: a
 * threshold that the presentation layer respects but the statistics do not is
 * decoration. The verdict string is generated from the same number the bands
 * are, so the page cannot show an encouraging headline over eleven data points.
 */
export const MIN_PASSES = 20;

function groupByPass(rows: readonly Resolved[]): number[][] {
  const byPass = new Map<number, number[]>();
  for (const r of rows) {
    const arr = byPass.get(r.obs.ts);
    if (arr) arr.push(r.returnPct);
    else byPass.set(r.obs.ts, [r.returnPct]);
  }
  return [...byPass.values()];
}

export function trackReport(
  ledger: readonly Observation[],
  horizons: readonly Horizon[] = HORIZONS,
  now = Date.now(),
  seed = 12345,
): TrackReport {
  const { resolved, pending, expired } = resolveOutcomes(ledger, horizons, now);
  const passTimes = new Set(ledger.map((o) => o.ts));
  const times = ledger.map((o) => o.ts);

  const horizonResults: HorizonResult[] = horizons.map((h) => {
    const rows = resolved.filter((r) => r.horizon === h.label);
    const baseline = mean(rows.map((r) => r.returnPct));
    const basePasses = groupByPass(rows);

    const bands = BUCKETS.map((b) => {
      const inBand = rows.filter((r) => r.obs.score >= b.min && r.obs.score < b.max);
      const bandPasses = groupByPass(inBand);
      // The lift is resampled as a DIFFERENCE of two means drawn from the same
      // passes, not as two independent intervals compared by eye. Overlapping
      // intervals do not imply an insignificant difference, and the reverse
      // mistake is the more common one.
      const paired = bandPasses.map((g) => g.map((v) => v - baseline));
      return {
        bucket: b.label,
        n: inBand.length,
        passes: bandPasses.length,
        meanReturnPct: mean(inBand.map((r) => r.returnPct)),
        medianReturnPct: median(inBand.map((r) => r.returnPct)),
        hitRate: inBand.length === 0 ? 0 : inBand.filter((r) => r.returnPct > 0).length / inBand.length,
        liftPct: mean(inBand.map((r) => r.returnPct)) - baseline,
        liftCI: clusterBootstrapCI(paired, mean, { seed }),
      };
    });

    return {
      horizon: h.label,
      n: rows.length,
      passes: basePasses.length,
      baselineMeanPct: baseline,
      bands,
      anyBandSeparates: bands.some((b) => b.liftCI !== null && (b.liftCI[0] > 0 || b.liftCI[1] < 0)),
    };
  });

  const maxPasses = Math.max(0, ...horizonResults.map((h) => h.passes));
  let verdict: string;
  if (ledger.length === 0) {
    verdict =
      "Nothing recorded yet. The ledger fills as you scan — leave the scanner open and " +
      "come back.";
  } else if (maxPasses < MIN_PASSES) {
    verdict =
      `${maxPasses} of ${MIN_PASSES} scan passes have resolved. Too few to say anything ` +
      `about whether the score predicts returns, and no interval below is worth reading yet.`;
  } else if (horizonResults.some((h) => h.anyBandSeparates)) {
    verdict =
      "At least one score band's return separates from the all-token baseline by more than " +
      "resampling noise. That is a measured edge over this sample and this period — not a " +
      "guarantee, and not evidence it will hold.";
  } else {
    verdict =
      `Across ${maxPasses} scan passes, no score band beats the average of everything the ` +
      `scanner listed by more than noise. The honest reading is that the score ranks tokens ` +
      `by evidence, not by future return.`;
  }

  return {
    observations: ledger.length,
    mints: new Set(ledger.map((o) => o.mint)).size,
    passes: passTimes.size,
    firstTs: times.length ? Math.min(...times) : 0,
    lastTs: times.length ? Math.max(...times) : 0,
    pending,
    expired,
    horizons: horizonResults,
    verdict,
  };
}
