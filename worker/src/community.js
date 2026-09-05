// Community, the cheapest honest version: a count and a note.
//
// "I followed this signal" — a reader saying so becomes a number on the
// signal for every other reader, never a name, never an amount. And a
// short note on a tracked wallet, shown to signed-in readers of this radar
// under a pseudonym derived from the reader's id: stable, so a reader's
// notes hang together, and useless for finding out who they are. Both
// need a gate (there is no "who" on an open radar), both go through the
// worker so the tables never meet the public key, and both are capped so
// one keyboard cannot become everyone's feed.

import { createHash } from "node:crypto";
import { HttpError } from "./http-error.js";

export const NOTE_MAX = 280;
/** Notes one reader may leave on one wallet. */
export const NOTES_PER_WALLET = 3;
/** Notes one reader may leave in an hour, across wallets. */
export const NOTES_PER_HOUR = 10;
const COUNT_TTL_MS = 30_000;
const COUNT_CACHE_CAP = 5_000;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44}:\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;

/** The pseudonym a reader's notes appear under: six hex of a hash of their id. */
export function handleOf(userId) {
  return `reader-${createHash("sha256").update(String(userId)).digest("hex").slice(0, 6)}`;
}

/** A note as it may be stored: trimmed, whitespace collapsed, printable, bounded. */
export function cleanNote(body) {
  if (typeof body !== "string") throw new HttpError(400, "a note is text");
  const text = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new HttpError(400, "a note needs some words");
  if (text.length > NOTE_MAX) throw new HttpError(400, `a note is at most ${NOTE_MAX} characters`);
  return text;
}

/** A note as other readers see it. */
export function publicNote(row, viewerId) {
  return {
    id: row.id,
    handle: handleOf(row.user_id),
    body: row.body,
    created_at: row.created_at ?? null,
    mine: row.user_id === viewerId,
  };
}

export class Community {
  /**
   * @param {{ communityReady: boolean | null, addFollow: (row: any) => Promise<void>, removeFollow: (userId: string, key: string) => Promise<void>, countFollows: (keys: string[]) => Promise<Map<string, number>>, listNotes: (wallet: string, limit: number) => Promise<any[]>, countUserNotes: (userId: string, wallet: string) => Promise<number>, addNote: (row: any) => Promise<any>, deleteNote: (userId: string, id: string) => Promise<boolean> }} db
   * @param {{ now?: () => number, onFollowers?: (signalKey: string, followers: number) => void }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.onFollowers = opts.onFollowers ?? (() => {});
    /** @type {Map<string, { n: number, until: number }>} */
    this.countCache = new Map();
    /** @type {Map<string, number[]>} */
    this.noteTimes = new Map();
    this.counts = { follows: 0, unfollows: 0, notes: 0, deleted: 0, refused: 0 };
  }

  get ready() {
    return this.db.communityReady === true;
  }

  requireReady() {
    if (!this.ready) throw new HttpError(503, "community is not set up on this radar yet — the community migration is missing");
  }

  /** @param {{ id: string }} user @param {unknown} signalKey */
  async follow(user, signalKey) {
    this.requireReady();
    const key = this.keyOf(signalKey);
    await this.db.addFollow({ user_id: user.id, signal_key: key, at: new Date(this.now()).toISOString() });
    this.counts.follows++;
    const followers = await this.countOne(key, true);
    this.onFollowers(key, followers);
    return { signal_key: key, followers };
  }

  /** @param {{ id: string }} user @param {unknown} signalKey */
  async unfollow(user, signalKey) {
    this.requireReady();
    const key = this.keyOf(signalKey);
    await this.db.removeFollow(user.id, key);
    this.counts.unfollows++;
    const followers = await this.countOne(key, true);
    this.onFollowers(key, followers);
    return { signal_key: key, followers };
  }

  /** @param {unknown} v */
  keyOf(v) {
    if (typeof v !== "string" || !KEY_RE.test(v)) {
      this.counts.refused++;
      throw new HttpError(400, "signal_key must be a signal's own key: wallet:mint:timestamp");
    }
    return v;
  }

  /**
   * Follow counts for signal keys, cached half a minute each.
   * @param {string[]} keys @returns {Promise<Record<string, number>>}
   */
  async followerCounts(keys) {
    const now = this.now();
    /** @type {Record<string, number>} */
    const out = {};
    const missing = [];
    for (const k of keys.slice(0, 100)) {
      const hit = this.countCache.get(k);
      if (hit && hit.until > now) out[k] = hit.n;
      else missing.push(k);
    }
    if (missing.length > 0 && this.ready) {
      const fresh = await this.db.countFollows(missing);
      for (const k of missing) {
        const n = fresh.get(k) ?? 0;
        out[k] = n;
        this.remember(k, n, now);
      }
    } else {
      for (const k of missing) out[k] = 0;
    }
    return out;
  }

  /** @param {string} key @param {boolean} fresh */
  async countOne(key, fresh) {
    if (fresh) this.countCache.delete(key);
    return (await this.followerCounts([key]))[key] ?? 0;
  }

  remember(key, n, now) {
    if (this.countCache.size >= COUNT_CACHE_CAP) {
      const oldest = this.countCache.keys().next().value;
      if (oldest !== undefined) this.countCache.delete(oldest);
    }
    this.countCache.set(key, { n, until: now + COUNT_TTL_MS });
  }

  /** @param {{ id: string }} user @param {string} wallet */
  async notes(user, wallet) {
    this.requireReady();
    if (!ADDRESS_RE.test(wallet)) throw new HttpError(400, "that is not a Solana address");
    const rows = await this.db.listNotes(wallet, 50);
    return rows.map((r) => publicNote(r, user.id));
  }

  /** @param {{ id: string }} user @param {string} wallet @param {unknown} body */
  async addNote(user, wallet, body) {
    this.requireReady();
    if (!ADDRESS_RE.test(wallet)) throw new HttpError(400, "that is not a Solana address");
    const text = cleanNote(body);
    const now = this.now();
    const times = (this.noteTimes.get(user.id) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= NOTES_PER_HOUR) {
      this.counts.refused++;
      throw new HttpError(429, `at most ${NOTES_PER_HOUR} notes an hour`);
    }
    if ((await this.db.countUserNotes(user.id, wallet)) >= NOTES_PER_WALLET) {
      this.counts.refused++;
      throw new HttpError(409, `at most ${NOTES_PER_WALLET} notes on one wallet — delete one first`);
    }
    times.push(now);
    this.noteTimes.set(user.id, times);
    const row = await this.db.addNote({ user_id: user.id, wallet_address: wallet, body: text, created_at: new Date(now).toISOString() });
    this.counts.notes++;
    return publicNote(row, user.id);
  }

  /** @param {{ id: string }} user @param {string} id */
  async deleteNote(user, id) {
    this.requireReady();
    const ok = await this.db.deleteNote(user.id, id);
    if (ok) this.counts.deleted++;
    return ok;
  }

  status() {
    return { ready: this.ready, ...this.counts, cached_counts: this.countCache.size };
  }
}
