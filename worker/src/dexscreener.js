// DexScreener token lookups — names and USD context for signals.
//
// The worker's own launch record is the first authority on a token's name
// (it heard the creation frame); DexScreener fills in tokens whose launch
// predates this process, and adds USD price and liquidity to the signal
// payload the frontend shows. Keyless, rate-limited to stay far inside
// their 300 req/min, cached because signal bursts cluster on hot mints.

import { LruMap, log } from "../../src/lib/radar/engine/util.js";

const BASE = "https://api.dexscreener.com/latest/dex/tokens/";
const TTL_MS = 60_000;
const MIN_GAP_MS = 300; // ≤ ~3.3 req/s

const cache = new LruMap(2_000);
let lastCallAt = 0;
let calls = 0;
let failures = 0;

/**
 * @param {string} mint
 * @returns {Promise<{ name: string | null, symbol: string | null, priceUsd: number | null, liquidityUsd: number | null } | null>}
 */
export async function dexScreenerLookup(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

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
    cache.set(mint, { at: Date.now(), value });
    return value;
  } catch (e) {
    failures++;
    if (failures <= 3) log("[dexscreener]", e instanceof Error ? e.message : String(e));
    cache.set(mint, { at: Date.now(), value: null });
    return null;
  }
}

export function dexScreenerStatus() {
  return { calls, failures, cached: cache.size };
}
