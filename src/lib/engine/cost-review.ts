import { bucketOf, mean, median, MIN_PASSES, resolveOutcomes, type Observation } from "./track-record";

/** A sensitivity analysis, not a fill simulator or an executable strategy. */
export function costReview(ledger: readonly Observation[], horizon: string, band: string, costPct: number, now = Date.now()) {
  if (!Number.isFinite(costPct) || costPct < 0 || costPct >= 100) throw new Error("Cost must be between 0 and 100% (exclusive).");
  const rows = resolveOutcomes(ledger, undefined, now).resolved.filter(r => r.horizon === horizon && bucketOf(r.obs.score)?.label === band && r.obs.unmeasuredCount === 0);
  const passes = new Set(rows.map(r => r.obs.ts)).size;
  const net = rows.map(r => ((1 + r.returnPct / 100) * (1 - costPct / 100) - 1) * 100);
  return {
    count: rows.length, passes, enough: passes >= MIN_PASSES,
    grossMeanPct: rows.length ? mean(rows.map(r => r.returnPct)) : null,
    netMeanPct: net.length ? mean(net) : null,
    netMedianPct: net.length ? median(net) : null,
    positiveRate: net.length ? net.filter(n => n > 0).length / net.length : null,
  };
}
