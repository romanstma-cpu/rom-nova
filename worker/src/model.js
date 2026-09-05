// The model desk: trains the graded model on the worker's own history,
// stamps a probability on every new signal, and keeps the forward record.
//
// Once an hour it reloads the last ninety days of graded signals and
// retrains; the card it prints is what /health summarises and
// /api/v1/model serves whole. A new signal gets `model_p` from the current
// card BEFORE it is written, so the row carries the guess the model made
// at the time — and when the grade lands, the forward record judges that
// guess with no hindsight anywhere in the chain. Without a fitted card
// (insufficient data) signals carry no probability and the record stays
// empty, which is the honest state for a young radar.

import { forwardRecord, MODEL_VERSION, predictP, trainModel } from "../../src/lib/radar/engine/model.js";
import { log } from "../../src/lib/radar/engine/util.js";

export const MODEL_REFRESH_MS = 60 * 60_000;
const HISTORY_DAYS = 90;
const HISTORY_LIMIT = 5_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CAP_MIN = 1_440;

export class ModelDesk {
  /**
   * @param {{ gradedSignals: (opts: { since: string, limit: number }) => Promise<any[]> }} db
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    /** @type {any} */
    this.card = null;
    /** @type {any} */
    this.forward = null;
    /** Signals seen recently, for a new signal's context: {wallet, mint, ts}. */
    this.recent = [];
    this.counts = { refreshes: 0, annotated: 0 };
    this.refreshedAt = 0;
    this.lastError = "";
  }

  async refresh() {
    const now = this.now();
    try {
      const rows = await this.db.gradedSignals({ since: new Date(now - HISTORY_DAYS * DAY_MS).toISOString(), limit: HISTORY_LIMIT });
      this.card = trainModel(rows, { now });
      this.forward = forwardRecord(rows);
      // Seed the live context from what the history knows of the last day.
      const dayAgo = now - DAY_MS;
      const seeded = rows
        .map((r) => ({ wallet: r.wallet_address, mint: r.token_address, ts: Date.parse(r.timestamp) }))
        .filter((r) => Number.isFinite(r.ts) && r.ts >= dayAgo);
      const own = this.recent.filter((r) => r.ts >= dayAgo && !seeded.some((s) => s.wallet === r.wallet && s.mint === r.mint && s.ts === r.ts));
      this.recent = [...seeded, ...own].sort((a, b) => a.ts - b.ts);
      this.counts.refreshes++;
      this.refreshedAt = now;
      this.lastError = "";
      log(`[model] ${this.card.verdict}: ${this.card.note}${this.forward ? ` — forward ${this.forward.n} graded, acted ${this.forward.acted.n}` : ""}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log("[model] refresh failed:", this.lastError);
    }
  }

  /** @param {{ wallet_address: string, token_address: string, timestamp: string }} signal */
  contextFor(signal) {
    const ts = Date.parse(signal.timestamp) || this.now();
    const dayAgo = ts - DAY_MS;
    this.recent = this.recent.filter((r) => r.ts >= dayAgo);
    const mine = this.recent.filter((r) => r.wallet === signal.wallet_address && r.ts < ts);
    const last = mine.length ? mine[mine.length - 1].ts : null;
    return {
      walletHour: mine.filter((r) => ts - r.ts <= HOUR_MS).length,
      mintDay: this.recent.filter((r) => r.mint === signal.token_address && r.ts < ts).length,
      sinceLastMin: last === null ? CAP_MIN : (ts - last) / 60_000,
    };
  }

  /**
   * The probability for a signal that just fired, as the columns it lands
   * in — or nothing, when there is no fitted card.
   * @param {any} signal
   */
  annotate(signal) {
    const ctx = this.contextFor(signal);
    this.recent.push({ wallet: signal.wallet_address, mint: signal.token_address, ts: Date.parse(signal.timestamp) || this.now() });
    const p = predictP(this.card, signal, ctx);
    if (p === null) return {};
    this.counts.annotated++;
    return { model_p: p, model_version: MODEL_VERSION };
  }

  /** The compact line for /health and the socket's status. */
  summary() {
    const c = this.card;
    return {
      version: MODEL_VERSION,
      verdict: c?.verdict ?? "untrained",
      usable: c?.usable ?? 0,
      trained_at: c?.trained_at ?? null,
      note: c?.note ?? null,
      test: c?.test ? { n: c.test.n, baseline: c.test.baseline, top_precision: c.test.top.precision, top_k: c.test.top.k, se: c.test.top.se, lift: c.test.top.lift } : null,
      forward: this.forward ? { n: this.forward.n, baseline: this.forward.baseline, acted: this.forward.acted.n, acted_precision: this.forward.acted.precision, top_precision: this.forward.top.precision, verdict: this.forward.verdict } : null,
      ...this.counts,
      lastError: this.lastError || null,
    };
  }

  /** The whole card, for /api/v1/model. */
  full() {
    return { card: this.card, forward: this.forward, refreshed_at: this.refreshedAt ? new Date(this.refreshedAt).toISOString() : null };
  }
}
