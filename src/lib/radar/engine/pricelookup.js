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

// Second source. DexScreener throttles by address, and a Render box shares
// its address with strangers: in production the first hour read nine 429s
// in fourteen calls. Jupiter's keyless price endpoint (the one the wallet
// page already uses) quotes in USD; dividing by SOL's own USD quote from the
// same call gives SOL per token. No names or liquidity from this path, but
// a grade is a price, and a price is what the worker was missing.
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
let jupCalls = 0;
let jupFailures = 0;
let jupBackoffMs = 0;
let jupBlockedUntil = 0;
let jupLastError = "";

let calls = 0;
let failures = 0;
let skipped = 0;
let lastError = "";

// Backoff. DexScreener's published limit is generous, but a Render box
// shares its egress address with strangers and gets 429s the moment a
// neighbour is busy; hammering through them just extends the ban. After a
// failure the next call waits — 30s, then double, up to five minutes — and
// a success resets the wait. Callers see an empty map during the wait and
// count it as a skip, never as a quote.
export const BACKOFF_MIN_MS = 30_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
let backoffMs = 0;
let blockedUntil = 0;

/** Test seam. */
export function resetLookup() {
  calls = 0;
  failures = 0;
  skipped = 0;
  lastError = "";
  backoffMs = 0;
  blockedUntil = 0;
  jupCalls = 0;
  jupFailures = 0;
  jupBackoffMs = 0;
  jupBlockedUntil = 0;
  jupLastError = "";
}

/**
 * SOL prices from Jupiter for mints DexScreener could not answer. Own
 * backoff, same shape. Exported so a driver can probe it on its own.
 *
 * @param {string[]} mints
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [now]
 * @returns {Promise<Map<string, PriceMark>>}
 */
export async function jupiterSolPrices(mints, fetchImpl = fetch, now = Date.now()) {
  const out = new Map();
  const batch = [...new Set(mints)].filter((m) => m !== WSOL).slice(0, LOOKUP_BATCH);
  if (batch.length === 0 || now < jupBlockedUntil) return out;
  jupCalls++;
  try {
    const res = await fetchImpl(`${JUP_PRICE}?ids=${[...batch, WSOL].join(",")}`, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = await res.json();
    const solUsd = Number(body?.[WSOL]?.usdPrice);
    if (!(solUsd > 0)) throw new Error("no SOL quote in the reply");
    jupBackoffMs = 0;
    const at = Date.now();
    for (const mint of batch) {
      const usd = Number(body?.[mint]?.usdPrice);
      if (!(usd > 0)) continue;
      out.set(mint, { priceSol: usd / solUsd, at, name: null, symbol: null, liquidityUsd: null });
    }
  } catch (e) {
    jupFailures++;
    jupLastError = e instanceof Error ? e.message : String(e);
    jupBackoffMs = jupBackoffMs === 0 ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, jupBackoffMs * 2);
    jupBlockedUntil = now + jupBackoffMs;
  }
  return out;
}

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
 * @param {number} [now]
 * @returns {Promise<Map<string, PriceMark>>}
 */
export async function lookupSolPrices(mints, fetchImpl = fetch, now = Date.now()) {
  const out = new Map();
  const batch = [...new Set(mints)].slice(0, LOOKUP_BATCH);
  if (batch.length === 0) return out;
  if (now < blockedUntil) {
    skipped++;
    // DexScreener is resting; Jupiter may still answer.
    for (const [m, v] of await jupiterSolPrices(batch, fetchImpl, now)) out.set(m, v);
    return out;
  }
  calls++;
  try {
    const res = await fetchImpl(BASE + batch.join(","), { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) {
      // Honour a Retry-After when the server names one; otherwise back off.
      const retry = Number(res.headers?.get?.("retry-after"));
      backoffMs = backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, backoffMs * 2);
      blockedUntil = now + (retry > 0 ? Math.max(retry * 1000, backoffMs) : backoffMs);
      throw new Error(`http ${res.status}`);
    }
    backoffMs = 0;
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
    // A network failure with no status backs off the same way.
    if (blockedUntil <= now) {
      backoffMs = backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, backoffMs * 2);
      blockedUntil = now + backoffMs;
    }
  }
  // Whatever DexScreener left unpriced — a failed call, or a token it has
  // no SOL pair for — Jupiter gets a chance at.
  const missing = batch.filter((m) => !out.has(m));
  if (missing.length > 0) {
    for (const [m, v] of await jupiterSolPrices(missing, fetchImpl, now)) out.set(m, v);
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
  return {
    calls,
    failures,
    skipped,
    lastError: lastError || null,
    backoffMs,
    blockedUntil: blockedUntil || null,
    jupiter: { calls: jupCalls, failures: jupFailures, backoffMs: jupBackoffMs, lastError: jupLastError || null },
  };
}
