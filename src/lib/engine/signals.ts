// The signal engine. Transparent by construction: every score is a sum of
// named factor contributions over a stored feature snapshot, so any signal
// can answer "why?" with numbers rather than vibes — and the engine is
// allowed to answer NO TRADE.

import type { DemoStore } from "../demo/store";
import { HOUR } from "../demo/universe";
import { extractFeatures } from "./features";
import {
  ENGINE_VERSION,
  type FeatureVector,
  type RiskFlag,
  type Signal,
  type SignalFactor,
  type SignalKind,
  type SignalLabel,
  type StrategyProfileId,
} from "../types";

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- factors

interface FactorDef {
  key: string;
  name: string;
  normalize: (f: FeatureVector) => number; // 0..1, higher = more bullish
  explain: (f: FeatureVector, norm: number) => string;
}

const usd = (x: number) =>
  `${x < 0 ? "-" : ""}$${Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(2) + "M" : Math.abs(x) >= 1e3 ? (Math.abs(x) / 1e3).toFixed(1) + "K" : Math.abs(x).toFixed(0)}`;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

export const FACTORS: FactorDef[] = [
  {
    key: "smart_money",
    name: "Smart Money Accumulation",
    normalize: (f) =>
      clamp(0.5 + Math.tanh(f.smartMoneyNetFlowUsd / 120_000) * 0.5) * clamp(0.4 + f.smartMoneyWallets / 8, 0, 1),
    explain: (f) =>
      f.smartMoneyWallets > 0
        ? `${f.smartMoneyWallets} high-scoring wallet${f.smartMoneyWallets === 1 ? "" : "s"} net ${f.smartMoneyNetFlowUsd >= 0 ? "bought" : "sold"} ${usd(Math.abs(f.smartMoneyNetFlowUsd))} in 6h`
        : "no tracked smart-money activity in the window",
  },
  {
    key: "whale_flow",
    name: "Whale Accumulation",
    normalize: (f) => clamp(0.5 + Math.tanh(f.whaleNetFlowUsd / 250_000) * 0.5),
    explain: (f) =>
      f.whaleBuys + f.whaleSells > 0
        ? `whale netflow ${usd(f.whaleNetFlowUsd)} (${f.whaleBuys} buys / ${f.whaleSells} sells)`
        : "no whale-sized trades in the window",
  },
  {
    key: "momentum",
    name: "Momentum",
    normalize: (f) => clamp(0.5 + Math.tanh(f.momentum1h / 12) * 0.3 + Math.tanh(f.momentum24h / 40) * 0.2),
    explain: (f) => `1h ${pct(f.momentum1h)}, 24h ${pct(f.momentum24h)}`,
  },
  {
    key: "volume_accel",
    name: "Volume Acceleration",
    normalize: (f) => clamp(Math.log2(Math.max(f.volumeAccel, 0.1)) / 4 + 0.5),
    explain: (f) => `6h volume running at ${(f.volumeAccel * 100).toFixed(0)}% of its trailing baseline`,
  },
  {
    key: "liquidity",
    name: "Liquidity Quality",
    normalize: (f) => clamp(Math.log10(Math.max(f.liquidityUsd, 1)) / 6.5) * clamp(0.7 + f.liquidityChangePct / 60),
    explain: (f) => `${usd(f.liquidityUsd)} pooled, ${pct(f.liquidityChangePct)} vs 24h ago`,
  },
  {
    key: "holder_growth",
    name: "Holder Growth",
    normalize: (f) => clamp(0.5 + Math.tanh(f.holderGrowthPct / 15) * 0.5),
    explain: (f) => `holders ${pct(f.holderGrowthPct)} over 24h`,
  },
  {
    key: "distribution",
    name: "Holder Distribution",
    normalize: (f) => clamp(1 - (f.top10Pct - 0.1) / 0.5),
    explain: (f) => `top 10 wallets hold ${(f.top10Pct * 100).toFixed(0)}% of supply`,
  },
  {
    key: "organic",
    name: "Organic Activity",
    normalize: (f) => f.organicScore,
    explain: (f) => `organic-activity score ${(f.organicScore * 100).toFixed(0)}/100`,
  },
  {
    key: "age_opportunity",
    name: "Token Age / Discovery",
    normalize: (f) => (f.ageHours < 4 ? 0.35 : f.ageHours < 72 ? 0.85 : f.ageHours < 24 * 14 ? 0.6 : 0.4),
    explain: (f) =>
      f.ageHours < 24
        ? `${f.ageHours.toFixed(0)}h old — early but unproven`
        : `${(f.ageHours / 24).toFixed(1)} days old`,
  },
  {
    key: "structure",
    name: "Market Structure",
    normalize: (f) => clamp(0.5 + f.buySellImbalance * 0.5) * clamp(0.5 + Math.tanh(f.exitDepthUsd / 60_000) * 0.5),
    explain: (f) =>
      `buy/sell imbalance ${(f.buySellImbalance * 100).toFixed(0)}%, ~${usd(f.exitDepthUsd)} exitable within 5% impact`,
  },
  {
    key: "social",
    name: "Social / Attention",
    normalize: (f) => clamp(f.socialScore * 0.7 + f.socialAccel * 2),
    explain: (f) => `attention ${(f.socialScore * 100).toFixed(0)}/100${f.socialAccel > 0.05 ? ", accelerating" : ""}`,
  },
];

// risk factors subtract from the score
export const RISK_FACTORS: FactorDef[] = [
  {
    key: "insider_risk",
    name: "Insider Risk",
    normalize: (f) => clamp(f.insiderPct / 0.3),
    explain: (f) => `insider-linked wallets hold ~${(f.insiderPct * 100).toFixed(0)}% of supply`,
  },
  {
    key: "bundler_sniper",
    name: "Bundler / Sniper Risk",
    normalize: (f) => clamp((f.bundlerPct + f.sniperPct) / 0.3),
    explain: (f) => `bundlers ${(f.bundlerPct * 100).toFixed(1)}%, snipers ${(f.sniperPct * 100).toFixed(1)}% of supply`,
  },
  {
    key: "dev_risk",
    name: "Dev Activity",
    normalize: (f) => clamp(f.devHoldsPct / 0.15) * (f.devSold ? 1 : 0.5) + (f.devSold ? 0.3 : 0),
    explain: (f) => (f.devSold ? `dev wallet has been selling (holds ${(f.devHoldsPct * 100).toFixed(1)}%)` : `dev holds ${(f.devHoldsPct * 100).toFixed(1)}%`),
  },
  {
    key: "exit_liquidity",
    name: "Exit Liquidity Risk",
    normalize: (f) => clamp(1 - Math.tanh(f.exitDepthUsd / 40_000)),
    explain: (f) => `only ~${usd(f.exitDepthUsd)} exitable near current price`,
  },
];

// ---------------------------------------------------------------- profiles

export interface StrategyProfile {
  id: StrategyProfileId;
  name: string;
  weights: Record<string, number>;
  riskWeight: number; // multiplier on risk penalty
  minConfidence: number;
  minLiquidityUsd: number;
}

const W = (over: Record<string, number> = {}): Record<string, number> => ({
  smart_money: 1.6,
  whale_flow: 1.3,
  momentum: 1.0,
  volume_accel: 1.0,
  liquidity: 0.9,
  holder_growth: 0.9,
  distribution: 0.7,
  organic: 0.8,
  age_opportunity: 0.5,
  structure: 0.8,
  social: 0.5,
  ...over,
});

export const PROFILES: Record<StrategyProfileId, StrategyProfile> = {
  conservative: {
    id: "conservative",
    name: "Conservative",
    weights: W({ liquidity: 1.6, distribution: 1.4, organic: 1.3, age_opportunity: 0.2, social: 0.2 }),
    riskWeight: 1.8,
    minConfidence: 0.55,
    minLiquidityUsd: 150_000,
  },
  balanced: {
    id: "balanced",
    name: "Balanced",
    weights: W(),
    riskWeight: 1.0,
    minConfidence: 0.4,
    minLiquidityUsd: 40_000,
  },
  aggressive: {
    id: "aggressive",
    name: "Aggressive",
    weights: W({ momentum: 1.5, volume_accel: 1.4, age_opportunity: 0.9 }),
    riskWeight: 0.6,
    minConfidence: 0.3,
    minLiquidityUsd: 15_000,
  },
  early_gem: {
    id: "early_gem",
    name: "Early Gem Hunter",
    weights: W({ age_opportunity: 2.0, holder_growth: 1.4, volume_accel: 1.3, smart_money: 1.2, liquidity: 0.5 }),
    riskWeight: 0.8,
    minConfidence: 0.3,
    minLiquidityUsd: 10_000,
  },
  smart_money: {
    id: "smart_money",
    name: "Smart Money Follower",
    weights: W({ smart_money: 2.6, whale_flow: 1.6, momentum: 0.6, social: 0.2 }),
    riskWeight: 1.0,
    minConfidence: 0.45,
    minLiquidityUsd: 30_000,
  },
  momentum: {
    id: "momentum",
    name: "Momentum Trader",
    weights: W({ momentum: 2.4, volume_accel: 1.8, structure: 1.2, smart_money: 0.8 }),
    riskWeight: 0.9,
    minConfidence: 0.35,
    minLiquidityUsd: 25_000,
  },
  mean_reversion: {
    id: "mean_reversion",
    name: "Mean Reversion",
    // inverted momentum: oversold quality tokens score higher
    weights: W({ momentum: -1.6, liquidity: 1.5, organic: 1.4, distribution: 1.2, volume_accel: 0.4 }),
    riskWeight: 1.2,
    minConfidence: 0.45,
    minLiquidityUsd: 80_000,
  },
  whale_shadow: {
    id: "whale_shadow",
    name: "Whale Shadow",
    weights: W({ whale_flow: 2.8, smart_money: 1.4, structure: 1.0 }),
    riskWeight: 1.0,
    minConfidence: 0.4,
    minLiquidityUsd: 30_000,
  },
  high_risk: {
    id: "high_risk",
    name: "High Risk / High Reward",
    weights: W({ momentum: 1.6, volume_accel: 1.6, social: 1.4, age_opportunity: 1.2, liquidity: 0.3, distribution: 0.3 }),
    riskWeight: 0.35,
    minConfidence: 0.2,
    minLiquidityUsd: 5_000,
  },
};

// ---------------------------------------------------------------- scoring

const REGIME_ADJUST: Record<string, number> = {
  meme_mania: 1.06,
  risk_on: 1.03,
  neutral: 1.0,
  rotation: 0.98,
  high_volatility: 0.95,
  low_liquidity: 0.93,
  distribution: 0.9,
  risk_off: 0.85,
};

function confidenceOf(f: FeatureVector): number {
  const sample = clamp(f.sampleSize / 60);
  const fresh = clamp(1 - f.worstStalenessMs / (2 * HOUR));
  const maturity = clamp(f.ageHours / 24, 0.25, 1);
  const liq = clamp(Math.log10(Math.max(f.liquidityUsd, 1)) / 5.5);
  return clamp(0.15 + 0.45 * sample + 0.2 * fresh + 0.1 * maturity + 0.1 * liq, 0, 0.98);
}

function riskFlags(f: FeatureVector): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const add = (key: string, name: string, severity: RiskFlag["severity"], detail: string) =>
    flags.push({ key, name, severity, detail });

  if (f.top10Pct > 0.4) add("concentration", "Extreme concentration", "high", `top 10 hold ${(f.top10Pct * 100).toFixed(0)}%`);
  else if (f.top10Pct > 0.28) add("concentration", "Concentrated supply", "medium", `top 10 hold ${(f.top10Pct * 100).toFixed(0)}%`);
  if (f.devSold) add("dev", "Dev selling", "high", "the deployer wallet has reduced its position");
  else if (f.devHoldsPct > 0.08) add("dev", "Dev holdings", "medium", `dev holds ${(f.devHoldsPct * 100).toFixed(1)}%`);
  if (f.insiderPct > 0.15) add("insider", "Insider exposure", "high", `insider-linked supply ~${(f.insiderPct * 100).toFixed(0)}%`);
  if (f.bundlerPct + f.sniperPct > 0.18) add("bundler", "Bundler/sniper supply", "medium", `${((f.bundlerPct + f.sniperPct) * 100).toFixed(0)}% of supply from bundlers/snipers`);
  if (f.exitDepthUsd < 15_000) add("exit", "Thin exit liquidity", "high", `~${usd(f.exitDepthUsd)} exitable near price`);
  else if (f.exitDepthUsd < 40_000) add("exit", "Modest exit liquidity", "medium", `~${usd(f.exitDepthUsd)} exitable near price`);
  if (f.liquidityChangePct < -25) add("liq_drop", "Liquidity draining", "high", `pool ${pct(f.liquidityChangePct)} in 24h`);
  if (f.organicScore < 0.35) add("organic", "Low organic activity", "medium", "trading pattern looks partly inorganic");
  if (f.ageHours < 24) add("age", "Very young token", "medium", `${f.ageHours.toFixed(0)} hours since launch`);
  if (f.momentum24h > 150) add("extended", "Vertically extended", "medium", `24h ${pct(f.momentum24h)} — chase risk`);
  return flags;
}

function classifyKind(f: FeatureVector, factors: SignalFactor[], score: number): SignalKind {
  const get = (k: string) => factors.find((x) => x.key === k)?.normalized ?? 0.5;
  if (f.liquidityChangePct < -35) return "liquidity_collapse";
  if (f.devSold && f.top10Pct > 0.3) return "rug_risk_escalation";
  if (score < 40 && f.whaleNetFlowUsd < -40_000) return "whale_exit_warning";
  if (score < 45 && get("distribution") < 0.35) return "distribution_warning";
  if (f.ageHours < 72 && get("smart_money") > 0.6) return "early_accumulation";
  if (get("volume_accel") > 0.75 && get("momentum") > 0.65) return "momentum_ignition";
  if (get("whale_flow") > 0.72) return "whale_breakout";
  if (get("smart_money") > 0.7) return "smart_money_rotation";
  if (f.liquidityChangePct > 30) return "liquidity_expansion";
  if (f.holderGrowthPct > 18) return "holder_expansion";
  if (get("volume_accel") > 0.8) return "volume_dislocation";
  if (get("social") > 0.75) return "social_momentum";
  if (f.momentum24h < -25 && get("organic") > 0.6 && get("liquidity") > 0.5) return "mean_reversion";
  return "momentum_ignition";
}

function labelOf(score: number, confidence: number, highRisks: number, noTrade: string | null): SignalLabel {
  if (noTrade) return "NO TRADE";
  if (highRisks >= 2 && score < 55) return "EXTREME RISK";
  if (score >= 88 && confidence >= 0.6) return "EXTREME POSITIVE";
  if (score >= 76) return "STRONG POSITIVE";
  if (score >= 64) return "POSITIVE";
  if (score >= 54) return "WATCH";
  if (score >= 45) return "NEUTRAL";
  if (score >= 35) return "WEAK";
  return "NEGATIVE";
}

export function computeSignal(
  store: DemoStore,
  mint: string,
  asOf: number,
  profileId: StrategyProfileId = "balanced",
): Signal | undefined {
  const f = extractFeatures(store, mint, asOf);
  if (!f) return undefined;
  const profile = PROFILES[profileId];

  const factors: SignalFactor[] = [];
  let weighted = 0;
  let totalWeight = 0;
  for (const def of FACTORS) {
    const weight = profile.weights[def.key] ?? 0;
    const raw = def.normalize(f);
    // negative weights invert the factor (mean reversion wants weak momentum)
    const norm = weight >= 0 ? raw : 1 - raw;
    const absW = Math.abs(weight);
    weighted += norm * absW;
    totalWeight += absW;
    factors.push({
      key: def.key,
      name: def.name,
      raw,
      normalized: norm,
      weight,
      contribution: 0, // filled below once the scale is known
      explanation: def.explain(f, raw),
    });
  }

  let base = totalWeight > 0 ? (weighted / totalWeight) * 100 : 50;

  // risk penalty
  let penalty = 0;
  for (const def of RISK_FACTORS) {
    const sev = def.normalize(f);
    const points = sev * 9 * profile.riskWeight;
    penalty += points;
    factors.push({
      key: def.key,
      name: def.name,
      raw: sev,
      normalized: 1 - sev,
      weight: -profile.riskWeight,
      contribution: -points,
      explanation: def.explain(f, sev),
    });
  }

  base = base * (REGIME_ADJUST[f.regime] ?? 1);
  // contrast stretch: the weighted mean compresses toward 50 (measured on
  // the demo distribution), so widen around the midpoint before penalties
  const stretched = clamp(50 + (base - 50) * 1.9, 0, 100);
  const score = Math.round(clamp(stretched - penalty * 0.7, 0, 100));

  // fill positive contributions proportionally
  for (const fac of factors) {
    if (fac.weight > 0 || (fac.weight < 0 && !RISK_FACTORS.some((r) => r.key === fac.key))) {
      fac.contribution = Number((((fac.normalized * Math.abs(fac.weight)) / totalWeight) * stretched).toFixed(1));
    }
  }

  const confidence = confidenceOf(f);
  const risks = riskFlags(f);
  const highRisks = risks.filter((r) => r.severity === "high").length;

  // NO TRADE gates — the engine is allowed to abstain
  let noTrade: string | null = null;
  if (confidence < profile.minConfidence) noTrade = `confidence ${(confidence * 100).toFixed(0)}% below the ${profile.name} floor`;
  else if (f.liquidityUsd < profile.minLiquidityUsd) noTrade = `liquidity ${usd(f.liquidityUsd)} below the ${profile.name} floor of ${usd(profile.minLiquidityUsd)}`;
  else if (highRisks >= 3) noTrade = `${highRisks} independent high-severity risks`;
  else if (f.sampleSize < 12) noTrade = "insufficient sample behind the features";
  else if (f.worstStalenessMs > 3 * HOUR) noTrade = "inputs are stale";

  const label = labelOf(score, confidence, highRisks, noTrade);
  const kind = classifyKind(f, factors, score);

  const positives = factors
    .filter((x) => x.weight > 0 && x.normalized > 0.62)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 5)
    .map((x) => x.explanation);

  const invalidation = [
    `liquidity falls below ${usd(f.liquidityUsd * 0.65)}`,
    `whale netflow turns below ${usd(-Math.max(50_000, Math.abs(f.whaleNetFlowUsd)))} over 6h`,
    f.smartMoneyWallets > 0 ? "tracked smart money flips to net selling" : "no smart-money confirmation appears within 24h",
    `price loses the 24h structure (${pct(-Math.max(12, Math.abs(f.momentum24h) * 0.4))} from here)`,
    "a new security flag (freeze/mint authority, dev selling) appears",
  ];

  const bearCase = [
    ...risks.map((r) => `${r.name}: ${r.detail}`),
    f.momentum24h > 60 ? "entry is late in the move — favorable expectancy decays fast after vertical legs" : "the setup depends on continued participation; volume fading invalidates it",
  ];

  const bucket = Math.floor(asOf / (2 * HOUR));
  return {
    id: `sig-${mint.slice(0, 8)}-${bucket}-${profileId}`,
    mint,
    kind,
    createdAt: bucket * 2 * HOUR,
    updatedAt: asOf,
    score,
    confidence: Number(confidence.toFixed(2)),
    label,
    profile: profileId,
    factors,
    risks,
    invalidation,
    bearCase,
    why: positives.length ? positives : ["no factor cleared the evidence bar — that is itself the finding"],
    engineVersion: ENGINE_VERSION,
    features: f,
    lifecycle: [{ state: "created", ts: bucket * 2 * HOUR }],
  };
}

// ---------------------------------------------------------------- batch + cache

const cache = new Map<string, Signal[]>();

export function signalsAt(store: DemoStore, asOf: number, profileId: StrategyProfileId = "balanced"): Signal[] {
  const bucket = Math.floor(asOf / (30 * 60 * 1000));
  const key = `${bucket}:${profileId}:${store.universe.seed}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const out: Signal[] = [];
  for (const tok of store.tokenList()) {
    const sig = computeSignal(store, tok.info.mint, asOf, profileId);
    if (sig) out.push(sig);
  }
  out.sort((a, b) => b.score - a.score);

  // lifecycle vs previous bucket
  const prevKey = `${bucket - 4}:${profileId}:${store.universe.seed}`;
  const prev = cache.get(prevKey);
  if (prev) {
    const prevByMint = new Map(prev.map((s) => [s.mint, s]));
    for (const s of out) {
      const p = prevByMint.get(s.mint);
      if (!p) continue;
      if (s.score >= p.score + 6) s.lifecycle.push({ state: "strengthened", ts: asOf, note: `${p.score} → ${s.score}` });
      else if (s.score <= p.score - 6) s.lifecycle.push({ state: "weakened", ts: asOf, note: `${p.score} → ${s.score}` });
      else if (s.score >= 64) s.lifecycle.push({ state: "confirmed", ts: asOf });
    }
  }

  if (cache.size > 240) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

/** Outcome measurement for signals old enough to have a future. This is the
 * ONLY place the engine reads past asOf, and only for evaluation. */
export function evaluateOutcome(store: DemoStore, sig: Signal): Signal {
  const tok = store.token(sig.mint);
  if (!tok) return sig;
  const after = tok.candles.filter((c) => c.t > sig.features.asOf && c.t <= sig.features.asOf + 24 * HOUR);
  if (after.length < 2) return sig;
  const p0 = store.lastPrice(sig.mint, sig.features.asOf);
  if (!p0) return sig;
  const c1h = after[0];
  const last = after[after.length - 1];
  const high = Math.max(...after.map((c) => c.h));
  const low = Math.min(...after.map((c) => c.l));
  const r24 = (last.c / p0 - 1) * 100;
  return {
    ...sig,
    outcome: {
      evaluatedAt: last.t,
      return1h: (c1h.c / p0 - 1) * 100,
      return24h: r24,
      maxFavorable: (high / p0 - 1) * 100,
      maxAdverse: (low / p0 - 1) * 100,
      hit: sig.score >= 64 ? r24 > 5 : null,
    },
  };
}

export interface AccuracyStats {
  profile: StrategyProfileId;
  windowDays: number;
  samples: number;
  hitRate: number;
  avgReturn24h: number;
  medianReturn24h: number;
  falsePositiveRate: number;
  byLabel: { label: string; n: number; avg24h: number }[];
}

export function accuracyStats(store: DemoStore, profileId: StrategyProfileId = "balanced", days = 10): AccuracyStats {
  const genesis = store.universe.genesis;
  const evaluated: Signal[] = [];
  for (let d = days; d >= 2; d--) {
    const asOf = genesis - d * 24 * HOUR;
    for (const s of signalsAt(store, asOf, profileId)) {
      if (s.label === "NO TRADE") continue;
      evaluated.push(evaluateOutcome(store, s));
    }
  }
  const withOutcome = evaluated.filter((s) => s.outcome?.return24h != null);
  const actionable = withOutcome.filter((s) => s.score >= 64);
  const hits = actionable.filter((s) => (s.outcome!.return24h ?? 0) > 5);
  const rets = actionable.map((s) => s.outcome!.return24h!) .sort((a, b) => a - b);
  const byLabelMap = new Map<string, { n: number; sum: number }>();
  for (const s of withOutcome) {
    const e = byLabelMap.get(s.label) ?? { n: 0, sum: 0 };
    e.n++;
    e.sum += s.outcome!.return24h!;
    byLabelMap.set(s.label, e);
  }
  return {
    profile: profileId,
    windowDays: days,
    samples: actionable.length,
    hitRate: actionable.length ? hits.length / actionable.length : 0,
    avgReturn24h: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    medianReturn24h: rets.length ? rets[Math.floor(rets.length / 2)] : 0,
    falsePositiveRate: actionable.length ? actionable.filter((s) => (s.outcome!.return24h ?? 0) < -10).length / actionable.length : 0,
    byLabel: [...byLabelMap.entries()]
      .map(([label, e]) => ({ label, n: e.n, avg24h: e.sum / e.n }))
      .sort((a, b) => b.n - a.n),
  };
}
