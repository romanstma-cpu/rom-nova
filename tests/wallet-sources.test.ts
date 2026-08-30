// Parsing the two vendor payloads a real wallet read depends on.
//
// Both have a failure that is invisible downstream. Read Coinbase's column 3
// instead of 4 and every fill is priced at the hour's OPEN — still plausible,
// still wrong, and no PnL figure would look odd enough to catch it. Keep
// Jupiter's zero-balance accounts and a trader's position table fills with
// 1,122 tokens they no longer own.

import { describe, it, expect } from "vitest";
import { parseCryptoCom, parseCoinbase, solUsdAt, BAR_MS, type SolBar } from "@/lib/providers/sol-history";
import { parseHoldings } from "@/lib/providers/holdings";

const T = 1_788_030_000_000;

describe("parseCryptoCom", () => {
  it("takes the close and converts the string prices", () => {
    const bars = parseCryptoCom({
      result: { data: [{ t: T, c: "105.41" }, { t: T - BAR_MS, c: "104.87" }] },
    });
    expect(bars).toHaveLength(2);
    // Sorted oldest first, whatever order the vendor sent.
    expect(bars[0].t).toBe(T - BAR_MS);
    expect(bars[1].close).toBe(105.41);
  });

  it("drops a bar with an unusable price rather than carrying a zero", () => {
    const bars = parseCryptoCom({ result: { data: [{ t: T, c: "0" }, { t: T, c: "abc" }] } });
    expect(bars).toHaveLength(0);
  });

  it("survives an empty or malformed body", () => {
    expect(parseCryptoCom({})).toEqual([]);
    expect(parseCryptoCom({ result: {} })).toEqual([]);
  });
});

describe("parseCoinbase", () => {
  // [time, low, high, open, close, volume]. Index 4 is the close; index 3 is
  // the open and would be silently wrong.
  it("reads the CLOSE column, not the open", () => {
    const bars = parseCoinbase([[T / 1000, 104.75, 105.29, 104.87, 105.13, 42497]]);
    expect(bars[0].close).toBe(105.13);
  });

  it("converts seconds to milliseconds", () => {
    expect(parseCoinbase([[T / 1000, 1, 2, 3, 4, 5]])[0].t).toBe(T);
  });

  it("ignores a short row instead of reading undefined as a price", () => {
    expect(parseCoinbase([[T / 1000, 1, 2]])).toEqual([]);
  });
});

describe("solUsdAt — the price at the fill, not the price now", () => {
  const bars: SolBar[] = [
    { t: T - 3 * BAR_MS, close: 100 },
    { t: T - 2 * BAR_MS, close: 110 },
    { t: T - BAR_MS, close: 120 },
    { t: T, close: 130 },
  ];

  it("takes the bar the timestamp falls inside", () => {
    expect(solUsdAt(bars, T - 2 * BAR_MS + 60_000)).toBe(110);
  });

  it("takes a bar exactly at its open", () => {
    expect(solUsdAt(bars, T - BAR_MS)).toBe(120);
  });

  it("covers the current, still-forming hour with the last closed bar", () => {
    expect(solUsdAt(bars, T + 30 * 60_000)).toBe(130);
  });

  // The whole reason this function exists. SOL moved $74 to $105 across the
  // readable series; reaching for the nearest bar would price a three-week-old
  // entry at a price from a different market.
  it("returns undefined before the series begins rather than the oldest bar", () => {
    expect(solUsdAt(bars, T - 10 * BAR_MS)).toBeUndefined();
  });

  it("returns undefined well past the end rather than the newest bar", () => {
    expect(solUsdAt(bars, T + 5 * BAR_MS)).toBeUndefined();
  });

  it("returns undefined with no series at all", () => {
    expect(solUsdAt([], T)).toBeUndefined();
  });
});

describe("parseHoldings", () => {
  const acc = (uiAmount: number, over: Record<string, unknown> = {}) => ({
    amount: String(uiAmount),
    uiAmount,
    decimals: 6,
    ...over,
  });

  // Measured on a real trader: 1,122 of 1,434 token accounts held nothing.
  // Listing those would fill the positions table with tokens the wallet sold.
  it("drops accounts with a zero balance", () => {
    const r = parseHoldings({ uiAmount: 1.5, tokens: { A: [acc(0)], B: [acc(20)] } });
    expect(r.tokens.map((t) => t.mint)).toEqual(["B"]);
  });

  it("sums several accounts of one mint", () => {
    const r = parseHoldings({ uiAmount: 0, tokens: { A: [acc(10), acc(15)] } });
    expect(r.tokens[0].tokens).toBe(25);
  });

  it("carries the frozen and spam flags the vendor supplies", () => {
    const r = parseHoldings({
      uiAmount: 0,
      tokens: { A: [acc(10, { isFrozen: true, excludeFromNetWorth: true })] },
    });
    expect(r.tokens[0].frozen).toBe(true);
    expect(r.tokens[0].excludeFromNetWorth).toBe(true);
  });

  it("sorts largest balance first", () => {
    const r = parseHoldings({ uiAmount: 0, tokens: { A: [acc(5)], B: [acc(500)] } });
    expect(r.tokens[0].mint).toBe("B");
  });

  it("reads native SOL and survives a body with nothing in it", () => {
    expect(parseHoldings({ uiAmount: 2.25, tokens: {} }).solBalance).toBe(2.25);
    expect(parseHoldings({}).solBalance).toBe(0);
    expect(parseHoldings({}).tokens).toEqual([]);
  });
});
