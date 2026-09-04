// The wallet ledger: positions, realized PNL, and the 0–100 score.
//
// Same honesty rule as the app's in-browser reputation engine: only what this
// worker OBSERVED counts. A wallet that sells tokens it bought before the
// stream was watching has no measured cost basis for those tokens — that sell
// is recorded in the journal but EXCLUDED from PNL and win rate, and counted
// in `unmeasuredSells` so the number's edge is visible. Guessing a basis
// would manufacture a win rate, which is the one thing this project refuses
// to do.
//
// Cost model: average cost. FIFO would need per-lot bookkeeping for wallets
// the worker follows by the hundred; average cost gives the same realized
// total over a closed position and keeps state to four numbers per position.
//
// Two ledgers beyond PNL, both for the reader who wants to COPY a wallet
// rather than admire it: how long it holds (a sniper flipping in forty
// seconds has a record nobody can follow), and what its signals were worth
// five minutes later to someone who bought on the alert — the follower
// return, graded by state.js from the same stream and folded in here.

import { classifyWallet } from "./behaviour.js";
import { clamp, medianOf } from "./util.js";

/**
 * @typedef {object} Position
 * @property {number} boughtSol   observed SOL spent on this mint
 * @property {number} boughtTok   observed tokens acquired
 * @property {number} heldTok     tokens still held OF THE OBSERVED buys
 * @property {number} firstBuyTs  chain time of the buy that opened this round trip
 *
 * @typedef {object} WalletStats
 * @property {number} firstSeen        ms epoch
 * @property {number} lastActive       ms epoch
 * @property {number} totalTrades     every journaled fill, buys and sells
 * @property {number} settledSells    sells with a fully-observed cost basis
 * @property {number} unmeasuredSells sells skipped for missing basis
 * @property {number} wins            settled sells with realized > 0
 * @property {number} realizedSol     Σ realized PNL over settled sells, in SOL
 * @property {number} grossProfitSol
 * @property {number} grossLossSol    positive number
 * @property {number} roiSum          Σ (realized / basis) over settled sells
 * @property {number[]} holds         last HOLD_RING settled hold durations, ms
 * @property {number[]} followRets    last FOLLOW_RING graded 5-minute follower returns
 * @property {number} signalsGraded   every 5-minute grade ever folded in
 * @property {number[]} rets          last RET_RING per-settled-sell ROIs, for consistency
 * @property {number} peakRealizedSol high-water mark of realized PNL
 * @property {number} maxDrawdownSol  deepest fall from that mark, positive number
 * @property {RecentFill[]} recent    last RECENT_RING fills, for behaviour reads
 * @property {number} lastFillTs      chain time of the last fill, 0 before any
 * @property {Map<string, Position>} positions by mint
 *
 * @typedef {object} RecentFill
 * @property {string} mint
 * @property {boolean} isBuy
 * @property {number} sol
 * @property {number} tokens
 * @property {number} ts
 */

/** Samples kept per wallet for the medians. Small on purpose: a wallet changes. */
export const HOLD_RING = 30;
export const FOLLOW_RING = 30;
export const RET_RING = 100;
/** Fills kept for the behaviour reads — a busy bot's last hour, a human's last week. */
export const RECENT_RING = 60;
/** Settled sells before a consistency figure is shown at all. */
export const MIN_CONSISTENCY_SELLS = 5;

/** @returns {WalletStats} */
export function newWallet(now) {
  return {
    firstSeen: now,
    lastActive: now,
    totalTrades: 0,
    settledSells: 0,
    unmeasuredSells: 0,
    wins: 0,
    realizedSol: 0,
    grossProfitSol: 0,
    grossLossSol: 0,
    roiSum: 0,
    holds: [],
    followRets: [],
    signalsGraded: 0,
    rets: [],
    peakRealizedSol: 0,
    maxDrawdownSol: 0,
    recent: [],
    lastFillTs: 0,
    positions: new Map(),
  };
}

/** Positions a wallet may hold at once before the flattest is dropped. */
export const MAX_POSITIONS = 300;

/** @param {number[]} ring @param {number} v @param {number} cap */
function pushRing(ring, v, cap) {
  ring.push(v);
  if (ring.length > cap) ring.shift();
}

/**
 * Fold one observed fill into a wallet's stats.
 *
 * @param {WalletStats} w
 * @param {{ mint: string, isBuy: boolean, sol: number, tokens: number, ts: number }} fill
 * @returns {{ realized: number | null, settled: boolean }} realized SOL for a
 *   settled sell; null for buys and for sells without measured basis.
 */
export function applyFill(w, fill) {
  w.totalTrades++;
  w.lastActive = fill.ts;
  w.lastFillTs = fill.ts;
  w.recent.push({ mint: fill.mint, isBuy: fill.isBuy, sol: fill.sol, tokens: fill.tokens, ts: fill.ts });
  if (w.recent.length > RECENT_RING) w.recent.shift();
  let pos = w.positions.get(fill.mint);

  if (fill.isBuy) {
    if (!pos) {
      pos = { boughtSol: 0, boughtTok: 0, heldTok: 0, firstBuyTs: fill.ts };
      w.positions.set(fill.mint, pos);
      if (w.positions.size > MAX_POSITIONS) evictFlattest(w);
    } else if (pos.heldTok <= 0) {
      // A flat position buying again is a new round trip; its hold clock
      // starts now, not at a buy the wallet already exited.
      pos.firstBuyTs = fill.ts;
    }
    pos.boughtSol += fill.sol;
    pos.boughtTok += fill.tokens;
    pos.heldTok += fill.tokens;
    return { realized: null, settled: false };
  }

  // Sell. Basis exists only for tokens the stream saw being bought.
  const measurable = pos ? Math.min(fill.tokens, pos.heldTok) : 0;
  if (!pos || pos.boughtTok <= 0 || measurable < fill.tokens * 0.999) {
    // Partially-covered sells are treated as unmeasured whole: splitting one
    // sell into a measured half and a guessed half would let the guessed half
    // hide inside a real number.
    w.unmeasuredSells++;
    if (pos) pos.heldTok = Math.max(0, pos.heldTok - fill.tokens);
    return { realized: null, settled: false };
  }

  const avgCost = pos.boughtSol / pos.boughtTok;
  const basis = avgCost * fill.tokens;
  const realized = fill.sol - basis;
  pos.heldTok -= fill.tokens;

  w.settledSells++;
  w.realizedSol += realized;
  const roi = basis > 0 ? realized / basis : 0;
  w.roiSum += roi;
  pushRing(w.rets, roi, RET_RING);
  if (realized > 0) {
    w.wins++;
    w.grossProfitSol += realized;
  } else {
    w.grossLossSol += -realized;
  }
  // Drawdown on the realized curve: how far the running total fell from its
  // best, the figure a copier feels in the stomach before the win rate.
  if (w.realizedSol > w.peakRealizedSol) w.peakRealizedSol = w.realizedSol;
  const dd = w.peakRealizedSol - w.realizedSol;
  if (dd > w.maxDrawdownSol) w.maxDrawdownSol = dd;
  // Hold time is measured on settled sells only — the same fills the score
  // trusts — from the buy that opened the round trip.
  if (Number.isFinite(pos.firstBuyTs)) pushRing(w.holds, Math.max(0, fill.ts - pos.firstBuyTs), HOLD_RING);
  return { realized, settled: true };
}

/**
 * Fold one graded follower return in: what a buyer at the signal's fill
 * price was sitting on five minutes later. Called by state.js when the
 * horizon resolves, and by the drivers when they replay journaled grades.
 *
 * @param {WalletStats} w
 * @param {number} ret  fraction, e.g. 0.34 for +34%
 */
export function applyFollowGrade(w, ret) {
  if (!Number.isFinite(ret)) return;
  pushRing(w.followRets, ret, FOLLOW_RING);
  w.signalsGraded++;
}

/** @param {WalletStats} w */
function evictFlattest(w) {
  let flattest = null;
  let flattestHeld = Infinity;
  for (const [mint, p] of w.positions) {
    if (p.heldTok < flattestHeld) {
      flattest = mint;
      flattestHeld = p.heldTok;
    }
  }
  if (flattest !== null) w.positions.delete(flattest);
}

/**
 * Number of settled sells at which the score stops being discounted for
 * sample size. Below it the score shrinks linearly toward zero, so a wallet
 * with two lucky exits cannot cross a 70 gate no matter how green they were.
 */
export const FULL_CONFIDENCE_SELLS = 6;

/** @param {WalletStats} w @returns {number} win rate in [0,1], 0 when nothing settled */
export function winRateOf(w) {
  return w.settledSells > 0 ? w.wins / w.settledSells : 0;
}

/** @param {WalletStats} w @returns {number} profit factor; capped at 99 for the all-wins case */
export function profitFactorOf(w) {
  if (w.grossProfitSol <= 0) return 0;
  if (w.grossLossSol <= 0) return 99;
  return w.grossProfitSol / w.grossLossSol;
}

/** @param {WalletStats} w @returns {number} mean ROI per settled sell, 0 when nothing settled */
export function avgRoiOf(w) {
  return w.settledSells > 0 ? w.roiSum / w.settledSells : 0;
}

export { medianOf };

/** @param {WalletStats} w @returns {number | null} median settled hold, ms; null until one settles */
export function medianHoldMs(w) {
  return medianOf(w.holds);
}

/** @param {WalletStats} w @returns {number | null} mean settled hold, ms */
export function avgHoldMs(w) {
  if (w.holds.length === 0) return null;
  return w.holds.reduce((a, b) => a + b, 0) / w.holds.length;
}

/**
 * Consistency: mean per-trade ROI over its standard deviation — the shape
 * of a Sharpe ratio applied to settled sells, NOT annualized and not
 * risk-free-adjusted, which is why the row calls it consistency. Null
 * until MIN_CONSISTENCY_SELLS have settled; a wallet whose every trade
 * returned exactly the same thing has no spread and reads as null too.
 *
 * @param {WalletStats} w
 * @returns {{ mean: number, sd: number, ratio: number | null } | null}
 */
export function consistencyOf(w) {
  const n = w.rets.length;
  if (n < MIN_CONSISTENCY_SELLS) return null;
  const mean = w.rets.reduce((a, b) => a + b, 0) / n;
  const variance = w.rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return { mean, sd, ratio: sd > 0 ? mean / sd : null };
}

/**
 * What following this wallet's signals has paid, five minutes after each.
 * The hit rate counts grades at or above +10% — a buyer who paid the
 * bonding curve's round trip in fees needs about that much to be green.
 *
 * @param {WalletStats} w
 * @returns {{ median: number | null, hitRate: number | null, graded: number }}
 */
export function followStats(w) {
  const n = w.followRets.length;
  if (n === 0) return { median: null, hitRate: null, graded: w.signalsGraded };
  const hits = w.followRets.filter((r) => r >= FOLLOW_HIT_RET).length;
  return { median: medianOf(w.followRets), hitRate: hits / n, graded: w.signalsGraded };
}

/** A follower grade at or above this counts as a hit. */
export const FOLLOW_HIT_RET = 0.1;

/**
 * The 0–100 score — the same family as the app's reputation formula, so a
 * number on the Radar means what a number on the wallet ledger means:
 * half for win rate above coin-flip-with-fees (35%→75% maps 0→50), half for
 * profit factor on a log scale (PF 4 = full marks), the whole thing shrunk
 * by sample size until FULL_CONFIDENCE_SELLS sells have settled.
 *
 * @param {WalletStats} w
 * @returns {number} integer 0–100
 */
export function scoreOf(w) {
  if (w.settledSells === 0) return 0;
  const wr = winRateOf(w);
  const pf = profitFactorOf(w);
  const base = 50 * clamp((wr - 0.35) / 0.4, 0, 1) + 50 * clamp(Math.log2(Math.max(pf, 0.01)) / 2, 0, 1);
  return Math.round(base * clamp(w.settledSells / FULL_CONFIDENCE_SELLS, 0, 1));
}

/**
 * The row shape written to tracked_wallets and pushed over the socket.
 * @param {string} address
 * @param {WalletStats} w
 * @param {{ isDev?: boolean }} [ctx] what the state knows that the ledger does not
 */
export function walletRow(address, w, ctx = {}) {
  const follow = followStats(w);
  const hold = medianHoldMs(w);
  const avgHold = avgHoldMs(w);
  const consistency = consistencyOf(w);
  return {
    labels: classifyWallet(w, ctx),
    consistency: consistency?.ratio == null ? null : Number(consistency.ratio.toFixed(3)),
    max_drawdown_sol: Number(w.maxDrawdownSol.toFixed(6)),
    avg_hold_ms: avgHold === null ? null : Math.round(avgHold),
    wallet_address: address,
    score: scoreOf(w),
    win_rate: Number(winRateOf(w).toFixed(4)),
    total_trades: w.totalTrades,
    realized_pnl: Number(w.realizedSol.toFixed(6)),
    avg_roi: Number(avgRoiOf(w).toFixed(4)),
    settled_sells: w.settledSells,
    unmeasured_sells: w.unmeasuredSells,
    // The copyability fields: null until measured, never a flattering zero.
    median_hold_ms: hold === null ? null : Math.round(hold),
    follow_ret_5m: follow.median === null ? null : Number(follow.median.toFixed(4)),
    follow_hit_rate: follow.hitRate === null ? null : Number(follow.hitRate.toFixed(4)),
    signals_graded: follow.graded,
    first_seen: new Date(w.firstSeen).toISOString(),
    last_active: new Date(w.lastActive).toISOString(),
  };
}
