// The scanner said it ranked by score, and did not.
//
// `handleTokens` had two exits. The LIVE one returned `live.data.slice(...)`
// directly; the sort block sat below it and only ever ran on the simulator
// path. So the demo universe was ranked and Solana was not, and the difference
// was invisible in every test because the tests all drove the demo store.
//
// Measured on production before the fix, in row order:
//   75, 33, 86, 77, 82, 50, 64, 93, 60, 28, 45, 67
// A 93 in eighth place, under a caption reading "Ranked by the signal score",
// beside a rank column, per-row rank-change flashes and a "freeze ranking"
// button — four pieces of UI decorating an order that never responded to it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenRow } from "@/lib/api/rows";

/** Rows in deliberately unsorted score order, as a vendor's trending list is. */
const LIVE_ROWS = [75, 33, 86, 77, 82, 50, 64, 93, 60, 28, 45, 67].map((score, i) =>
  ({
    mint: `M${i}`,
    symbol: `T${i}`,
    name: `Token ${i}`,
    narrative: "Community",
    hue: 1,
    verified: false,
    ageHours: 10,
    priceUsd: 1,
    marketCapUsd: 1,
    liquidityUsd: 1000 * (i + 1),
    volume24hUsd: 1,
    m5: 0, h1: 0, h6: 0, h24: 0,
    buys1h: 1, sells1h: 1,
    holders: 1, holderGrowthPct: 0, top10Pct: 0,
    organicScore: 0, socialScore: 0, volumeAccel: 1,
    whaleFlowUsd: 0, smFlow6hUsd: 0, smWallets: 0,
    signalScore: score,
    signalLabel: "WATCH",
    signalKind: "momentum_ignition",
    signalId: `sig-${i}`,
    confidence: 0.7,
    riskLevel: "low" as const,
    dataTs: 1,
    scored: true,
    source: "jupiter",
  }) as TokenRow,
);

/** One unscored row, to prove it cannot float to the top of an ascending sort. */
const UNSCORED: TokenRow = { ...LIVE_ROWS[0], mint: "UNSCORED", symbol: "UNS", signalScore: 0, scored: false };

vi.mock("@/lib/api/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/source")>();
  return {
    ...actual,
    trendingRows: vi.fn(async () => ({
      data: [...LIVE_ROWS, UNSCORED],
      provenance: { source: "jupiter", real: true },
    })),
  };
});

import { handleTokens } from "@/lib/api/handlers";
import { DemoStore } from "@/lib/demo/store";

const store = new DemoStore(77);

beforeEach(() => vi.clearAllMocks());

describe("handleTokens — the live list is ordered, because the page says it is", () => {
  it("returns live rows sorted by signal score, descending", async () => {
    const res = await handleTokens(store, {});
    const scored = res.rows.filter((r) => r.scored).map((r) => r.signalScore);
    expect(scored).toEqual([...scored].sort((a, b) => b - a));
    expect(scored[0]).toBe(93);
  });

  it("honours an explicit ascending direction", async () => {
    const res = await handleTokens(store, { dir: "asc" });
    const scored = res.rows.filter((r) => r.scored).map((r) => r.signalScore);
    expect(scored).toEqual([...scored].sort((a, b) => a - b));
    expect(scored[0]).toBe(28);
  });

  it("sorts by another numeric column when asked", async () => {
    const res = await handleTokens(store, { sort: "liquidityUsd" });
    const liq = res.rows.filter((r) => r.scored).map((r) => r.liquidityUsd);
    expect(liq).toEqual([...liq].sort((a, b) => b - a));
  });

  it("sinks unscored rows even ascending, because their zero is not a score", async () => {
    // `signalScore` is 0 on an unscored row because the field is not optional,
    // not because the token scored zero. Floating it to the top of an ascending
    // sort would rank "we could not measure this" above every measured token.
    const res = await handleTokens(store, { dir: "asc" });
    expect(res.rows[res.rows.length - 1].mint).toBe("UNSCORED");
  });

  it("leaves the order alone for a column that is not numeric", async () => {
    const res = await handleTokens(store, { sort: "symbol" });
    expect(res.rows.filter((r) => r.scored).map((r) => r.signalScore)).toEqual(
      LIVE_ROWS.map((r) => r.signalScore),
    );
  });

  it("still sorts the simulator path when no live source answers", async () => {
    const source = await import("@/lib/api/source");
    vi.mocked(source.trendingRows).mockResolvedValueOnce(null);
    const res = await handleTokens(store, {});
    const scores = res.rows.map((r) => r.signalScore);
    expect(res.demo).toBe(true);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
