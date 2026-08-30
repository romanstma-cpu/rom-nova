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
  type UnmeasuredField,
} from "../types";

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- factors

interface FactorDef {
  key: string;
  name: string;
  normalize: (f: FeatureVector) => number; // 0..1, higher = more bullish
  explain: (f: FeatureVector, norm: number) => string;
  /**
   * Feature fields this factor reads that a provider might not have.
   *
   * The simulator knows its own universe completely, so every factor was
   * always computable and this was not needed. Real providers changed that:
   * DEX Screener and GeckoTerminal publish price, liquidity and trade counts
   * and nothing about who holds the supply. Scoring `top10Pct: 0` gives a
   * PERFECT distribution mark and raises no concentration flag — the most
   * flattering possible reading of a token nobody has examined.
   *
   * So a factor whose inputs are unmeasured is dropped from the weighted mean
   * entirely rather than contributing a fictional number, and its weight
   * leaves the denominator with it.
   */
  needs?: readonly UnmeasuredField[];
}

/** Whether every input this factor depends on was actually observed. */
function measured(def: FactorDef, f: FeatureVector): boolean {
  if (!def.needs || !f.unmeasured?.length) return true;
  return !def.needs.some((n) => f.unmeasured!.includes(n));
}

/** The provider count, or null when nobody computed one. */
function knownProviders(f: FeatureVector): number | null {
  return (f.unmeasured ?? []).includes("lpProviders") ? null : f.lpProviders;
}

/**
 * How much an unlocked pool still matters once N parties hold it.
 *
 * Not a theorem. It is a bounded scale chosen so that the two ends are right
 * and nothing in between is absurd:
 *
 *   unknown or 1 provider   1.00   the deployer may hold the pool — full weight
 *   2                       0.71
 *   10                      0.32
 *   43 (PUMP, measured)     0.15
 *
 * `1/sqrt(n)` because the split between providers is NOT published — one of
 * forty-three could still hold most of it — so the risk has to fall with the
 * count without ever reaching zero. An unknown count gets the full penalty
 * rather than the benefit of the doubt, which keeps the fail-safe direction:
 * this can only ever reduce a penalty on evidence, never on absence.
 */
export function dispersionDampener(f: FeatureVector): number {
  const providers = knownProviders(f);
  if (providers === null) return 1;
  return 1 / Math.sqrt(Math.max(1, providers));
}

const usd = (x: number) =>
  `${x < 0 ? "-" : ""}$${Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(2) + "M" : Math.abs(x) >= 1e3 ? (Math.abs(x) / 1e3).toFixed(1) + "K" : Math.abs(x).toFixed(0)}`;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

export const FACTORS: FactorDef[] = [
  {
    key: "smart_money",
    name: "Smart Money Accumulation",
    // Unmeasurable outside the simulator. Knowing which wallets moved is not
    // knowing whether they are any good, and nothing in the live stack carries
    // wallet reputation — so on a real token this used to score a placeholder
    // zero as "no smart money is touching this", a verdict nobody reached.
    needs: ["smartMoney"],
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
    // Real when a flow provider is configured, absent without one. The
    // difference matters: "no whale bought this" and "nobody looked" point a
    // reader in opposite directions.
    needs: ["whaleFlow"],
    normalize: (f) => clamp(0.5 + Math.tanh(f.whaleNetFlowUsd / 250_000) * 0.5),
    explain: (f) =>
      f.whaleBuys + f.whaleSells > 0
        ? `whale netflow ${usd(f.whaleNetFlowUsd)} (${f.whaleBuys} buys / ${f.whaleSells} sells)`
        : "no whale-sized trades in the window",
  },
  {
    key: "momentum",
    name: "Momentum",
    // Needs candles. A list of tokens cannot afford them, so rather than
    // refusing to score the whole token this factor steps aside and the
    // confidence falls by its weight.
    needs: ["momentum"],
    normalize: (f) => clamp(0.5 + Math.tanh(f.momentum1h / 12) * 0.3 + Math.tanh(f.momentum24h / 40) * 0.2),
    explain: (f) => `1h ${pct(f.momentum1h)}, 24h ${pct(f.momentum24h)}`,
  },
  {
    key: "volume_accel",
    name: "Volume Acceleration",
    // Also derived from candles. Its own field rather than sharing momentum's,
    // because a source could plausibly publish one without the other.
    needs: ["volumeAccel"],
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
    needs: ["holders"],
  },
  {
    key: "distribution",
    name: "Holder Distribution",
    normalize: (f) => clamp(1 - (f.top10Pct - 0.1) / 0.5),
    explain: (f) => `top 10 wallets hold ${(f.top10Pct * 100).toFixed(0)}% of supply`,
    needs: ["top10Pct"],
  },
  {
    key: "organic",
    name: "Organic Activity",
    normalize: (f) => f.organicScore,
    explain: (f) => `organic-activity score ${(f.organicScore * 100).toFixed(0)}/100`,
    needs: ["organicScore"],
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
    needs: ["socialScore"],
  },
];

// risk factors subtract from the score
export const RISK_FACTORS: FactorDef[] = [
  {
    key: "mint_authority",
    name: "Mint Authority",
    // The single most load-bearing safety fact about an SPL token, and until
    // now the scorer could not see it at all — the flag lived on TokenInfo,
    // never on the vector, so the security panel and the score were reading
    // different worlds. A token whose deployer could still mint rendered
    // POSITIVE beside a panel saying the supply was not fixed.
    needs: ["authorities"],
    normalize: (f) => (f.mintAuthorityRevoked ? 0 : 1),
    explain: (f) =>
      f.mintAuthorityRevoked
        ? "mint authority revoked — the supply is fixed"
        : "MINT AUTHORITY IS LIVE — whoever holds that key can inflate the supply at will",
  },
  {
    key: "freeze_authority",
    name: "Freeze Authority",
    needs: ["authorities"],
    normalize: (f) => (f.freezeAuthorityRevoked ? 0 : 1),
    explain: (f) =>
      f.freezeAuthorityRevoked
        ? "freeze authority revoked — balances cannot be frozen"
        : "FREEZE AUTHORITY IS LIVE — balances can be frozen in place, including yours",
  },
  {
    key: "permanent_delegate",
    name: "Permanent Delegate",
    needs: ["permanentDelegate"],
    normalize: (f) => (f.permanentDelegate ? 1 : 0),
    explain: (f) =>
      f.permanentDelegate
        ? "PERMANENT DELEGATE SET — that key can move any balance without permission"
        : "no permanent delegate",
  },
  {
    key: "lp_lock",
    name: "LP Lock",
    // The mechanic behind most memecoin losses. Every other risk here is about
    // supply; a deployer who can withdraw the pool does not need a mint
    // authority to take the money. Half the pool locked is treated as the point
    // where withdrawal stops being the obvious move.
    //
    // SCALED BY HOW MANY PARTIES HOLD IT, which is the correction that was
    // missing. "0.04% locked" says nothing on its own: for PUMP that figure
    // sits across 435 pools and 43 independent providers, none of whom
    // withdrawing is a rug, and charging it the maximum cost the token a whole
    // verdict band. The previous pass demoted the FLAG to medium and left the
    // PENALTY at full — conceding the point in prose and charging anyway.
    needs: ["lpLocked"],
    normalize: (f) => clamp(1 - f.lpLockedPct / 0.5) * dispersionDampener(f),
    explain: (f) => {
      const locked = `${(f.lpLockedPct * 100).toFixed(1)}% of the pool's LP is locked or burned`;
      if (f.lpLockedPct >= 0.5) return locked;
      const providers = knownProviders(f);
      if (providers === null) {
        return `${locked} — the rest can be withdrawn, and no source here says by how many separate parties it is held`;
      }
      if (providers <= 1) {
        return `${locked}, and a single provider holds the pool — that party can withdraw it`;
      }
      return (
        `${locked}, but it is spread over ${providers} independent providers, so no one of them ` +
        `holds the pool — the penalty is scaled down accordingly, not removed`
      );
    },
  },
  {
    key: "concentration_risk",
    name: "Supply Concentration",
    // `distribution` above is a positive-family factor: it bottoms out at zero
    // around 60% and cannot go below it, so an extremely concentrated token
    // could only fail to gain points, never lose any. This is the other half —
    // deliberately starting where that factor has already saturated, so the two
    // do not double-count the same supply.
    needs: ["top10Pct"],
    normalize: (f) => clamp((f.top10Pct - 0.5) / 0.35),
    explain: (f) => `top 10 wallets hold ${(f.top10Pct * 100).toFixed(0)}% of supply`,
  },
  {
    key: "insider_risk",
    name: "Insider Risk",
    normalize: (f) => clamp(f.insiderPct / 0.3),
    // Says what it MEASURES. The old wording claimed a share of supply, which
    // put "insider-linked wallets hold ~0% of supply" on the same screen as
    // "3 insider networks, 12 wallets" — the field only sums insider flags
    // among the top holders the source published, so a network that never
    // cracks the top twenty reads as zero here.
    explain: (f) =>
      f.insiderPct > 0
        ? `insider-flagged wallets among the published top holders hold ~${(f.insiderPct * 100).toFixed(1)}% of supply`
        : "no insider flag on any of the published top holders — networks outside them are not counted here",
    needs: ["insiderPct"],
  },
  {
    key: "bundler_sniper",
    name: "Bundler / Sniper Risk",
    normalize: (f) => clamp((f.bundlerPct + f.sniperPct) / 0.3),
    explain: (f) => `bundlers ${(f.bundlerPct * 100).toFixed(1)}%, snipers ${(f.sniperPct * 100).toFixed(1)}% of supply`,
    needs: ["bundlerPct", "sniperPct"],
  },
  {
    key: "dev_risk",
    name: "Dev Holdings",
    // Split from the selling signal below. The two used to be one factor whose
    // formula multiplied by `devSold ? 1 : 0.5` — and `devSold` is hardcoded
    // false on every live token, so every live token silently took the halved
    // branch. That is an unmeasured field steering a measured one, which is the
    // bug this whole machinery exists to stop. Holdings are published; keep
    // scoring them.
    normalize: (f) => clamp(f.devHoldsPct / 0.15),
    explain: (f) => `dev holds ${(f.devHoldsPct * 100).toFixed(1)}% of supply`,
    needs: ["devHoldsPct"],
  },
  {
    key: "dev_selling",
    name: "Dev Selling",
    // Its own factor so it can stand down honestly. Nothing in the live stack
    // watches the deployer's balance over time, so on real tokens this abstains
    // and the invalidation copy no longer promises a flag that cannot fire.
    normalize: (f) => (f.devSold ? 1 : 0),
    explain: (f) =>
      f.devSold
        ? "the deployer wallet has been reducing its position"
        : "the deployer wallet has not sold in the observed window",
    needs: ["devSold"],
  },
  {
    key: "deployer_history",
    name: "Deployer History",
    // The page has printed "this wallet has issued 19,042 mints — a serial
    // deployer is a warning" since the scanner shipped, and the scorer could
    // not see it: devMints reached TokenInfo, the row and the card, never the
    // vector. CATE rendered POSITIVE/73 under that sentence.
    needs: ["devHistory"],
    normalize: (f) => {
      const mints = Math.max(1, f.devMints);
      // Log scale: one mint is nothing, ten is a pattern, a thousand is a
      // factory. Saturates around 1,000.
      const volume = clamp((Math.log10(mints) - 0.3) / 2);
      // Migrations only ever DISCHARGE the severity. An absent count arrives as
      // zero, and a zero here withholds mitigation rather than inventing a
      // finding — the fail-safe direction, and the only one available while
      // Jupiter publishes devMigrations on some mints and not others.
      const graduated = f.devMigrations / mints;
      return clamp(volume * (1 - clamp(graduated / 0.25)));
    },
    explain: (f) => {
      if (f.devMints <= 1) return "first mint from this deployer — no track record either way";
      const rate = f.devMigrations > 0 ? `, ${f.devMigrations} of which reached a real pool` : "";
      return `this deployer has issued ${f.devMints.toLocaleString()} mints${rate}${
        f.devMigrations > 0 ? "" : " and no migration count was published"
      }`;
    },
  },
  {
    key: "exit_liquidity",
    name: "Exit Liquidity Risk",
    normalize: (f) => clamp(1 - Math.tanh(f.exitDepthUsd / 40_000)),
    explain: (f) => `only ~${usd(f.exitDepthUsd)} exitable near current price`,
  },
];

/**
 * The risk factors that answer "who holds this, and who made it".
 *
 * A subset rather than the whole list, because the abstention gate has to be
 * able to name a FAMILY. Counting all risk factors was tried and broke: adding
 * the three authority checks took the list from eight to eleven, so a token
 * whose cap table, insiders, bundlers and dev holdings were ALL unknown still
 * cleared "more than half assessable" on the authorities alone, and rendered
 * EXTREME POSITIVE. A ratio taken over a list that changes length is not a
 * threshold.
 *
 * The authorities are deliberately NOT in here. "Nobody can inflate the supply"
 * is not evidence about who is already holding it, and the two must not
 * substitute for one another.
 *
 * `lp_lock` is also out: it is about whether the pool can be withdrawn, which is
 * a liquidity question rather than a distribution one, and it has its own factor
 * and its own veto path.
 *
 * AND SO ARE THE TWO NOBODY CAN ANSWER. `bundler_sniper` and `dev_selling` are
 * distribution questions, and they are missing from this list on purpose: no
 * source in this stack publishes either, at any price we pay. Counting a
 * permanently-blind factor in a threshold is what broke the original
 * `unmeasuredRisks >= 2` rule — every token started one gap down, so any second
 * gap abstained and the verdict stopped meaning anything.
 *
 * Measured on twelve live trending mints with the six-key version: eight
 * abstained. The gate has to count what is KNOWABLE, or it drifts straight back
 * to the constant it replaced.
 */
export const SUPPLY_RISK_KEYS = [
  "concentration_risk",
  "insider_risk",
  "dev_risk",
  "deployer_history",
] as const;

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

/**
 * Contrast stretch around the midpoint, and the two constants that turn a risk
 * severity into points.
 *
 * Named rather than inline because the audit has to reproduce the arithmetic
 * exactly: 50 + every contribution equals the score, and that identity breaks
 * the moment a literal here and a literal there drift apart.
 */
export const STRETCH = 1.9;
const RISK_POINTS = 9;
const RISK_SCALE = 0.7;
/** Where a score with no evidence either way sits, and what the audit sums from. */
export const NEUTRAL_BASE = 50;

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

/**
 * How good the evidence behind the vector is, ignoring how much of it is there.
 *
 * The denominators were tight enough that every live token pinned this at 0.98
 * and confidence became a restatement of coverage — 77% on eight of twelve
 * mints reviewed. Widened so a thin tape and a deep one actually separate:
 * `sampleSize` on a live token is the 1h trade count, which spans two orders of
 * magnitude across a trending list and used to saturate at sixty.
 *
 * `confidence` is this multiplied by coverage, and `auditFactors` reports both
 * halves so a reader can see which one is binding rather than staring at a
 * number that never moves.
 */
export function evidenceQuality(f: FeatureVector): number {
  const sample = clamp(Math.log10(Math.max(1, f.sampleSize)) / 3.2);
  const fresh = clamp(1 - f.worstStalenessMs / (2 * HOUR));
  const maturity = clamp(f.ageHours / (24 * 7), 0.15, 1);
  const liq = clamp(Math.log10(Math.max(f.liquidityUsd, 1)) / 7);
  return clamp(0.1 + 0.4 * sample + 0.2 * fresh + 0.15 * maturity + 0.15 * liq, 0, 0.98);
}

function riskFlags(f: FeatureVector): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const add = (key: string, name: string, severity: RiskFlag["severity"], detail: string) =>
    flags.push({ key, name, severity, detail });
  /** Whether a field was actually observed. A zero from an absent field must
   *  not raise a flag, and — worse — must not be read as the flag's absence. */
  const missing = f.unmeasured ?? [];
  const has = (k: UnmeasuredField) => !missing.includes(k);

  // The security facts, first, because they are the ones that take a position
  // to zero regardless of how the tape looks. These reach `bearCase` through
  // this list, which is why "WHAT COULD MAKE THIS FAIL" used to list momentum
  // risk on a token whose deployer could mint more supply at will.
  if (has("authorities")) {
    if (!f.mintAuthorityRevoked) {
      add("mint_authority", "Mint authority is LIVE", "high", "the supply can be inflated at any time by the key holder");
    }
    if (!f.freezeAuthorityRevoked) {
      add("freeze_authority", "Freeze authority is LIVE", "high", "balances can be frozen in place by the key holder");
    }
  } else {
    add("authority_unknown", "Authorities unverified", "high", "no source could read the mint account, so neither authority is known");
  }
  if (has("permanentDelegate") && f.permanentDelegate) {
    add("permanent_delegate", "Permanent delegate set", "high", "that key can move any balance without the holder's permission");
  }
  // Deliberately never "high", however low the figure.
  //
  // An unlocked pool is only a rug when ONE party holds the LP, and nothing in
  // this stack publishes the deployer's share of it. The aggregate runs near
  // zero on large tokens by construction — measured at 0.04% for PUMP across
  // 435 pools and 43 independent LP providers, none of whom withdrawing is a
  // rug — so grading it high-severity fired EXTREME RISK on exactly the tokens
  // where it means least. The penalty still scales; the alarm does not.
  if (has("lpLocked") && f.lpLockedPct < 0.5) {
    add(
      "lp_lock",
      "Liquidity pool largely unlocked",
      "medium",
      `${(f.lpLockedPct * 100).toFixed(1)}% of LP locked — whoever holds the rest can withdraw it, ` +
        `and no source here says who that is`,
    );
  }

  if (has("top10Pct")) {
    if (f.top10Pct > 0.4) add("concentration", "Extreme concentration", "high", `top 10 hold ${(f.top10Pct * 100).toFixed(0)}%`);
    else if (f.top10Pct > 0.28) add("concentration", "Concentrated supply", "medium", `top 10 hold ${(f.top10Pct * 100).toFixed(0)}%`);
  }
  // `devSold` gets its own guard now. It was hardcoded false on every live
  // token and NOT declared, so this branch could never fire there — while the
  // invalidation copy told the reader to watch for exactly this flag.
  if (has("devSold") && f.devSold) {
    add("dev_selling", "Dev selling", "high", "the deployer wallet has reduced its position");
  } else if (has("devHoldsPct") && f.devHoldsPct > 0.08) {
    add("dev", "Dev holdings", "medium", `dev holds ${(f.devHoldsPct * 100).toFixed(1)}%`);
  }
  // A serial deployer, in the bear case rather than only on the card.
  if (has("devHistory") && f.devMints >= 10) {
    const graduated = f.devMigrations > 0 ? ` (${f.devMigrations} reached a pool)` : " with no published migrations";
    add(
      "deployer_history",
      f.devMints >= 1000 ? "Deployer runs a mint factory" : "Serial deployer",
      f.devMints >= 1000 && f.devMigrations / f.devMints < 0.05 ? "high" : "medium",
      `${f.devMints.toLocaleString()} mints from this wallet${graduated}`,
    );
  }
  if (has("insiderPct") && f.insiderPct > 0.15) add("insider", "Insider exposure", "high", `insider-flagged top holders hold ~${(f.insiderPct * 100).toFixed(0)}% of supply`);
  if (has("bundlerPct") && has("sniperPct") && f.bundlerPct + f.sniperPct > 0.18) add("bundler", "Bundler/sniper supply", "medium", `${((f.bundlerPct + f.sniperPct) * 100).toFixed(0)}% of supply from bundlers/snipers`);
  if (f.exitDepthUsd < 15_000) add("exit", "Thin exit liquidity", "high", `~${usd(f.exitDepthUsd)} exitable near price`);
  else if (f.exitDepthUsd < 40_000) add("exit", "Modest exit liquidity", "medium", `~${usd(f.exitDepthUsd)} exitable near price`);
  if (f.liquidityChangePct < -25) add("liq_drop", "Liquidity draining", "high", `pool ${pct(f.liquidityChangePct)} in 24h`);
  if (has("organicScore") && f.organicScore < 0.35) add("organic", "Low organic activity", "medium", "trading pattern looks partly inorganic");
  if (f.ageHours < 24) add("age", "Very young token", "medium", `${f.ageHours.toFixed(0)} hours since launch`);
  if (f.momentum24h > 150) add("extended", "Vertically extended", "medium", `24h ${pct(f.momentum24h)} — chase risk`);
  return flags;
}

function classifyKind(f: FeatureVector, factors: SignalFactor[], score: number): SignalKind {
  const get = (k: string) => factors.find((x) => x.key === k)?.normalized ?? 0.5;
  // A verified-live authority is the loudest thing that can be true about a
  // token, so it names the signal rather than being outvoted by the tape.
  const missing = f.unmeasured ?? [];
  if (securityVetoOf(f)) return "rug_risk_escalation";
  if (f.liquidityChangePct < -35) return "liquidity_collapse";
  // Both halves have to be measured. `devSold` is hardcoded false on live data,
  // so this branch was dead there and the escalation never fired.
  if (!missing.includes("devSold") && !missing.includes("top10Pct") && f.devSold && f.top10Pct > 0.3) {
    return "rug_risk_escalation";
  }
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

/**
 * A measured, disqualifying security fact, or null.
 *
 * Only ever set when a source actually READ the field. An unverified authority
 * returns null here and routes to abstention instead — "we looked and it is
 * dangerous" and "nobody looked" are different findings and must not collapse
 * into one verdict.
 *
 * This exists because a weight cannot express a veto. The risk factors above
 * subtract nine points each; a token with deep liquidity, 240% volume
 * acceleration and a 97/100 organic score absorbs that and still renders
 * POSITIVE, which is exactly what a live mint authority must never be allowed
 * to do. The score stays an honest weighted mean of what was measured, and the
 * LABEL carries the veto.
 */
export function securityVetoOf(f: FeatureVector): string | null {
  const missing = f.unmeasured ?? [];
  if (!missing.includes("authorities")) {
    if (!f.mintAuthorityRevoked) {
      return "the mint authority is LIVE — supply can be inflated out from under a holder at any time";
    }
    if (!f.freezeAuthorityRevoked) {
      return "the freeze authority is LIVE — balances can be frozen in place, including yours";
    }
  }
  if (!missing.includes("permanentDelegate") && f.permanentDelegate) {
    return "a permanent delegate is set — that key can move any balance without permission";
  }
  return null;
}

function labelOf(
  score: number,
  confidence: number,
  highRisks: number,
  noTrade: string | null,
  securityVeto: string | null,
): SignalLabel {
  // The VETO outranks abstention. Checked first because "we read the mint
  // account and the authority is live" is a finding, and NO TRADE is the
  // absence of one — the chip said NO TRADE while the banner directly above it
  // said EXTREME RISK, which is two verdicts on one screen even though both
  // point the same way. The abstention reason is still carried on the signal
  // and still shown; it is no longer the headline.
  if (securityVeto) return "EXTREME RISK";
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
  return scoreFeatures(f, mint, asOf, profileId);
}

/**
 * Scores a feature vector, wherever it came from.
 *
 * Split out of computeSignal so a vector assembled from live providers goes
 * through byte-for-byte the same scoring, gating and abstention as one read
 * from the simulator. A second scorer written for live data would drift from
 * this one within a week, and the divergence would show up as a signal that
 * says one thing in the backtest and another in the terminal.
 */
export function scoreFeatures(
  f: FeatureVector,
  mint: string,
  asOf: number,
  profileId: StrategyProfileId = "balanced",
): Signal {
  const profile = PROFILES[profileId];

  const factors: SignalFactor[] = [];
  let weighted = 0;
  let totalWeight = 0;
  /** Weight the model wanted but could not use, for the confidence penalty. */
  let unmeasuredWeight = 0;
  /** Risk factors that could not be assessed at all. */
  let unmeasuredRisks = 0;
  /** Which of the SUPPLY_RISK_KEYS specifically went unread, for the named gate. */
  const supplyBlind: string[] = [];
  for (const def of FACTORS) {
    const weight = profile.weights[def.key] ?? 0;
    const absW = Math.abs(weight);

    // A factor nobody could measure is removed from the average, not scored
    // as zero. It still appears in the breakdown, saying so — a reader who
    // sees nine factors where there were eleven deserves to know which two
    // are missing and why, and an empty row is how the score stays auditable.
    if (!measured(def, f)) {
      unmeasuredWeight += absW;
      factors.push({
        key: def.key,
        name: def.name,
        raw: 0,
        normalized: 0,
        weight: 0,
        contribution: 0,
        explanation: `not measured — this data source does not publish ${(def.needs ?? []).join(", ")}`,
      });
      continue;
    }

    const raw = def.normalize(f);
    // negative weights invert the factor (mean reversion wants weak momentum)
    const norm = weight >= 0 ? raw : 1 - raw;
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
    // An unmeasured risk is the dangerous case: normalize() over zeros returns
    // "no insiders, no bundlers, clean dev", so the token would be rewarded
    // with a zero penalty for data nobody has. Skipped instead, and counted
    // against confidence below.
    if (!measured(def, f)) {
      unmeasuredRisks++;
      if ((SUPPLY_RISK_KEYS as readonly string[]).includes(def.key)) supplyBlind.push(def.key);
      factors.push({
        key: def.key,
        name: def.name,
        raw: 0,
        normalized: 0,
        weight: 0,
        contribution: 0,
        explanation: `not measured — no ${(def.needs ?? []).join(", ")} from this source, so no penalty could be assessed`,
      });
      continue;
    }
    const sev = def.normalize(f);
    const points = sev * RISK_POINTS * profile.riskWeight;
    penalty += points;
    factors.push({
      key: def.key,
      name: def.name,
      raw: sev,
      normalized: 1 - sev,
      weight: -profile.riskWeight,
      // Scaled the same way the score scales it, so the column adds up.
      contribution: Number((-points * RISK_SCALE).toFixed(1)),
      explanation: def.explain(f, sev),
    });
  }

  const regimeMult = REGIME_ADJUST[f.regime] ?? 1;
  base = base * regimeMult;
  // contrast stretch: the weighted mean compresses toward 50 (measured on
  // the demo distribution), so widen around the midpoint before penalties
  const stretched = clamp(50 + (base - 50) * STRETCH, 0, 100);
  const score = Math.round(clamp(stretched - penalty * RISK_SCALE, 0, 100));

  // Contributions are measured FROM THE NEUTRAL MIDPOINT, not from zero.
  //
  // The old form was `normalized * weight/total * stretched`, which is always
  // positive — so a factor sitting exactly at its 0.5 midpoint rendered as
  // credit. SKHY's "Whale Accumulation +4.8 — no whale-sized trades in the
  // window" was its third-largest positive contribution, paid for the absence
  // of the thing the factor measures.
  //
  // Rebasing also makes the table reconcile exactly: 50 + every contribution,
  // signal and risk alike, equals the score. That is the property an auditable
  // score should have had all along, and it could not before, because the
  // positive rows summed to `stretched` while the penalties were scaled by
  // RISK_SCALE on the way out.
  const riskKeys = new Set(RISK_FACTORS.map((r) => r.key));
  for (const fac of factors) {
    if (riskKeys.has(fac.key)) continue;
    if (fac.weight === 0) continue;
    fac.contribution = Number(
      (STRETCH * (Math.abs(fac.weight) / totalWeight) * (regimeMult * fac.normalized * 100 - 50)).toFixed(1),
    );
  }

  // Confidence falls by the share of the model that could not be evaluated.
  // A score built from two thirds of its factors is a weaker claim than the
  // same number built from all of them, and the difference has to be visible
  // somewhere or the missing third costs nothing.
  const coverage = totalWeight + unmeasuredWeight > 0 ? totalWeight / (totalWeight + unmeasuredWeight) : 1;
  const confidence = clamp(evidenceQuality(f) * coverage, 0, 0.98);
  const risks = riskFlags(f);
  const highRisks = risks.filter((r) => r.severity === "high").length;

  const securityVeto = securityVetoOf(f);

  // NO TRADE gates — the engine is allowed to abstain
  let noTrade: string | null = null;
  // Whether anybody could read the mint account, first.
  //
  // This is a NAMED gate rather than a count, because "nobody could tell me
  // whether the deployer can still mint" is a specific and actionable reason to
  // abstain, and the old generic count said nothing a reader could act on.
  if ((f.unmeasured ?? []).includes("authorities")) {
    noTrade = "the mint and freeze authorities could not be read — the two facts most likely to take a position to zero are unknown";
  }
  // Then whether anyone could see WHO HOLDS THE SUPPLY.
  //
  // This gate has now been wrong in both directions, and the second failure is
  // the instructive one.
  //
  // It began as `unmeasuredRisks >= 2`, which stopped meaning anything: Jupiter
  // never publishes bundlerPct or sniperPct, so one factor was permanently
  // unmeasured and any second gap abstained. Five of six mints in review
  // abstained through it — a verdict carrying no information.
  //
  // It was replaced with a SHARE of all risk factors, and that broke the moment
  // the model grew. Adding the three authority checks took the list from eight
  // to eleven, so a token with its cap table, insiders, bundlers and dev
  // holdings ALL unknown still cleared "more than half assessable" on the
  // strength of authorities alone — and scored EXTREME POSITIVE. A ratio over a
  // list that changes length is not a threshold, it is a moving target.
  //
  // So the gate names its family instead of counting. The authorities and the
  // supply are different questions: "nobody can inflate this" is not evidence
  // about who is already holding it, and a clean mint account must never buy a
  // positive verdict on a cap table no one has read.
  else if (supplyBlind.length > SUPPLY_RISK_KEYS.length - 2) {
    noTrade =
      `the authorities are readable but the supply is not — ` +
      `${supplyBlind.length} of ${SUPPLY_RISK_KEYS.length} distribution risks ` +
      `(${supplyBlind.join(", ")}) could not be assessed, so who actually holds ` +
      `this token is unknown`;
  } else if (coverage < 0.6) {
    noTrade = `only ${(coverage * 100).toFixed(0)}% of the model's inputs were available`;
  } else if (confidence < profile.minConfidence) noTrade = `confidence ${(confidence * 100).toFixed(0)}% below the ${profile.name} floor`;
  else if (f.liquidityUsd < profile.minLiquidityUsd) noTrade = `liquidity ${usd(f.liquidityUsd)} below the ${profile.name} floor of ${usd(profile.minLiquidityUsd)}`;
  // The generic count is suppressed when a veto is present, because the veto is
  // the SPECIFIC version of the same claim. "4 independent high-severity risks"
  // and "the mint authority is LIVE" describe one token; the second is the one
  // a reader can act on, and letting the count win buried it.
  else if (highRisks >= 3 && !securityVeto) noTrade = `${highRisks} independent high-severity risks`;
  else if (f.sampleSize < 12) noTrade = "insufficient sample behind the features";
  else if (f.worstStalenessMs > 3 * HOUR) noTrade = "inputs are stale";

  const label = labelOf(score, confidence, highRisks, noTrade, securityVeto);
  const kind = classifyKind(f, factors, score);

  const positives = factors
    .filter((x) => x.weight > 0 && x.normalized > 0.62)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 5)
    .map((x) => x.explanation);

  // Only ever promises what this data actually watches. The last line used to
  // tell the reader to expect a "dev selling" flag on a field that is hardcoded
  // false for every live token — an invalidation condition that could not occur.
  const missing = f.unmeasured ?? [];
  const invalidation = [
    `liquidity falls below ${usd(f.liquidityUsd * 0.65)}`,
    missing.includes("whaleFlow")
      ? "whale flow becomes observable and shows net distribution — no flow source is answering right now"
      : `whale netflow turns below ${usd(-Math.max(50_000, Math.abs(f.whaleNetFlowUsd)))} over 6h`,
    f.smartMoneyWallets > 0 ? "tracked smart money flips to net selling" : "no smart-money confirmation appears within 24h",
    `price loses the 24h structure (${pct(-Math.max(12, Math.abs(f.momentum24h) * 0.4))} from here)`,
    missing.includes("devSold")
      ? "a new security flag (freeze or mint authority) appears — dev selling is NOT watched here, nothing in this stack tracks the deployer's balance over time"
      : "a new security flag (freeze/mint authority, dev selling) appears",
  ];

  const bearCase = [
    // The veto leads, because it is not one bear argument among several — it is
    // the reason the label says EXTREME RISK whatever the tape did.
    ...(securityVeto ? [`Disqualifying: ${securityVeto}`] : []),
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
    ...(noTrade ? { noTradeReason: noTrade } : {}),
    ...(securityVeto ? { securityVeto } : {}),
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

// ---------------------------------------------------------------- audit

/**
 * One row of the score, as a reader should see it.
 *
 * `SignalFactor` records what the scorer USED, which means a factor that stood
 * down carries `weight: 0` — indistinguishable, in a table, from a factor this
 * profile genuinely does not care about. The weight the profile WANTED lives in
 * PROFILES and nowhere in the signal, so joining the two here keeps that join
 * next to the weights instead of copying them into a page component where they
 * would drift the first time a profile is retuned.
 */
export interface FactorAudit {
  key: string;
  name: string;
  kind: "signal" | "risk";
  /** What this profile assigns. Risk factors carry the profile's riskWeight. */
  intendedWeight: number;
  /** False when the factor's inputs were unmeasured and it left the average. */
  measured: boolean;
  normalized: number;
  /** Signed points on the 0-100 scale. Negative for risk penalties. */
  contribution: number;
  explanation: string;
}

export interface ScoreAudit {
  rows: FactorAudit[];
  /**
   * Share of the profile's signal weight that could actually be evaluated.
   *
   * Recomputed here from the same two inputs the scorer used, so it reproduces
   * the number behind `noTradeReason` rather than approximating it.
   */
  coverage: number;
  /** Weight the model wanted and could not use. */
  missingWeight: number;
  /** Risk factors that could not be assessed at all. */
  unmeasuredRisks: number;
  /**
   * The two halves of confidence, so it stops reading as a mystery constant.
   *
   * `confidence = evidenceQuality × coverage`. Reported separately because on
   * live tokens coverage is almost always the binding half, and a reader
   * staring at 77% on every token deserves to see which term is holding it
   * there.
   */
  evidenceQuality: number;
  /** The baseline every score starts from, before any factor moves it. */
  base: number;
  /** 50 + every contribution. Equals the signal's score when the audit is sound. */
  reconciled: number;
}

export function auditFactors(signal: Signal): ScoreAudit {
  const profile = PROFILES[signal.profile] ?? PROFILES.balanced;
  const byKey = new Map(signal.factors.map((f) => [f.key, f]));

  const rows: FactorAudit[] = [];
  let usedWeight = 0;
  let missingWeight = 0;
  let unmeasuredRisks = 0;

  // Whether each factor stood down is read from the FEATURE VECTOR, not from
  // the stored `weight: 0`. A profile is free to assign a factor zero weight,
  // and then "dropped for lack of data" and "weighted at nothing" would look
  // identical in the table — two different findings under one appearance.
  for (const def of FACTORS) {
    const f = byKey.get(def.key);
    if (!f) continue;
    const intended = profile.weights[def.key] ?? 0;
    const ok = measured(def, signal.features);
    if (ok) usedWeight += Math.abs(intended);
    else missingWeight += Math.abs(intended);
    rows.push({
      key: def.key,
      name: def.name,
      kind: "signal",
      intendedWeight: intended,
      measured: ok,
      normalized: f.normalized,
      contribution: f.contribution,
      explanation: f.explanation,
    });
  }

  for (const def of RISK_FACTORS) {
    const f = byKey.get(def.key);
    if (!f) continue;
    const ok = measured(def, signal.features);
    if (!ok) unmeasuredRisks++;
    rows.push({
      key: def.key,
      name: def.name,
      kind: "risk",
      intendedWeight: -profile.riskWeight,
      measured: ok,
      normalized: f.normalized,
      contribution: f.contribution,
      explanation: f.explanation,
    });
  }

  // Guard the degenerate case rather than dividing by it: a profile with every
  // signal weight at zero would otherwise report NaN coverage, which renders as
  // a confident-looking blank.
  const total = usedWeight + missingWeight;
  const contributed = rows.reduce((s, r) => s + r.contribution, 0);
  return {
    rows,
    coverage: total > 0 ? usedWeight / total : 1,
    missingWeight,
    unmeasuredRisks,
    evidenceQuality: evidenceQuality(signal.features),
    base: NEUTRAL_BASE,
    // Rounded to the same place the score is, so a reader comparing the two
    // sees them agree rather than differing in the last decimal.
    reconciled: Math.round(Math.max(0, Math.min(100, NEUTRAL_BASE + contributed))),
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
