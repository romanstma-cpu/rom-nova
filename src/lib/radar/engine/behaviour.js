// What a wallet IS, read from what it DID — and the moments worth an alert.
//
// Labels here are earned from measured fills, never assigned from a
// vendor's list: a sniper is a wallet whose settled round trips close in
// under a minute, a holder one whose trips run past a day, a dev one that
// created a token the radar saw born. Each rule names its threshold, and a
// wallet with too little history for a rule simply does not get the label.
//
// The behaviour reads fire ONCE at a threshold — the third buy of a mint
// with no sell, the fourth alternating leg inside ten minutes — so a bot
// making its two-hundredth wash trade does not make two hundred alerts.

import { medianOf } from "./util.js";

/** Median settled hold under this: a sniper — out before a person is in. */
export const SNIPER_HOLD_MS = 60_000;
/** Under this: a flipper. */
export const FLIPPER_HOLD_MS = 30 * 60_000;
/** Over this: a holder. */
export const HOLDER_HOLD_MS = 24 * 3_600_000;
/** Settled sells before any hold label is earned. */
export const MIN_LABEL_SELLS = 3;
/** Quiet this long, then a buy this big: a dormant wallet waking up. */
export const DORMANT_MS = 7 * 86_400_000;
export const DORMANT_MIN_SOL = 5;
/** Buys of one mint with no sell of it in the recent ring: accumulation. */
export const ACCUM_MIN_BUYS = 3;
/** Sells of one mint with no buy of it in the recent ring: distribution. */
export const DIST_MIN_SELLS = 3;
/** Alternating buy/sell legs on one mint inside the window, ending flat: wash-like. */
export const WASH_MIN_LEGS = 4;
export const WASH_WINDOW_MS = 10 * 60_000;
/** Net tokens under this share of gross traded counts as flat. */
export const WASH_FLAT_SHARE = 0.1;

/**
 * @typedef {import("./score.js").WalletStats} WalletStats
 * @typedef {import("./score.js").RecentFill} RecentFill
 */

/** @param {RecentFill[]} recent @param {string} mint */
function ofMint(recent, mint) {
  return recent.filter((f) => f.mint === mint);
}

/**
 * The alternating buy/sell legs on a mint inside the window, and whether
 * they netted out flat.
 * @param {RecentFill[]} fills fills of ONE mint, oldest first
 * @param {number} now
 */
function washRead(fills, now) {
  const inWindow = fills.filter((f) => now - f.ts <= WASH_WINDOW_MS);
  let legs = 0;
  let last = null;
  let net = 0;
  let gross = 0;
  for (const f of inWindow) {
    if (last === null || f.isBuy !== last) legs++;
    last = f.isBuy;
    net += f.isBuy ? f.tokens : -f.tokens;
    gross += f.tokens;
  }
  return { legs, flat: gross > 0 && Math.abs(net) <= gross * WASH_FLAT_SHARE };
}

/**
 * The labels a wallet has earned.
 *
 * @param {WalletStats} w
 * @param {{ isDev?: boolean }} [ctx]
 * @returns {string[]}
 */
export function classifyWallet(w, ctx = {}) {
  const labels = [];
  if (ctx.isDev) labels.push("dev");
  const hold = medianOf(w.holds);
  if (hold !== null && w.settledSells >= MIN_LABEL_SELLS) {
    if (hold < SNIPER_HOLD_MS) labels.push("sniper");
    else if (hold < FLIPPER_HOLD_MS) labels.push("flipper");
    else if (hold >= HOLDER_HOLD_MS) labels.push("holder");
  }
  const mints = new Set(w.recent.map((f) => f.mint));
  let accumulating = false;
  let washing = false;
  const now = w.lastFillTs;
  for (const mint of mints) {
    const fills = ofMint(w.recent, mint);
    const buys = fills.filter((f) => f.isBuy).length;
    const sells = fills.length - buys;
    if (buys >= ACCUM_MIN_BUYS && sells === 0) accumulating = true;
    const wr = washRead(fills, now);
    if (wr.legs >= WASH_MIN_LEGS && wr.flat) washing = true;
  }
  if (accumulating) labels.push("accumulator");
  const recentSells = w.recent.filter((f) => !f.isBuy).length;
  const recentBuys = w.recent.length - recentSells;
  if (recentSells >= 4 && recentSells >= 2 * recentBuys) labels.push("distributor");
  if (washing) labels.push("wash-like");
  return labels;
}

/**
 * @typedef {{ kind: "dormant_buy", gapMs: number } | { kind: "accumulation", buys: number } | { kind: "distribution", sells: number } | { kind: "wash_like", legs: number }} BehaviourRead
 */

/**
 * What this fill, just folded into the ledger, means — the reads that fire
 * exactly at a threshold. Call AFTER applyFill, with the wallet's previous
 * fill time.
 *
 * @param {WalletStats} w
 * @param {{ mint: string, isBuy: boolean, sol: number, ts: number }} fill
 * @param {number} prevFillTs chain time of the fill before this one, 0 if none
 * @returns {BehaviourRead[]}
 */
export function detectBehaviour(w, fill, prevFillTs) {
  /** @type {BehaviourRead[]} */
  const out = [];
  if (fill.isBuy && fill.sol >= DORMANT_MIN_SOL && prevFillTs > 0 && fill.ts - prevFillTs >= DORMANT_MS) {
    out.push({ kind: "dormant_buy", gapMs: fill.ts - prevFillTs });
  }
  const fills = ofMint(w.recent, fill.mint);
  const buys = fills.filter((f) => f.isBuy).length;
  const sells = fills.length - buys;
  if (fill.isBuy && buys === ACCUM_MIN_BUYS && sells === 0) out.push({ kind: "accumulation", buys });
  if (!fill.isBuy && sells === DIST_MIN_SELLS && buys === 0) out.push({ kind: "distribution", sells });
  const wr = washRead(fills, fill.ts);
  if (wr.legs === WASH_MIN_LEGS && wr.flat) out.push({ kind: "wash_like", legs: wr.legs });
  return out;
}
