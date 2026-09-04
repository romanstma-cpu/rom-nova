// The two gates: is this buy a whale entering a fresh launch, and is this
// buy worth waking anyone up over. Pure functions — the streams feed them,
// the tests corner them.

/**
 * @typedef {object} Gates
 * @property {number} whaleThresholdSol  buy size that marks a wallet (default 10)
 * @property {number} whaleWindowMs      how long after launch a big buy still counts
 * @property {number} signalMinScore     tracked-wallet score a signal requires (default 70)
 * @property {number} signalMinSettled   settled sells a signal requires — a score
 *                                       shrunk by sample size can't reach 70 with
 *                                       fewer, but the explicit floor keeps the
 *                                       rule visible and testable
 * @property {number} signalMinBuySol    ignore dust buys even from proven wallets
 */

/**
 * Whale gate: a BUY at/over the threshold, on a mint whose launch this worker
 * saw, inside the window. Sells never qualify — exiting big is not entering.
 *
 * @param {{ isBuy: boolean, sol: number, chainTs: number }} trade
 * @param {number | undefined} launchAt ms epoch the launch was seen, undefined when unseen
 * @param {Gates} g
 */
export function isWhaleBuy(trade, launchAt, g) {
  if (!trade.isBuy || trade.sol < g.whaleThresholdSol) return false;
  if (launchAt === undefined) return false;
  const age = trade.chainTs - launchAt;
  // The launch clock is this worker's receipt time and the trade clock is the
  // chain's; a small negative age just means the push beat the block.
  return age <= g.whaleWindowMs;
}

/**
 * Signal gate: a tracked wallet with a proven score buys meaningfully.
 *
 * @param {{ isBuy: boolean, sol: number }} trade
 * @param {{ score: number, settledSells: number } | undefined} wallet stats snapshot, undefined when untracked
 * @param {Gates} g
 */
export function isSignalBuy(trade, wallet, g) {
  if (!trade.isBuy || !wallet) return false;
  if (trade.sol < g.signalMinBuySol) return false;
  if (wallet.settledSells < g.signalMinSettled) return false;
  return wallet.score > g.signalMinScore;
}
