// A SOL price from outside the stream, for tokens the stream cannot see.
//
// The program-log firehose covers the pump.fun bonding curve and nothing
// else. A token that graduates trades on a pool the radar never hears, so
// its grades — and a reader's follow on it — would freeze at the last
// curve trade. DexScreener's token endpoint is keyless, answers up to
// thirty mints a call, and quotes each pair in its quote token; for a SOL
// pair that quote IS the SOL price the ledger measures in. Browser and Node
// run this same file: global fetch, no Buffer, no key.
//
// Rate: DexScreener allows 300 calls a minute. The drivers call this at
// most once every few seconds with a capped batch, which is a rounding
// error against that — and every failure is counted where /status and
// /health can show it.

const BASE = "https://api.dexscreener.com/latest/dex/tokens/";
const WSOL = "So11111111111111111111111111111111111111112";
/** Mints per call — DexScreener's own limit. */
export const LOOKUP_BATCH = 30;

let calls = 0;
let failures = 0;
let lastError = "";

/**
 * @typedef {object} PriceMark
 * @property {number} priceSol   SOL per token from the deepest SOL pair
 * @property {number} at         ms epoch of the lookup, this machine's clock
 * @property {string | null} name
 * @property {string | null} symbol
 * @property {number | null} liquidityUsd
 */

/**
 * Look up SOL prices for a batch of mints. Missing or unpriced mints are
 * absent from the result — never a zero. A failed call resolves to an
 * empty map so a tick never throws over a quote.
 *
 * @param {string[]} mints
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Map<string, PriceMark>>}
 */
export async function lookupSolPrices(mints, fetchImpl = fetch) {
  const out = new Map();
  const batch = [...new Set(mints)].slice(0, LOOKUP_BATCH);
  if (batch.length === 0) return out;
  calls++;
  try {
    const res = await fetchImpl(BASE + batch.join(","), { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = await res.json();
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    const at = Date.now();
    for (const mint of batch) {
      // The deepest SOL-quoted pair speaks for the token. Non-SOL quotes
      // (USDC pools) would need a second conversion and are left out.
      const best = pairs
        .filter((p) => p?.chainId === "solana" && p?.baseToken?.address === mint && p?.quoteToken?.address === WSOL)
        .sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
      const priceSol = best ? Number(best.priceNative) : NaN;
      if (!(priceSol > 0)) continue;
      out.set(mint, {
        priceSol,
        at,
        name: typeof best.baseToken?.name === "string" ? best.baseToken.name : null,
        symbol: typeof best.baseToken?.symbol === "string" ? best.baseToken.symbol : null,
        liquidityUsd: Number.isFinite(Number(best.liquidity?.usd)) ? Number(best.liquidity.usd) : null,
      });
    }
  } catch (e) {
    failures++;
    lastError = e instanceof Error ? e.message : String(e);
  }
  return out;
}

/** Pure: pick the marks out of a DexScreener body — the part worth testing without a network. */
export function marksFromBody(body, mints) {
  const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
  const out = new Map();
  for (const mint of mints) {
    const best = pairs
      .filter((p) => p?.chainId === "solana" && p?.baseToken?.address === mint && p?.quoteToken?.address === WSOL)
      .sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
    const priceSol = best ? Number(best.priceNative) : NaN;
    if (priceSol > 0) out.set(mint, priceSol);
  }
  return out;
}

export function lookupStatus() {
  return { calls, failures, lastError: lastError || null };
}
