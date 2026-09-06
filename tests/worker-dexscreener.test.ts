// The worker's name lookup and the brake it shares with the price path.
//
// Both files call api.dexscreener.com from the same Render box, which shares
// its egress address with strangers. pricelookup.js has always backed off
// when that address got 429'd; this one had no brake and kept calling
// straight through the ban, which is what extends it. Production read 114
// failures in 171 calls. These tests hold the brake in place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dexScreenerLookup, dexScreenerStatus, resetDexScreener } from "../worker/src/dexscreener.js";
import { BACKOFF_MIN_MS, lookupSolPrices, lookupStatus, resetLookup } from "../src/lib/radar/engine/pricelookup.js";

const T = 1_788_000_000_000;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const pairFor = (mint: string) => ({
  baseToken: { address: mint, name: "Bonk", symbol: "BONK" },
  priceUsd: "0.000021",
  liquidity: { usd: 4_200_000 },
});

const answers = (mint: string) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ pairs: [pairFor(mint)] }) }));
const refuses = (status: number) => vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));

describe("the worker's DexScreener lookup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    resetDexScreener();
    resetLookup();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the deepest pair and reports a clean status", async () => {
    vi.stubGlobal("fetch", answers(MINT));
    expect(await dexScreenerLookup(MINT)).toEqual({
      name: "Bonk",
      symbol: "BONK",
      priceUsd: 0.000021,
      liquidityUsd: 4_200_000,
    });
    expect(dexScreenerStatus()).toMatchObject({ calls: 1, failures: 0, skipped: 0, lastError: null, blockedUntil: null });
  });

  it("waits after a refusal instead of hammering through the ban", async () => {
    const fetchMock = refuses(429);
    vi.stubGlobal("fetch", fetchMock);

    expect(await dexScreenerLookup("A")).toBeNull();
    expect(dexScreenerStatus()).toMatchObject({ calls: 1, failures: 1, backoffMs: BACKOFF_MIN_MS });
    // The cause is on /health now, not just a count with no reason.
    expect(dexScreenerStatus().lastError).toBe("http 429");

    // A different mint one second later must not become a second request.
    vi.setSystemTime(T + 1_000);
    expect(await dexScreenerLookup("B")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dexScreenerStatus().skipped).toBe(1);
  });

  it("resumes when the wait is over, and an answer clears it", async () => {
    vi.stubGlobal("fetch", refuses(429));
    await dexScreenerLookup("A");

    vi.setSystemTime(T + BACKOFF_MIN_MS + 1);
    const ok = answers("C");
    vi.stubGlobal("fetch", ok);
    expect(await dexScreenerLookup("C")).not.toBeNull();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(dexScreenerStatus()).toMatchObject({ backoffMs: 0, blockedUntil: null });
  });

  it("goes quiet while the price path is serving out its own ban", async () => {
    // Same host, same address: a refusal there is a refusal here.
    const failing = vi.fn(async () => {
      throw new Error("http 429");
    });
    await lookupSolPrices(["A"], failing as never, T);
    expect(lookupStatus().blockedUntil).toBe(T + BACKOFF_MIN_MS);

    const fetchMock = answers("Z");
    vi.stubGlobal("fetch", fetchMock);
    vi.setSystemTime(T + 1_000);
    expect(await dexScreenerLookup("Z")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dexScreenerStatus()).toMatchObject({ calls: 0, skipped: 1 });
  });

  it("does not blank a mint it skipped — it looks it up once the wait lifts", async () => {
    const failing = vi.fn(async () => {
      throw new Error("http 429");
    });
    await lookupSolPrices(["A"], failing as never, T);

    const fetchMock = answers("Z");
    vi.stubGlobal("fetch", fetchMock);
    vi.setSystemTime(T + 1_000);
    expect(await dexScreenerLookup("Z")).toBeNull();

    // Caching the skip as null would have blanked this name for the full TTL.
    vi.setSystemTime(T + BACKOFF_MIN_MS + 1);
    expect(await dexScreenerLookup("Z")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
