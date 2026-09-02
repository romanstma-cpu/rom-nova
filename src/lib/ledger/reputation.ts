// What a wallet's recorded fills add up to, and whether they add up to anything.
//
// The chain reader sees ~2 days of a wallet at a time. The ledger keeps every
// fill it has ever seen for a recorded wallet, so after three weeks the
// question "is this wallet any good" has three weeks of evidence behind it
// instead of two days. This file turns that evidence into a verdict, and
// refuses to when there is not enough of it.
//
// THE REFUSAL IS THE FEATURE
//
// Ten closed round trips over a week is the floor, not a sample size — below
// it the win rate of a coin flip is indistinguishable from skill, and a score
// printed off four trades would be the most dangerous number on the page. So
// `verdict` is "insufficient" until both thresholds clear, and the panel says
// what is still missing rather than showing a provisional grade that a reader
// would remember and the caveat they would not.
//
// The score is a FILTER, not a prediction: it says this wallet's recorded
// trades, replayed FIFO, closed more winners than losers and made more on the
// winners than it lost on the losers. Nothing here knows whether that
// continues. The track record page grades the app's own calls the same way
// and is allowed to conclude "no edge"; so is this.

import type { WalletFill } from "../types";
import { replayFills } from "../engine/wallet-profile";

/** A span of time a wallet was actually observed over — a read's window. */
export interface Interval {
  from: number;
  to: number;
}

/** Closed round trips before a reputation is called measured. */
export const MIN_ROUND_TRIPS = 10;
/** Days of OBSERVED history (not span — gaps do not count) before measured. */
export const MIN_OBSERVED_DAYS = 7;
/** Score at or above which a measured wallet counts as smart money. */
export const SMART_SCORE = 60;

const DAY = 86_400_000;
/** Two read windows closer than this are one window; the endpoint's clock jitters. */
const MERGE_SLACK_MS = 60_000;

/** The classifications that are trades. Transfers, LP moves and rotations carry no P&L. */
const TRADE_CLASSES = new Set(["open", "add", "reduce", "exit"]);

export interface WalletReputation {
  address: string;
  verdict: "measured" | "insufficient";
  /** When insufficient: each threshold not yet met, in words. */
  needs: string[];
  /** First observed moment to last, in days. Includes gaps. */
  spanDays: number;
  /** Days actually covered by reads. What the verdict is over. */
  observedDays: number;
  gaps: { count: number; days: number };
  fills: {
    total: number;
    /** Trades (open/add/reduce/exit) with a price — the only fills that book P&L. */
    priced: number;
    /** Trades without an observable price. Move tokens, book nothing. */
    unpriced: number;
    /** Transfers, LP deposits and withdrawals, rotations, unknowns. Excluded. */
    nonTrade: number;
  };
  roundTrips: number;
  wins: number;
  losses: number;
  winRate?: number;
  /** Closed round trips plus partial exits — every priced sell against its FIFO cost. */
  realizedPnlUsd: number;
  /** Gross profit on winning round trips over gross loss on losing ones. */
  profitFactor?: number;
  medianHoldHours?: number;
  medianRoundTripUsd?: number;
  distinctMints: number;
  /** Sells that found no observed buy — excluded from P&L rather than booked as pure profit. */
  unmatchedSellMints: number;
  /** 0–100, only when measured. */
  score?: number;
  grade?: "A" | "B" | "C" | "D";
  /** Measured, score ≥ SMART_SCORE, and net positive. What the token scorer reads. */
  smart: boolean;
}

/** Merge overlapping and near-adjacent windows; returns them sorted. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list
    .filter((i) => i.to >= i.from && i.from > 0)
    .map((i) => ({ from: i.from, to: i.to }))
    .sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.from <= last.to + MERGE_SLACK_MS) {
      if (i.to > last.to) last.to = i.to;
    } else {
      out.push(i);
    }
  }
  return out;
}

/** Days covered, days spanned, and the holes between — from merged windows. */
export function coverageOf(covered: readonly Interval[]): { spanDays: number; observedDays: number; gaps: { count: number; days: number } } {
  const merged = mergeIntervals(covered);
  if (merged.length === 0) return { spanDays: 0, observedDays: 0, gaps: { count: 0, days: 0 } };
  const observed = merged.reduce((s, i) => s + (i.to - i.from), 0);
  const span = merged[merged.length - 1].to - merged[0].from;
  let gapMs = 0;
  for (let k = 1; k < merged.length; k++) gapMs += merged[k].from - merged[k - 1].to;
  return {
    spanDays: span / DAY,
    observedDays: observed / DAY,
    gaps: { count: merged.length - 1, days: gapMs / DAY },
  };
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The score, in the open so it can be argued with.
 *
 * Half from win rate, scaled so 35% scores nothing and 75% scores full; half
 * from profit factor on a log scale so 1× (break-even) scores nothing, 2×
 * scores half and 4× scores full. A wallet that wins 80% of the time but
 * gives it all back on the losers lands in the middle, which is where it
 * belongs.
 */
export function scoreOf(winRate: number, profitFactor: number): number {
  const w = clamp01((winRate - 0.35) / 0.4);
  const pf = clamp01(Math.log2(Math.max(profitFactor, 1e-9)) / 2);
  return Math.round(50 * w + 50 * pf);
}

export function gradeOf(score: number): "A" | "B" | "C" | "D" {
  return score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
}

/**
 * Reputation from everything recorded for one wallet.
 *
 * `fills` is the ledger's accumulated set — deduplicated by signature, any
 * order — and `covered` the read windows it was gathered over. Only priced
 * trades enter the replay; the rest are counted so the panel can say how much
 * of what the wallet did was outside what could be judged.
 */
export function reputationFrom(address: string, fills: readonly WalletFill[], covered: readonly Interval[]): WalletReputation {
  const cov = coverageOf(covered);
  let nonTrade = 0;
  let unpriced = 0;
  const trades: WalletFill[] = [];
  for (const f of fills) {
    if (!TRADE_CLASSES.has(f.classification)) {
      nonTrade++;
      continue;
    }
    if (f.priceUsd === undefined || !(f.priceUsd > 0)) {
      unpriced++;
      continue;
    }
    trades.push(f);
  }

  const replay = replayFills(address, trades);
  const trips = replay.ledger.roundTrips;
  const wins = trips.filter((t) => t.pnlUsd > 0).length;
  const losses = trips.filter((t) => t.pnlUsd < 0).length;
  const grossWin = trips.reduce((s, t) => s + Math.max(0, t.pnlUsd), 0);
  const grossLoss = trips.reduce((s, t) => s + Math.max(0, -t.pnlUsd), 0);
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : undefined;
  // Infinity is a legitimate profit factor for a wallet with no losing trip
  // yet; the score clamps it. It is not rendered as a number.
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : undefined;
  const realizedPnlUsd = replay.ledger.realizedPnlUsd;

  const needs: string[] = [];
  if (trips.length < MIN_ROUND_TRIPS) {
    needs.push(`${MIN_ROUND_TRIPS - trips.length} more closed round trip${MIN_ROUND_TRIPS - trips.length === 1 ? "" : "s"} (${trips.length} of ${MIN_ROUND_TRIPS})`);
  }
  if (cov.observedDays < MIN_OBSERVED_DAYS) {
    needs.push(`${(MIN_OBSERVED_DAYS - cov.observedDays).toFixed(1)} more observed days (${cov.observedDays.toFixed(1)} of ${MIN_OBSERVED_DAYS})`);
  }
  const measured = needs.length === 0 && winRate !== undefined && profitFactor !== undefined;

  const score = measured ? scoreOf(winRate as number, profitFactor as number) : undefined;
  return {
    address,
    verdict: measured ? "measured" : "insufficient",
    needs,
    spanDays: cov.spanDays,
    observedDays: cov.observedDays,
    gaps: cov.gaps,
    fills: { total: fills.length, priced: trades.length, unpriced, nonTrade },
    roundTrips: trips.length,
    wins,
    losses,
    winRate,
    realizedPnlUsd,
    profitFactor,
    medianHoldHours: median(trips.map((t) => t.holdHours)),
    medianRoundTripUsd: median(trips.map((t) => t.costUsd)),
    distinctMints: new Set(trades.map((t) => t.mint)).size,
    unmatchedSellMints: replay.unmatched.size,
    score,
    grade: score !== undefined ? gradeOf(score) : undefined,
    smart: measured && (score as number) >= SMART_SCORE && realizedPnlUsd > 0,
  };
}
