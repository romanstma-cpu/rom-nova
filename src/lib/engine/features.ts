// Feature extraction. One function turns (mint, asOf) into the raw
// FeatureVector the signal engine scores. It only reads data at or before
// asOf — the anti-lookahead guarantee lives here, not in the callers.

import type { DemoStore } from "../demo/store";
import { HOUR, DAY } from "../demo/universe";
import type { FeatureVector } from "../types";
// The one definition of "smart" and "whale". A private copy lived here and
// agreed with the flow chart by luck, not by construction — see thresholds.ts.
import { SMART_MONEY_THRESHOLD, WHALE_TRADE_USD } from "./thresholds";

/** The window the simulator's wallet-flow fields cover. */
export const DEMO_FLOW_WINDOW_MS = 6 * HOUR;

export function extractFeatures(store: DemoStore, mint: string, asOf: number): FeatureVector | undefined {
  const tok = store.token(mint);
  const snap = store.snapshot(mint, asOf);
  if (!tok || !snap) return undefined;

  const candles = tok.candles.filter((c) => c.t <= asOf);
  if (candles.length < 3) return undefined;
  const i = candles.length - 1;
  const px = snap.priceUsd;

  const at = (hoursBack: number) => candles[Math.max(0, i - hoursBack)].c;
  const mom1h = i >= 1 ? (px / at(1) - 1) * 100 : 0;
  const mom24h = i >= 24 ? (px / at(24) - 1) * 100 : (px / candles[0].c - 1) * 100;
  // 5m momentum: live price vs hour open when available, else intrabar drift
  const mom5m = (px / candles[i].o - 1) * 100 * 0.35;

  const volWin = (from: number, to: number) =>
    candles.slice(Math.max(0, i - from), Math.max(0, i - to + 1)).reduce((s, c) => s + c.v, 0);
  const vol6h = volWin(5, 0);
  const prior24 = volWin(29, 6);
  const volumeAccel = prior24 > 0 ? vol6h / (prior24 / 4) : vol6h > 0 ? 3 : 1;

  const stats = store.tokenStats(tok, asOf);
  const liqNow = snap.liquidityUsd;
  const liq24 = tok.liquidityUsd[Math.max(0, i - 24)];
  const holdersNow = snap.holders;
  const holders24 = tok.holders[Math.max(0, i - 24)];

  // wallet flows over the trailing window — six hours, and the vector says so
  const trades = store.mintTrades(mint, asOf - DEMO_FLOW_WINDOW_MS, asOf);
  let smFlow = 0;
  let whaleFlow = 0;
  let whaleBuys = 0;
  let whaleSells = 0;
  const smWallets = new Set<string>();
  for (const t of trades) {
    const w = store.wallet(t.wallet);
    const signed = t.side === "buy" ? t.amountUsd : -t.amountUsd;
    if (w && w.smartMoney.total >= SMART_MONEY_THRESHOLD) {
      smFlow += signed;
      smWallets.add(t.wallet);
    }
    if ((w && w.labels.includes("whale")) || t.amountUsd >= WHALE_TRADE_USD) {
      whaleFlow += signed;
      if (t.side === "buy") whaleBuys++;
      else whaleSells++;
    }
  }

  const totalTrades1h = snap.buys1h + snap.sells1h;
  const imbalance = totalTrades1h > 0 ? (snap.buys1h - snap.sells1h) / totalTrades1h : 0;

  const market = store.marketState(asOf);

  return {
    asOf,
    mint,
    smartMoneyNetFlowUsd: smFlow,
    smartMoneyWallets: smWallets.size,
    whaleNetFlowUsd: whaleFlow,
    whaleBuys,
    whaleSells,
    momentum1h: mom1h,
    momentum5m: mom5m,
    momentum24h: mom24h,
    volumeAccel,
    liquidityUsd: liqNow,
    liquidityChangePct: liq24 > 0 ? (liqNow / liq24 - 1) * 100 : 0,
    holderGrowthPct: holders24 > 0 ? (holdersNow / holders24 - 1) * 100 : 0,
    top10Pct: stats.top10Pct,
    organicScore: stats.organicScore,
    socialScore: stats.socialScore,
    socialAccel: Math.max(0, stats.socialScore - store.tokenStats(tok, asOf - DAY).socialScore),
    ageHours: (asOf - tok.info.createdAt) / HOUR,
    buySellImbalance: imbalance,
    insiderPct: stats.insiderPct,
    bundlerPct: stats.bundlerPct,
    sniperPct: stats.sniperPct,
    devHoldsPct: stats.devHoldsPct,
    devSold: stats.devSold,
    // The simulator authored these when it generated the token, so unlike the
    // live path they are always known here.
    mintAuthorityRevoked: tok.info.mintAuthorityRevoked,
    freezeAuthorityRevoked: tok.info.freezeAuthorityRevoked,
    permanentDelegate: tok.info.permanentDelegate,
    // The security facts the simulator has no concept of. Declared below rather
    // than invented: a synthetic 100% lock would be the most reassuring
    // possible reading of something this universe does not model.
    lpLockedPct: 0,
    lpProviders: 0,
    // The simulator DOES author a deployer history, so these are real here.
    devMints: 1,
    devMigrations: 1,
    exitDepthUsd: liqNow * 0.18,
    regime: market.regime,
    sampleSize: trades.length + Math.min(candles.length, 48) + totalTrades1h,
    worstStalenessMs: Math.max(0, asOf - candles[i].t - (store.livePrice.has(mint) ? 0 : 0)),
    // Carried, not recomputed. Whichever provider built the snapshot is the
    // only thing that knows what it could not see, and the scorer needs that
    // to drop those factors rather than read their zeros as good news.
    //
    // Plus the gaps the SIMULATOR itself has. It does not model liquidity
    // locking, who provides that liquidity, or a deployer's other mints, so
    // those factors stand down here exactly as they would against a provider
    // that did not publish them. `devSold` is NOT among them — the simulator
    // tracks the deployer's position over time, which is precisely what the
    // live stack cannot do.
    unmeasured: [
      ...(snap.unmeasured ?? []),
      "lpLocked" as const,
      "lpProviders" as const,
      "devHistory" as const,
    ],
  };
}
