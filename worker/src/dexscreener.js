// DexScreener token lookups — names and USD context for signals.
//
// The worker's own launch record is the first authority on a token's name
// (it heard the creation frame); DexScreener fills in tokens whose launch
// predates this process, and adds USD price and liquidity to the signal
// payload the frontend shows. Keyless, cached because signal bursts cluster
// on hot mints.

import { LruMap, log } from "../../src/lib/radar/engine/util.js";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, lookupStatus } from "../../src/lib/radar/engine/pricelookup.js";

const BASE = "https://api.dexscreener.com/latest/dex/tokens/";
const TTL_MS = 60_000;
const MIN_GAP_MS = 300; // ≤ ~3.3 req/s

let cache = new LruMap(2_000);
let lastCallAt = 0;
let calls = 0;
let failures = 0;
let skipped = 0;
let lastError = "";

// One brake, shared with the price path.
//
// This file and pricelookup.js call the SAME host from the SAME box. That
// file backs off hard — 30s, doubling to five minutes — because a Render
// address is shared with strangers and DexScreener 429s it the moment a
// neighbour is busy; its own comment says hammering through a ban only
// extends it. This file had no brake at all and kept calling at 3.3 req/s
// straight through, which in production read as 114 failures in 171 calls
// while the price path sat politely in its wait. The neighbour extending
// the ban was us.
//
// So the wait is honoured in both directions: this path stops when either
// it or the price path has been refused, and a refusal here is now visible
// on /health instead of being a bare count with no cause.
let backoffMs = 0;
let blockedUntil = 0;

/** The later of our own wait and the price path's — same host, same limit. */
function blockedThrough() {
  return Math.max(blockedUntil, lookupStatus().blockedUntil || 0);
}

/**
 * @param {string} mint
 * @returns {Promise<{ name: string | null, symbol: string | null, priceUsd: number | null, liquidityUsd: number | null } | null>}
 */
export async function dexScreenerLookup(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  // Not cached as null: a mint skipped during a ban must stay lookupable
  // the moment the ban lifts, or one 429 blanks every name for an hour.
  if (Date.now() < blockedThrough()) {
    skipped++;
    return null;
  }

  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  calls++;

  try {
    const res = await fetch(BASE + mint, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = await res.json();
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    // Deepest pair speaks for the token.
    const best = pairs
      .filter((p) => p?.baseToken?.address === mint)
      .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    const value = best
      ? {
          name: best.baseToken?.name ?? null,
          symbol: best.baseToken?.symbol ?? null,
          priceUsd: best.priceUsd != null ? Number(best.priceUsd) : null,
          liquidityUsd: best.liquidity?.usd ?? null,
        }
      : null;
    // An answer means the ban is over; the next failure starts again at 30s.
    backoffMs = 0;
    blockedUntil = 0;
    cache.set(mint, { at: Date.now(), value });
    return value;
  } catch (e) {
    const now = Date.now();
    failures++;
    lastError = e instanceof Error ? e.message : String(e);
    if (blockedUntil <= now) {
      backoffMs = backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, backoffMs * 2);
      blockedUntil = now + backoffMs;
      log("[dexscreener]", lastError, `- waiting ${Math.round(backoffMs / 1000)}s`);
    }
    cache.set(mint, { at: now, value: null });
    return null;
  }
}

export function dexScreenerStatus() {
  return {
    calls,
    failures,
    skipped,
    cached: cache.size,
    lastError: lastError || null,
    backoffMs,
    blockedUntil: blockedUntil || null,
  };
}

/** Test seam, mirroring resetLookup() in pricelookup.js. */
export function resetDexScreener() {
  // LruMap has no clear(); a fresh one is the reset.
  cache = new LruMap(2_000);
  lastCallAt = 0;
  calls = 0;
  failures = 0;
  skipped = 0;
  lastError = "";
  backoffMs = 0;
  blockedUntil = 0;
}
