// API keys: a session's stand-in for scripts and bots, which do not read
// email codes.
//
// A signed-in reader mints a key on the account page. The worker shows it
// ONCE and keeps only its SHA-256; a leaked database leaks nothing that
// opens the feed. The key rides in the same place a session token does —
// the Bearer header, or the socket handshake's auth — and the gate treats
// its owner exactly as it would that owner's session, so a lapsed
// subscriber's key stops working the minute their session would.
//
// A sliding-window rate limit per key keeps one script from becoming
// everyone's outage; the window is a minute, the count is the operator's.

import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./http-error.js";

export const KEY_PREFIX = "nova_";
/** 30 random bytes → 40 base64url characters after the prefix. */
const KEY_BYTES = 30;
/** How much of the key the list shows, so a reader can tell two apart. */
const PREFIX_CHARS = 8;
const RESOLVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const TOUCH_EVERY_MS = 60_000;
const CACHE_CAP = 5_000;
const NAME_MAX = 60;

/** @returns {{ key: string, hash: string, prefix: string }} */
export function generateKey() {
  const key = KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
  return { key, hash: hashKey(key), prefix: key.slice(KEY_PREFIX.length, KEY_PREFIX.length + PREFIX_CHARS) };
}

/** @param {string} key */
export function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

/** Is this a key of ours in shape? Says nothing about whether it is live. */
export function looksLikeApiKey(v) {
  return typeof v === "string" && v.startsWith(KEY_PREFIX) && v.length >= KEY_PREFIX.length + 20 && v.length <= 120 && /^[A-Za-z0-9_-]+$/.test(v.slice(KEY_PREFIX.length));
}

/** The row as its owner may see it: never the hash. */
export function publicKeyRow(row) {
  return {
    id: row.id,
    prefix: KEY_PREFIX + row.prefix + "…",
    name: typeof row.name === "string" ? row.name : "",
    created_at: row.created_at ?? null,
    last_used_at: row.last_used_at ?? null,
  };
}

/** A sliding one-minute window per subject. */
export class RateLimiter {
  /** @param {{ perMinute?: number, now?: () => number }} [opts] */
  constructor(opts = {}) {
    this.perMinute = opts.perMinute ?? 60;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
    this.counts = { allowed: 0, limited: 0 };
  }

  /** @param {string} subject @returns {{ ok: boolean, remaining: number, retryAfterS: number }} */
  take(subject) {
    const now = this.now();
    const floor = now - 60_000;
    const times = (this.hits.get(subject) ?? []).filter((t) => t > floor);
    if (times.length >= this.perMinute) {
      this.hits.set(subject, times);
      this.counts.limited++;
      return { ok: false, remaining: 0, retryAfterS: Math.max(1, Math.ceil((times[0] + 60_000 - now) / 1000)) };
    }
    times.push(now);
    this.hits.set(subject, times);
    this.counts.allowed++;
    if (this.hits.size > CACHE_CAP) this.prune(floor);
    return { ok: true, remaining: this.perMinute - times.length, retryAfterS: 0 };
  }

  /** @param {number} floor */
  prune(floor) {
    for (const [k, times] of this.hits) if (times.length === 0 || times[times.length - 1] <= floor) this.hits.delete(k);
  }
}

export class ApiKeys {
  /**
   * @param {{ createApiKey: (row: any) => Promise<any>, listApiKeys: (userId: string) => Promise<any[]>, revokeApiKey: (userId: string, id: string, at: string) => Promise<boolean>, findApiKeyByHash: (hash: string) => Promise<any>, touchApiKey: (id: string, at: string) => Promise<void>, apiReady: boolean | null }} db
   * @param {{ now?: () => number, maxPerUser?: number }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.maxPerUser = opts.maxPerUser ?? 10;
    /** @type {Map<string, { until: number, hit: { id: string, user_id: string } | null }>} */
    this.cache = new Map();
    /** @type {Map<string, number>} */
    this.touched = new Map();
    this.counts = { created: 0, revoked: 0, resolves: 0, hits: 0, unknown: 0 };
  }

  get ready() {
    return this.db.apiReady === true;
  }

  /** @param {{ id: string }} user @param {unknown} name */
  async create(user, name) {
    if (!this.ready) throw new HttpError(503, "API keys are not set up on this radar yet — the accounts migration is missing");
    const existing = await this.db.listApiKeys(user.id);
    if (existing.length >= this.maxPerUser) throw new HttpError(409, `at most ${this.maxPerUser} keys — revoke one first`);
    const label = typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "";
    const k = generateKey();
    const row = await this.db.createApiKey({
      user_id: user.id,
      key_hash: k.hash,
      prefix: k.prefix,
      name: label,
      created_at: new Date(this.now()).toISOString(),
    });
    this.counts.created++;
    // The only time the key itself leaves this process.
    return { ...publicKeyRow(row), key: k.key };
  }

  /** @param {string} userId */
  async list(userId) {
    if (!this.ready) return [];
    return (await this.db.listApiKeys(userId)).map(publicKeyRow);
  }

  /** @param {string} userId @param {string} id */
  async revoke(userId, id) {
    if (!this.ready) throw new HttpError(503, "API keys are not set up on this radar yet");
    const ok = await this.db.revokeApiKey(userId, id, new Date(this.now()).toISOString());
    if (ok) {
      this.counts.revoked++;
      for (const [hash, e] of this.cache) if (e.hit?.id === id) this.cache.delete(hash);
    }
    return ok;
  }

  /**
   * Whose key is this? Cached a minute; a revoked key drops out of the
   * cache at once on this process and within a minute on any other.
   * @param {string} key @returns {Promise<{ id: string, user_id: string } | null>}
   */
  async resolve(key) {
    if (!looksLikeApiKey(key)) return null;
    this.counts.resolves++;
    const now = this.now();
    const hash = hashKey(key);
    const cached = this.cache.get(hash);
    if (cached && cached.until > now) {
      this.counts.hits++;
      if (cached.hit) this.touch(cached.hit.id);
      return cached.hit;
    }
    const row = this.ready ? await this.db.findApiKeyByHash(hash) : null;
    const hit = row && !row.revoked_at ? { id: row.id, user_id: row.user_id } : null;
    if (this.cache.size >= CACHE_CAP) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hash, { until: now + (hit ? RESOLVE_TTL_MS : NEGATIVE_TTL_MS), hit });
    if (!hit) this.counts.unknown++;
    else this.touch(hit.id);
    return hit;
  }

  /** last_used_at, written at most once a minute per key, never awaited. */
  touch(id) {
    const now = this.now();
    const last = this.touched.get(id) ?? 0;
    if (now - last < TOUCH_EVERY_MS) return;
    this.touched.set(id, now);
    this.db.touchApiKey(id, new Date(now).toISOString()).catch(() => {});
  }

  status() {
    return { ready: this.ready, ...this.counts, cached: this.cache.size };
  }
}
