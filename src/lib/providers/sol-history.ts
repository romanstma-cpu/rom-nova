// The SOL/USD price AT THE TIME OF A FILL.
//
// A memecoin trade is denominated in SOL. The chain records "0.42 SOL for
// 1,200 tokens" and says nothing about dollars, so turning a fill into USD
// needs the SOL price on the day it happened — not today's.
//
// That distinction is not pedantry. SOL moved from $74 to $105 inside the last
// thirty days of bars this file reads; valuing a three-week-old entry at
// today's price would misstate the cost basis by forty percent and, because
// entries and exits would both be shifted, would land the error entirely in the
// PnL. A wallet that broke even would be shown a profit.
//
// WHY THESE THREE SOURCES
//
// Measured with an explicit `Origin: app://rom-nova` header, which is what the
// Electron shell sends and what a bare GET will never tell you:
//
//   crypto.com   371ms   CORS app://rom-nova   1h bars
//   coinbase     293ms   CORS *                1h bars, 350 of them
//   kraken       320ms   CORS app://rom-nova   1h bars
//   binance      451     GEO-BLOCKED, no CORS header at all
//
// Binance is the one every tutorial reaches for and it is the one that cannot
// be used. Crypto.com leads because the app already depends on it for the SOL
// reference price in the header, so a failure there is a failure the /status
// page already reports rather than a new silent dependency.

import { providerFetch } from "./http";

/** Bars are hourly; a fill is priced at the close of the hour it landed in. */
export const BAR_MS = 3_600_000;

export interface SolBar {
  /** ms epoch, bar open. */
  t: number;
  close: number;
}

interface CryptoComCandles {
  result?: { data?: { t?: number; c?: string }[] };
}

/**
 * An hourly SOL/USD series, newest last.
 *
 * `count` is the number of bars. 350 covers about fourteen days, comfortably
 * more than the two-day window a keyless wallet read can reach, so a fill
 * should never fall off the front of this series in practice — and when one
 * does, `solUsdAt` returns undefined rather than reaching for the nearest bar
 * it can find.
 */
export async function fetchSolBars(count = 350): Promise<SolBar[]> {
  try {
    const body = await providerFetch<CryptoComCandles>(
      "cryptocom",
      `https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=SOL_USD&timeframe=1h&count=${count}`,
      { timeoutMs: 8_000 },
    );
    const bars = parseCryptoCom(body);
    if (bars.length > 0) return bars;
  } catch {
    // Fall through. One exchange being unreachable is not a reason to price
    // every fill at today's SOL, which is the failure this file exists to stop.
  }
  try {
    const rows = await providerFetch<number[][]>(
      "coinbase",
      "https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600",
      { timeoutMs: 8_000 },
    );
    return parseCoinbase(rows);
  } catch {
    return [];
  }
}

/** Crypto.com returns `t` in ms and prices as strings. */
export function parseCryptoCom(body: CryptoComCandles): SolBar[] {
  const out: SolBar[] = [];
  for (const row of body.result?.data ?? []) {
    const t = Number(row.t);
    const close = Number(row.c);
    if (Number.isFinite(t) && Number.isFinite(close) && close > 0) out.push({ t, close });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Coinbase returns `[time, low, high, open, close, volume]`, seconds, newest
 * first. The column order is the one thing to get wrong here: reading index 3
 * instead of 4 would silently price every fill at the hour's OPEN, which is
 * plausible enough that no test would catch it by looking at the number.
 */
export function parseCoinbase(rows: number[][]): SolBar[] {
  const out: SolBar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = row[0] * 1000;
    const close = row[4];
    if (Number.isFinite(t) && Number.isFinite(close) && close > 0) out.push({ t, close });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The SOL price for one moment, or undefined when the series does not cover it.
 *
 * Undefined rather than the nearest available bar. A fill from before the
 * series begins is a fill whose dollar value nobody here measured, and
 * substituting the oldest bar would produce a confident number from a
 * three-week-old price.
 */
export function solUsdAt(bars: readonly SolBar[], ts: number): number | undefined {
  if (bars.length === 0) return undefined;
  const first = bars[0].t;
  const last = bars[bars.length - 1].t;
  // One bar of slack past the newest: a fill from the current, still-forming
  // hour belongs to the last closed bar, not to nothing.
  if (ts < first || ts >= last + 2 * BAR_MS) return undefined;

  // Binary search for the last bar opening at or before ts.
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bars[mid].t <= ts) lo = mid;
    else hi = mid - 1;
  }
  return bars[lo].close;
}

let cache: { at: number; bars: SolBar[] } | null = null;
let inflight: Promise<SolBar[]> | null = null;

/** Bars change once an hour; refetching per wallet would be pure waste. */
export const SOL_BARS_CACHE_MS = 10 * 60_000;

export async function getSolBars(): Promise<SolBar[]> {
  if (cache && Date.now() - cache.at < SOL_BARS_CACHE_MS) return cache.bars;
  if (inflight) return inflight;
  inflight = fetchSolBars().finally(() => {
    inflight = null;
  });
  const bars = await inflight;
  // An empty result is not cached: it means both exchanges failed, and the next
  // caller should get a real attempt rather than ten minutes of blindness.
  if (bars.length > 0) cache = { at: Date.now(), bars };
  return bars.length > 0 ? bars : (cache?.bars ?? []);
}
