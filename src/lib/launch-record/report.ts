// What the launch feed's verdicts turned out to be worth.
//
// The feed triages every new mint into AVOID, CAUTION or UNVERIFIED and — until
// this file — nothing ever checked whether those words predicted anything. A
// verdict that lands in 130ms is only worth having if UNVERIFIED mints go on
// to graduate more often than AVOID mints, or survive longer, or return more.
// This is the forward test for the launch feed, the same discipline the track
// record applies to the scanner's score: every launch seen is written down
// with its verdict, and the same mint is looked up again an hour and a day
// later to see what became of it.
//
// THREE OUTCOMES, BECAUSE A MEMECOIN HAS THREE FATES
//
//   graduated   the bonding curve completed into a real pool inside 24h
//   alive       still listed with real liquidity at the horizon
//   return      price at the horizon against the first price seen — only for
//               rows that HAD a price within two minutes of first sight, which
//               on a launchpad mint is not most of them
//
// Graduation and survival are the honest headline; most launches never have a
// price a second source will quote, and a return statistic over the ones that
// did would be a statistic over the survivors.
//
// THE FLOOR
//
// A rate is printed only over thirty resolved launches in a bucket. Below
// that the row says how many of thirty it has. Nothing here resamples
// intervals the way the track record does: launches are closer to independent
// events than twelve tokens in one scan pass are, but a bull hour still lifts
// every curve, so the comparison that matters is between buckets over the
// same period, and the page says so.

import type { LaunchVerdict } from "../types";

export type LaunchHorizonLabel = "1h" | "24h";

export interface LaunchHorizon {
  label: LaunchHorizonLabel;
  ms: number;
}

export const LAUNCH_HORIZONS: LaunchHorizon[] = [
  { label: "1h", ms: 3_600_000 },
  { label: "24h", ms: 24 * 3_600_000 },
];

/** Same rule as the track record: a closed laptop expires a horizon, it never stretches one. */
export function launchToleranceFor(h: LaunchHorizon): number {
  return Math.max(h.ms, 30 * 60_000);
}

/** Resolved launches in a bucket before a rate is printed. */
export const LAUNCH_MIN_RESOLVED = 30;

/** Liquidity at the horizon below which a listed mint is counted as dead. */
export const ALIVE_LIQUIDITY_USD = 1_000;

/** A first price counts as "at first sight" only inside this window. */
export const PRICE_AT_SEEN_MS = 2 * 60_000;

export interface LaunchOutcome {
  horizon: LaunchHorizonLabel;
  /** When the lookup ran — this machine's clock. */
  at: number;
  /** Whether the source still listed the mint at all. */
  listed: boolean;
  priceUsd?: number;
  liquidityUsd?: number;
  graduatedAt?: number;
}

export interface LaunchRecordObs {
  mint: string;
  symbol: string;
  /** When the feed first laid eyes on it — receipt time, local clock. */
  seenAt: number;
  launchpad?: string;
  event: "pool" | "graduation";
  source: string;
  verdict: LaunchVerdict;
  /**
   * Whether the verdict is the settled one. Triage runs again as the risk read
   * lands, so the verdict at first sight and the verdict ninety seconds later
   * can differ; the settled one is what a reader acted on.
   */
  settled: boolean;
  verdictAt: number;
  measured: number;
  readings: number;
  riskScore?: number;
  devMints?: number;
  devMigrations?: number;
  /** First price seen inside PRICE_AT_SEEN_MS of first sight, and when. */
  priceUsd?: number;
  priceAt?: number;
  liquidityUsd?: number;
  bondingCurvePct?: number;
  /** From the feed itself when it saw the graduation, or from a later lookup. */
  graduatedAt?: number;
  outcomes: LaunchOutcome[];
  expired: LaunchHorizonLabel[];
}

export interface LaunchBucketStat {
  bucket: string;
  /** Launches seen in this bucket. */
  n: number;
  resolved1h: number;
  resolved24h: number;
  /** Of resolved24h: still listed with liquidity ≥ ALIVE_LIQUIDITY_USD. */
  alive24h: number;
  /** Of resolved24h: graduated within 24h of first sight. */
  graduated24h: number;
  /** Rows with a price at first sight AND at the horizon. */
  priced1h: number;
  priced24h: number;
  medianReturn1h?: number;
  medianReturn24h?: number;
  aboveWater24h?: number;
  /** Rates are printed only past the floor. */
  enough24h: boolean;
}

export interface LaunchReport {
  total: number;
  settled: number;
  pending: number;
  expired: number;
  firstTs: number;
  lastTs: number;
  byVerdict: LaunchBucketStat[];
  byDeployer: LaunchBucketStat[];
  byLaunchpad: LaunchBucketStat[];
  verdict: string;
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function deployerBucket(devMints: number | undefined): string {
  if (devMints === undefined) return "deployer history unknown";
  if (devMints <= 1) return "first mint";
  if (devMints < 50) return "repeat deployer (2–49)";
  return "serial deployer (50+)";
}

/** Did this launch graduate inside a day of first sight, by anyone's account? */
export function graduatedWithin24h(o: LaunchRecordObs): boolean {
  const at = o.graduatedAt ?? o.outcomes.find((x) => x.graduatedAt !== undefined)?.graduatedAt;
  return at !== undefined && at - o.seenAt <= LAUNCH_HORIZONS[1].ms + launchToleranceFor(LAUNCH_HORIZONS[1]);
}

function bucketStat(bucket: string, rows: LaunchRecordObs[]): LaunchBucketStat {
  const out: LaunchBucketStat = {
    bucket,
    n: rows.length,
    resolved1h: 0,
    resolved24h: 0,
    alive24h: 0,
    graduated24h: 0,
    priced1h: 0,
    priced24h: 0,
    enough24h: false,
  };
  const r1: number[] = [];
  const r24: number[] = [];
  for (const o of rows) {
    const o1 = o.outcomes.find((x) => x.horizon === "1h");
    const o24 = o.outcomes.find((x) => x.horizon === "24h");
    if (o1) {
      out.resolved1h++;
      if (o.priceUsd && o1.priceUsd && o.priceUsd > 0 && o1.priceUsd > 0) {
        out.priced1h++;
        r1.push((o1.priceUsd / o.priceUsd - 1) * 100);
      }
    }
    if (o24) {
      out.resolved24h++;
      if (o24.listed && (o24.liquidityUsd ?? 0) >= ALIVE_LIQUIDITY_USD) out.alive24h++;
      if (graduatedWithin24h(o)) out.graduated24h++;
      if (o.priceUsd && o24.priceUsd && o.priceUsd > 0 && o24.priceUsd > 0) {
        out.priced24h++;
        r24.push((o24.priceUsd / o.priceUsd - 1) * 100);
      }
    }
  }
  out.medianReturn1h = median(r1);
  out.medianReturn24h = median(r24);
  out.aboveWater24h = r24.length > 0 ? r24.filter((x) => x > 0).length / r24.length : undefined;
  out.enough24h = out.resolved24h >= LAUNCH_MIN_RESOLVED;
  return out;
}

function group(rows: readonly LaunchRecordObs[], key: (o: LaunchRecordObs) => string, order?: string[]): LaunchBucketStat[] {
  const map = new Map<string, LaunchRecordObs[]>();
  for (const o of rows) {
    const k = key(o);
    const arr = map.get(k);
    if (arr) arr.push(o);
    else map.set(k, [o]);
  }
  const keys = order ? [...order.filter((k) => map.has(k)), ...[...map.keys()].filter((k) => !order.includes(k))] : [...map.keys()].sort();
  return keys.map((k) => bucketStat(k, map.get(k) ?? []));
}

const pctStr = (x: number) => `${Math.round(x * 100)}%`;

export function launchReport(obs: readonly LaunchRecordObs[], now = Date.now()): LaunchReport {
  let pending = 0;
  let expired = 0;
  for (const o of obs) {
    for (const h of LAUNCH_HORIZONS) {
      if (o.outcomes.some((x) => x.horizon === h.label)) continue;
      if (o.expired.includes(h.label)) {
        expired++;
        continue;
      }
      if (now < o.seenAt + h.ms + launchToleranceFor(h)) pending++;
      else expired++;
    }
  }
  const byVerdict = group(obs, (o) => o.verdict, ["unverified", "caution", "avoid"]);
  const byDeployer = group(obs, (o) => deployerBucket(o.devMints), [
    "first mint",
    "repeat deployer (2–49)",
    "serial deployer (50+)",
    "deployer history unknown",
  ]);
  const byLaunchpad = group(obs, (o) => o.launchpad ?? o.event);

  const ready = byVerdict.filter((b) => b.enough24h);
  let verdict: string;
  if (obs.length === 0) {
    verdict = "Nothing recorded yet. Open the launch feed and every mint it sees is written down with its verdict.";
  } else if (ready.length === 0) {
    const most = byVerdict.reduce((a, b) => (b.resolved24h > a.resolved24h ? b : a), byVerdict[0]);
    verdict =
      `Too early. ${obs.length.toLocaleString()} launches recorded; the fullest verdict bucket (${most.bucket.toUpperCase()}) ` +
      `has ${most.resolved24h} of the ${LAUNCH_MIN_RESOLVED} resolved at 24h that a rate needs. Rates print per bucket as each crosses the floor.`;
  } else {
    const parts = ready.map(
      (b) =>
        `${b.bucket.toUpperCase()}: ${pctStr(b.graduated24h / b.resolved24h)} graduated and ${pctStr(b.alive24h / b.resolved24h)} still had ` +
        `$${ALIVE_LIQUIDITY_USD.toLocaleString()}+ of liquidity a day later (n=${b.resolved24h})`,
    );
    verdict =
      `Over the same period, ${parts.join("; ")}. ` +
      (ready.length < 2
        ? "One bucket has cleared the floor — a comparison needs two."
        : "Whether the gap is the verdict or the market is the question this page keeps re-asking as it fills.");
  }

  const ts = obs.map((o) => o.seenAt);
  return {
    total: obs.length,
    settled: obs.filter((o) => o.settled).length,
    pending,
    expired,
    firstTs: ts.length ? Math.min(...ts) : 0,
    lastTs: ts.length ? Math.max(...ts) : 0,
    byVerdict,
    byDeployer,
    byLaunchpad,
    verdict,
  };
}
