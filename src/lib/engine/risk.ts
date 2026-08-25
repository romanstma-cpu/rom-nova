// Token security / risk radar. Grades are coarse on purpose — a red badge
// the user can trust beats a decimal that implies precision nobody has.

import type { DemoStore } from "../demo/store";
import { extractFeatures } from "./features";
import type { RiskLevel, RiskRadar } from "../types";

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

  const concentration: RiskLevel = f.top10Pct > 0.4 ? "high" : f.top10Pct > 0.25 ? "medium" : "low";
  const dev: RiskLevel = f.devSold ? "high" : f.devHoldsPct > 0.08 ? "medium" : "low";
  if (f.devSold) notes.push("deployer wallet has been selling");

  const bundler: RiskLevel = f.bundlerPct + f.sniperPct > 0.18 ? "high" : f.bundlerPct + f.sniperPct > 0.08 ? "medium" : "low";
  const organic: RiskLevel = f.organicScore < 0.35 ? "high" : f.organicScore < 0.55 ? "medium" : "low";
  const structure: RiskLevel =
    f.momentum24h > 150 || f.liquidityChangePct < -35 ? "high" : Math.abs(f.momentum24h) > 60 ? "medium" : "low";

  const highCount = [security, liquidity, concentration, dev, bundler, organic, structure].filter((x) => x === "high").length;
  const medCount = [security, liquidity, concentration, dev, bundler, organic, structure].filter((x) => x === "medium").length;
  const overall: RiskLevel = highCount >= 2 ? "high" : highCount === 1 || medCount >= 3 ? "medium" : "low";

  return { mint, overall, security, liquidity, concentration, dev, bundler, organic, structure, notes };
}
