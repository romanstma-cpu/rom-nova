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

import { clamp } from "./util.js";

/**
 * @typedef {object} Position
 * @property {number} boughtSol   observed SOL spent on this mint
 * @property {number} boughtTok   observed tokens acquired
 * @property {number} heldTok     tokens still held OF THE OBSERVED buys
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
 * @property {Map<string, Position>} positions by mint
 */

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
    positions: new Map(),
  };
}

/** Positions a wallet may hold at once before the flattest is dropped. */
export const MAX_POSITIONS = 300;

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
  let pos = w.positions.get(fill.mint);

  if (fill.isBuy) {
    if (!pos) {
      pos = { boughtSol: 0, boughtTok: 0, heldTok: 0 };
      w.positions.set(fill.mint, pos);
      if (w.positions.size > MAX_POSITIONS) evictFlattest(w);
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
  w.roiSum += basis > 0 ? realized / basis : 0;
  if (realized > 0) {
    w.wins++;
    w.grossProfitSol += realized;
  } else {
    w.grossLossSol += -realized;
  }
  return { realized, settled: true };
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
 */
export function walletRow(address, w) {
  return {
    wallet_address: address,
    score: scoreOf(w),
    win_rate: Number(winRateOf(w).toFixed(4)),
    total_trades: w.totalTrades,
    realized_pnl: Number(w.realizedSol.toFixed(6)),
    avg_roi: Number(avgRoiOf(w).toFixed(4)),
    settled_sells: w.settledSells,
    unmeasured_sells: w.unmeasuredSells,
    first_seen: new Date(w.firstSeen).toISOString(),
    last_active: new Date(w.lastActive).toISOString(),
  };
}
