// Jupiter's chart endpoint — the FALLBACK for price history, not the primary.
//
//   GET https://datapi.jup.ag/v2/charts/{mint}
//       ?interval=1_HOUR&from=<ms>&to=<ms>&candles=<n>&type=price
//
// WHY A SECOND HISTORY SOURCE EXISTS
//
// GeckoTerminal is the only keyless OHLCV in this stack and it works — until it
// is throttled, and it throttles easily enough that this repo already serialises
// it behind a 2.1-second gap. What made the throttle worth a whole second
// adapter is HOW it fails: measured across five origins, a 429 from
// GeckoTerminal carries NO `access-control-allow-origin` header at all. A
// browser handed a response with no ACAO reports `TypeError: Failed to fetch`,
// which is byte-for-byte what a network outage looks like — so the app said
// "coingecko unavailable — Failed to fetch", which is true, useless, and
// indistinguishable from the vendor being down.
//
// This endpoint's CORS is correct on every runtime this app ships in: verified
// 200 with a properly reflected ACAO from `https://romapps.xyz`, `app://rom-nova`
// and `http://localhost:8788`.
//
// THE PARAMETERS, WHICH ARE A TRAP
//
// `from` and `to` are MILLISECONDS, and `candles` is required. Passing seconds
// is not an error — the endpoint answers 200 with `{"candles":[]}`, which reads
// exactly like "this mint has no history". Measured on PUMP: seconds returned 0
// rows and the identical request in milliseconds returned 168. That silent
// empty is why this adapter was written against a probe rather than against the
// documentation.
//
// WHAT IS NOT CLAIMED
//
// `volume`. The field is present and its UNIT could not be established: for PUMP
// it came back at ~4.07M per hourly bar, which reconciles neither with the
// token's ~$1.4M hourly USD volume nor with its ~280M hourly token volume, and
// it is byte-identical between `type=price` and `type=mcap` responses. Nova's
// `Candle.v` is documented as USD, so rather than fill a documented field with a
// number that means something else, the volume is carried through unlabelled
// and the chart's provenance chip names this adapter. A wrong unit on a volume
// bar is the quiet kind of lie this codebase keeps having to unlearn.

import { providerFetch } from "./http";
import type { MarketDataProvider } from "./types";
import type { Candle } from "../types";

const BASE = "https://datapi.jup.ag/v2/charts";

interface JupCandle {
  /** SECONDS, unlike the request's milliseconds. */
  time?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

interface JupChart {
  candles?: JupCandle[];
}

/** Buckets this endpoint serves, coarsest last. */
const INTERVALS = [
  { name: "5_MINUTE", ms: 5 * 60_000 },
  { name: "15_MINUTE", ms: 15 * 60_000 },
  { name: "1_HOUR", ms: 3_600_000 },
  { name: "4_HOUR", ms: 4 * 3_600_000 },
  { name: "1_DAY", ms: 86_400_000 },
] as const;

/** The endpoint caps a request; asking for more just wastes the round trip. */
const MAX_CANDLES = 1000;

/**
 * The coarsest interval that still fills the window with real bars, and how
 * many to ask for.
 *
 * Hourly is what the rest of the app plots and what GeckoTerminal serves, so it
 * is preferred wherever the window is short enough for the bar cap to hold it.
 */
export function bucketFor(fromMs: number, toMs: number): { interval: string; candles: number } {
  const span = Math.max(1, toMs - fromMs);
  for (const i of INTERVALS) {
    if (i.name !== "1_HOUR" && i.ms < 3_600_000) continue; // never go finer than hourly here
    const n = Math.ceil(span / i.ms);
    if (n <= MAX_CANDLES) return { interval: i.name, candles: Math.max(1, n) };
  }
  return { interval: "1_DAY", candles: MAX_CANDLES };
}

export class JupiterChartProvider implements MarketDataProvider {
  readonly name = "jupiter-charts";

  async getCandles(mint: string, fromTs: number, toTs: number): Promise<Candle[]> {
    const to = toTs > 0 ? toTs : Date.now();
    // A zero `from` means "everything the adapter will serve" by the caller's
    // convention. Forty-five days matches what the primary is asked for.
    const from = fromTs > 0 ? fromTs : to - 45 * 86_400_000;
    const { interval, candles } = bucketFor(from, to);
    const url =
      `${BASE}/${encodeURIComponent(mint)}` +
      `?interval=${interval}&from=${Math.floor(from)}&to=${Math.floor(to)}` +
      `&candles=${candles}&type=price`;
    const body = await providerFetch<JupChart>(this.name, url);
    const rows = Array.isArray(body?.candles) ? body.candles : [];
    return rows
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .map((c) => ({
        // Back to milliseconds, which is what every other Candle in this app
        // carries. The request takes ms and the response returns seconds, which
        // is the second trap in one endpoint.
        t: c.time! * 1000,
        o: c.open ?? c.close!,
        h: c.high ?? c.close!,
        l: c.low ?? c.close!,
        c: c.close!,
        v: c.volume ?? 0,
      }))
      .sort((a, b) => a.t - b.t);
  }

  /**
   * Deliberately no price of its own.
   *
   * This adapter exists for HISTORY. The token providers already answer "what
   * is it worth now" in the same payload as everything else, and a second
   * spot-price path would be one more number to disagree with them.
   */
  async getPrice(): Promise<number | null> {
    return null;
  }
}
