// Token security / risk radar. Grades are coarse on purpose — a red badge
// the user can trust beats a decimal that implies precision nobody has.

import type { DemoStore } from "../demo/store";
import { extractFeatures } from "./features";
import type { FeatureVector, RiskLevel, RiskRadar, UnmeasuredField } from "../types";

/** Whether the provider behind this vector could see a given field. */
function isUnmeasured(f: FeatureVector, field: UnmeasuredField): boolean {
  return Boolean(f.unmeasured?.includes(field));
}

const worst = (...levels: RiskLevel[]): RiskLevel =>
  levels.includes("high") ? "high" : levels.includes("medium") ? "medium" : "low";

export function riskRadar(store: DemoStore, mint: string, asOf?: number): RiskRadar | undefined {
  const tok = store.token(mint);
  const f = extractFeatures(store, mint, asOf ?? store.simulatedUntil);
  if (!tok || !f) return undefined;
  const info = tok.info;
  const notes: string[] = [];

  let security: RiskLevel = "low";
  if (!info.mintAuthorityRevoked) {
    security = "high";
    notes.push("mint authority is NOT revoked — supply can be inflated");
  }
  if (!info.freezeAuthorityRevoked) {
    security = worst(security, "high");
    notes.push("freeze authority is NOT revoked — transfers can be frozen");
  }
  if (info.permanentDelegate) {
    security = worst(security, "high");
    notes.push("permanent delegate set — a third party can move balances");
  }
  if (!info.verified) {
    security = worst(security, "medium");
    notes.push("token is unverified");
  }

  const liquidity: RiskLevel = f.exitDepthUsd < 15_000 ? "high" : f.exitDepthUsd < 60_000 ? "medium" : "low";
  if (liquidity !== "low") notes.push(`exit depth ~$${Math.round(f.exitDepthUsd / 1000)}K near current price`);
  if (f.liquidityChangePct < -25) notes.push(`pool drained ${f.liquidityChangePct.toFixed(0)}% in 24h`);

  // A grade this radar cannot compute must never come out "low".
  //
  // Every threshold below reads a percentage, and a source that does not
  // publish supply distribution hands over a zero. Zero top-10 concentration,
  // zero bundlers, zero snipers, a dev holding nothing: read literally, the
  // cleanest token ever listed. Unknown is graded HIGH instead — on a
  // memecoin, "nobody has checked who holds this" is a fact about danger, not
  // an absence of it.
  const missing = (field: Parameters<typeof isUnmeasured>[1]) => isUnmeasured(f, field);

  const concentration: RiskLevel = missing("top10Pct")
    ? "high"
    : f.top10Pct > 0.4
      ? "high"
      : f.top10Pct > 0.25
        ? "medium"
        : "low";
  if (missing("top10Pct")) notes.push("supply distribution unknown — this source does not publish holder data");

  const dev: RiskLevel = f.devSold ? "high" : missing("devHoldsPct") ? "high" : f.devHoldsPct > 0.08 ? "medium" : "low";
  if (f.devSold) notes.push("deployer wallet has been selling");
  else if (missing("devHoldsPct")) notes.push("deployer holdings unknown");

  const bundler: RiskLevel = missing("bundlerPct") || missing("sniperPct")
    ? "high"
    : f.bundlerPct + f.sniperPct > 0.18
      ? "high"
      : f.bundlerPct + f.sniperPct > 0.08
        ? "medium"
        : "low";
  if (missing("bundlerPct") || missing("sniperPct")) notes.push("bundler and sniper supply unknown");

  // organicScore already fails safe — an unmeasured zero lands under the 0.35
  // threshold and grades high on its own — but stated explicitly so the note
  // says "unknown" rather than implying inorganic trading was observed.
  const organic: RiskLevel = missing("organicScore")
    ? "high"
    : f.organicScore < 0.35
      ? "high"
      : f.organicScore < 0.55
        ? "medium"
        : "low";
  if (missing("organicScore")) notes.push("organic-activity score unavailable from this source");
  const structure: RiskLevel =
    f.momentum24h > 150 || f.liquidityChangePct < -35 ? "high" : Math.abs(f.momentum24h) > 60 ? "medium" : "low";

  const highCount = [security, liquidity, concentration, dev, bundler, organic, structure].filter((x) => x === "high").length;
  const medCount = [security, liquidity, concentration, dev, bundler, organic, structure].filter((x) => x === "medium").length;
  const overall: RiskLevel = highCount >= 2 ? "high" : highCount === 1 || medCount >= 3 ? "medium" : "low";

  return { mint, overall, security, liquidity, concentration, dev, bundler, organic, structure, notes };
}
