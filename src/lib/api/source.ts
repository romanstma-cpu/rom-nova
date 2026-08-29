// Where a payload actually came from.
//
// The provider layer has been finished and correct for a while: `types.ts`
// declares the contracts, `registry.ts` resolves each capability to the best
// configured adapter, and the demo adapters implement the same interfaces over
// the synthetic store. Its own header says the app depends on those interfaces
// only.
//
// That was aspirational. Every handler took a concrete `DemoStore`, so
// `getProviders()` resolved to keyless live adapters that nothing ever called,
// and `/status` had to describe them as "tested and NOT YET CONSUMED". This is
// the seam that lets a handler ask for data without knowing who answers.
//
// WHY PROVENANCE TRAVELS WITH THE DATA
//
// Nova is published with a global SIMULATED DATA chip in the nav and the top
// bar. That chip is honest today because everything except the SOL reference
// price is synthetic. The moment one panel is real it becomes the dangerous
// kind of wrong — a reader who has been told the whole screen is a simulation
// will discount a real number, and a reader who notices one real panel will
// trust a synthetic one beside it.
//
// So nothing here returns bare data. Every answer carries the adapter that
// produced it and whether it is real, and a fallback is required to SAY it fell
// back. Silent degradation to the simulator, wearing a live label, is the one
// outcome this file exists to make impossible.

import type { Candle } from "../types";
import type { DemoStore } from "../demo/store";
import { getProviders } from "../providers/registry";

export interface Provenance {
  /** The adapter that actually answered. "demo" is the simulator. */
  source: string;
  /** True only when real market data served this payload. */
  real: boolean;
  /** Present when the answer is not the one the configuration implies. */
  note?: string;
}

export interface Sourced<T> {
  data: T;
  provenance: Provenance;
}

export const DEMO: Provenance = {
  source: "demo",
  real: false,
  note: "deterministic synthetic universe",
};

/**
 * Candles for a mint, from the best configured source.
 *
 * GeckoTerminal is the only keyless adapter with history — roughly a thousand
 * hourly bars — which is why candles are the first capability through this
 * seam. DEX Screener has no OHLCV endpoint at all, so with only it configured
 * the market slot stays on the simulator and says so.
 *
 * A live source that answers with nothing is treated as a miss, not as an empty
 * truth. A brand-new mint with no pool history and a rate-limited request look
 * identical from here, and both should show the reader a simulator label rather
 * than an empty chart captioned "live".
 */
export async function candlesFor(
  store: DemoStore,
  mint: string,
  from?: number,
  to?: number,
): Promise<Sourced<Candle[]>> {
  const market = getProviders().market;
  const fallback = (note?: string): Sourced<Candle[]> => ({
    data: store.candles(mint, from, to),
    provenance: note ? { ...DEMO, note } : DEMO,
  });

  if (market.name === "demo") return fallback();

  try {
    // The provider contract takes a closed range; the store's is open-ended, so
    // an absent bound becomes the widest window the adapter will serve rather
    // than being passed through as undefined.
    const candles = await market.getCandles(mint, from ?? 0, to ?? Date.now());
    if (candles.length > 0) {
      return { data: candles, provenance: { source: market.name, real: true } };
    }
    return fallback(`${market.name} returned no history for this mint`);
  } catch (err) {
    // The reason is kept rather than swallowed. A provider failing silently
    // behind a demo label is indistinguishable from one that is working, which
    // is how a dead integration survives for weeks.
    //
    // But a 404 is not a failure and must not be reported as one. Every mint in
    // the synthetic universe 404s by construction — it does not exist on
    // Solana — so labelling that "coingecko unavailable" would tell a reader
    // the integration is broken on every demo token they open, which is both
    // false and the fastest way to teach them to ignore the chip.
    const why = err instanceof Error ? err.message : String(err);
    const missing = /\b404\b/.test(why);
    return fallback(
      missing
        ? `not listed on ${market.name} — no on-chain history for this mint`
        : `${market.name} unavailable — ${why}`,
    );
  }
}

/**
 * A short human label for a provenance, for the chip a panel renders.
 *
 * Deliberately names the vendor rather than saying "LIVE". "LIVE" is a claim
 * about freshness; "geckoterminal" is a claim about origin, and origin is what
 * a reader needs to judge the number.
 */
export function provenanceLabel(p: Provenance): string {
  return p.real ? p.source.toUpperCase() : "SIMULATED";
}
