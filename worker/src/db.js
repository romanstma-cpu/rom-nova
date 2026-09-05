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
import { randomUUID } from "node:crypto";
import { log } from "../../src/lib/radar/engine/util.js";

const FLUSH_MS = 2_000;
const QUEUE_CAP = 5_000;
const REPROBE_MS = 5 * 60_000;
export const MIGRATION_FILE = "worker/supabase/migrations/002-copy-desk.sql";
/** 1.21.0: the subscriptions table, and the end of anon reads on the radar tables. */
export const ACCOUNTS_MIGRATION_FILE = "worker/supabase/migrations/003-accounts.sql";
/** 1.22.0: API keys. */
export const API_MIGRATION_FILE = "worker/supabase/migrations/004-api-keys.sql";
/** 1.24.0: follows and notes. */
export const COMMUNITY_MIGRATION_FILE = "worker/supabase/migrations/006-community.sql";

/** The column each grading horizon lands in. */
export const HORIZON_COLUMN = { m1: "ret_1m", m5: "ret_5m", m15: "ret_15m", h1: "ret_1h" };

/** Columns the 1.17.0 migration adds, stripped from writes until it has run. */
const WALLET_COLUMNS_1_17 = ["median_hold_ms", "follow_ret_5m", "follow_hit_rate", "signals_graded", "labels", "consistency", "max_drawdown_sol", "avg_hold_ms"];
const SIGNAL_COLUMNS_1_17 = ["signal_key", "price_at_signal"];
/** Columns the 1.23.0 migration adds (the model's evidence and its guess), stripped until it has run. */
const SIGNAL_COLUMNS_1_23 = ["settled_sells", "launch_age_ms", "model_p", "model_version"];
/** 1.23.0: the graded model's columns on signals. */
export const MODEL_MIGRATION_FILE = "worker/supabase/migrations/005-model.sql";

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
    /** null = not probed yet; false = the 1.23.0 model columns are missing. */
    this.modelColumns = null;
    /** null = not probed yet; false = the subscriptions table is missing (003). */
    this.billingReady = null;
    /** null = not probed yet; false = the api_keys table is missing (004). */
    this.apiReady = null;
    /** null = not probed yet; false = the follows/notes tables are missing (006). */
    this.communityReady = null;
    /**
     * Are the radar tables still readable with the public anon key? The
     * schema once granted that; 003 revokes it, because with a gated feed a
     * world-readable table is the feed with the gate left open. null until
     * probed, and only probed when a gate is on and the key is known.
     */
    this.anonReads = null;
    this.queues = {
      /** @type {any[]} */ trades: [],
      /** @type {Map<string, any>} */ wallets: new Map(), // coalesced by address
      /** @type {any[]} */ launches: [],
      /** @type {any[]} */ signals: [],
      /** @type {Map<string, any>} */ patches: new Map(), // coalesced by signal_key
    };
    this.dropped = 0;
    this.droppedPatches = 0;
    this.written = { trades: 0, wallets: 0, launches: 0, signals: 0, patches: 0, subscriptions: 0, api_keys: 0, follows: 0, notes: 0 };
    this.lastError = "";
    /** DRY_RUN mirror, capped. */
    this.memory = { trades: [], launches: [], signals: [], wallets: new Map(), subscriptions: new Map(), apiKeys: new Map(), follows: new Map(), notes: new Map() };
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.probeTimer = null;
  }

  async connect() {
    if (this.cfg.dryRun) {
      log("[db] DRY_RUN — in-memory store, nothing persists");
      this.migrated = true;
      this.billingReady = true;
      this.apiReady = true;
      this.communityReady = true;
      return;
    }
    const { createClient } = await import("@supabase/supabase-js");
    this.client = createClient(this.cfg.supabaseUrl, this.cfg.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    log("[db] supabase client ready");
    await this.probeSchema();
    if (this.cfg.access !== "open") await this.probeAccounts();
  }

  /**
   * Is the accounts migration in? The subscriptions table is the marker.
   * Then the honesty check the migration also carries: with the public key
   * alone, can anyone still read the signals table around the gate?
   */
  async probeAccounts() {
    if (!this.client) return;
    const { error } = await this.client.from("subscriptions").select("user_id").limit(1);
    const was = this.billingReady;
    this.billingReady = !error;
    if (this.billingReady && was !== true) log("[db] subscriptions table present — the gate can read entitlements");
    if (!this.billingReady && was !== false) log(`[db] no subscriptions table — run ${ACCOUNTS_MIGRATION_FILE} before RADAR_ACCESS=subscription can admit anyone`);
    const keys = await this.client.from("api_keys").select("id").limit(1);
    const hadKeys = this.apiReady;
    this.apiReady = !keys.error;
    if (this.apiReady && hadKeys !== true) log("[db] api_keys table present — readers can mint API keys");
    if (!this.apiReady && hadKeys !== false) log(`[db] no api_keys table — run ${API_MIGRATION_FILE} before anyone can mint a key`);
    const c = await this.client.from("follows").select("signal_key").limit(1);
    const hadCommunity = this.communityReady;
    this.communityReady = !c.error;
    if (this.communityReady && hadCommunity !== true) log("[db] follows and notes tables present — community is on");
    if (!this.communityReady && hadCommunity !== false) log(`[db] no follows table — run ${COMMUNITY_MIGRATION_FILE} for follow counts and wallet notes`);

    if (!this.cfg.supabaseAnonKey) return;
    try {
      const res = await fetch(`${this.cfg.supabaseUrl}/rest/v1/signals?select=id&limit=1`, {
        headers: { apikey: this.cfg.supabaseAnonKey, authorization: `Bearer ${this.cfg.supabaseAnonKey}` },
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      const open = Array.isArray(rows) && rows.length > 0;
      if (open && this.anonReads !== true) log(`[db] the radar tables are still readable with the anon key — ${ACCOUNTS_MIGRATION_FILE} closes that`);
      this.anonReads = open;
    } catch {
      /* the probe is advisory; the next one will say */
    }
  }

  // ------------------------------------------------- subscriptions (1.21.0)
  // Direct reads and writes, not the batched queue: a webhook must be on
  // disk before Stripe hears 200, and the gate reads on demand.

  /** @param {string} userId @returns {Promise<any | null>} */
  async getSubscription(userId) {
    if (!this.client) return this.memory.subscriptions.get(userId) ?? null;
    const { data, error } = await this.client.from("subscriptions").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(`subscriptions read: ${error.message}`);
    return data ?? null;
  }

  /** @param {string} customerId @returns {Promise<any | null>} */
  async findSubscriptionByCustomer(customerId) {
    if (!this.client) {
      for (const row of this.memory.subscriptions.values()) if (row.stripe_customer_id === customerId) return row;
      return null;
    }
    const { data, error } = await this.client.from("subscriptions").select("*").eq("stripe_customer_id", customerId).limit(1).maybeSingle();
    if (error) throw new Error(`subscriptions lookup: ${error.message}`);
    return data ?? null;
  }

  /** @param {Record<string, any>} row keyed on user_id; replaces the row's known fields */
  async upsertSubscription(row) {
    if (!this.client) {
      this.memory.subscriptions.set(row.user_id, row);
      this.written.subscriptions++;
      return;
    }
    const { error } = await this.client.from("subscriptions").upsert(row, { onConflict: "user_id" });
    if (error) {
      this.lastError = `subscriptions: ${error.message}`;
      throw new Error(this.lastError);
    }
    this.written.subscriptions++;
  }

  // ------------------------------------------------------ API keys (1.22.0)

  /** @param {Record<string, any>} row without an id; returns the row with one */
  async createApiKey(row) {
    if (!this.client) {
      const stored = { id: randomUUID(), last_used_at: null, revoked_at: null, ...row };
      this.memory.apiKeys.set(stored.id, stored);
      this.written.api_keys++;
      return stored;
    }
    const { data, error } = await this.client.from("api_keys").insert(row).select().single();
    if (error) {
      this.lastError = `api_keys: ${error.message}`;
      throw new Error(this.lastError);
    }
    this.written.api_keys++;
    return data;
  }

  /** The reader's live keys, oldest first. @param {string} userId */
  async listApiKeys(userId) {
    if (!this.client) return [...this.memory.apiKeys.values()].filter((k) => k.user_id === userId && !k.revoked_at);
    const { data, error } = await this.client.from("api_keys").select("id,user_id,prefix,name,created_at,last_used_at,revoked_at").eq("user_id", userId).is("revoked_at", null).order("created_at", { ascending: true });
    if (error) throw new Error(`api_keys list: ${error.message}`);
    return data ?? [];
  }

  /** @param {string} hash @returns {Promise<any | null>} the row, revoked or not */
  async findApiKeyByHash(hash) {
    if (!this.client) {
      for (const k of this.memory.apiKeys.values()) if (k.key_hash === hash) return k;
      return null;
    }
    const { data, error } = await this.client.from("api_keys").select("id,user_id,revoked_at").eq("key_hash", hash).maybeSingle();
    if (error) throw new Error(`api_keys lookup: ${error.message}`);
    return data ?? null;
  }

  /** Revoke one of the reader's own keys. @returns {Promise<boolean>} whether a live key was found */
  async revokeApiKey(userId, id, at) {
    if (!this.client) {
      const k = this.memory.apiKeys.get(id);
      if (!k || k.user_id !== userId || k.revoked_at) return false;
      k.revoked_at = at;
      return true;
    }
    const { data, error } = await this.client.from("api_keys").update({ revoked_at: at }).eq("id", id).eq("user_id", userId).is("revoked_at", null).select("id");
    if (error) throw new Error(`api_keys revoke: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /** @param {string} id @param {string} at */
  async touchApiKey(id, at) {
    if (!this.client) {
      const k = this.memory.apiKeys.get(id);
      if (k) k.last_used_at = at;
      return;
    }
    await this.client.from("api_keys").update({ last_used_at: at }).eq("id", id);
  }

  // ------------------------------------------------------ community (1.24.0)

  /** @param {{ user_id: string, signal_key: string, at: string }} row — a repeat is not an error, it is the same follow */
  async addFollow(row) {
    if (!this.client) {
      this.memory.follows.set(`${row.user_id}|${row.signal_key}`, row);
      this.written.follows++;
      return;
    }
    const { error } = await this.client.from("follows").upsert(row, { onConflict: "user_id,signal_key", ignoreDuplicates: true });
    if (error) throw new Error(`follows: ${error.message}`);
    this.written.follows++;
  }

  async removeFollow(userId, key) {
    if (!this.client) {
      this.memory.follows.delete(`${userId}|${key}`);
      return;
    }
    const { error } = await this.client.from("follows").delete().eq("user_id", userId).eq("signal_key", key);
    if (error) throw new Error(`follows delete: ${error.message}`);
  }

  /** @param {string[]} keys @returns {Promise<Map<string, number>>} */
  async countFollows(keys) {
    const out = new Map();
    if (!this.client) {
      for (const f of this.memory.follows.values()) if (keys.includes(f.signal_key)) out.set(f.signal_key, (out.get(f.signal_key) ?? 0) + 1);
      return out;
    }
    const { data, error } = await this.client.from("follows").select("signal_key").in("signal_key", keys);
    if (error) throw new Error(`follows count: ${error.message}`);
    for (const r of data ?? []) out.set(r.signal_key, (out.get(r.signal_key) ?? 0) + 1);
    return out;
  }

  /** Visible notes on a wallet, newest first. */
  async listNotes(wallet, limit) {
    if (!this.client) {
      return [...this.memory.notes.values()]
        .filter((n) => n.wallet_address === wallet && !n.hidden)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }
    const { data, error } = await this.client.from("notes").select("id,user_id,body,created_at").eq("wallet_address", wallet).eq("hidden", false).order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(`notes: ${error.message}`);
    return data ?? [];
  }

  async countUserNotes(userId, wallet) {
    if (!this.client) return [...this.memory.notes.values()].filter((n) => n.user_id === userId && n.wallet_address === wallet).length;
    const { count, error } = await this.client.from("notes").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("wallet_address", wallet);
    if (error) throw new Error(`notes count: ${error.message}`);
    return count ?? 0;
  }

  async addNote(row) {
    if (!this.client) {
      const stored = { id: randomUUID(), hidden: false, ...row };
      this.memory.notes.set(stored.id, stored);
      this.written.notes++;
      return stored;
    }
    const { data, error } = await this.client.from("notes").insert(row).select("id,user_id,body,created_at").single();
    if (error) throw new Error(`notes insert: ${error.message}`);
    this.written.notes++;
    return data;
  }

  /** @returns {Promise<boolean>} whether the reader's own note was found */
  async deleteNote(userId, id) {
    if (!this.client) {
      const n = this.memory.notes.get(id);
      if (!n || n.user_id !== userId) return false;
      this.memory.notes.delete(id);
      return true;
    }
    const { data, error } = await this.client.from("notes").delete().eq("id", id).eq("user_id", userId).select("id");
    if (error) throw new Error(`notes delete: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /** Graded signals since an instant, oldest first — what the model trains and judges on. */
  async gradedSignals({ since, limit }) {
    if (!this.client) return this.memory.signals.filter((s) => typeof s.ret_5m === "number" && s.timestamp >= since).slice(-limit);
    const { data, error } = await this.client.from("signals").select("*").not("ret_5m", "is", null).gte("timestamp", since).order("timestamp", { ascending: true }).limit(limit);
    if (error) throw new Error(`graded signals: ${error.message}`);
    return data ?? [];
  }

  /** Signals since an instant, newest first — the API's history read. */
  async recentSignals({ since, limit }) {
    if (!this.client) return this.memory.signals.filter((s) => s.timestamp >= since).slice(-limit).reverse();
    const { data, error } = await this.client.from("signals").select("*").gte("timestamp", since).order("timestamp", { ascending: false }).limit(limit);
    if (error) throw new Error(`signals history: ${error.message}`);
    return data ?? [];
  }

  /** Are the copy-desk columns there? Cheap: one column, one row. */
  async probeSchema() {
    if (!this.client) return;
    // The newest column the migration adds is the marker, so a half-applied
    // earlier draft of it reads as "pending" and the re-run adds the rest.
    const { error } = await this.client.from("tracked_wallets").select("avg_hold_ms").limit(1);
    const was = this.migrated;
    this.migrated = !error;
    if (this.migrated && was !== true) log("[db] schema current — grades and exits will be written");
    if (!this.migrated && was !== false) log(`[db] schema is pre-1.17.0 — writing base columns only until ${MIGRATION_FILE} is run`);
    const m = await this.client.from("signals").select("model_p").limit(1);
    const had = this.modelColumns;
    this.modelColumns = !m.error;
    if (this.modelColumns && had !== true) log("[db] model columns present — signals carry their evidence and the model's guess");
    if (!this.modelColumns && had !== false) log(`[db] no model columns — the model trains on what exists; run ${MODEL_MIGRATION_FILE} for its evidence and forward record`);
  }

  start() {
    this.timer = setInterval(() => {
      this.flush().catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      });
    }, FLUSH_MS);
    this.probeTimer = setInterval(() => {
      if (this.migrated !== true || this.modelColumns !== true) this.probeSchema().catch(() => {});
      if (this.cfg.access !== "open" && (this.billingReady !== true || this.apiReady !== true || this.communityReady !== true || this.anonReads === true)) this.probeAccounts().catch(() => {});
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
    const modelColumns = this.modelColumns === true;
    const signalBatch = signals
      .splice(0, signals.length)
      .map((r) => (migrated ? r : without(r, SIGNAL_COLUMNS_1_17)))
      .map((r) => (modelColumns ? r : without(r, SIGNAL_COLUMNS_1_23)));
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
      model_columns: this.cfg.dryRun
        ? "not probed (DRY_RUN)"
        : this.modelColumns === true
          ? "current"
          : this.modelColumns === false
            ? `migration pending — run ${MODEL_MIGRATION_FILE} (schema.sql carries it) for the model's evidence and forward record`
            : "probing",
      accounts:
        this.cfg.access === "open"
          ? "not used (RADAR_ACCESS=open)"
          : this.billingReady === true
            ? "current"
            : this.billingReady === false
              ? `migration pending — run ${ACCOUNTS_MIGRATION_FILE} in the Supabase SQL editor`
              : "probing",
      api_keys:
        this.cfg.access === "open"
          ? "not used (RADAR_ACCESS=open)"
          : this.apiReady === true
            ? "current"
            : this.apiReady === false
              ? `migration pending — run ${API_MIGRATION_FILE} in the Supabase SQL editor`
              : "probing",
      community:
        this.cfg.access === "open"
          ? "not used (RADAR_ACCESS=open)"
          : this.communityReady === true
            ? "current"
            : this.communityReady === false
              ? `migration pending — run ${COMMUNITY_MIGRATION_FILE} (schema.sql carries it)`
              : "probing",
      anon_reads:
        this.cfg.access === "open" || !this.cfg.supabaseAnonKey || this.cfg.dryRun
          ? null
          : this.anonReads === true
            ? `OPEN — the radar tables are readable with the public key; run ${ACCOUNTS_MIGRATION_FILE}`
            : this.anonReads === false
              ? "closed"
              : "probing",
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
