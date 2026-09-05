// The gate: given a token, may this connection read the feed?
//
// Three modes (config.js): open lets everyone through and asks nobody
// anything; account wants a live Supabase session; subscription wants that
// session AND a paid row in the subscriptions table. Every answer carries
// the HTTP status the app keys its message on — 401 "sign in", 402 "this
// costs money", 503 "not right now" — so the page never guesses.
//
// Fail closed. If Supabase cannot be asked, nobody is let in on a hunch;
// the app keeps retrying and the reader sees "could not be verified" rather
// than a feed that was never theirs.

import { looksLikeApiKey } from "./apikeys.js";
import { entitledAt, publicSubscription } from "./billing.js";

const ENTITLEMENT_TTL_MS = 60_000;
const ENTITLEMENT_CACHE_CAP = 5_000;

export class Access {
  /**
   * @param {import("./config.js").Config} cfg
   * @param {{ verifier: import("./auth.js").AuthVerifier | null, db: { getSubscription: (id: string) => Promise<any>, billingReady: boolean | null }, apiKeys?: import("./apikeys.js").ApiKeys | null, now?: () => number }} deps
   */
  constructor(cfg, { verifier, db, apiKeys, now }) {
    this.cfg = cfg;
    this.mode = cfg.access;
    this.verifier = verifier;
    this.db = db;
    this.apiKeys = apiKeys ?? null;
    this.now = now ?? Date.now;
    /** @type {Map<string, { entitled: boolean, row: any, until: number }>} */
    this.entCache = new Map();
    this.counts = { allowed: 0, unauthenticated: 0, unentitled: 0, unavailable: 0 };
  }

  /**
   * Who holds this token — the first half of check(), on its own for the
   * routes that must answer a signed-in reader who is NOT entitled (/me,
   * checkout) instead of turning them away.
   * @param {unknown} token
   * @returns {Promise<{ ok: true, user: { id: string, email: string } | null } | { ok: false, status: number, reason: string }>}
   */
  async identify(token) {
    if (this.mode === "open" || !this.verifier) return { ok: true, user: null };
    // An API key stands in for its owner's session, and is judged as its
    // owner: the entitlement check downstream reads the same row.
    if (this.apiKeys && looksLikeApiKey(token)) {
      let hit;
      try {
        hit = await this.apiKeys.resolve(token);
      } catch {
        this.counts.unavailable++;
        return { ok: false, status: 503, reason: "the API key could not be checked right now — try again shortly" };
      }
      if (!hit) {
        this.counts.unauthenticated++;
        return { ok: false, status: 401, reason: "API key not recognised, or revoked" };
      }
      return { ok: true, user: { id: hit.user_id, email: "", via: "key", keyId: hit.id } };
    }
    let user;
    try {
      user = await this.verifier.verify(token);
    } catch {
      this.counts.unavailable++;
      return { ok: false, status: 503, reason: "sign-in could not be verified right now — try again shortly" };
    }
    if (!user) {
      this.counts.unauthenticated++;
      return { ok: false, status: 401, reason: "sign in to use this radar" };
    }
    return { ok: true, user };
  }

  /**
   * May this token read the feed?
   * @param {unknown} token
   * @returns {Promise<{ ok: true, user: { id: string, email: string } | null, entitled: true, subscription: any } | { ok: false, status: number, reason: string, subscription?: any }>}
   */
  async check(token) {
    const who = await this.identify(token);
    if (!who.ok) return who;
    if (this.mode !== "subscription" || !who.user) {
      this.counts.allowed++;
      return { ok: true, user: who.user, entitled: true, subscription: null };
    }
    if (this.db.billingReady !== true) {
      this.counts.unavailable++;
      return { ok: false, status: 503, reason: "billing is not set up on this radar yet" };
    }
    let ent;
    try {
      ent = await this.entitlement(who.user.id);
    } catch {
      this.counts.unavailable++;
      return { ok: false, status: 503, reason: "subscription could not be read right now — try again shortly" };
    }
    if (!ent.entitled) {
      this.counts.unentitled++;
      return { ok: false, status: 402, reason: "this radar needs a subscription", subscription: ent.row };
    }
    this.counts.allowed++;
    return { ok: true, user: who.user, entitled: true, subscription: ent.row };
  }

  /**
   * The reader's paid state, cached a minute. `fresh` skips the cache — the
   * account page asks fresh after a checkout, when the webhook has just
   * landed and a minute is too long to wait.
   * @param {string} userId @param {{ fresh?: boolean }} [opts]
   */
  async entitlement(userId, opts = {}) {
    const now = this.now();
    const hit = this.entCache.get(userId);
    if (!opts.fresh && hit && hit.until > now) return hit;
    const row = await this.db.getSubscription(userId);
    const e = { entitled: entitledAt(row, now, this.cfg.entitlementGraceMs), row: publicSubscription(row), until: now + ENTITLEMENT_TTL_MS };
    if (this.entCache.size >= ENTITLEMENT_CACHE_CAP) {
      const oldest = this.entCache.keys().next().value;
      if (oldest !== undefined) this.entCache.delete(oldest);
    }
    this.entCache.set(userId, e);
    return e;
  }

  /** A webhook just changed this reader's row: the next check reads it. */
  forget(userId) {
    this.entCache.delete(userId);
  }

  status() {
    return { mode: this.mode, ...this.counts, auth: this.verifier ? this.verifier.status() : null };
  }
}
