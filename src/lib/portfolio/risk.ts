// What a wallet's holdings say about its risk, from the balances one read
// returned and nothing inferred.
//
// Concentration is measured over the tokens, with native SOL reported
// beside it rather than inside it: a wallet that is ninety percent SOL and
// ten percent one memecoin is not "one bet", it is mostly cash with a
// small bet — and the reading says which. A position without a cost
// basis (bought where this read could not see) counts in the concentration
// and is named as unknown-cost, because no PnL may claim it.

import type { WalletProfile } from "@/lib/types";

export type ConcentrationReading = "one bet" | "concentrated" | "spread" | "no tokens";

/** Above this share of token value in one position: one bet. */
export const ONE_BET_PCT = 0.6;
/** Above this share in the top three: concentrated. */
export const CONCENTRATED_PCT = 0.8;

export interface PortfolioRisk {
  valuedUsd: number;
  tokenValueUsd: number;
  solValueUsd: number | null;
  /** share of everything valued that is native SOL */
  solPct: number | null;
  /** positions with a price and a balance worth counting */
  positions: number;
  unpricedMints: number;
  /** Jupiter's dust and spam flag */
  dust: number;
  top1: { mint: string; symbol: string; pct: number; valueUsd: number } | null;
  top3Pct: number | null;
  /** share of token value whose cost basis this read could not see */
  unknownCostPct: number | null;
  reading: ConcentrationReading;
  notes: string[];
}

export function portfolioRisk(p: Pick<WalletProfile, "holdings" | "positions">): PortfolioRisk | null {
  const h = p.holdings;
  if (!h) return null;
  const counted = p.positions
    .filter((x) => !x.excludeFromNetWorth && typeof x.valueUsd === "number" && Number.isFinite(x.valueUsd) && x.valueUsd > 0.01)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const dust = p.positions.filter((x) => x.excludeFromNetWorth).length;
  const tokenValue = counted.reduce((sum, x) => sum + (x.valueUsd ?? 0), 0);
  const solValue = typeof h.solValueUsd === "number" && Number.isFinite(h.solValueUsd) ? h.solValueUsd : null;
  const valued = tokenValue + (solValue ?? 0);
  const solPct = solValue !== null && valued > 0 ? solValue / valued : null;

  const top = counted[0];
  const top1 = top && tokenValue > 0 ? { mint: top.mint, symbol: top.symbol ?? "", pct: (top.valueUsd ?? 0) / tokenValue, valueUsd: top.valueUsd ?? 0 } : null;
  const top3Pct = tokenValue > 0 ? counted.slice(0, 3).reduce((sum, x) => sum + (x.valueUsd ?? 0), 0) / tokenValue : null;
  const unknownCost = counted.filter((x) => !x.costBasisKnown).reduce((sum, x) => sum + (x.valueUsd ?? 0), 0);
  const unknownCostPct = tokenValue > 0 ? unknownCost / tokenValue : null;

  const reading: ConcentrationReading =
    counted.length === 0 || tokenValue <= 0 ? "no tokens" : top1 && top1.pct >= ONE_BET_PCT ? "one bet" : top3Pct !== null && top3Pct >= CONCENTRATED_PCT ? "concentrated" : "spread";

  const notes: string[] = [];
  if (h.unpricedMints > 0) notes.push(`${h.unpricedMints} held mint${h.unpricedMints === 1 ? " has" : "s have"} no published price and ${h.unpricedMints === 1 ? "is" : "are"} not counted`);
  if (dust > 0) notes.push(`${dust} position${dust === 1 ? "" : "s"} Jupiter flags as dust or spam, left out`);
  if (unknownCostPct !== null && unknownCostPct > 0) notes.push(`${Math.round(unknownCostPct * 100)}% of token value was bought where this read could not see — its cost is unknown, so no PnL claims it`);
  if (solPct !== null && solPct >= 0.5) notes.push(`${Math.round(solPct * 100)}% of the wallet is native SOL`);
  if (solValue === null && h.solBalance > 0) notes.push("native SOL not valued: no SOL price was available for this read");

  return {
    valuedUsd: valued,
    tokenValueUsd: tokenValue,
    solValueUsd: solValue,
    solPct,
    positions: counted.length,
    unpricedMints: h.unpricedMints,
    dust,
    top1,
    top3Pct,
    unknownCostPct,
    reading,
    notes,
  };
}
