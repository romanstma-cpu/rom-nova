// A real wallet, assembled: what it holds, what it paid, what it made.
//
// Three sources meet here and each answers a different question, which is why
// the assembly is a file of its own rather than a method on a provider:
//
//   solana-rpc   what it DID     fills, from balance deltas, last ~2 days
//   jupiter      what it HAS     current balances, complete, no history
//   jupiter      what it is WORTH current prices
//
// THE RECONCILIATION IS THE POINT
//
// A wallet tracker that only replays trades reports a position it can explain.
// A wallet tracker that only reads balances reports a position it cannot
// price. Having both lets this one report the DISAGREEMENT, and the
// disagreement is where the lie usually lives: when the observed fills account
// for 400 tokens and the chain says the wallet holds 10,000, the other 9,600
// arrived before the window or by transfer, and every cost-basis figure for
// that position is a guess.
//
// So a position whose token count does not reconcile gets a value and NO PnL.
// That is the whole discipline. The alternative — assuming the unobserved
// tokens were free, or were bought at the earliest price seen — is how a bag
// acquired months ago gets rendered as a clean multiple.
//
// WHAT REALIZED PnL MEANS HERE AND ONLY HERE
//
// FIFO over the observed fills. When a sell finds no lot, the buy happened
// outside the window: its proceeds are real and its PROFIT is unknowable, so
// the sell is excluded from realized PnL entirely and counted in
// `unmatchedSellTokens`. Crediting it against a zero cost would book the whole
// proceeds as gain, which on a wallet whose entries all predate the window
// would report a pure, enormous, fictional profit.

import type {
  UnmeasuredWalletField,
  WalletCoverage,
  WalletFill,
  WalletHolding,
  WalletProfile,
  WalletWindowStats,
} from "../types";
import { measurePerformance, type RoundTrip, type WalletLedger } from "./perf";
import type { HeldToken } from "../providers/holdings";

interface Lot {
  tokens: number;
  costPerToken: number;
  ts: number;
}

export interface FillReplay {
  ledger: WalletLedger;
  /** Tokens sold out of lots that were never observed being bought, per mint. */
  unmatched: Map<string, number>;
  /** Tokens the observed fills leave the wallet holding, per mint. */
  derivedTokens: Map<string, number>;
  /** Mints where at least one movement had no price at all. */
  unpricedMints: Set<string>;
}

/** Floating-point dust after repeated lot splitting; not a real balance. */
const EPS = 1e-9;

/**
 * FIFO replay over observed fills.
 *
 * The lot maths is `perf.replayWallet`'s, repointed at `WalletFill` and taught
 * two things the simulator never needed to know:
 *
 *  - An unpriced movement still MOVES TOKENS. It changes the position and
 *    contributes no cost, so it enters `derivedTokens` and never enters a lot.
 *    Skipping it entirely would make the reconciliation below claim a
 *    divergence that this read could actually explain.
 *  - A sell can exhaust the lots. The remainder is recorded rather than
 *    silently matched at zero cost.
 */
export function replayFills(address: string, fills: readonly WalletFill[]): FillReplay {
  const lots = new Map<string, Lot[]>();
  const opened = new Map<string, number>();
  const derivedTokens = new Map<string, number>();
  const unmatched = new Map<string, number>();
  const unpricedMints = new Set<string>();
  const roundTrips: RoundTrip[] = [];
  let realized = 0;

  const bump = (mint: string, by: number): void => {
    derivedTokens.set(mint, (derivedTokens.get(mint) ?? 0) + by);
  };

  for (const f of [...fills].sort((a, b) => a.ts - b.ts || a.slot - b.slot)) {
    const priced = f.priceUsd !== undefined && f.priceUsd > 0;
    if (!priced) unpricedMints.add(f.mint);

    if (f.side === "buy") {
      bump(f.mint, f.tokens);
      if (!priced) continue;
      const arr = lots.get(f.mint) ?? [];
      if (arr.length === 0 && !opened.has(f.mint)) opened.set(f.mint, f.ts);
      arr.push({ tokens: f.tokens, costPerToken: f.priceUsd as number, ts: f.ts });
      lots.set(f.mint, arr);
      continue;
    }

    bump(f.mint, -f.tokens);
    const arr = lots.get(f.mint) ?? [];
    let remaining = f.tokens;
    let cost = 0;
    let sold = 0;
    while (remaining > EPS && arr.length > 0) {
      const lot = arr[0];
      const take = Math.min(lot.tokens, remaining);
      cost += take * lot.costPerToken;
      sold += take;
      lot.tokens -= take;
      remaining -= take;
      if (lot.tokens <= EPS) arr.shift();
    }
    if (remaining > EPS) {
      // Sold more than we watched them buy. The window started mid-position.
      unmatched.set(f.mint, (unmatched.get(f.mint) ?? 0) + remaining);
    }
    if (sold > EPS && priced) {
      const proceeds = sold * (f.priceUsd as number);
      realized += proceeds - cost;
      if (arr.length === 0) {
        const entryTs = opened.get(f.mint) ?? f.ts;
        roundTrips.push({
          mint: f.mint,
          entryTs,
          exitTs: f.ts,
          costUsd: cost,
          proceedsUsd: proceeds,
          pnlUsd: proceeds - cost,
          holdHours: (f.ts - entryTs) / 3_600_000,
        });
        opened.delete(f.mint);
      }
    }
    if (arr.length === 0) lots.delete(f.mint);
  }

  const positions = [];
  for (const [mint, arr] of lots) {
    const tokens = arr.reduce((s, l) => s + l.tokens, 0);
    if (tokens <= EPS) continue;
    positions.push({
      wallet: address,
      mint,
      tokens,
      costBasisUsd: arr.reduce((s, l) => s + l.tokens * l.costPerToken, 0),
      openedAt: opened.get(mint) ?? arr[0].ts,
      lastChangedAt: arr[arr.length - 1].ts,
    });
  }

  return {
    ledger: { address, positions, roundTrips, realizedPnlUsd: realized },
    unmatched,
    derivedTokens,
    unpricedMints,
  };
}

/**
 * How far the observed fills and the real balance may differ and still be
 * called the same position.
 *
 * One percent, not zero. A wallet that bought 10,000 tokens and holds 9,999.97
 * lost the rest to a transfer tax or to the rounding in `uiAmount`; treating
 * that as an unexplained acquisition would mark almost every position unknown
 * and make the honest signal useless by crying wolf.
 */
export const RECONCILE_TOLERANCE = 0.01;

export interface ReconcileVerdict {
  costBasisKnown: boolean;
  reason?: string;
}

/**
 * Does the trade history explain the balance the chain reports?
 *
 * Three ways it does not, each with a different meaning for the reader:
 * tokens the wallet held before the window, tokens that arrived without a
 * price, and tokens the wallet has that the fills never mention at all.
 */
export function reconcile(
  held: number,
  observed: number,
  hadUnpricedMovement: boolean,
): ReconcileVerdict {
  if (observed <= EPS) {
    return {
      costBasisKnown: false,
      reason: "held before the readable window — no entry observed, so no cost basis",
    };
  }
  if (hadUnpricedMovement) {
    return {
      costBasisKnown: false,
      reason: "part of this position moved with no price attached — cost basis incomplete",
    };
  }
  const drift = Math.abs(held - observed) / Math.max(held, EPS);
  if (drift > RECONCILE_TOLERANCE) {
    return {
      costBasisKnown: false,
      reason:
        `fills account for ${observed.toLocaleString(undefined, { maximumFractionDigits: 2 })} of ` +
        `${held.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens held — the rest ` +
        `was acquired outside this window`,
    };
  }
  return { costBasisKnown: true };
}

export interface AssembleInput {
  address: string;
  fills: readonly WalletFill[];
  coverage: WalletCoverage;
  holdings: { source: string; solBalance: number; tokens: HeldToken[] } | null;
  prices: Map<string, number>;
  /** Symbols where a token lookup supplied one. Purely cosmetic. */
  symbols?: Map<string, string>;
}

/** Everything above, wired into the one object a page renders. */
export function assembleProfile(input: AssembleInput): WalletProfile {
  const { address, fills, coverage, holdings, prices } = input;
  const symbols = input.symbols ?? new Map<string, string>();
  const replay = replayFills(address, fills);
  const derivedByMint = new Map(
    replay.ledger.positions.map((p) => [p.mint, p]),
  );

  const positions: WalletHolding[] = [];
  let unrealized = 0;
  let anyCostUnknown = false;
  let valuedUsd = 0;
  let pricedMints = 0;

  for (const held of holdings?.tokens ?? []) {
    const priceUsd = prices.get(held.mint);
    const valueUsd = priceUsd !== undefined ? held.tokens * priceUsd : undefined;
    if (valueUsd !== undefined) {
      valuedUsd += valueUsd;
      pricedMints++;
    }
    const derived = derivedByMint.get(held.mint);
    const observed = derived?.tokens ?? Math.max(0, replay.derivedTokens.get(held.mint) ?? 0);
    const verdict = reconcile(held.tokens, observed, replay.unpricedMints.has(held.mint));

    const row: WalletHolding = {
      mint: held.mint,
      symbol: symbols.get(held.mint),
      decimals: held.decimals,
      tokens: held.tokens,
      priceUsd,
      valueUsd,
      observedTokens: observed,
      costBasisKnown: verdict.costBasisKnown,
      reason: verdict.reason,
      excludeFromNetWorth: held.excludeFromNetWorth,
    };

    if (verdict.costBasisKnown && derived) {
      row.costBasisUsd = derived.costBasisUsd;
      if (valueUsd !== undefined) {
        row.unrealizedPnlUsd = valueUsd - derived.costBasisUsd;
        row.unrealizedPnlPct =
          derived.costBasisUsd > 0 ? (row.unrealizedPnlUsd / derived.costBasisUsd) * 100 : undefined;
        unrealized += row.unrealizedPnlUsd;
      }
    } else {
      anyCostUnknown = true;
    }
    positions.push(row);
  }

  // Positions the fills opened that the holdings call did not return. Either
  // Jupiter missed them or the wallet closed them between the two reads; either
  // way the fills are evidence and dropping them would lose real trades.
  for (const p of replay.ledger.positions) {
    if (positions.some((row) => row.mint === p.mint)) continue;
    positions.push({
      mint: p.mint,
      symbol: symbols.get(p.mint),
      decimals: 0,
      tokens: p.tokens,
      priceUsd: prices.get(p.mint),
      valueUsd: prices.get(p.mint) !== undefined ? p.tokens * (prices.get(p.mint) as number) : undefined,
      costBasisUsd: p.costBasisUsd,
      observedTokens: p.tokens,
      costBasisKnown: true,
      reason: "derived from observed fills — not present in the balance read",
    });
  }
  positions.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  // Performance over the window. `measurePerformance` supplies the shared maths
  // — win rate, profit factor, median hold — from the same ledger shape the
  // simulator uses, so the two paths cannot drift apart.
  const perf = measurePerformance(replay.ledger, (mint) => prices.get(mint));
  const rt = replay.ledger.roundTrips;
  const priced = fills.filter((f) => f.priceUsd !== undefined).length;
  const unmatchedTokens = [...replay.unmatched.values()].reduce((s, x) => s + x, 0);

  const stats: WalletWindowStats = {
    // Realized PnL exists only if a round trip closed inside the window. With
    // none, the honest value is absent — 0 would read as "traded and broke
    // even" on a wallet that simply has not sold yet.
    realizedPnlUsd: rt.length > 0 ? replay.ledger.realizedPnlUsd : undefined,
    unrealizedPnlUsd: positions.some((p) => p.unrealizedPnlUsd !== undefined) ? unrealized : undefined,
    winRate: rt.length > 0 ? perf.winRate : undefined,
    profitFactor: rt.length > 0 ? perf.profitFactor : undefined,
    avgWinUsd: rt.length > 0 ? perf.avgWinUsd : undefined,
    avgLossUsd: rt.length > 0 ? perf.avgLossUsd : undefined,
    medianHoldHours: rt.length > 0 ? perf.medianHoldHours : undefined,
    roundTrips: rt.length,
    buys: fills.filter((f) => f.side === "buy").length,
    sells: fills.filter((f) => f.side === "sell").length,
    pricedFills: priced,
    unpricedFills: fills.length - priced,
    distinctMints: new Set(fills.map((f) => f.mint)).size,
    unmatchedSellTokens: unmatchedTokens,
    unmatchedSellMints: replay.unmatched.size,
  };

  const unmeasured: UnmeasuredWalletField[] = [
    // Always. There is no keyless lifetime history; see `wallet-chain.ts`.
    "lifetimeHistory",
    // Always. Nothing here carries wallet reputation, measured or otherwise.
    "reputation",
  ];
  if (anyCostUnknown) unmeasured.push("costBasis");
  if (replay.unmatched.size > 0) unmeasured.push("realizedPnl");
  if (stats.unpricedFills > 0) unmeasured.push("fillPrice");

  return {
    address,
    coverage,
    holdings: holdings
      ? {
          source: holdings.source,
          solBalance: holdings.solBalance,
          mints: holdings.tokens.length,
          valuedUsd,
          pricedMints,
          unpricedMints: holdings.tokens.length - pricedMints,
        }
      : null,
    positions,
    roundTrips: rt
      .map((r) => ({ ...r, symbol: symbols.get(r.mint) }))
      .sort((a, b) => b.exitTs - a.exitTs),
    fills: [...fills].sort((a, b) => b.ts - a.ts),
    stats,
    unmeasured,
    provenance: provenanceLines(coverage, holdings?.source ?? null, stats),
  };
}

/** One line per claim, naming who answered it and what it does not cover. */
function provenanceLines(
  coverage: WalletCoverage,
  holdingsSource: string | null,
  stats: WalletWindowStats,
): string[] {
  const out: string[] = [];
  const hours = coverage.windowHours;
  out.push(
    `trades: ${coverage.source} — ${coverage.transactionsRead} transactions over ` +
      `${hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(hours * 60)}min`}, ${coverage.note}`,
  );
  if (coverage.transactionsRefused > 0) {
    out.push(
      `${coverage.transactionsRefused} transactions were REFUSED by the public RPC's rate limit ` +
        `(2,400 requests per minute, shared across every tab on this connection) — reload shortly for a complete read`,
    );
  }
  const lost = coverage.transactionsFailed - coverage.transactionsRefused;
  if (lost > 0) {
    out.push(`${lost} transactions could not be read at all — their fills are missing from every figure below`);
  }
  out.push(
    holdingsSource
      ? `positions: ${holdingsSource} — current balances read whole, independent of the trade window`
      : `positions: UNAVAILABLE — the balance read failed, so only fill-derived positions are shown`,
  );
  if (stats.unpricedFills > 0) {
    out.push(
      `${stats.unpricedFills} of ${stats.pricedFills + stats.unpricedFills} movements had no quote leg belonging to this ` +
        `wallet (transfers, claims, token-for-token rotations) and carry no price`,
    );
  }
  if (stats.unmatchedSellMints > 0) {
    out.push(
      `sells in ${stats.unmatchedSellMints} token${stats.unmatchedSellMints === 1 ? "" : "s"} had no observed buy — ` +
        `excluded from realized PnL rather than counted as pure profit`,
    );
  }
  out.push("smart-money score: NOT COMPUTED — a two-day window is a sample, not a reputation");
  return out;
}
