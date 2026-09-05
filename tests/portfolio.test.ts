// The read-only portfolio: FIFO over observed fills with every blank
// explained, the risk reading over real balances, the CSV, and the
// remembered address.

import { beforeEach, describe, expect, it } from "vitest";
import { csvEscape, fifoCsv, fifoCsvName, FIFO_CSV_COLUMNS } from "../src/lib/portfolio/csv";
import { fifoRows } from "../src/lib/portfolio/fifo";
import { portfolioRisk } from "../src/lib/portfolio/risk";
import type { WalletFill, WalletHolding, WalletProfile } from "../src/lib/types";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});

const DAY = 86_400_000;
const T0 = 1_788_000_000_000;
let seq = 0;

/** A fill with only what FIFO reads; the rest of WalletFill is prose. */
function fill(over: Partial<WalletFill> & { side: "buy" | "sell"; tokens: number; ts: number }): WalletFill {
  seq++;
  return { signature: `sig${seq}`, slot: seq, wallet: "W", mint: "MINT", decimals: 6, ...over } as unknown as WalletFill;
}

describe("fifoRows", () => {
  it("matches a sell to the lot before it and books the difference", () => {
    const { rows, summary } = fifoRows([fill({ side: "buy", tokens: 100, ts: T0, priceUsd: 1 }), fill({ side: "sell", tokens: 100, ts: T0 + DAY, priceUsd: 2 })]);
    const sell = rows[1];
    expect(sell).toMatchObject({ side: "sell", matchedTokens: 100, unmatchedTokens: 0, costBasisUsd: 100, proceedsUsd: 200, realizedPnlUsd: 100, longTerm: false, note: "" });
    expect(sell.holdDays).toBeCloseTo(1, 6);
    expect(summary).toMatchObject({ buys: 1, sells: 1, matchedSells: 1, realizedPnlUsd: 100, shortTermPnlUsd: 100, longTermPnlUsd: 0, openLots: 0, mints: 1 });
  });

  it("consumes lots oldest first and weights the hold by tokens", () => {
    const { rows } = fifoRows([
      fill({ side: "buy", tokens: 100, ts: T0, priceUsd: 1 }),
      fill({ side: "buy", tokens: 100, ts: T0 + 2 * DAY, priceUsd: 3 }),
      fill({ side: "sell", tokens: 150, ts: T0 + 4 * DAY, priceUsd: 2 }),
    ]);
    const sell = rows[2];
    expect(sell.costBasisUsd).toBeCloseTo(250, 6); // 100 @ 1 + 50 @ 3
    expect(sell.proceedsUsd).toBeCloseTo(300, 6);
    expect(sell.realizedPnlUsd).toBeCloseTo(50, 6);
    expect(sell.holdDays).toBeCloseTo((100 * 4 + 50 * 2) / 150, 6);
  });

  it("excludes a sell out of lots it never saw, and the unseen part of a partial one", () => {
    const stranger = fifoRows([fill({ side: "sell", tokens: 50, ts: T0, priceUsd: 2 })]);
    expect(stranger.rows[0]).toMatchObject({ matchedTokens: 0, unmatchedTokens: 50, realizedPnlUsd: null, proceedsUsd: null });
    expect(stranger.rows[0].note).toMatch(/never saw bought/);
    expect(stranger.summary).toMatchObject({ unmatchedSells: 1, realizedPnlUsd: 0 });

    const partial = fifoRows([fill({ side: "buy", tokens: 50, ts: T0, priceUsd: 1 }), fill({ side: "sell", tokens: 80, ts: T0 + DAY, priceUsd: 2 })]);
    const sell = partial.rows[1];
    expect(sell).toMatchObject({ matchedTokens: 50, unmatchedTokens: 30, costBasisUsd: 50, proceedsUsd: 100, realizedPnlUsd: 50 });
    expect(sell.note).toMatch(/that part is excluded/);
    expect(partial.summary.partlyMatchedSells).toBe(1);
  });

  it("leaves cost or proceeds blank when a price was never seen, and says which", () => {
    const noBuyPrice = fifoRows([fill({ side: "buy", tokens: 100, ts: T0 }), fill({ side: "sell", tokens: 100, ts: T0 + DAY, priceUsd: 2 })]);
    expect(noBuyPrice.rows[0].note).toMatch(/cost is unknown/);
    expect(noBuyPrice.rows[1]).toMatchObject({ costBasisUsd: null, proceedsUsd: 200, realizedPnlUsd: null });
    expect(noBuyPrice.rows[1].note).toMatch(/lot behind this sell had no price/);
    expect(noBuyPrice.summary.unknownCostSells).toBe(1);

    const noSellPrice = fifoRows([fill({ side: "buy", tokens: 100, ts: T0, priceUsd: 1 }), fill({ side: "sell", tokens: 100, ts: T0 + DAY })]);
    expect(noSellPrice.rows[1]).toMatchObject({ costBasisUsd: 100, proceedsUsd: null, realizedPnlUsd: null });
    expect(noSellPrice.summary.unpricedSells).toBe(1);
    expect(noSellPrice.summary.realizedPnlUsd).toBe(0);
  });

  it("marks a sell long-term only when every lot behind it is older than a year, and splits the summary", () => {
    const { rows, summary } = fifoRows([
      fill({ side: "buy", tokens: 10, ts: T0, priceUsd: 1 }),
      fill({ side: "sell", tokens: 10, ts: T0 + 400 * DAY, priceUsd: 3 }),
      fill({ side: "buy", tokens: 10, ts: T0 + 401 * DAY, priceUsd: 1, mint: "OTHER" }),
      fill({ side: "sell", tokens: 10, ts: T0 + 402 * DAY, priceUsd: 0.5, mint: "OTHER" }),
    ]);
    expect(rows[1].longTerm).toBe(true);
    expect(rows[3].longTerm).toBe(false);
    expect(summary.longTermPnlUsd).toBeCloseTo(20, 6);
    expect(summary.shortTermPnlUsd).toBeCloseTo(-5, 6);
    expect(summary.mints).toBe(2);
  });

  it("sorts by time whatever order the fills came in, keeps mints apart, and counts open lots", () => {
    const { rows, summary } = fifoRows([
      fill({ side: "sell", tokens: 5, ts: T0 + DAY, priceUsd: 2 }),
      fill({ side: "buy", tokens: 5, ts: T0, priceUsd: 1 }),
      fill({ side: "buy", tokens: 7, ts: T0, priceUsd: 1, mint: "OTHER" }),
    ]);
    expect(rows.map((r) => r.side)).toEqual(["buy", "buy", "sell"]);
    expect(rows[2].realizedPnlUsd).toBeCloseTo(5, 6);
    expect(summary.openLots).toBe(1);
    expect(fifoRows([]).summary).toMatchObject({ fills: 0, firstTs: null, lastTs: null });
  });
});

function holding(over: Partial<WalletHolding> & { mint: string; valueUsd?: number }): WalletHolding {
  return { decimals: 6, tokens: 1, observedTokens: 1, costBasisKnown: true, ...over };
}

function profile(positions: WalletHolding[], holdings: Partial<NonNullable<WalletProfile["holdings"]>> = {}): Pick<WalletProfile, "holdings" | "positions"> {
  const tokenValueUsd = positions.filter((p) => !p.excludeFromNetWorth).reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  return {
    positions,
    holdings: { source: "test", solBalance: 0, mints: positions.length, tokenValueUsd, valuedUsd: tokenValueUsd, pricedMints: positions.length, unpricedMints: 0, ...holdings },
  };
}

describe("portfolioRisk", () => {
  it("reads one bet, concentrated and spread off the token shares, with SOL beside them", () => {
    const oneBet = portfolioRisk(profile([holding({ mint: "A", symbol: "AAA", valueUsd: 700 }), holding({ mint: "B", valueUsd: 300 })], { solValueUsd: 9_000, solBalance: 50 }))!;
    expect(oneBet.reading).toBe("one bet");
    expect(oneBet.top1).toMatchObject({ mint: "A", symbol: "AAA", valueUsd: 700 });
    expect(oneBet.top1!.pct).toBeCloseTo(0.7, 6);
    expect(oneBet.solPct).toBeCloseTo(0.9, 6);
    expect(oneBet.notes.some((n) => n.includes("90% of the wallet is native SOL"))).toBe(true);

    const conc = portfolioRisk(profile([holding({ mint: "A", valueUsd: 40 }), holding({ mint: "B", valueUsd: 30 }), holding({ mint: "C", valueUsd: 20 }), holding({ mint: "D", valueUsd: 10 })]))!;
    expect(conc.reading).toBe("concentrated");
    expect(conc.top3Pct).toBeCloseTo(0.9, 6);

    const spread = portfolioRisk(profile(Array.from({ length: 10 }, (_, i) => holding({ mint: `M${i}`, valueUsd: 10 }))))!;
    expect(spread.reading).toBe("spread");
    expect(spread.positions).toBe(10);
  });

  it("leaves dust and unpriced mints out and names unknown cost", () => {
    const r = portfolioRisk(
      profile(
        [holding({ mint: "A", valueUsd: 60, costBasisKnown: false }), holding({ mint: "B", valueUsd: 40 }), holding({ mint: "SPAM", valueUsd: 500, excludeFromNetWorth: true }), holding({ mint: "NOPRICE" })],
        { unpricedMints: 1 },
      ),
    )!;
    expect(r.positions).toBe(2);
    expect(r.dust).toBe(1);
    expect(r.tokenValueUsd).toBe(100);
    expect(r.unknownCostPct).toBeCloseTo(0.6, 6);
    expect(r.notes.some((n) => n.startsWith("60% of token value was bought where this read could not see"))).toBe(true);
    expect(r.notes.some((n) => n.includes("1 held mint has no published price"))).toBe(true);
    expect(r.notes.some((n) => n.includes("1 position Jupiter flags as dust"))).toBe(true);
  });

  it("says no tokens, and nothing at all without balances", () => {
    expect(portfolioRisk(profile([]))!.reading).toBe("no tokens");
    expect(portfolioRisk({ holdings: null, positions: [] })).toBeNull();
    const unvalued = portfolioRisk(profile([holding({ mint: "A", valueUsd: 10 })], { solBalance: 3 }))!;
    expect(unvalued.solPct).toBeNull();
    expect(unvalued.notes.some((n) => n.includes("native SOL not valued"))).toBe(true);
  });
});

describe("the CSV", () => {
  it("escapes what needs escaping and nothing else", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a, b")).toBe('"a, b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(Number.NaN)).toBe("");
    expect(csvEscape(1.5)).toBe("1.5");
  });

  it("writes the header, one row per fill, and the note that explains a blank", () => {
    const { rows } = fifoRows([fill({ side: "buy", tokens: 100, ts: T0, priceUsd: 1 }), fill({ side: "sell", tokens: 120, ts: T0 + DAY, priceUsd: 2 })], () => "TKN");
    const csv = fifoCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(FIFO_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4); // header, two rows, trailing newline
    expect(lines[1]).toContain(`${new Date(T0).toISOString()},buy,MINT,TKN,100,1,100.00,,,,,,,,`);
    expect(lines[2]).toContain(",sell,MINT,TKN,120,2,240.00,100,20,100.00,200.00,100.00,1.00,short,");
    expect(lines[2].endsWith(",part of this sell came from lots never observed — that part is excluded")).toBe(true);
  });

  it("names the file for the wallet, the day and the word estimate", () => {
    expect(fifoCsvName("So11111111111111111111111111111111111111112", T0)).toBe(`rom-nova-fifo-estimate-So1111-1112-${new Date(T0).toISOString().slice(0, 10)}.csv`);
  });
});

describe("my wallet", () => {
  beforeEach(() => store.clear());

  it("remembers a plausible address in this browser and forgets it on request", async () => {
    const m = await import("../src/lib/portfolio/mine");
    m.resetMyWallet();
    expect(m.myWalletSnapshot()).toBe("");
    m.setMyWallet("So11111111111111111111111111111111111111112");
    expect(m.myWalletSnapshot()).toBe("So11111111111111111111111111111111111111112");
    expect(store.get("whalenova_my_wallet_v1")).toBe("So11111111111111111111111111111111111111112");
    m.setMyWallet("not-an-address");
    expect(m.myWalletSnapshot()).toBe("");
    expect(store.has("whalenova_my_wallet_v1")).toBe(false);
    m.setMyWallet("So11111111111111111111111111111111111111112");
    m.setMyWallet(null);
    expect(m.myWalletSnapshot()).toBe("");
  });
});
