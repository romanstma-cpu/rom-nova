// What the providers ACTUALLY did, as opposed to which ones are configured.
//
// Its own module because the two readers sit on opposite sides of a dependency
// edge: `api/source.ts` records the outcome and already imports the registry,
// so the registry cannot import back from it. A shared leaf breaks the cycle.
//
// WHY THIS EXISTS AT ALL
//
// `dataMode()` decided "prices & candles — LIVE" by testing the market
// provider's NAME. That is a fact about configuration. Whether the vendor is
// answering is a different question, and for candles the two come apart
// routinely: GeckoTerminal is the only keyless OHLCV in this stack, it
// rate-limits easily enough that this repo serialises it behind a 2.1-second
// gap, and — measured across five origins — its 429 carries NO
// `access-control-allow-origin` header. A browser handed a response with no
// ACAO reports `TypeError: Failed to fetch`, indistinguishable from the vendor
// being down.
//
// The result was a nav chip advertising live candles while every chart on the
// site fell back to the simulator.

/** How long an outcome is worth reporting before it stops describing "now". */
export const HEALTH_TTL_MS = 5 * 60_000;

export interface ProviderOutcome {
  ok: boolean;
  /** The failure reason, when there was one. */
  note?: string;
  at: number;
}

const outcomes = new Map<string, ProviderOutcome>();

/**
 * Record what a capability just did.
 *
 * Keyed by CAPABILITY ("candles") rather than by vendor, because the claim the
 * UI makes is about the capability and the vendor behind it may change.
 */
export function noteOutcome(capability: string, ok: boolean, note?: string): void {
  outcomes.set(capability, { ok, note, at: Date.now() });
}

/**
 * The last outcome for a capability, or null when there is none recent enough.
 *
 * Null means "nothing has been tried lately", which is genuinely different from
 * "it worked" — a caller must not read the absence as a pass. It is returned
 * before anything has been fetched, and callers fall back to reporting the
 * configuration, which is the only thing known at that point.
 */
export function lastOutcome(capability: string, now = Date.now()): ProviderOutcome | null {
  const hit = outcomes.get(capability);
  if (!hit || now - hit.at > HEALTH_TTL_MS) return null;
  return hit;
}

/** Test seam. Nothing in the app clears this; a process restart does. */
export function resetOutcomes(): void {
  outcomes.clear();
}
