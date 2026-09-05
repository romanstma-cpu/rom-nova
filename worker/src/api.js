// The paid API: the feed's planes over plain HTTP, for scripts.
//
// Everything the socket pushes, as JSON on request — recent signals with
// their grades and exits, the leaderboard with its intelligence columns,
// launches, whales, fills, behaviours — plus history for signals out of the
// database. The same gate as the socket (config.js RADAR_ACCESS), so a key
// opens exactly what its owner's session would, and a rate limit per key.
//
// Pure with respect to the network: handle() takes the method, path, query
// and token and answers {status, body, headers}. The router (io.js) reads
// bytes; this file decides. The tests drive it directly.

import { looksLikeApiKey } from "./apikeys.js";
import { HttpError } from "./http-error.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SINCE_MAX_DAYS = 30;

/** The routes that belong to community.js rather than the data planes. */
export function isCommunityPath(path) {
  return path === "/api/v1/follows" || path.startsWith("/api/v1/follows/") || /^\/api\/v1\/wallets\/[^/]+\/notes$/.test(path) || path.startsWith("/api/v1/notes/");
}

/** @param {unknown} raw @param {number} dflt @param {number} max */
export function parseLimit(raw, dflt = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(max, Math.floor(n));
}

/** An ISO instant no older than the history the API serves, or null. */
export function parseSince(raw, nowMs) {
  if (typeof raw !== "string" || !raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new HttpError(400, "since must be an ISO-8601 instant, e.g. 2026-09-05T00:00:00Z");
  const floor = nowMs - SINCE_MAX_DAYS * 86_400_000;
  return new Date(Math.max(t, floor)).toISOString();
}

export class Api {
  /**
   * @param {{
   *   cfg: import("./config.js").Config,
   *   access: import("./access.js").Access,
   *   apiKeys: import("./apikeys.js").ApiKeys,
   *   limiter: import("./apikeys.js").RateLimiter,
   *   db: { recentSignals: (opts: { since: string, limit: number }) => Promise<any[]> },
   *   data: { rings: () => Record<string, any[]>, topWallets: (n: number) => any[], wallet: (address: string) => any | null, model?: () => any },
   *   community?: import("./community.js").Community | null,
   *   now?: () => number,
   * }} deps
   */
  constructor({ cfg, access, apiKeys, limiter, db, data, community, now }) {
    this.cfg = cfg;
    this.access = access;
    this.apiKeys = apiKeys;
    this.limiter = limiter;
    this.db = db;
    this.data = data;
    this.community = community ?? null;
    this.now = now ?? Date.now;
    this.counts = { requests: 0, denied: 0, limited: 0, served: 0 };
  }

  /**
   * @param {string} method @param {string} path @param {Record<string, string>} query @param {string} token
   * @param {{ body?: unknown, remote?: string }} [ctx]
   * @returns {Promise<{ status: number, body: any, headers?: Record<string, string> }>}
   */
  async handle(method, path, query, token, ctx = {}) {
    this.counts.requests++;
    try {
      if (path === "/api/keys" || path.startsWith("/api/keys/")) return await this.keysRoute(method, path, token, ctx.body);
      if (isCommunityPath(path)) return await this.communityRoute(method, path, query, token, ctx.body);
      if (path.startsWith("/api/v1/")) return await this.dataRoute(method, path, query, token, ctx.remote ?? "");
      return { status: 404, body: { error: "not found" } };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      throw err;
    }
  }

  // ------------------------------------------------------------ keys

  /** Sessions mint and revoke keys; a key may not mint another. */
  async keysRoute(method, path, token, body) {
    if (this.cfg.access === "open") return { status: 404, body: { error: "this radar is open — no keys are needed and none are issued" } };
    if (looksLikeApiKey(token)) return { status: 403, body: { error: "keys are managed with a signed-in session, not with another key" } };
    const who = await this.access.identify(token);
    if (!who.ok) return { status: who.status, body: { error: who.reason } };
    if (!who.user) return { status: 401, body: { error: "sign in first" } };

    if (method === "GET" && path === "/api/keys") return { status: 200, body: { keys: await this.apiKeys.list(who.user.id) } };
    if (method === "POST" && path === "/api/keys") {
      const name = body && typeof body === "object" ? /** @type {any} */ (body).name : "";
      return { status: 201, body: await this.apiKeys.create(who.user, name) };
    }
    const m = /^\/api\/keys\/([0-9a-f-]{36})$/.exec(path);
    if (method === "DELETE" && m) {
      const ok = await this.apiKeys.revoke(who.user.id, m[1]);
      return ok ? { status: 200, body: { revoked: m[1] } } : { status: 404, body: { error: "no such key" } };
    }
    return { status: 404, body: { error: "not found" } };
  }

  // -------------------------------------------------------- community

  /**
   * Follows and notes: a signed-in reader (session or key), the same rate
   * limit as the data, and nothing at all on an open radar, which has no
   * readers to count.
   */
  async communityRoute(method, path, query, token, body) {
    if (this.cfg.access === "open" || !this.community) return { status: 404, body: { error: "this radar is open — it has no signed-in readers, so no follows or notes" } };
    const who = await this.access.check(token);
    if (!who.ok) {
      this.counts.denied++;
      return { status: who.status, body: { error: who.reason } };
    }
    const user = who.user;
    if (!user) return { status: 401, body: { error: "sign in first" } };
    const lim = this.limiter.take(/** @type {any} */ (user).keyId ?? user.id);
    const headers = { "x-ratelimit-limit": String(this.limiter.perMinute), "x-ratelimit-remaining": String(lim.remaining) };
    if (!lim.ok) {
      this.counts.limited++;
      return { status: 429, body: { error: "rate limit — try again shortly" }, headers: { ...headers, "retry-after": String(lim.retryAfterS) } };
    }
    const b = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
    const c = this.community;

    if (path === "/api/v1/follows") {
      if (method === "GET") {
        const keys = String(query.keys ?? "")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        return { status: 200, body: { counts: await c.followerCounts(keys) }, headers };
      }
      if (method === "POST") return { status: 201, body: await c.follow(user, b.signal_key), headers };
    }
    let m = /^\/api\/v1\/follows\/(.+)$/.exec(path);
    if (m && method === "DELETE") return { status: 200, body: await c.unfollow(user, decodeURIComponent(m[1])), headers };

    m = /^\/api\/v1\/wallets\/([^/]+)\/notes$/.exec(path);
    if (m) {
      if (method === "GET") return { status: 200, body: { notes: await c.notes(user, m[1]) }, headers };
      if (method === "POST") return { status: 201, body: await c.addNote(user, m[1], b.body), headers };
    }
    m = /^\/api\/v1\/notes\/([0-9a-f-]{36})$/.exec(path);
    if (m && method === "DELETE") {
      const ok = await c.deleteNote(user, m[1]);
      return ok ? { status: 200, body: { deleted: m[1] }, headers } : { status: 404, body: { error: "no such note of yours" }, headers };
    }
    return { status: 404, body: { error: "not found" }, headers };
  }

  // ------------------------------------------------------------ data

  async dataRoute(method, path, query, token, remote) {
    if (method !== "GET") return { status: 405, body: { error: "GET only" }, headers: { allow: "GET" } };
    const r = await this.access.check(token);
    if (!r.ok) {
      this.counts.denied++;
      return { status: r.status, body: { error: r.reason } };
    }
    // The subject the limit counts: the key, else the reader, else (open) the caller's address.
    const subject = r.user ? (/** @type {any} */ (r.user).keyId ?? r.user.id) : remote || "anon";
    const lim = this.limiter.take(subject);
    const headers = { "x-ratelimit-limit": String(this.limiter.perMinute), "x-ratelimit-remaining": String(lim.remaining) };
    if (!lim.ok) {
      this.counts.limited++;
      return { status: 429, body: { error: "rate limit — try again shortly" }, headers: { ...headers, "retry-after": String(lim.retryAfterS) } };
    }

    const limit = parseLimit(query.limit);
    const rings = this.data.rings();
    const recent = (ring) => (rings[ring] ?? []).slice(-limit).reverse();
    let body;
    if (path === "/api/v1/signals") {
      const since = parseSince(query.since, this.now());
      body = { signals: since ? await this.db.recentSignals({ since, limit }) : recent("signals"), since, limit };
    } else if (path === "/api/v1/wallets") {
      body = { wallets: this.data.topWallets(limit), limit };
    } else if (path.startsWith("/api/v1/wallets/")) {
      const address = path.slice("/api/v1/wallets/".length);
      if (!ADDRESS_RE.test(address)) throw new HttpError(400, "that is not a Solana address");
      const wallet = this.data.wallet(address);
      if (!wallet) throw new HttpError(404, "the radar is not tracking this wallet");
      body = { wallet, signals: (rings.signals ?? []).filter((s) => s.wallet_address === address).slice(-limit).reverse() };
    } else if (path === "/api/v1/launches" || path === "/api/v1/whales" || path === "/api/v1/trades" || path === "/api/v1/behaviours") {
      const ring = path.slice("/api/v1/".length);
      body = { [ring]: recent(ring), limit };
    } else if (path === "/api/v1/model") {
      // The whole card: verdict, folds, weights, norm — enough to reproduce
      // a probability, and the forward record that judges the guesses.
      body = this.data.model ? this.data.model() : { card: null, forward: null, refreshed_at: null };
    } else {
      return { status: 404, body: { error: "not found" }, headers };
    }
    this.counts.served++;
    return { status: 200, body: { ...body, as_of: new Date(this.now()).toISOString() }, headers };
  }

  status() {
    return { ...this.counts, rate_per_min: this.limiter.perMinute, keys: this.apiKeys.status(), community: this.community ? this.community.status() : null };
  }
}
