// The worker's working memory and the pipeline through it.
//
// Streams push raw material in (launches, decoded trades); this module runs
// the gates and the ledger and emits plain effect objects out through one
// callback — { kind: "launch" | "whale" | "trade" | "signal" | "wallet" } —
// which index.js fans out to the database and the socket. No I/O in here, so
// the whole pipeline is testable by calling two functions.

import { isSignalBuy, isWhaleBuy } from "./classify.js";
import { applyFill, newWallet, scoreOf, walletRow } from "./score.js";
import { LruMap, LruSet } from "./util.js";

export class RadarState {
  /**
   * @param {import("./config.js").Config["gates"]} gates
   * @param {number} maxTracked
   * @param {(effect: any) => void} emit
   */
  constructor(gates, maxTracked, emit) {
    this.gates = gates;
    this.maxTracked = maxTracked;
    this.emit = emit;

    /** Launches this worker saw, mint → row. Sized for hours of pump.fun. */
    this.launches = new LruMap(20_000);
    /** @type {Map<string, import("./score.js").WalletStats>} address → ledger */
    this.tracked = new Map();
    /** One row per confirmed fill already processed — the two streams overlap. */
    this.seenFills = new LruSet(60_000);

    this.counts = { launches: 0, tradesSeen: 0, whales: 0, journaled: 0, signals: 0 };
  }

  /**
   * A creation frame from PumpPortal. The frame has no timestamp, so the row
   * is stamped with receipt time — the same honesty note the app's launch
   * feed carries.
   *
   * @param {{ mint: string, name?: string, symbol?: string, dev?: string, vSol?: number | null, signature?: string }} launch
   * @param {number} receivedAt
   */
  onLaunch(launch, receivedAt) {
    if (this.launches.has(launch.mint)) return;
    const row = { ...launch, at: receivedAt };
    this.launches.set(launch.mint, row);
    this.counts.launches++;
    this.emit({ kind: "launch", launch: row });
  }

  /**
   * One decoded, confirmed pump.fun fill — or a fill the Helius stream parsed
   * from another venue (same shape, `venue` says which).
   *
   * @param {import("./decode.js").PumpTrade & { signature?: string, venue?: string }} trade
   */
  onTrade(trade) {
    this.counts.tradesSeen++;
    // Dedupe across the two streams, keyed the same way the table's unique
    // index is. Side is part of the key so a same-tx buy+sell (arb inside one
    // transaction) keeps both legs.
    const key = trade.signature
      ? `${trade.signature}:${trade.user}:${trade.mint}:${trade.isBuy}`
      : `${trade.user}:${trade.mint}:${trade.chainTs}:${trade.sol}:${trade.isBuy}`;
    if (!this.seenFills.add(key)) return;

    const launch = this.launches.get(trade.mint);
    const known = this.tracked.get(trade.user);

    // Discovery: a big buy into a fresh launch marks the wallet.
    if (!known && isWhaleBuy(trade, launch?.at, this.gates)) {
      const w = newWallet(trade.chainTs);
      this.trackWallet(trade.user, w);
      this.counts.whales++;
      this.emit({
        kind: "whale",
        wallet: trade.user,
        mint: trade.mint,
        sol: trade.sol,
        launchAgeMs: launch ? trade.chainTs - launch.at : null,
        at: trade.chainTs,
      });
    }

    const w = this.tracked.get(trade.user);
    if (!w) return;

    // Signal check runs BEFORE this fill is folded in: the score that fires
    // an alert must be the score the wallet had walking into the trade, not
    // one the trade itself just moved.
    const statsBefore = { score: scoreOf(w), settledSells: w.settledSells };
    const fires = isSignalBuy(trade, statsBefore, this.gates);

    applyFill(w, { mint: trade.mint, isBuy: trade.isBuy, sol: trade.sol, tokens: trade.tokens, ts: trade.chainTs });
    this.counts.journaled++;

    this.emit({
      kind: "trade",
      trade: {
        wallet_address: trade.user,
        token_address: trade.mint,
        buy_or_sell: trade.isBuy ? "buy" : "sell",
        amount_sol: Number(trade.sol.toFixed(9)),
        price_at_trade: Number(trade.priceSol.toPrecision(9)),
        timestamp: new Date(trade.chainTs).toISOString(),
        signature: trade.signature ?? null,
        venue: trade.venue ?? "pumpfun",
      },
    });
    this.emit({ kind: "wallet", row: walletRow(trade.user, w), settledSells: w.settledSells });

    if (fires) {
      this.counts.signals++;
      this.emit({
        kind: "signal",
        signal: {
          wallet_address: trade.user,
          wallet_score: statsBefore.score,
          token_address: trade.mint,
          token_name: launch?.name ?? null,
          buy_amount_sol: Number(trade.sol.toFixed(9)),
          timestamp: new Date(trade.chainTs).toISOString(),
        },
        settledSells: statsBefore.settledSells,
      });
    }
  }

  /**
   * @param {string} address
   * @param {import("./score.js").WalletStats} w
   */
  trackWallet(address, w) {
    this.tracked.set(address, w);
    if (this.tracked.size > this.maxTracked) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const [a, s] of this.tracked) {
        if (s.lastActive < oldestAt) {
          oldest = a;
          oldestAt = s.lastActive;
        }
      }
      if (oldest !== null) this.tracked.delete(oldest);
    }
  }

  /** Top wallets by score, for the snapshot and the leaderboard push. */
  top(n = 10) {
    return [...this.tracked.entries()]
      .map(([a, w]) => walletRow(a, w))
      .sort((x, y) => y.score - x.score || y.total_trades - x.total_trades)
      .slice(0, n);
  }
}
