// Shared small pieces. No dependencies, no side effects beyond console.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58 for 32-byte account keys. Hand-rolled so the decode path needs no
 * dependency — the worker's only deps are the DB client and socket.io.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base58(bytes) {
  let x = 0n;
  for (const b of bytes) x = x * 256n + BigInt(b);
  let out = "";
  while (x > 0n) {
    out = ALPHABET[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** @param {number} x @param {number} lo @param {number} hi */
export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** @param {string} a */
export function short(a) {
  return a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/**
 * Insertion-ordered set with a cap — the signature dedupe. Map iteration
 * order is insertion order, so the first key is always the oldest.
 */
export class LruSet {
  /** @param {number} cap */
  constructor(cap) {
    this.cap = cap;
    /** @type {Set<string>} */
    this.set = new Set();
  }
  /** @param {string} key @returns {boolean} true when the key was NEW */
  add(key) {
    if (this.set.has(key)) return false;
    this.set.add(key);
    if (this.set.size > this.cap) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
    return true;
  }
}

/**
 * Capped map evicting its oldest entry. Re-setting a key refreshes its age.
 * @template V
 */
export class LruMap {
  /** @param {number} cap */
  constructor(cap) {
    this.cap = cap;
    /** @type {Map<string, V>} */
    this.map = new Map();
  }
  /** @param {string} key @param {V} value */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  /** @param {string} key @returns {V | undefined} */
  get(key) {
    return this.map.get(key);
  }
  /** @param {string} key */
  has(key) {
    return this.map.has(key);
  }
  /** @param {string} key */
  delete(key) {
    return this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
  /** Oldest first, like the map underneath. Deleting while iterating is safe. */
  [Symbol.iterator]() {
    return this.map[Symbol.iterator]();
  }
  entries() {
    return this.map.entries();
  }
  keys() {
    return this.map.keys();
  }
}

/** Timestamped stdout line — Render's log view has no timestamps of its own. */
export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
