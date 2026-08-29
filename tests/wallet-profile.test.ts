// The rules that stop a two-day window from being reported as a career.
//
// Three specific lies this file exists to prevent, each of which every other
// wallet tracker tells by default:
//
//   1. A sell whose buy predates the window, credited at a cost of zero, so its
//      whole proceeds become "profit".
//   2. A bag acquired before the window, given a cost basis anyway, so a
//      position bought at any price shows a clean multiple.
//   3. A statistic with no sample behind it rendered as 0 — 0% win rate on a
//      wallet that has not closed a trade, $0 realized on one that has not sold.

import { describe, it, expect } from "vitest";
import { replayFills, reconcile, assembleProfile, RECONCILE_TOLERANCE } from "@/lib/engine/wallet-profile";
import type { WalletCoverage, WalletFill } from "@/lib/types";

const W = "EmNnGUq5eeVRhU175SswgkUWiVD3E6gagJKQE6aomqRK";
const A = "MintAAAA1111111111111111111111111111111111AA";
const B = "MintBBBB1111111111111111111111111111111111BB";
const H = 3_600_000;
const T0 = 1_700_000_000_000;

let seq = 0;
function fill(over: Partial<WalletFill>): WalletFill {
  seq++;
  const tokens = over.tokens ?? 100;
  const priceUsd = over.priceUsd;
  return {
    signature: `sig${seq}`,
    slot: seq,
    ts: over.ts ?? T0,
    wallet: W,
    mint: A,
    decimals: 6,
    side: "buy",
    tokens,
    pricing: priceUsd === undefined ? "unpriced" : "stable",
    classification: priceUsd === undefined ? "transfer" : "open",
    ...over,
    ...(priceUsd !== undefined ? { priceUsd, valueUsd: priceUsd * tokens } : {}),
  };
}

const COVERAGE: WalletCoverage = {
  source: "solana-rpc",
  newestTs: T0 + 4 * H,
  oldestTs: T0,
  windowHours: 4,
  signaturesListed: 10,
  transactionsRead: 10,
  transactionsFailed: 0,
  transactionsRefused: 0,
  cappedByBudget: false,
  reachedEndpointLimit: true,
  lifetime: false,
  note: "test window",
};

describe("replayFills — FIFO over what was actually seen", () => {
  it("closes a round trip and books the difference", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "sell", tokens: 100, priceUsd: 1.5, ts: T0 + 2 * H }),
    ]);
    expect(r.ledger.roundTrips).toHaveLength(1);
    expect(r.ledger.realizedPnlUsd).toBeCloseTo(50, 9);
    expect(r.ledger.roundTrips[0].holdHours).toBeCloseTo(2, 9);
    expect(r.unmatched.size).toBe(0);
  });

  it("matches lots oldest first, not cheapest first", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "buy", tokens: 100, priceUsd: 3, ts: T0 + H }),
      fill({ side: "sell", tokens: 100, priceUsd: 2, ts: T0 + 2 * H }),
    ]);
    // FIFO sells the $1 lot: +$100. LIFO would have booked a $100 loss, and
    // "average cost" would have booked nothing. The three disagree by $200 on
    // two hundred dollars of trading.
    expect(r.ledger.realizedPnlUsd).toBeCloseTo(100, 9);
  });

  // The big one. A sell with no observed buy is proceeds without a cost, and
  // matching it at zero would report the entire sale as profit.
  it("excludes a sell with no observed buy instead of costing it at zero", () => {
    const r = replayFills(W, [fill({ side: "sell", tokens: 400, priceUsd: 2, ts: T0 })]);
    expect(r.ledger.realizedPnlUsd).toBe(0);
    expect(r.ledger.roundTrips).toHaveLength(0);
    expect(r.unmatched.get(A)).toBeCloseTo(400, 9);
  });

  it("splits a sell that only partly matches", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "sell", tokens: 250, priceUsd: 2, ts: T0 + H }),
    ]);
    // The 100 we saw bought: cost $100, sold for $200, +$100. The other 150 are
    // unattributable and contribute nothing rather than another $300 of "gain".
    expect(r.ledger.realizedPnlUsd).toBeCloseTo(100, 9);
    expect(r.unmatched.get(A)).toBeCloseTo(150, 9);
  });

  // An unpriced movement changes the position and contributes no cost. Skipping
  // it entirely would make the reconciliation report a divergence this read can
  // actually explain.
  it("counts an unpriced movement in the token balance but not in the lots", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "buy", tokens: 900, ts: T0 + H }),
    ]);
    expect(r.derivedTokens.get(A)).toBeCloseTo(1000, 9);
    expect(r.ledger.positions[0].tokens).toBeCloseTo(100, 9);
    expect(r.ledger.positions[0].costBasisUsd).toBeCloseTo(100, 9);
    expect(r.unpricedMints.has(A)).toBe(true);
  });

  it("keeps each mint's lots to itself", () => {
    const r = replayFills(W, [
      fill({ mint: A, side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ mint: B, side: "sell", tokens: 100, priceUsd: 5, ts: T0 + H }),
    ]);
    expect(r.ledger.realizedPnlUsd).toBe(0);
    expect(r.unmatched.get(B)).toBeCloseTo(100, 9);
    expect(r.derivedTokens.get(A)).toBeCloseTo(100, 9);
  });

  it("replays in time order regardless of input order", () => {
    const buy = fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 });
    const sell = fill({ side: "sell", tokens: 100, priceUsd: 4, ts: T0 + H });
    const forwards = replayFills(W, [buy, sell]).ledger.realizedPnlUsd;
    const backwards = replayFills(W, [sell, buy]).ledger.realizedPnlUsd;
    expect(backwards).toBeCloseTo(forwards, 9);
    expect(backwards).toBeCloseTo(300, 9);
  });
});

describe("reconcile — does the history explain the balance?", () => {
  it("accepts a position the fills fully account for", () => {
    expect(reconcile(1000, 1000, false).costBasisKnown).toBe(true);
  });

  it("tolerates dust-level drift from transfer taxes and rounding", () => {
    expect(reconcile(1000, 1000 * (1 - RECONCILE_TOLERANCE / 2), false).costBasisKnown).toBe(true);
  });

  it("refuses when the wallet holds materially more than it was seen buying", () => {
    const v = reconcile(10_000, 400, false);
    expect(v.costBasisKnown).toBe(false);
    expect(v.reason).toMatch(/acquired outside this window/i);
  });

  it("refuses a position with no observed entry at all", () => {
    const v = reconcile(10_000, 0, false);
    expect(v.costBasisKnown).toBe(false);
    expect(v.reason).toMatch(/held before the readable window/i);
  });

  // Token counts can reconcile perfectly while the cost is still unknown,
  // because an unpriced arrival supplies tokens and no price.
  it("refuses when part of the position arrived without a price", () => {
    const v = reconcile(1000, 1000, true);
    expect(v.costBasisKnown).toBe(false);
    expect(v.reason).toMatch(/no price attached/i);
  });
});

describe("assembleProfile — what reaches the screen", () => {
  const holdings = (tokens: { mint: string; tokens: number }[]) => ({
    source: "jupiter",
    solBalance: 1.5,
    tokens: tokens.map((t) => ({ ...t, decimals: 6, frozen: false, excludeFromNetWorth: false })),
  });

  it("prices a reconciled position and gives it an unrealized PnL", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 1000, priceUsd: 1, ts: T0 })],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 1000 }]),
      prices: new Map([[A, 1.5]]),
    });
    const pos = p.positions.find((x) => x.mint === A)!;
    expect(pos.costBasisKnown).toBe(true);
    expect(pos.costBasisUsd).toBeCloseTo(1000, 9);
    expect(pos.valueUsd).toBeCloseTo(1500, 9);
    expect(pos.unrealizedPnlUsd).toBeCloseTo(500, 9);
    expect(p.stats.unrealizedPnlUsd).toBeCloseTo(500, 9);
  });

  // The lie this whole design exists to refuse. The wallet holds 10,000 tokens
  // and we watched it buy 400; a tracker that assumed would report a 25x.
  it("gives an unreconciled position a value and NO unrealized PnL", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 400, priceUsd: 0.01, ts: T0 })],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 10_000 }]),
      prices: new Map([[A, 1]]),
    });
    const pos = p.positions.find((x) => x.mint === A)!;
    expect(pos.valueUsd).toBeCloseTo(10_000, 9);
    expect(pos.costBasisUsd).toBeUndefined();
    expect(pos.unrealizedPnlUsd).toBeUndefined();
    expect(pos.costBasisKnown).toBe(false);
    expect(p.stats.unrealizedPnlUsd).toBeUndefined();
    expect(p.unmeasured).toContain("costBasis");
  });

  // A zero here would say "traded and broke even". The truth is "has not
  // closed a trade where we could see it".
  it("leaves realized PnL and win rate absent when no round trip closed", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 })],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 100 }]),
      prices: new Map([[A, 1]]),
    });
    expect(p.stats.realizedPnlUsd).toBeUndefined();
    expect(p.stats.winRate).toBeUndefined();
    expect(p.stats.profitFactor).toBeUndefined();
    expect(p.stats.medianHoldHours).toBeUndefined();
    expect(p.stats.roundTrips).toBe(0);
  });

  it("declares realizedPnl unmeasured when sells outran the observed buys", () => {
    const p = assembleProfile({
      address: W,
      fills: [
        fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
        fill({ side: "sell", tokens: 500, priceUsd: 2, ts: T0 + H }),
      ],
      coverage: COVERAGE,
      holdings: holdings([]),
      prices: new Map(),
    });
    expect(p.unmeasured).toContain("realizedPnl");
    expect(p.stats.unmatchedSellTokens).toBeCloseTo(400, 9);
    expect(p.stats.unmatchedSellMints).toBe(1);
    // Only the matched hundred is profit: cost $100, proceeds $200.
    expect(p.stats.realizedPnlUsd).toBeCloseTo(100, 9);
  });

  // Set on every keyless read, unconditionally, so nothing downstream can read
  // a two-day figure as a lifetime one.
  it("always declares lifetime history and reputation unmeasured", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: holdings([]),
      prices: new Map(),
    });
    expect(p.unmeasured).toContain("lifetimeHistory");
    expect(p.unmeasured).toContain("reputation");
    expect(p.coverage.lifetime).toBe(false);
  });

  it("counts a mint held but never priced instead of valuing it at zero", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: holdings([
        { mint: A, tokens: 10 },
        { mint: B, tokens: 20 },
      ]),
      prices: new Map([[A, 3]]),
    });
    expect(p.holdings?.pricedMints).toBe(1);
    expect(p.holdings?.unpricedMints).toBe(1);
    expect(p.holdings?.valuedUsd).toBeCloseTo(30, 9);
    expect(p.positions.find((x) => x.mint === B)?.valueUsd).toBeUndefined();
  });

  it("names the window and the sources in its provenance", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 100 })],
      coverage: { ...COVERAGE, transactionsRefused: 3, transactionsFailed: 3 },
      holdings: holdings([{ mint: A, tokens: 100 }]),
      prices: new Map(),
    });
    const joined = p.provenance.join(" | ");
    expect(joined).toMatch(/solana-rpc/);
    expect(joined).toMatch(/jupiter/);
    expect(joined).toMatch(/rate limit/i);
    expect(joined).toMatch(/smart-money score: NOT COMPUTED/);
  });

  it("says so when the balance read failed rather than showing a partial bag as complete", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 100, priceUsd: 1 })],
      coverage: COVERAGE,
      holdings: null,
      prices: new Map([[A, 2]]),
    });
    expect(p.holdings).toBeNull();
    expect(p.provenance.join(" ")).toMatch(/positions: UNAVAILABLE/);
    // The fill-derived position survives — it is evidence, and dropping it
    // would lose a trade we watched happen.
    expect(p.positions.find((x) => x.mint === A)?.tokens).toBeCloseTo(100, 9);
  });
});
