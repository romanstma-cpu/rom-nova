// The provider seam has one job beyond fetching: never let the reader mistake
// the simulator for Solana, or Solana for the simulator.
//
// Every failure mode here is silent by nature. A rate-limited request, a mint
// with no pool history, and a working adapter with a quiet hour all return the
// same thing — nothing — and an app that renders that as an empty chart under a
// live badge has told the reader a lie without erroring once. These tests are
// guards on that single mistake, the same way unmeasured.test.ts guards the
// zeros a keyless provider reports for holder data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketDataProvider } from "@/lib/providers/types";
import type { TokenInfo, TokenSnapshot } from "@/lib/types";
import { buildLiveTokenRows } from "@/lib/api/rows";

const market: { current: MarketDataProvider } = {
  current: { name: "demo", getCandles: async () => [], getPrice: async () => null },
};

vi.mock("@/lib/providers/registry", () => ({
  getProviders: () => ({ mode: "demo", market: market.current }),
}));

import { candlesFor, provenanceLabel, DEMO } from "@/lib/api/source";
import { DemoStore } from "@/lib/demo/store";

const store = new DemoStore(77);
const mint = store.tokenList()[0].info.mint;

/** A live adapter that answers however the test needs it to. */
function live(impl: MarketDataProvider["getCandles"], name = "geckoterminal"): MarketDataProvider {
  return { name, getCandles: impl, getPrice: async () => null };
}

const oneCandle = [{ t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }];

beforeEach(() => {
  market.current = { name: "demo", getCandles: async () => [], getPrice: async () => null };
});

describe("candlesFor — provenance travels with the data", () => {
  it("reads the simulator when no live adapter is configured", async () => {
    const r = await candlesFor(store, mint);
    expect(r.provenance.source).toBe("demo");
    expect(r.provenance.real).toBe(false);
    expect(r.data.length).toBeGreaterThan(0);
  });

  it("never calls a live adapter when the demo one is resolved", async () => {
    const spy = vi.fn(async () => oneCandle);
    market.current = { name: "demo", getCandles: spy, getPrice: async () => null };
    await candlesFor(store, mint);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports the vendor by name when real data answers", async () => {
    market.current = live(async () => oneCandle);
    const r = await candlesFor(store, mint);
    expect(r.provenance).toEqual({ source: "geckoterminal", real: true });
    expect(r.data).toEqual(oneCandle);
  });

  it("passes a closed range, because the contract has no open bounds", async () => {
    const seen: number[][] = [];
    market.current = live(async (_m, from, to) => {
      seen.push([from, to]);
      return oneCandle;
    });
    await candlesFor(store, mint);
    expect(seen[0][0]).toBe(0);
    expect(seen[0][1]).toBeGreaterThan(0);
  });

  // The two silent failures. Both must degrade to the simulator AND say so.
  it("treats an empty live answer as a miss, not as an empty truth", async () => {
    market.current = live(async () => []);
    const r = await candlesFor(store, mint);
    expect(r.provenance.real).toBe(false);
    expect(r.provenance.source).toBe("demo");
    expect(r.provenance.note).toContain("geckoterminal");
    expect(r.data.length).toBeGreaterThan(0);
  });

  it("keeps the reason when a live adapter throws", async () => {
    market.current = live(async () => {
      throw new Error("429 rate limited");
    });
    const r = await candlesFor(store, mint);
    expect(r.provenance.real).toBe(false);
    expect(r.provenance.note).toContain("429 rate limited");
    expect(r.provenance.note).toContain("unavailable");
  });

  // Every synthetic mint 404s by construction — it does not exist on Solana.
  // Reporting that as an outage would mark the integration broken on every
  // demo token, teaching the reader to ignore the chip entirely.
  it("calls a 404 a missing listing, not an outage", async () => {
    market.current = live(async () => {
      throw new Error("[coingecko] HTTP 404 for /api/v2/networks/solana/tokens/abc");
    });
    const r = await candlesFor(store, mint);
    expect(r.provenance.note).toContain("not listed");
    expect(r.provenance.note).not.toContain("unavailable");
  });

  it("does not surface a live source name on a fallback", async () => {
    market.current = live(async () => {
      throw new Error("boom");
    });
    const r = await candlesFor(store, mint);
    // The chip renders `source`; if a fallback kept the vendor name there, the
    // panel would badge simulator data as GECKOTERMINAL.
    expect(r.provenance.source).toBe("demo");
    expect(provenanceLabel(r.provenance)).toBe("SIMULATED");
  });
});

describe("buildLiveTokenRows — real market data, no invented score", () => {
  const entry = (over: Partial<TokenSnapshot> = {}): TokenInfo & { snapshot: TokenSnapshot } => ({
    mint: "So11111111111111111111111111111111111111112",
    name: "Wrapped SOL",
    symbol: "SOL",
    createdAt: Date.now() - 10 * 3_600_000,
    decimals: 9,
    narrative: "Infra" as TokenInfo["narrative"],
    verified: true,
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: false,
    permanentDelegate: false,
    devWallet: "",
    hue: 200,
    snapshot: {
      mint: "So11111111111111111111111111111111111111112",
      ts: Date.now(),
      priceUsd: 180,
      marketCapUsd: 9e10,
      fdvUsd: 9e10,
      liquidityUsd: 5e7,
      volume24hUsd: 2e9,
      buys1h: 900,
      sells1h: 700,
      uniqueBuyers1h: 0,
      uniqueSellers1h: 0,
      holders: 0,
      top10Pct: 0,
      devHoldsPct: 0,
      organicScore: 0,
      socialScore: 0,
      bundlerPct: 0,
      sniperPct: 0,
      insiderPct: 0,
      unmeasured: ["top10Pct", "holders"] as const,
      ...over,
    } as TokenSnapshot,
  });

  it("carries the real market columns through", () => {
    const [r] = buildLiveTokenRows([entry()], "dexscreener");
    expect(r.symbol).toBe("SOL");
    expect(r.priceUsd).toBe(180);
    expect(r.liquidityUsd).toBe(5e7);
    expect(r.volume24hUsd).toBe(2e9);
    expect(r.buys1h).toBe(900);
    expect(r.source).toBe("dexscreener");
  });

  // The whole point. A live row has no candle history and no wallet flow, so
  // the engine refuses a vector — and the row must not quietly present a 0 as
  // if the model had looked and found nothing.
  it("is never scored", () => {
    const [r] = buildLiveTokenRows([entry()], "dexscreener");
    expect(r.scored).toBe(false);
    expect(r.signalScore).toBe(0);
    expect(r.unscoredReason).toBeTruthy();
    expect(r.unscoredReason).toContain("refuses");
  });

  it("keeps the source's own unmeasured list", () => {
    const [r] = buildLiveTokenRows([entry()], "dexscreener");
    expect(r.unmeasured).toContain("top10Pct");
    expect(r.unmeasured).toContain("holders");
  });

  it("marks demo rows as scored so the dash is only ever the live path", () => {
    // Guard against the flag defaulting the wrong way if a caller omits it.
    const [r] = buildLiveTokenRows([entry()], "demo");
    expect(r.scored).toBe(false);
  });
});

describe("provenanceLabel — origin, not freshness", () => {
  it("names the vendor for real data", () => {
    expect(provenanceLabel({ source: "geckoterminal", real: true })).toBe("GECKOTERMINAL");
  });

  it("says SIMULATED for anything that is not real", () => {
    expect(provenanceLabel(DEMO)).toBe("SIMULATED");
    expect(provenanceLabel({ source: "demo", real: false, note: "x" })).toBe("SIMULATED");
  });

  it("refuses to call the simulator live even under a vendor name", () => {
    // Defensive: a future caller constructing provenance by hand must not be
    // able to get a live-looking chip out of real=false.
    expect(provenanceLabel({ source: "birdeye", real: false })).toBe("SIMULATED");
  });
});
