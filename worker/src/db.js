// Supabase persistence — batched writes in, one hydration read out.
//
// The firehose is filtered BEFORE this layer: the database sees launches
// (~1/s), tracked-wallet fills, score upserts, signals and their grades, not
// the ~35 trades/s the program stream carries. Writes queue in memory and
// flush on a 2s clock; a flush that fails keeps its rows for the next tick,
// and the queue is capped so an outage degrades to counted drops instead of
// an OOM.
//
// DRY_RUN swaps this file's Supabase client for capped in-memory arrays with
// the same surface, which is how the whole pipeline is smoke-tested live
// without a database or a key.
//
// Schema drift is handled here, not by crashing: the copy-desk columns
// (1.17.0) may not exist yet on a database created from the earlier schema.
// The layer probes for them at connect and every few minutes after; until
// they exist it writes the base columns only, drops the grades with a
// counter, and says in /health exactly which file to run.

// The engine — the pure pipeline shared with the app's in-browser hunter —
// lives in the app tree; this service is one of its two drivers.
import { log } from "../../src/lib/radar/engine/util.js";

const FLUSH_MS = 2_000;
const QUEUE_CAP = 5_000;
const REPROBE_MS = 5 * 60_000;
export const MIGRATION_FILE = "worker/supabase/migrations/002-copy-desk.sql";

/** The column each grading horizon lands in. */
export const HORIZON_COLUMN = { m1: "ret_1m", m5: "ret_5m", m15: "ret_15m", h1: "ret_1h" };

/** Columns the 1.17.0 migration adds, stripped from writes until it has run. */
const WALLET_COLUMNS_1_17 = ["median_hold_ms", "follow_ret_5m", "follow_hit_rate", "signals_graded"];
const SIGNAL_COLUMNS_1_17 = ["signal_key", "price_at_signal"];

/** @param {Record<string, any>} row @param {string[]} columns */
function without(row, columns) {
  const out = { ...row };
  for (const c of columns) delete out[c];
  return out;
}

export class Db {
  /** @param {import("./config.js").Config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {any} */
    this.client = null;
    /** null = not probed yet; false = the 1.17.0 columns are missing. */
    this.migrated = null;
    this.queues = {
      /** @type {any[]} */ trades: [],
      /** @type {Map<string, any>} */ wallets: new Map(), // coalesced by address
      /** @type {any[]} */ launches: [],
      /** @type {any[]} */ signals: [],
      /** @type {Map<string, any>} */ patches: new Map(), // coalesced by signal_key
    };
    this.dropped = 0;
    this.droppedPatches = 0;
    this.written = { trades: 0, wallets: 0, launches: 0, signals: 0, patches: 0 };
    this.lastError = "";
    /** DRY_RUN mirror, capped. */
    this.memory = { trades: [], launches: [], signals: [], wallets: new Map() };
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.probeTimer = null;
  }

  async connect() {
    if (this.cfg.dryRun) {
      log("[db] DRY_RUN — in-memory store, nothing persists");
      this.migrated = true;
      return;
    }
    const { createClient } = await import("@supabase/supabase-js");
    this.client = createClient(this.cfg.supabaseUrl, this.cfg.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    log("[db] supabase client ready");
    await this.probeSchema();
  }

  /** Are the copy-desk columns there? Cheap: one column, one row. */
  async probeSchema() {
    if (!this.client) return;
    const { error } = await this.client.from("signals").select("signal_key").limit(1);
    const was = this.migrated;
    this.migrated = !error;
    if (this.migrated && was !== true) log("[db] schema current — grades and exits will be written");
    if (!this.migrated && was !== false) log(`[db] schema is pre-1.17.0 — writing base columns only until ${MIGRATION_FILE} is run`);
  }

  start() {
    this.timer = setInterval(() => {
      this.flush().catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      });
    }, FLUSH_MS);
    this.probeTimer = setInterval(() => {
      if (this.migrated !== true) this.probeSchema().catch(() => {});
    }, REPROBE_MS);
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

  /** A grade or an exit for a signal already written, by its key. Coalesced. */
  patchSignal(key, patch) {
    if (!key) return;
    if (this.migrated === false) {
      this.droppedPatches++;
      return;
    }
    this.queues.patches.set(key, { ...(this.queues.patches.get(key) ?? {}), ...patch });
    if (this.queues.patches.size > QUEUE_CAP) {
      const oldest = this.queues.patches.keys().next().value;
      if (oldest !== undefined) this.queues.patches.delete(oldest);
      this.droppedPatches++;
    }
  }

  async flush() {
    if (!this.client) {
      // DRY_RUN: the queues only exist to be dropped.
      this.queues.trades.length = 0;
      this.queues.launches.length = 0;
      this.queues.signals.length = 0;
      this.queues.wallets.clear();
      this.queues.patches.clear();
      return;
    }
    const { trades, launches, signals } = this.queues;
    const migrated = this.migrated === true;
    const wallets = [...this.queues.wallets.values()].map((r) => (migrated ? r : without(r, WALLET_COLUMNS_1_17)));
    this.queues.wallets.clear();
    const tradeBatch = trades.splice(0, trades.length);
    const launchBatch = launches.splice(0, launches.length);
    const signalBatch = signals.splice(0, signals.length).map((r) => (migrated ? r : without(r, SIGNAL_COLUMNS_1_17)));
    const patchBatch = migrated ? [...this.queues.patches.entries()] : [];
    if (migrated) this.queues.patches.clear();

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
    // With the key column present a re-emitted signal (a restart replaying
    // the same fill) lands once; without it the base insert stands as before.
    await write("signals", signalBatch, migrated ? { onConflict: "signal_key", ignoreDuplicates: true } : undefined);

    for (const [key, patch] of patchBatch) {
      const { error } = await this.client.from("signals").update(patch).eq("signal_key", key);
      if (error) {
        this.lastError = `signals patch: ${error.message}`;
        this.queues.patches.set(key, { ...patch, ...(this.queues.patches.get(key) ?? {}) });
        continue;
      }
      this.written.patches++;
    }
  }

  /**
   * Boot hydration: reload the tracked set and replay each wallet's journaled
   * fills through the scoring engine, oldest first, so scores survive a
   * restart — Render restarts free services whenever it likes, and a worker
   * that forgot every wallet it ever proved would never produce a signal.
   * Then the recent signals: their five-minute grades fold back into the
   * follower stats, and any still grading or still awaiting its wallet's
   * exit resumes where it was.
   *
   * @param {import("./state.js").RadarState} state
   */
  async hydrate(state) {
    const none = { wallets: 0, fills: 0, signals: 0, grades: 0, watching: 0 };
    if (!this.client) return none;
    const { applyFill, applyFollowGrade, newWallet } = await import("../../src/lib/radar/engine/score.js");

    const { data: walletRows, error: wErr } = await this.client
      .from("tracked_wallets")
      .select("wallet_address,first_seen,last_active")
      .order("last_active", { ascending: false })
      .limit(this.cfg.maxTracked);
    if (wErr) {
      this.lastError = `hydrate wallets: ${wErr.message}`;
      return none;
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

    let signals = 0;
    let grades = 0;
    let watching = 0;
    if (this.migrated === true) {
      const now = Date.now();
      const { data: sigRows, error: sErr } = await this.client
        .from("signals")
        .select("signal_key,wallet_address,token_address,timestamp,price_at_signal,ret_1m,ret_5m,ret_15m,ret_1h,peak_ret_1h,whale_exit_ret")
        .gte("timestamp", new Date(now - 7 * 86_400_000).toISOString())
        .order("timestamp", { ascending: true })
        .limit(5_000);
      if (sErr) {
        this.lastError = `hydrate signals: ${sErr.message}`;
      } else {
        for (const s of sigRows ?? []) {
          signals++;
          const w = state.tracked.get(s.wallet_address);
          const r5 = s.ret_5m === null || s.ret_5m === undefined ? null : Number(s.ret_5m);
          if (w && r5 !== null && Number.isFinite(r5)) {
            applyFollowGrade(w, r5);
            grades++;
          }
          const at = Date.parse(s.timestamp);
          const price = Number(s.price_at_signal);
          if (!s.signal_key || !at || !(price > 0)) continue;
          const resolved = {
            m1: s.ret_1m !== null && s.ret_1m !== undefined,
            m5: r5 !== null,
            m15: s.ret_15m !== null && s.ret_15m !== undefined,
            h1: s.ret_1h !== null && s.ret_1h !== undefined,
          };
          const stillGrading = Object.values(resolved).some((v) => !v) && now - at < 2 * 3_600_000;
          const exited = s.whale_exit_ret !== null && s.whale_exit_ret !== undefined;
          const watchExit = !exited && now - at < 24 * 3_600_000;
          if (!stillGrading && !watchExit) continue;
          const peak = Number(s.peak_ret_1h);
          state.registerSignal(
            { signal_key: s.signal_key, wallet_address: s.wallet_address, token_address: s.token_address },
            at,
            price,
            {
              resolved: stillGrading ? resolved : { m1: true, m5: true, m15: true, h1: true },
              exited: !watchExit,
              peak: price * (1 + (Number.isFinite(peak) ? peak : 0)),
            },
          );
          watching++;
        }
      }
    }
    return { wallets: state.tracked.size, fills, signals, grades, watching };
  }

  status() {
    return {
      mode: this.cfg.dryRun ? "dry-run (in-memory)" : "supabase",
      schema: this.migrated === true ? "current" : this.migrated === false ? `migration pending — run ${MIGRATION_FILE} in the Supabase SQL editor` : "probing",
      queued:
        this.queues.trades.length +
        this.queues.launches.length +
        this.queues.signals.length +
        this.queues.wallets.size +
        this.queues.patches.size,
      written: this.written,
      dropped: this.dropped,
      droppedPatches: this.droppedPatches,
      lastError: this.lastError || null,
    };
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    await this.flush().catch(() => {});
  }
}
