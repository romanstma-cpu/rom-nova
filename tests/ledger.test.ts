// The wallet ledger and the reputation it refuses to hand out early.
//
// Everything a reader could be misled by is pinned here: a grade off four
// trades, a span that counts days nobody observed, a transfer booked as a
// trade, a sell with no observed buy booked as pure profit, a cap that
// evicts fills but keeps claiming their window, and a record for a wallet
// nobody chose to record.

import { describe, it, expect, beforeEach } from "vitest";
import type { WalletFill } from "@/lib/types";
import {
  coverageOf,
  mergeIntervals,
  reputationFrom,
  scoreOf,
  gradeOf,
  MIN_OBSERVED_DAYS,
  MIN_ROUND_TRIPS,
  SMART_SCORE,
} from "@/lib/ledger/reputation";
import {
  FILL_CAP,
  WALLET_CAP,
  isRecording,
  ledgerRecord,
  ledgerSnapshot,
  recordFills,
  recordedWallets,
  reputationOf,
  resetLedger,
  setRecording,
  forgetWallet,
  subscribeLedger,
} from "@/lib/ledger/store";

const W = "WaLLet111111111111111111111111111111111111";
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

let sigN = 0;
function fill(over: Partial<WalletFill> & { ts: number; side: "buy" | "sell"; tokens: number; priceUsd?: number }): WalletFill {
  sigN++;
  const priced = over.priceUsd !== undefined;
  return {
    signature: `sig${sigN}`,
    slot: Math.floor(over.ts / 400),
    wallet: W,
    mint: "MINT",
    decimals: 6,
    pricing: priced ? "wsol" : "unpriced",
    classification: over.side === "buy" ? "open" : "exit",
    valueUsd: priced ? over.tokens * (over.priceUsd as number) : undefined,
    ...over,
  };
}

/** N round trips a day apart: buy 100 at `buyPx`, sell 100 at `sellPx`. */
function trips(n: number, buyPx: number, sellPx: number, start = T0, mint = "MINT"): WalletFill[] {
  const out: WalletFill[] = [];
  for (let k = 0; k < n; k++) {
    const t = start + k * DAY;
    out.push(fill({ ts: t, side: "buy", tokens: 100, priceUsd: buyPx, mint, classification: "open" }));
    out.push(fill({ ts: t + 3_600_000, side: "sell", tokens: 100, priceUsd: sellPx, mint, classification: "exit" }));
  }
  return out;
}

describe("coverage: observed days count only what was read", () => {
  it("merges overlapping windows and names the gaps between the rest", () => {
    const merged = mergeIntervals([
      { from: T0, to: T0 + DAY },
      { from: T0 + DAY / 2, to: T0 + 2 * DAY },
      { from: T0 + 5 * DAY, to: T0 + 6 * DAY },
    ]);
    expect(merged).toHaveLength(2);
    const cov = coverageOf(merged);
    expect(cov.spanDays).toBeCloseTo(6, 5);
    expect(cov.observedDays).toBeCloseTo(3, 5);
    expect(cov.gaps).toEqual({ count: 1, days: 3 });
  });

  it("ignores windows with no real timestamps", () => {
    expect(mergeIntervals([{ from: 0, to: 0 }, { from: 5, to: 1 }])).toEqual([]);
    expect(coverageOf([]).observedDays).toBe(0);
  });
});

describe("reputation: the refusal is the feature", () => {
  it("is insufficient with fewer round trips than the floor, and says how many are missing", () => {
    const rep = reputationFrom(W, trips(4, 1, 2), [{ from: T0, to: T0 + 30 * DAY }]);
    expect(rep.verdict).toBe("insufficient");
    expect(rep.roundTrips).toBe(4);
    expect(rep.needs).toHaveLength(1);
    expect(rep.needs[0]).toContain(`${MIN_ROUND_TRIPS - 4} more closed round trips`);
    expect(rep.score).toBeUndefined();
    expect(rep.grade).toBeUndefined();
    expect(rep.smart).toBe(false);
    // The running numbers are still reported as numbers — as a sample.
    expect(rep.wins).toBe(4);
    expect(rep.realizedPnlUsd).toBeCloseTo(400, 6);
  });

  it("is insufficient with enough trips but too few OBSERVED days — span does not count", () => {
    // Twelve trips inside two days of reads, then nothing observed for a month.
    const fills = trips(12, 1, 2, T0).map((f, i) => ({ ...f, ts: T0 + Math.floor(i / 2) * 3_600_000 + (i % 2) * 600_000 }));
    const rep = reputationFrom(W, fills, [
      { from: T0, to: T0 + 2 * DAY },
      { from: T0 + 40 * DAY, to: T0 + 40 * DAY + 3_600_000 },
    ]);
    expect(rep.roundTrips).toBe(12);
    expect(rep.spanDays).toBeGreaterThan(30);
    expect(rep.observedDays).toBeLessThan(MIN_OBSERVED_DAYS);
    expect(rep.verdict).toBe("insufficient");
    expect(rep.needs[0]).toContain("more observed days");
    expect(rep.gaps.count).toBe(1);
  });

  it("measures a wallet that clears both floors, with the grade and the evidence beside it", () => {
    const fills = [...trips(8, 1, 2), ...trips(4, 1, 0.5, T0 + 100 * DAY, "OTHER")];
    const rep = reputationFrom(W, fills, [{ from: T0, to: T0 + 104 * DAY }]);
    expect(rep.verdict).toBe("measured");
    expect(rep.roundTrips).toBe(12);
    expect(rep.wins).toBe(8);
    expect(rep.losses).toBe(4);
    expect(rep.winRate).toBeCloseTo(8 / 12, 6);
    // 8 × +100 against 4 × −50: profit factor 4.
    expect(rep.profitFactor).toBeCloseTo(4, 6);
    expect(rep.realizedPnlUsd).toBeCloseTo(600, 6);
    expect(rep.score).toBe(scoreOf(8 / 12, 4));
    expect(rep.grade).toBe(gradeOf(rep.score as number));
    expect(rep.smart).toBe((rep.score as number) >= SMART_SCORE);
    expect(rep.distinctMints).toBe(2);
    expect(rep.medianHoldHours).toBeCloseTo(1, 6);
  });

  it("excludes transfers, LP moves and unpriced trades from the replay but counts them", () => {
    const fills = [
      ...trips(10, 1, 2),
      fill({ ts: T0 + 20 * DAY, side: "buy", tokens: 1_000_000, classification: "transfer" }),
      fill({ ts: T0 + 21 * DAY, side: "sell", tokens: 5, classification: "lp" }),
      fill({ ts: T0 + 22 * DAY, side: "buy", tokens: 50, classification: "open" }), // unpriced trade
    ];
    const rep = reputationFrom(W, fills, [{ from: T0, to: T0 + 30 * DAY }]);
    expect(rep.fills).toEqual({ total: 23, priced: 20, unpriced: 1, nonTrade: 2 });
    expect(rep.roundTrips).toBe(10);
    expect(rep.realizedPnlUsd).toBeCloseTo(1000, 6);
  });

  it("books nothing for a sell whose buy was never observed", () => {
    const fills = [...trips(10, 1, 2), fill({ ts: T0 + 15 * DAY, side: "sell", tokens: 999, priceUsd: 50, mint: "GHOST", classification: "exit" })];
    const rep = reputationFrom(W, fills, [{ from: T0, to: T0 + 30 * DAY }]);
    expect(rep.unmatchedSellMints).toBe(1);
    expect(rep.realizedPnlUsd).toBeCloseTo(1000, 6);
    expect(rep.roundTrips).toBe(10);
  });

  it("scores in the open: break-even and coin-flip score nothing, 75% at 4x scores full", () => {
    expect(scoreOf(0.35, 1)).toBe(0);
    expect(scoreOf(0.5, 1)).toBe(19);
    expect(scoreOf(0.75, 4)).toBe(100);
    expect(scoreOf(0.9, 0.5)).toBe(50);
    expect(gradeOf(80)).toBe("A");
    expect(gradeOf(60)).toBe("B");
    expect(gradeOf(40)).toBe("C");
    expect(gradeOf(39)).toBe("D");
  });
});

describe("store: opt-in, deduplicated, capped, and honest about what it evicted", () => {
  beforeEach(() => resetLedger());

  const cov = (oldestTs: number, newestTs: number) => ({ oldestTs, newestTs, source: "solana-rpc" });

  it("records nothing for a wallet nobody chose to record", () => {
    expect(recordFills(W, trips(1, 1, 2), cov(T0, T0 + DAY), T0 + DAY)).toBeNull();
    expect(ledgerRecord(W)).toBeUndefined();
    expect(reputationOf(W)).toBeUndefined();
  });

  it("merges reads by signature and grows the covered window to the read time", () => {
    setRecording(W, true, T0);
    expect(isRecording(W)).toBe(true);
    const first = trips(2, 1, 2);
    expect(recordFills(W, first, cov(T0, T0 + DAY), T0 + DAY)).toEqual({ added: 4, total: 4 });
    // The same read again, plus one new fill.
    const extra = fill({ ts: T0 + 2 * DAY, side: "buy", tokens: 1, priceUsd: 1 });
    expect(recordFills(W, [...first, extra], cov(T0, T0 + 2 * DAY), T0 + 2 * DAY)).toEqual({ added: 1, total: 5 });
    const rec = ledgerRecord(W)!;
    expect(rec.reads).toBe(2);
    expect(rec.covered).toEqual([{ from: T0, to: T0 + 2 * DAY }]);
    expect(rec.fills.map((f) => f.ts)).toEqual([...rec.fills.map((f) => f.ts)].sort((a, b) => a - b));
  });

  it("ignores fills that belong to another wallet", () => {
    setRecording(W, true, T0);
    const foreign = { ...fill({ ts: T0, side: "buy", tokens: 1, priceUsd: 1 }), wallet: "SomeoneElse" };
    expect(recordFills(W, [foreign], cov(T0, T0), T0)).toEqual({ added: 0, total: 0 });
  });

  it("an empty read of a quiet wallet covers only the moment it ran", () => {
    setRecording(W, true, T0);
    recordFills(W, [], { oldestTs: 0, newestTs: 0, source: "solana-rpc" }, T0 + 5 * DAY);
    expect(ledgerRecord(W)!.covered).toEqual([{ from: T0 + 5 * DAY, to: T0 + 5 * DAY }]);
  });

  it("evicts oldest past the cap and clips the covered window to the oldest fill kept", () => {
    setRecording(W, true, T0);
    const many: WalletFill[] = [];
    for (let k = 0; k < FILL_CAP + 10; k++) many.push(fill({ ts: T0 + k * 60_000, side: "buy", tokens: 1, priceUsd: 1 }));
    const readAt = T0 + (FILL_CAP + 10) * 60_000;
    expect(recordFills(W, many, cov(T0, readAt), readAt)!.total).toBe(FILL_CAP);
    const rec = ledgerRecord(W)!;
    expect(rec.fills[0].ts).toBe(T0 + 10 * 60_000);
    expect(rec.covered[0].from).toBe(T0 + 10 * 60_000);
  });

  it("caps how many wallets can record at once, and pausing keeps the history", () => {
    for (let k = 0; k < WALLET_CAP; k++) expect(setRecording(`W${k}`, true, T0)).not.toBeNull();
    expect(setRecording("OneTooMany", true, T0)).toBeNull();
    expect(recordedWallets()).toHaveLength(WALLET_CAP);
    setRecording("W0", false, T0);
    expect(recordedWallets()).toHaveLength(WALLET_CAP - 1);
    expect(ledgerRecord("W0")).toBeDefined();
    expect(recordFills("W0", trips(1, 1, 2), cov(T0, T0), T0)).toBeNull();
    forgetWallet("W0");
    expect(ledgerRecord("W0")).toBeUndefined();
  });

  it("the snapshot carries each wallet's reputation and bumps its version on change", () => {
    let pings = 0;
    const off = subscribeLedger(() => pings++);
    const v0 = ledgerSnapshot().version;
    setRecording(W, true, T0);
    recordFills(W, trips(12, 1, 2), cov(T0, T0 + 12 * DAY), T0 + 12 * DAY);
    const snap = ledgerSnapshot();
    expect(snap.version).toBeGreaterThan(v0);
    expect(snap.wallets).toHaveLength(1);
    expect(snap.wallets[0].reputation.verdict).toBe("measured");
    expect(snap.wallets[0].reputation.smart).toBe(true);
    expect(snap.totalFills).toBe(24);
    expect(pings).toBeGreaterThan(0);
    expect(snap.backend).toBe("memory");
    off();
  });
});
