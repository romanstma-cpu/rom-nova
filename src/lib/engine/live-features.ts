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
import { riskHeadline } from "../providers/rugcheck";
import type {
  MarketDataProvider,
  SecurityDataProvider,
  TokenDataProvider,
  TokenFlow,
  TokenFlowProvider,
  TokenRisk,
  TokenRiskProvider,
} from "../providers/types";

const HOUR = 3_600_000;

export interface LiveSources {
  token: TokenDataProvider;
  market: MarketDataProvider;
  /** Optional: only a keyed provider has holder data. */
  security?: SecurityDataProvider;
  /** Optional: wallet-level flow. Absent means whale movement is unmeasured. */
  flow?: TokenFlowProvider;
  /**
   * Optional: a third-party risk grade. Never scored — see the overlay block in
   * `liveFeatures` for why a vendor's opinion stays out of the weighted mean.
   */
  risk?: TokenRiskProvider;
}

/**
 * A movement this size in USD counts as a whale.
 *
 * Matches the demo path's own threshold in `buildFlowSeries`, deliberately: a
 * live vector and a simulated one have to mean the same thing when they reach
 * the scorer, or the two worlds stop being comparable.
 */
export const WHALE_USD = 20_000;

/** How much chain history one live vector will pay for. */
const FLOW_MINUTES = 10;

/**
 * How deep into the mover ranking to look for whales.
 *
 * Forty each way. The scan is free once the stream is already folded, and the
 * cost of guessing too low is a whale reported as no whale.
 */
const FLOW_MOVERS = 40;

export interface LiveFeatureResult {
  features: FeatureVector;
  info: TokenInfo;
  snapshot: TokenSnapshot;
  candles: Candle[];
  /**
   * The raw flow behind the whale numbers, when a provider supplied it.
   *
   * Carried rather than discarded because "whale netflow +$40k" and "these
   * three wallets bought it" are different claims, and the second is the one a
   * reader can actually check on a block explorer.
   */
  flow?: TokenFlow;
  /**
   * The third-party risk grade, when one was fetched.
   *
   * Carried beside the features rather than folded into them, so a UI can show
   * "RugCheck says 44/100" as somebody's opinion rather than as one more input
   * that silently moved the number Nova is claiming as its own.
   */
  risk?: TokenRisk;
  /**
   * Whether a source actually READ the mint and freeze authorities, and which.
   *
   * `info.mintAuthorityRevoked` alone cannot say. The keyless token providers
   * report both as not-revoked whether they checked or not, and this function
   * overwrites them when a security provider answers — so the flag a caller
   * receives is sometimes a chain read and sometimes a fail-safe default, and
   * the two are worth very different amounts to a reader. A UI that cannot tell
   * them apart will print "mint authority LIVE" on a token nobody examined.
   */
  authorityChecked: boolean;
  authoritySource?: string;
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
  // A flow provider says WHO moved; nothing here says whether they are any
  // good. Wallet reputation needs a track record no source in this stack
  // publishes, so smart money stays unmeasured even when whale flow is real.
  "smartMoney",
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
  /**
   * Whether to pull the FULL risk report rather than the summary.
   *
   * Off by default because the difference is three orders of magnitude — ~300
   * bytes against 80KB to 1.6MB — and a twelve-row list must never pay it. A
   * token detail page may.
   */
  detailedRisk = false,
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
  // What the market source returned, and nothing about what that costs — the
  // block below decides whether momentum is actually unavailable or comes from
  // the token provider's published stats instead. This line used to assert
  // "momentum and volume acceleration unavailable" and was then followed, four
  // lines later, by "momentum from its 1h/24h stats": two answers to one
  // question in the same report, which is the failure this file already fixed
  // once for concentration.
  provenance.push(
    candles.length
      ? `${sources.market.name}: ${candles.length} hourly bars`
      : `${sources.market.name}: no bars returned`,
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
      // A provider may close SOME gaps. The chain gives authorities away free
      // but puts holder distribution behind endpoints the public RPCs block, so
      // top10Pct is only accepted when the provider says it actually read it —
      // otherwise its zero would leave the unmeasured set and be scored as a
      // flawlessly distributed cap table, which is the exact failure the
      // unmeasured machinery exists to prevent.
      if (sec.top10Known !== false) {
        // Birdeye reports the share as a percentage in some responses and a
        // fraction in others; normalise, because 45 read as a fraction would be
        // a 4,500% concentration and read as 0.45 would be a serious understatement.
        const raw = sec.top10Pct;
        top10Pct = raw > 1 ? raw / 100 : raw;
        unmeasured.delete("top10Pct");
      }
      mintRevoked = sec.mintAuthorityRevoked;
      freezeRevoked = sec.freezeAuthorityRevoked;
      authorityChecked = true;
      // "top-10 holders 0.0%" is the zeros problem wearing prose. A provider
      // that did not read concentration must not have its placeholder printed
      // as a measurement — the line says unmeasured, exactly like the vector.
      //
      // But it must describe the COMPOSED state, not this provider's private
      // one. With Jupiter supplying concentration and the free RPC unable to,
      // the flat version of this line printed "top-10 holders UNMEASURED" while
      // the vector scored a real 74.5% from the token provider — two answers to
      // one question in the same report, which is worse than either alone.
      const stillUnknown = unmeasured.has("top10Pct");
      const concentration = stillUnknown
        ? "top-10 holders UNMEASURED"
        : sec.top10Known === false
          ? `top-10 holders ${(top10Pct * 100).toFixed(1)}% (from ${sources.token.name}; this source could not read it)`
          : `top-10 holders ${(top10Pct * 100).toFixed(1)}%`;
      provenance.push(
        `${sources.security.name}: ${concentration}, ` +
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

  // Without candles there is no momentum and no volume acceleration. This used
  // to refuse the whole vector — "rather than emit zeros that mean flat" — and
  // that was the right instinct with the wrong remedy, because it also threw
  // away liquidity, trade imbalance, age, the authorities and the wallet flow,
  // all of which were known. It is also what made a scored token LIST
  // impossible: candles cost 4.4s each and zero of twelve arrived under any
  // concurrency, so refusing on their absence meant refusing every row.
  //
  // Declaring beats refusing. The two candle-derived factors step aside, the
  // confidence falls by exactly their weight, and everything else still counts.
  const c = fromCandles(candles, price);
  // Candles win where they exist: they are bars this app can plot and audit,
  // over windows it chose. Where there are none, a source that publishes its
  // OWN rate-of-change stats can still answer the question — Jupiter ships
  // priceChange and volumeChange per interval in the same payload as the price.
  //
  // That is not a substitute for candles, it is a second measurement of the
  // same quantity by someone with better data than a free OHLCV endpoint hands
  // out. Which one served is stated, because "1h +23%" computed from bars and
  // the same figure taken on trust are different claims.
  const snapMomentum = snapshot.momentum1h !== undefined || snapshot.momentum24h !== undefined;
  const snapAccel = snapshot.volumeAccel !== undefined;
  if (!c) {
    if (snapMomentum) {
      unmeasured.delete("momentum");
      provenance.push(
        `${sources.token.name}: no candles, but the source publishes interval price change — ` +
          `momentum from its 1h/24h stats rather than from bars`,
      );
    } else {
      unmeasured.add("momentum");
    }
    if (snapAccel) {
      unmeasured.delete("volumeAccel");
      provenance.push(`${sources.token.name}: volume acceleration from its published volume change`);
    } else {
      unmeasured.add("volumeAccel");
    }
    if (!snapMomentum || !snapAccel) {
      provenance.push(
        "fewer than 3 hourly bars and no published interval stats — " +
          (!snapMomentum && !snapAccel
            ? "momentum and volume acceleration"
            : !snapMomentum
              ? "momentum"
              : "volume acceleration") +
          " unmeasured, scored on what remains",
      );
    }
  }

  // ------------------------------------------------------------ risk overlay
  //
  // A third-party opinion, kept separate from the chain facts above. It never
  // moves the score — the scorer weighs evidence this app can inspect, and
  // importing a vendor's number into it would launder their judgement as ours.
  // It reaches the reader as prose and flags, which is where an opinion belongs.
  let risk: TokenRisk | undefined;
  if (sources.risk) {
    const r = await sources.risk.getTokenRisk(mint, detailedRisk).catch(() => null);
    if (r) {
      risk = r;
      provenance.push(`${r.source}: ${riskHeadline(r)}`);
      for (const item of r.risks.filter((x) => x.level === "danger")) {
        provenance.push(`WARNING (${r.source}): ${item.name}${item.value ? ` — ${item.value}` : ""}`);
      }
      // LP lock is the one that earns its own line whatever its value. An
      // unlocked pool is the mechanic behind most memecoin losses and it is
      // invisible to every other source in this stack.
      if (r.lpLockedPct !== undefined && r.lpLockedPct < 0.5) {
        provenance.push(
          `WARNING: only ${(r.lpLockedPct * 100).toFixed(1)}% of liquidity is locked — ` +
            `the pool can be withdrawn`,
        );
      }
      // `insiderPct` is set by the provider ONLY when the insider-graph
      // analysis is present in the payload, so a defined value means somebody
      // looked — and a defined ZERO is a finding, not a silence. Gating this on
      // `> 0` (as it first did) would have kept "no insiders found" in the
      // unmeasured set, which is the mirror of the bug this machinery exists to
      // stop: refusing to record a real negative result.
      if (r.insiderPct !== undefined) unmeasured.delete("insiderPct");
    } else {
      provenance.push(`${sources.risk.name}: no report for this mint — risk ungraded`);
    }
  }

  const totalTrades1h = snapshot.buys1h + snapshot.sells1h;
  const liquidityUsd = snapshot.liquidityUsd;
  // Bar count is the fallback age when the pool's creation time is unknown.
  // With no candles there is no fallback either, so age is zero and reads as
  // brand new — the cautious direction, and the one `age_opportunity` already
  // treats as highest risk.
  const ageHours = info.createdAt > 0 ? (now - info.createdAt) / HOUR : (c?.bars ?? 0);

  // ------------------------------------------------------------- wallet flow
  //
  // The five flow fields have been zeros since this file was written, and
  // unlike the holder fields they are NOT in UnmeasuredField — so the scorer
  // has been reading "no whale has touched this" as a measured fact rather than
  // an absence. A flow provider closes the whale half of that.
  //
  // Smart money is deliberately NOT closed. It needs wallet reputation, and
  // nothing here knows which addresses are good; inferring it from a ten-minute
  // window would be inventing a track record.
  let whaleNetFlowUsd = 0;
  let whaleBuys = 0;
  let whaleSells = 0;
  let flowDetail: TokenFlow | undefined;
  if (sources.flow) {
    // topMovers is asked for generously because whale detection happens HERE,
    // not in the provider: only this layer knows the mint's decimals and price,
    // so only it can convert a raw delta into dollars. The provider's default
    // of five would silently cap the search at the ten biggest wallets, and a
    // whale in eleventh place would read as no whale at all.
    const f = await sources.flow
      .getTokenFlow(mint, { minutes: FLOW_MINUTES, topMovers: FLOW_MOVERS })
      .catch(() => null);
    if (f && f.movements > 0) {
      flowDetail = f;
      const decimals = info.decimals ?? 9;
      for (const mover of f.largest) {
        const usd = (Number(mover.deltaUnits) / 10 ** decimals) * price;
        if (Math.abs(usd) < WHALE_USD) continue;
        whaleNetFlowUsd += usd;
        if (usd > 0) whaleBuys++;
        else whaleSells++;
      }
      const window = f.complete
        ? `${FLOW_MINUTES} min`
        : `${(f.blocksCovered / 150).toFixed(1)} min of ${FLOW_MINUTES} requested`;
      provenance.push(
        `${f.source}: ${f.movements} balance changes across ${f.wallets} wallets over ${window}` +
          (f.complete ? "" : " — byte budget reached, window truncated") +
          `; ${whaleBuys + whaleSells} moved $${WHALE_USD.toLocaleString()}+`,
      );
    } else {
      // A provider that answered with nothing has not established that nobody
      // traded — it may have been rate-limited, or the window may have been
      // truncated to almost nothing by the byte budget. Unmeasured, not quiet.
      unmeasured.add("whaleFlow");
      provenance.push(
        `${sources.flow.name}: no wallet movement returned — whale flow stays unmeasured`,
      );
    }
  } else {
    unmeasured.add("whaleFlow");
    provenance.push("no flow provider configured — whale and smart-money flow unmeasured");
  }

  const features: FeatureVector = {
    asOf: now,
    // Smart money needs wallet reputation no source here has. Still zero, and
    // still an absence rather than a finding.
    smartMoneyNetFlowUsd: 0,
    smartMoneyWallets: 0,
    mint,
    whaleNetFlowUsd,
    whaleBuys,
    whaleSells,
    // Candles first, the source's own published stats second, zero last — and
    // a zero that survives to here is inert, because the factor reading it has
    // been declared unmeasured above and the scorer drops it rather than
    // reading a flat tape.
    momentum1h: c?.momentum1h ?? snapshot.momentum1h ?? 0,
    momentum5m: c?.momentum5m ?? snapshot.momentum5m ?? 0,
    momentum24h: c?.momentum24h ?? snapshot.momentum24h ?? 0,
    volumeAccel: c?.volumeAccel ?? snapshot.volumeAccel ?? 0,
    liquidityUsd,
    // A single snapshot cannot say whether a pool grew or is being drained, so
    // this was hardcoded flat. A source that publishes its own 24h change can
    // say, and a draining pool is the loudest pre-rug signal there is.
    liquidityChangePct: snapshot.liquidityChangePct ?? 0,
    holderGrowthPct: snapshot.holderGrowthPct ?? 0,
    top10Pct,
    organicScore: snapshot.organicScore,
    socialScore: snapshot.socialScore,
    socialAccel: 0,
    ageHours,
    buySellImbalance: totalTrades1h > 0 ? (snapshot.buys1h - snapshot.sells1h) / totalTrades1h : 0,
    // The risk provider is the only source here that flags insider-linked
    // holders, and only from the full report where the graph analysis ran.
    insiderPct: risk?.insiderPct ?? snapshot.insiderPct,
    bundlerPct: snapshot.bundlerPct,
    sniperPct: snapshot.sniperPct,
    devHoldsPct: snapshot.devHoldsPct,
    devSold: false,
    // Same 18% rule the simulator uses, so the two are comparable.
    exitDepthUsd: liquidityUsd * 0.18,
    regime: regimeOf(c?.momentum24h ?? 0, c?.volumeAccel ?? 1, liquidityUsd),
    // Sample size drives confidence, so a candle-less vector must not borrow
    // any: what remains is the 1h trade count and nothing else.
    sampleSize: Math.min(c?.bars ?? 0, 48) + totalTrades1h,
    // No bars means no bar to be stale, and the freshest thing we have is the
    // snapshot itself.
    worstStalenessMs: Math.max(0, now - (c?.newestTs ?? snapshot.ts)),
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

  // The verified authorities are written back into the info the caller gets.
  // Without this the token provider's placeholder survives — coingecko hardcodes
  // both to false — so anything reading `result.info` saw "mint authority live"
  // on a token the chain had just confirmed renounced, while the provenance
  // beside it said revoked. Two answers to one question is worse than either.
  const verified: TokenInfo = authorityChecked
    ? { ...(info as TokenInfo), mintAuthorityRevoked: mintRevoked, freezeAuthorityRevoked: freezeRevoked }
    : (info as TokenInfo);

  return {
    features,
    info: verified,
    snapshot,
    candles,
    provenance,
    flow: flowDetail,
    risk,
    authorityChecked,
    authoritySource: authorityChecked ? sources.security?.name : undefined,
  };
}

/** Convenience: assemble and score in one call. */
export async function liveSignal(
  mint: string,
  sources: LiveSources,
  profile: StrategyProfileId = "balanced",
  now = Date.now(),
  detailedRisk = false,
): Promise<{ signal: Signal; result: LiveFeatureResult } | null> {
  const result = await liveFeatures(mint, sources, now, detailedRisk);
  if (!result) return null;
  return { signal: scoreFeatures(result.features, mint, now, profile), result };
}
