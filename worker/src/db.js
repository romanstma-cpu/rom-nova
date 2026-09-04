// Supabase persistence — batched writes in, one hydration read out.
//
// The firehose is filtered BEFORE this layer: the database sees launches
// (~1/s), tracked-wallet fills, score upserts and signals, not the ~35
// trades/s the program stream carries. Writes queue in memory and flush on a
// 2s clock; a flush that fails keeps its rows for the next tick, and the
// queue is capped so an outage degrades to counted drops instead of an OOM.
//
// DRY_RUN swaps this file's Supabase client for capped in-memory arrays with
// the same surface, which is how the whole pipeline is smoke-tested live
// without a database or a key.

import { log } from "./util.js";

const FLUSH_MS = 2_000;
const QUEUE_CAP = 5_000;

export class Db {
  /** @param {import("./config.js").Config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {any} */
    this.client = null;
    this.queues = {
      /** @type {any[]} */ trades: [],
      /** @type {Map<string, any>} */ wallets: new Map(), // coalesced by address
      /** @type {any[]} */ launches: [],
      /** @type {any[]} */ signals: [],
    };
    this.dropped = 0;
    this.written = { trades: 0, wallets: 0, launches: 0, signals: 0 };
    this.lastError = "";
    /** DRY_RUN mirror, capped. */
    this.memory = { trades: [], launches: [], signals: [], wallets: new Map() };
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
  }

  async connect() {
    if (this.cfg.dryRun) {
      log("[db] DRY_RUN — in-memory store, nothing persists");
      return;
    }
    const { createClient } = await import("@supabase/supabase-js");
    this.client = createClient(this.cfg.supabaseUrl, this.cfg.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    log("[db] supabase client ready");
  }

  start() {
    this.timer = setInterval(() => {
      this.flush().catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      });
    }, FLUSH_MS);
  }

  /** @param {any[]} queue @param {any} row */
  push(queue, row) {
    queue.push(row);
    if (queue.length > QUEUE_CAP) {
      queue.shift();
      this.dropped++;
    }
  }

  addLaunch(row) {
    this.push(this.queues.launches, {
      token_address: row.mint,
      token_name: row.name ?? row.symbol ?? null,
      launch_time: new Date(row.at).toISOString(),
      initial_liquidity: row.vSol ?? null,
    });
    if (this.cfg.dryRun) {
      this.memory.launches.push(row);
      if (this.memory.launches.length > 500) this.memory.launches.shift();
    }
  }

  addTrade(row) {
    this.push(this.queues.trades, row);
    if (this.cfg.dryRun) {
      this.memory.trades.push(row);
      if (this.memory.trades.length > 1_000) this.memory.trades.shift();
    }
  }

  addWallet(row) {
    this.queues.wallets.set(row.wallet_address, row);
    if (this.cfg.dryRun) this.memory.wallets.set(row.wallet_address, row);
  }

  addSignal(row) {
    this.push(this.queues.signals, row);
    if (this.cfg.dryRun) {
      this.memory.signals.push(row);
      if (this.memory.signals.length > 500) this.memory.signals.shift();
    }
  }

  async flush() {
    if (!this.client) {
      // DRY_RUN: the queues only exist to be dropped.
      this.queues.trades.length = 0;
      this.queues.launches.length = 0;
      this.queues.signals.length = 0;
      this.queues.wallets.clear();
      return;
    }
    const { trades, launches, signals } = this.queues;
    const wallets = [...this.queues.wallets.values()];
    this.queues.wallets.clear();
    const tradeBatch = trades.splice(0, trades.length);
    const launchBatch = launches.splice(0, launches.length);
    const signalBatch = signals.splice(0, signals.length);

    /** @param {string} table @param {any[]} rows @param {object} [opts] */
    const write = async (table, rows, opts) => {
      if (rows.length === 0) return;
      const { error } = await this.client.from(table).upsert(rows, opts);
      if (error) {
        this.lastError = `${table}: ${error.message}`;
        // Put the rows back for the next tick rather than losing them.
        const q = table === "wallet_trades" ? this.queues.trades : table === "token_launches" ? this.queues.launches : table === "signals" ? this.queues.signals : null;
        if (q) {
          q.unshift(...rows.slice(0, QUEUE_CAP - q.length));
        } else {
          for (const r of rows) this.queues.wallets.set(r.wallet_address, r);
        }
        return;
      }
      this.written[table === "wallet_trades" ? "trades" : table === "token_launches" ? "launches" : table === "tracked_wallets" ? "wallets" : "signals"] += rows.length;
    };

    await write("token_launches", launchBatch, { onConflict: "token_address", ignoreDuplicates: true });
    await write("tracked_wallets", wallets, { onConflict: "wallet_address" });
    await write("wallet_trades", tradeBatch, {
      onConflict: "signature,wallet_address,token_address,buy_or_sell",
      ignoreDuplicates: true,
    });
    await write("signals", signalBatch);
  }

  /**
   * Boot hydration: reload the tracked set and replay each wallet's journaled
   * fills through the scoring engine, oldest first, so scores survive a
   * restart — Render restarts free services whenever it likes, and a worker
   * that forgot every wallet it ever proved would never produce a signal.
   *
   * @param {import("./state.js").RadarState} state
   */
  async hydrate(state) {
    if (!this.client) return { wallets: 0, fills: 0 };
    const { applyFill, newWallet } = await import("./score.js");

    const { data: walletRows, error: wErr } = await this.client
      .from("tracked_wallets")
      .select("wallet_address,first_seen,last_active")
      .order("last_active", { ascending: false })
      .limit(this.cfg.maxTracked);
    if (wErr) {
      this.lastError = `hydrate wallets: ${wErr.message}`;
      return { wallets: 0, fills: 0 };
    }

    let fills = 0;
    for (const row of walletRows ?? []) {
      const w = newWallet(Date.parse(row.first_seen) || Date.now());
      // Paged replay, oldest first, capped at 4k fills a wallet — the same
      // cap the app's ledger holds per wallet.
      const { data: tradeRows, error: tErr } = await this.client
        .from("wallet_trades")
        .select("token_address,buy_or_sell,amount_sol,price_at_trade,timestamp")
        .eq("wallet_address", row.wallet_address)
        .order("timestamp", { ascending: true })
        .limit(4_000);
      if (tErr) {
        this.lastError = `hydrate trades: ${tErr.message}`;
        continue;
      }
      for (const t of tradeRows ?? []) {
        const sol = Number(t.amount_sol) || 0;
        const price = Number(t.price_at_trade) || 0;
        applyFill(w, {
          mint: t.token_address,
          isBuy: t.buy_or_sell === "buy",
          sol,
          tokens: price > 0 ? sol / price : 0,
          ts: Date.parse(t.timestamp) || Date.now(),
        });
        fills++;
      }
      state.tracked.set(row.wallet_address, w);
    }
    log(`[db] hydrated ${state.tracked.size} wallets, ${fills} fills replayed`);
    return { wallets: state.tracked.size, fills };
  }

  status() {
    return {
      mode: this.cfg.dryRun ? "dry-run (in-memory)" : "supabase",
      queued: this.queues.trades.length + this.queues.launches.length + this.queues.signals.length + this.queues.wallets.size,
      written: this.written,
      dropped: this.dropped,
      lastError: this.lastError || null,
    };
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => {});
  }
}
