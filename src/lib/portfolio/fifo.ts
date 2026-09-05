// FIFO over a wallet's observed fills: what each sell cost, what it made,
// how long the lots it consumed were held.
//
// An estimate, and labelled as one everywhere it appears. The inputs are
// the fills one read of the chain returned, priced at the fill where a
// price was seen; a sell that consumes tokens this read never saw bought
// has no cost basis, and is EXCLUDED from realized figures rather than
// booked at zero cost as pure profit. That exclusion is the whole point:
// every tracker that assumes a basis turns an old bag into a gain.
//
// Lots are consumed oldest first, per mint, which is the FIFO most tax
// regimes default to. The long-term flag is the one-year line; whether it
// means anything for the reader is a question for their accountant, not
// this file.

import type { WalletFill } from "@/lib/types";

export const LONG_TERM_DAYS = 365;
const DAY_MS = 86_400_000;
const EPS = 1e-12;

export interface FifoRow {
  ts: number;
  signature: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  tokens: number;
  priceUsd: number | null;
  valueUsd: number | null;
  /** sells: tokens matched against observed lots, and tokens that were not */
  matchedTokens: number;
  unmatchedTokens: number;
  /** sells: FIFO cost of the matched tokens, when every consumed lot had a price */
  costBasisUsd: number | null;
  /** sells: proceeds of the matched tokens alone */
  proceedsUsd: number | null;
  realizedPnlUsd: number | null;
  /** sells: token-weighted age of the consumed lots */
  holdDays: number | null;
  /** sells: every consumed lot older than a year */
  longTerm: boolean | null;
  note: string;
}

export interface FifoSummary {
  fills: number;
  buys: number;
  sells: number;
  /** over sells with a known cost and a price */
  realizedPnlUsd: number;
  shortTermPnlUsd: number;
  longTermPnlUsd: number;
  /** sells fully matched against observed lots */
  matchedSells: number;
  /** sells matched in part */
  partlyMatchedSells: number;
  /** sells with no observed lot at all */
  unmatchedSells: number;
  unpricedSells: number;
  /** matched sells whose lots lacked a price */
  unknownCostSells: number;
  mints: number;
  /** lots still open at the end of the fills: tokens bought and not yet sold, by mint */
  openLots: number;
  firstTs: number | null;
  lastTs: number | null;
}

interface Lot {
  tokens: number;
  priceUsd: number | null;
  ts: number;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function fifoRows(fills: readonly WalletFill[], symbolOf: (mint: string) => string | undefined = () => undefined): { rows: FifoRow[]; summary: FifoSummary } {
  const sorted = [...fills].sort((a, b) => a.ts - b.ts || a.slot - b.slot || a.signature.localeCompare(b.signature));
  const lots = new Map<string, Lot[]>();
  const rows: FifoRow[] = [];
  const s: FifoSummary = {
    fills: sorted.length,
    buys: 0,
    sells: 0,
    realizedPnlUsd: 0,
    shortTermPnlUsd: 0,
    longTermPnlUsd: 0,
    matchedSells: 0,
    partlyMatchedSells: 0,
    unmatchedSells: 0,
    unpricedSells: 0,
    unknownCostSells: 0,
    mints: 0,
    openLots: 0,
    firstTs: sorted.length ? sorted[0].ts : null,
    lastTs: sorted.length ? sorted[sorted.length - 1].ts : null,
  };

  for (const f of sorted) {
    const price = finite(f.priceUsd);
    const value = finite(f.valueUsd) ?? (price !== null ? price * f.tokens : null);
    const symbol = symbolOf(f.mint) ?? "";
    const base = { ts: f.ts, signature: f.signature, mint: f.mint, symbol, side: f.side, tokens: f.tokens, priceUsd: price, valueUsd: value };

    if (f.side === "buy") {
      s.buys++;
      const q = lots.get(f.mint) ?? [];
      q.push({ tokens: f.tokens, priceUsd: price, ts: f.ts });
      lots.set(f.mint, q);
      rows.push({
        ...base,
        matchedTokens: 0,
        unmatchedTokens: 0,
        costBasisUsd: null,
        proceedsUsd: null,
        realizedPnlUsd: null,
        holdDays: null,
        longTerm: null,
        note: price === null ? "bought without a price — this lot's cost is unknown" : "",
      });
      continue;
    }

    s.sells++;
    const q = lots.get(f.mint) ?? [];
    let remaining = f.tokens;
    let matched = 0;
    let cost = 0;
    let costKnown = true;
    let weightedAgeMs = 0;
    let allLong = true;
    while (remaining > EPS && q.length > 0) {
      const lot = q[0];
      const take = Math.min(lot.tokens, remaining);
      matched += take;
      remaining -= take;
      lot.tokens -= take;
      if (lot.priceUsd === null) costKnown = false;
      else cost += take * lot.priceUsd;
      const age = f.ts - lot.ts;
      weightedAgeMs += take * age;
      if (age < LONG_TERM_DAYS * DAY_MS) allLong = false;
      if (lot.tokens <= EPS) q.shift();
    }
    const unmatched = remaining > EPS ? remaining : 0;
    const anyLot = matched > EPS;
    const proceeds = anyLot && price !== null ? price * matched : null;
    const costBasis = anyLot && costKnown ? cost : null;
    const realized = proceeds !== null && costBasis !== null ? proceeds - costBasis : null;
    const holdDays = anyLot ? weightedAgeMs / matched / DAY_MS : null;
    const longTerm = anyLot ? allLong : null;

    if (!anyLot) s.unmatchedSells++;
    else if (unmatched > 0) s.partlyMatchedSells++;
    else s.matchedSells++;
    if (price === null) s.unpricedSells++;
    if (anyLot && !costKnown) s.unknownCostSells++;
    if (realized !== null) {
      s.realizedPnlUsd += realized;
      if (longTerm) s.longTermPnlUsd += realized;
      else s.shortTermPnlUsd += realized;
    }

    rows.push({
      ...base,
      matchedTokens: matched,
      unmatchedTokens: unmatched,
      costBasisUsd: costBasis,
      proceedsUsd: proceeds,
      realizedPnlUsd: realized,
      holdDays,
      longTerm,
      note: !anyLot
        ? "sold out of lots this read never saw bought — excluded from realized figures"
        : unmatched > 0
          ? "part of this sell came from lots never observed — that part is excluded"
          : price === null
            ? "no price at the fill — proceeds unknown"
            : !costKnown
              ? "a lot behind this sell had no price — cost unknown"
              : "",
    });
  }

  s.mints = lots.size;
  for (const q of lots.values()) s.openLots += q.length;
  return { rows, summary: s };
}
