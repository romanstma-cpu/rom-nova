// The worker's working memory and the pipeline through it.
//
// Streams push raw material in (launches, decoded trades); this module runs
// the gates and the ledger and emits plain effect objects out through one
// callback — { kind: "launch" | "whale" | "trade" | "signal" | "wallet" |
// "signal_outcome" | "exit" } — which the drivers fan out to the database,
// the socket, the journal and the toasts. No I/O in here, so the whole
// pipeline is testable by calling three functions.
//
// Two things a signal did not do before: get graded, and get an exit. Every
// trade on the curve passes through onTrade, so the stream that produced a
// signal can also say what the token was worth one, five, fifteen and sixty
// minutes later — the follower return, marked at the first trade at or after
// each horizon — and can hear the signal wallet sell, which is the moment a
// copier most needs to know about. Both are measured from the same fills the
// score trusts, and both go blind where the stream does: off the curve, and
// on a token nobody trades again (then the mark is the last trade seen, and
// the grade says so).

import { isSignalBuy, isWhaleBuy } from "./classify.js";
import { applyFill, applyFollowGrade, newWallet, scoreOf, walletRow } from "./score.js";
import { LruMap, LruSet } from "./util.js";

/** Grading horizons after the signal fill, ms. Keys are the column suffixes. */
export const HORIZONS = /** @type {const} */ ({ m1: 60_000, m5: 300_000, m15: 900_000, h1: 3_600_000 });
/** How long past a horizon the grader waits for a trade before marking to the last one seen. */
export const STALE_GRACE_MS = 45_000;
/** An open signal older than this stops listening for the wallet's exit. */
export const EXIT_WATCH_MS = 24 * 3_600_000;
/** A pinned mint quiet for this long is worth a price lookup off the stream. */
export const PIN_REFRESH_MS = 30_000;

/** @param {{ wallet_address: string, token_address: string, timestamp: string }} s */
export const signalKeyOf = (s) => `${s.wallet_address}:${s.token_address}:${s.timestamp}`;

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

    /**
     * Mints whose price this state keeps marking: every mint with a signal
     * still grading, plus any a driver pinned (a reader's own follow).
     * @type {LruMap<string, { lastPriceSol: number | null, lastAt: number, grading: GradeRecord[], pinned: boolean }>}
     */
    this.watched = new LruMap(5_000);
    /**
     * Signals whose wallet has not sold yet, `${wallet}:${mint}` → record.
     * @type {LruMap<string, { key: string, at: number, priceSol: number, wallet: string, mint: string, exited: boolean }>}
     */
    this.openSignals = new LruMap(2_000);

    this.counts = { launches: 0, tradesSeen: 0, whales: 0, journaled: 0, signals: 0, graded: 0, exits: 0 };
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

    // Every trade marks the price of a watched mint, whoever made it — the
    // grader and a reader's follows read the whole curve, not just whales.
    this.markPrice(trade);

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

    // The exit check also reads the position BEFORE the fill: what fraction
    // of what the wallet held did this sell let go of.
    const heldBefore = w.positions.get(trade.mint)?.heldTok ?? 0;

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
      const signal = {
        wallet_address: trade.user,
        wallet_score: statsBefore.score,
        token_address: trade.mint,
        token_name: launch?.name ?? null,
        buy_amount_sol: Number(trade.sol.toFixed(9)),
        timestamp: new Date(trade.chainTs).toISOString(),
        // The fill price the grades and the exit are measured against.
        price_at_signal: Number(trade.priceSol.toPrecision(9)),
        signal_key: "",
      };
      signal.signal_key = signalKeyOf(signal);
      this.registerSignal(signal, trade.chainTs, trade.priceSol);
      this.emit({ kind: "signal", signal, settledSells: statsBefore.settledSells });
    } else if (!trade.isBuy) {
      this.checkExit(trade, heldBefore);
    }
  }

  /**
   * Start grading a signal and listening for its wallet's exit. Also used by
   * the drivers to resume a journaled signal after a restart.
   *
   * @param {{ signal_key: string, wallet_address: string, token_address: string }} signal
   * @param {number} at         chain time of the signal fill
   * @param {number} priceSol   fill price
   * @param {{ resolved?: Partial<Record<keyof typeof HORIZONS, boolean>>, exited?: boolean, peak?: number }} [resume]
   */
  registerSignal(signal, at, priceSol, resume = {}) {
    if (!(priceSol > 0)) return;
    const mint = signal.token_address;
    const entry = this.watched.get(mint) ?? { lastPriceSol: null, lastAt: 0, grading: [], pinned: false };
    /** @type {GradeRecord} */
    const rec = {
      key: signal.signal_key,
      wallet: signal.wallet_address,
      mint,
      at,
      priceSol,
      peak: Math.max(priceSol, resume.peak ?? priceSol),
      pending: new Set(/** @type {(keyof typeof HORIZONS)[]} */ (Object.keys(HORIZONS)).filter((h) => !resume.resolved?.[h])),
    };
    if (rec.pending.size > 0) entry.grading.push(rec);
    this.watched.set(mint, entry);
    if (!resume.exited) {
      this.openSignals.set(`${signal.wallet_address}:${mint}`, {
        key: signal.signal_key,
        at,
        priceSol,
        wallet: signal.wallet_address,
        mint,
        exited: false,
      });
    }
  }

  /**
   * Keep marking a mint's price whether or not a signal is grading on it — a
   * reader's own follow. Unpin to let it fall out when the grades finish.
   * @param {string} mint @param {boolean} pinned
   */
  pinMint(mint, pinned = true) {
    const entry = this.watched.get(mint);
    if (entry) {
      entry.pinned = pinned;
      if (!pinned && entry.grading.length === 0) this.watched.delete(mint);
      return;
    }
    if (pinned) this.watched.set(mint, { lastPriceSol: null, lastAt: 0, grading: [], pinned: true });
  }

  /** @param {string} mint @returns {{ priceSol: number, at: number } | null} last trade seen on a watched mint */
  lastPrice(mint) {
    const e = this.watched.get(mint);
    return e && e.lastPriceSol !== null ? { priceSol: e.lastPriceSol, at: e.lastAt } : null;
  }

  /** @param {import("./decode.js").PumpTrade} trade */
  markPrice(trade) {
    const entry = this.watched.get(trade.mint);
    if (!entry || !(trade.priceSol > 0)) return;
    entry.lastPriceSol = trade.priceSol;
    entry.lastAt = trade.chainTs;
    if (entry.grading.length === 0) return;
    for (const rec of entry.grading) {
      if (trade.priceSol > rec.peak) rec.peak = trade.priceSol;
      for (const h of [...rec.pending]) {
        if (trade.chainTs >= rec.at + HORIZONS[h]) this.resolve(rec, h, trade.priceSol, trade.chainTs, "stream");
      }
    }
    this.sweep(entry, trade.mint);
  }

  /**
   * Mints whose price the driver should fetch from outside the stream: a
   * grading horizon has passed with no trade at or after it (the stream is
   * blind off the curve, and quiet tokens stay quiet), or a pinned mint has
   * not traded for a while. Capped so a burst of dead tokens cannot become a
   * fetch storm; the rest come round on the next tick.
   *
   * @param {number} now
   * @param {number} [cap]
   * @returns {string[]}
   */
  marksWanted(now, cap = 30) {
    const out = [];
    for (const [mint, entry] of this.watched) {
      let want = false;
      for (const rec of entry.grading) {
        for (const h of rec.pending) {
          const due = rec.at + HORIZONS[h];
          if (now >= due && entry.lastAt < due) {
            want = true;
            break;
          }
        }
        if (want) break;
      }
      if (!want && entry.pinned && now - entry.lastAt >= PIN_REFRESH_MS) want = true;
      if (want) out.push(mint);
      if (out.length >= cap) break;
    }
    return out;
  }

  /**
   * A price from outside the stream — a DexScreener quote for a token that
   * left the curve. Marks the mint and resolves the horizons it covers, the
   * way a trade would, tagged so the grade says where it came from. A
   * lookup older than the last trade seen changes nothing.
   *
   * @param {string} mint
   * @param {number} priceSol
   * @param {number} at
   */
  markExternal(mint, priceSol, at) {
    const entry = this.watched.get(mint);
    if (!entry || !(priceSol > 0) || at < entry.lastAt) return;
    entry.lastPriceSol = priceSol;
    entry.lastAt = at;
    for (const rec of entry.grading) {
      if (priceSol > rec.peak) rec.peak = priceSol;
      for (const h of [...rec.pending]) {
        if (at >= rec.at + HORIZONS[h]) this.resolve(rec, h, priceSol, at, "lookup");
      }
    }
    this.sweep(entry, mint);
  }

  /**
   * The clock: mark horizons the stream never got a trade for, and drop
   * exit-watches nobody needs any more. Drivers call it every few seconds.
   * @param {number} now
   */
  tick(now) {
    for (const [mint, entry] of this.watched) {
      for (const rec of entry.grading) {
        for (const h of [...rec.pending]) {
          if (now >= rec.at + HORIZONS[h] + STALE_GRACE_MS) {
            // No trade at or after the horizon and no lookup landed inside
            // the grace: the last mark is the only price there is. Before
            // any mark at all, that is the signal fill itself — a flat
            // grade, flagged stale.
            const mark = entry.lastPriceSol ?? rec.priceSol;
            this.resolve(rec, h, mark, now, "last-mark");
          }
        }
      }
      this.sweep(entry, mint);
    }
    for (const [k, o] of this.openSignals) {
      if (now - o.at > EXIT_WATCH_MS) this.openSignals.delete(k);
    }
  }

  /**
   * @param {GradeRecord} rec
   * @param {keyof typeof HORIZONS} h
   * @param {number} priceSol
   * @param {number} at
   * @param {"stream" | "lookup" | "last-mark"} source where the price came
   *   from: a trade at or after the horizon, an external quote, or the last
   *   mark seen because nothing else arrived (that one is `stale`)
   */
  resolve(rec, h, priceSol, at, source) {
    const stale = source === "last-mark";
    rec.pending.delete(h);
    const ret = priceSol / rec.priceSol - 1;
    const peakRet = rec.peak / rec.priceSol - 1;
    this.counts.graded++;
    if (h === "m5") {
      const w = this.tracked.get(rec.wallet);
      if (w) {
        applyFollowGrade(w, ret);
        this.emit({ kind: "wallet", row: walletRow(rec.wallet, w), settledSells: w.settledSells });
      }
    }
    this.emit({
      kind: "signal_outcome",
      signal_key: rec.key,
      wallet: rec.wallet,
      mint: rec.mint,
      horizon: h,
      ret: Number(ret.toFixed(4)),
      peak_ret: Number(peakRet.toFixed(4)),
      price_sol: Number(priceSol.toPrecision(9)),
      stale,
      source,
      at,
      done: rec.pending.size === 0,
    });
  }

  /** Drop finished grades; forget the mint once nothing needs its price. */
  sweep(entry, mint) {
    entry.grading = entry.grading.filter((r) => r.pending.size > 0);
    if (entry.grading.length === 0 && !entry.pinned) this.watched.delete(mint);
  }

  /**
   * A tracked wallet sold: if a signal of theirs on this mint is still open,
   * that is the exit a copier is waiting to hear about.
   * @param {import("./decode.js").PumpTrade & { signature?: string }} trade
   * @param {number} heldBefore tokens the ledger had the wallet holding before this sell
   */
  checkExit(trade, heldBefore) {
    const k = `${trade.user}:${trade.mint}`;
    const open = this.openSignals.get(k);
    if (!open) return;
    const fraction = heldBefore > 0 ? Math.min(1, trade.tokens / heldBefore) : null;
    const first = !open.exited;
    open.exited = true;
    // Flat, or a sell the ledger cannot size: stop listening either way.
    if (fraction === null || fraction >= 0.999) this.openSignals.delete(k);
    this.counts.exits++;
    this.emit({
      kind: "exit",
      signal_key: open.key,
      wallet: trade.user,
      mint: trade.mint,
      sol: Number(trade.sol.toFixed(9)),
      price_sol: Number(trade.priceSol.toPrecision(9)),
      ret: Number((trade.priceSol / open.priceSol - 1).toFixed(4)),
      after_ms: Math.max(0, trade.chainTs - open.at),
      fraction: fraction === null ? null : Number(fraction.toFixed(4)),
      first,
      at: trade.chainTs,
    });
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

/**
 * @typedef {object} GradeRecord
 * @property {string} key
 * @property {string} wallet
 * @property {string} mint
 * @property {number} at
 * @property {number} priceSol
 * @property {number} peak
 * @property {Set<keyof typeof HORIZONS>} pending
 */
