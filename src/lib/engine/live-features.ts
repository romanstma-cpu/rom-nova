// Builds a FeatureVector for a REAL Solana mint out of live providers.
//
// `extractFeatures` reads the simulator, which knows everything about its own
// universe. This reads the open internet, which knows some of it, and the
// difference is the whole design problem: a field nobody published arrives as
// a zero, and a zero in `top10Pct` reads as a perfectly distributed token
// rather than an unexamined one.
//
// So this function's real output is not the numbers — it is the honest
// accounting of which numbers are real. Every provider declares what it could
// not see, the declarations compose (a keyed provider filling a gap REMOVES
// that field from the unmeasured set), and the scorer drops the factors that
// are still blank instead of scoring their zeros.
//
// What each source can reach today:
//
//   GeckoTerminal   price, liquidity, volume, trade counts, pool age, and the
//                   only keyless OHLCV — ~1,000 hourly bars
//   DEX Screener    the same snapshot fields, summed across every pool
//   Birdeye (key)   top-10 holder share, mint/freeze authority — the fields
//                   that decide whether a memecoin is a trap
//
// Wallet-level flow (smart money, whale accumulation) has no source here at
// any price we are paying, so those two factors stay declared unmeasured and
// the coverage penalty accounts for them.

import { scoreFeatures } from "./signals";
import type {
  Candle,
  FeatureVector,
  MarketRegime,
  Signal,
  StrategyProfileId,
  TokenInfo,
  TokenSnapshot,
  UnmeasuredField,
} from "../types";
import type {
  MarketDataProvider,
  SecurityDataProvider,
  TokenDataProvider,
} from "../providers/types";

const HOUR = 3_600_000;

export interface LiveSources {
  token: TokenDataProvider;
  market: MarketDataProvider;
  /** Optional: only a keyed provider has holder data. */
  security?: SecurityDataProvider;
}

export interface LiveFeatureResult {
  features: FeatureVector;
  info: TokenInfo;
  snapshot: TokenSnapshot;
  candles: Candle[];
  /** Human-readable account of where each part came from, for the caller to print. */
  provenance: string[];
}

/** Fields no source in this stack can reach, whatever keys are configured. */
const NEVER_AVAILABLE: readonly UnmeasuredField[] = [
  // Requires indexing every swap on Solana and knowing which wallets matter.
  "uniqueBuyers1h",
  "uniqueSellers1h",
  // Requires a social-listening product.
  "socialScore",
];

/**
 * Momentum and volume acceleration from real candles.
 *
 * Mirrors extractFeatures deliberately, including the window sizes, so a live
 * vector and a simulated one mean the same thing when they reach the scorer.
 */
function fromCandles(candles: Candle[], priceNow: number) {
  if (candles.length < 3) return null;
  const i = candles.length - 1;
  const at = (back: number) => candles[Math.max(0, i - back)].c;
  const volWin = (from: number, to: number) =>
    candles.slice(Math.max(0, i - from), Math.max(0, i - to + 1)).reduce((s, c) => s + c.v, 0);
  const vol6h = volWin(5, 0);
  const prior24 = volWin(29, 6);
  return {
    momentum1h: i >= 1 ? (priceNow / at(1) - 1) * 100 : 0,
    momentum24h: i >= 24 ? (priceNow / at(24) - 1) * 100 : (priceNow / candles[0].c - 1) * 100,
    momentum5m: (priceNow / candles[i].o - 1) * 100 * 0.35,
    volumeAccel: prior24 > 0 ? vol6h / (prior24 / 4) : vol6h > 0 ? 3 : 1,
    // Liquidity history would need a recorder running over days; a single
    // snapshot cannot say whether the pool grew or is being drained. Reported
    // as flat rather than invented, and the factor that reads it is weakened
    // accordingly by its own unmeasured declaration.
    newestTs: candles[i].t,
    bars: candles.length,
  };
}

/**
 * Regime from the token's own tape.
 *
 * The simulator has a market-wide state to consult. Here there is one token,
 * so regime is inferred from its recent behaviour — coarse on purpose, and
 * only ever nudges the score by a few percent through REGIME_ADJUST.
 */
function regimeOf(momentum24h: number, volumeAccel: number, liquidityUsd: number): MarketRegime {
  if (liquidityUsd < 25_000) return "low_liquidity";
  if (Math.abs(momentum24h) > 60) return "high_volatility";
  if (momentum24h < -20) return "risk_off";
  if (volumeAccel > 1.8) return "rotation";
  return "neutral";
}

/**
 * Assembles a live feature vector, or null when the token cannot be priced.
 *
 * Never throws for a missing capability — a provider that cannot answer widens
 * the unmeasured set instead, which is the difference between a tool that
 * degrades and one that falls over.
 */
export async function liveFeatures(
  mint: string,
  sources: LiveSources,
  now = Date.now(),
): Promise<LiveFeatureResult | null> {
  const provenance: string[] = [];

  const token = await sources.token.getToken(mint);
  if (!token) {
    provenance.push(`${sources.token.name}: no listing for this mint`);
    return null;
  }
  provenance.push(`${sources.token.name}: token info + snapshot`);
  const { snapshot, ...info } = token;

  const candles = await sources.market
    .getCandles(mint, now - 45 * 24 * HOUR, now)
    .catch(() => [] as Candle[]);
  provenance.push(
    candles.length
      ? `${sources.market.name}: ${candles.length} hourly bars`
      : `${sources.market.name}: NO candles — momentum and volume acceleration unavailable`,
  );

  const price = snapshot.priceUsd;
  if (!(price > 0)) {
    provenance.push("no usable price; refusing to build a vector");
    return null;
  }

  // Start from what the snapshot's own provider declared it could not see.
  const unmeasured = new Set<UnmeasuredField>(snapshot.unmeasured ?? []);
  for (const f of NEVER_AVAILABLE) unmeasured.add(f);

  // A keyed security provider can fill some of those gaps back in. This is the
  // composition rule, and it only ever REMOVES a field — a provider is trusted
  // to close a gap, never to reopen one another source already filled.
  let top10Pct = snapshot.top10Pct;
  let mintRevoked = info.mintAuthorityRevoked;
  let freezeRevoked = info.freezeAuthorityRevoked;
  /**
   * Whether anything actually CHECKED the authorities.
   *
   * The keyless providers report both as not-revoked, which is the right
   * default for grading — a token nobody examined must not be treated as
   * safely renounced. But reporting that default as "mint authority is LIVE"
   * states a fact nobody established, and for an established token it is
   * simply false. Grading fails safe; prose must say "unverified".
   */
  let authorityChecked = false;
  if (sources.security) {
    // The failure REASON is the diagnostic. Swallowing it into a null told the
    // caller "no holder data" whether the key was rejected, the endpoint had
    // moved, or the tier does not include it — three problems with three
    // different fixes, reported identically.
    let secError: string | null = null;
    const sec = await sources.security.getTokenSecurity(mint).catch((e: unknown) => {
      secError = e instanceof Error ? e.message : String(e);
      return null;
    });
    if (sec) {
      // Birdeye reports the share as a percentage in some responses and a
      // fraction in others; normalise, because 45 read as a fraction would be
      // a 4,500% concentration and read as 0.45 would be a serious understatement.
      const raw = sec.top10Pct;
      top10Pct = raw > 1 ? raw / 100 : raw;
      unmeasured.delete("top10Pct");
      mintRevoked = sec.mintAuthorityRevoked;
      freezeRevoked = sec.freezeAuthorityRevoked;
      authorityChecked = true;
      provenance.push(
        `${sources.security.name}: top-10 holders ${(top10Pct * 100).toFixed(1)}%, ` +
          `mint ${mintRevoked ? "revoked" : "LIVE"}, freeze ${freezeRevoked ? "revoked" : "LIVE"}` +
          (sec.warnings.length ? ` — ${sec.warnings.join("; ")}` : ""),
      );
    } else {
      provenance.push(
        secError
          ? `${sources.security.name}: FAILED — ${secError}`
          : `${sources.security.name}: responded, but with no data for this mint — holder data stays unmeasured`,
      );
    }
  } else {
    provenance.push("no security provider configured — holder data unmeasured (set BIRDEYE_API_KEY)");
  }

  const c = fromCandles(candles, price);
  if (!c) {
    // Without candles there is no momentum, no volume acceleration and no
    // sample to speak of. Rather than emit a vector whose zeros mean "flat",
    // refuse — the caller can say why.
    provenance.push("fewer than 3 hourly bars; refusing to build a vector");
    return null;
  }

  const totalTrades1h = snapshot.buys1h + snapshot.sells1h;
  const liquidityUsd = snapshot.liquidityUsd;
  const ageHours = info.createdAt > 0 ? (now - info.createdAt) / HOUR : c.bars;

  const features: FeatureVector = {
    asOf: now,
    mint,
    // No wallet-flow source at this price point. Declared, not faked.
    smartMoneyNetFlowUsd: 0,
    smartMoneyWallets: 0,
    whaleNetFlowUsd: 0,
    whaleBuys: 0,
    whaleSells: 0,
    momentum1h: c.momentum1h,
    momentum5m: c.momentum5m,
    momentum24h: c.momentum24h,
    volumeAccel: c.volumeAccel,
    liquidityUsd,
    liquidityChangePct: 0,
    holderGrowthPct: 0,
    top10Pct,
    organicScore: snapshot.organicScore,
    socialScore: snapshot.socialScore,
    socialAccel: 0,
    ageHours,
    buySellImbalance: totalTrades1h > 0 ? (snapshot.buys1h - snapshot.sells1h) / totalTrades1h : 0,
    insiderPct: snapshot.insiderPct,
    bundlerPct: snapshot.bundlerPct,
    sniperPct: snapshot.sniperPct,
    devHoldsPct: snapshot.devHoldsPct,
    devSold: false,
    // Same 18% rule the simulator uses, so the two are comparable.
    exitDepthUsd: liquidityUsd * 0.18,
    regime: regimeOf(c.momentum24h, c.volumeAccel, liquidityUsd),
    sampleSize: Math.min(c.bars, 48) + totalTrades1h,
    worstStalenessMs: Math.max(0, now - c.newestTs),
    unmeasured: [...unmeasured],
  };

  // The authority flags are not FeatureVector fields but they are the loudest
  // facts about a memecoin, so they reach the caller through provenance —
  // phrased according to whether anyone actually looked.
  if (authorityChecked) {
    if (!mintRevoked) provenance.push("WARNING: mint authority is LIVE — supply can be inflated");
    if (!freezeRevoked) provenance.push("WARNING: freeze authority is LIVE — transfers can be frozen");
    if (mintRevoked && freezeRevoked) provenance.push("mint and freeze authorities both revoked");
  } else {
    provenance.push(
      "mint and freeze authorities UNVERIFIED — no keyless source publishes them. " +
        "Graded as not-revoked so an unexamined token is never treated as safe, " +
        "which is not the same as knowing they are live",
    );
  }

  return { features, info: info as TokenInfo, snapshot, candles, provenance };
}

/** Convenience: assemble and score in one call. */
export async function liveSignal(
  mint: string,
  sources: LiveSources,
  profile: StrategyProfileId = "balanced",
  now = Date.now(),
): Promise<{ signal: Signal; result: LiveFeatureResult } | null> {
  const result = await liveFeatures(mint, sources, now);
  if (!result) return null;
  return { signal: scoreFeatures(result.features, mint, now, profile), result };
}
