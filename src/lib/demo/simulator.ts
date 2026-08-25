// The live simulator. Continues each token's price path from where the
// generated history ended, emits wallet trades consistent with wallet
// behavior, and feeds the event stream the UI subscribes to. Deterministic
// per (seed, minute) so two server instances tell the same story.

import { Rng, fakeSignature } from "./rng";
import { getStore, DemoStore } from "./store";
import { HOUR } from "./universe";
import { enforceStops } from "../engine/paper";
import { signalsAt } from "../engine/signals";
import type { AlertEvent, LiveEvent, WalletTrade } from "../types";

const TICK_MS = 4_000;

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

let tradeSeq = 1_000_000;

function tick(store: DemoStore) {
  const now = Date.now();
  const rng = new Rng(hash32(`tick:${store.universe.seed}:${Math.floor(now / TICK_MS)}`));
  const tokens = store.tokenList();

  // advance prices: random-walk continuation of each token's final regime
  for (const tok of tokens) {
    const last = store.livePrice.get(tok.info.mint)?.price ?? tok.candles[tok.candles.length - 1]?.c;
    if (!last) continue;
    const dtH = TICK_MS / HOUR;
    const ret = tok.drift * dtH + rng.gaussian(0, tok.vol * Math.sqrt(dtH));
    store.livePrice.set(tok.info.mint, { ts: now, price: Math.max(1e-12, last * Math.exp(ret)) });
  }

  // occasionally a tracked wallet trades (~every ~3 ticks)
  if (rng.chance(0.38)) {
    const wallets = store.walletList();
    const w = rng.pick(wallets);
    const liquid = tokens.filter((t) => t.archetype !== "rug" && t.liquidityUsd[t.liquidityUsd.length - 1] > 30_000);
    const tok = rng.pick(liquid.length ? liquid : tokens);
    const price = store.lastPrice(tok.info.mint) ?? 0;
    if (price > 0) {
      const isWhale = w.labels.includes("whale") || w.labels.includes("fund");
      const usd = rng.heavyTail(isWhale ? 60_000 : 9_000, 0.8);
      const side: "buy" | "sell" = rng.chance(w.behavior.momentumBias * 0.5 + 0.3) ? "buy" : "sell";
      const trade: WalletTrade = {
        id: `lt${++tradeSeq}`,
        signature: fakeSignature(rng),
        wallet: w.address,
        mint: tok.info.mint,
        ts: now,
        side,
        amountUsd: usd,
        amountTokens: usd / price,
        priceUsd: price,
        dex: w.behavior.preferredDex,
        classification: side === "buy" ? (rng.chance(0.4) ? "open" : "add") : rng.chance(0.5) ? "reduce" : "exit",
        confidence: rng.range(0.7, 0.97),
      };
      store.liveTrades.push(trade);
      if (store.liveTrades.length > 3000) store.liveTrades.splice(0, 500);

      const smart = w.smartMoney.total >= 65;
      const kind: LiveEvent["kind"] =
        side === "buy"
          ? smart
            ? "smart_money_buy"
            : trade.classification === "open"
              ? "new_position"
              : "whale_buy"
          : trade.classification === "exit"
            ? "position_exit"
            : smart
              ? "smart_money_sell"
              : "whale_sell";
      const ev: LiveEvent = {
        id: `ev${tradeSeq}`,
        kind,
        ts: now,
        mint: tok.info.mint,
        wallet: w.address,
        amountUsd: usd,
        headline: `${smart ? "SMART MONEY" : isWhale ? "WHALE" : "TRACKED WALLET"} ${side.toUpperCase()}`,
        detail: `${w.knownEntity ?? w.address.slice(0, 4) + "…" + w.address.slice(-4)} ${side === "buy" ? "accumulated" : "sold"} $${Math.round(usd / 1000)}K of ${tok.info.symbol}`,
        confidence: trade.confidence,
        signature: trade.signature,
      };
      store.pushEvent(ev);
      matchAlerts(store, ev);
    }
  }

  // occasional liquidity / risk events
  if (rng.chance(0.06)) {
    const tok = rng.pick(tokens);
    const add = rng.chance(0.6);
    const usd = rng.heavyTail(80_000, 0.7);
    store.pushEvent({
      id: `lq${++tradeSeq}`,
      kind: add ? "liquidity_add" : "liquidity_remove",
      ts: now,
      mint: tok.info.mint,
      amountUsd: usd,
      headline: add ? "LIQUIDITY ADDED" : "LIQUIDITY REMOVED",
      detail: `$${Math.round(usd / 1000)}K ${add ? "added to" : "pulled from"} the ${tok.info.symbol} pool`,
    });
  }

  // stops/targets on paper portfolios
  for (const fired of enforceStops(store)) {
    const sym = store.token(fired.mint)?.info.symbol ?? "?";
    store.pushEvent({
      id: store.nextId("ev"),
      kind: "risk_event",
      ts: now,
      mint: fired.mint,
      headline: "PAPER ORDER TRIGGERED",
      detail: `${sym}: ${fired.reason}`,
    });
  }

  store.simulatedUntil = now;
}

function matchAlerts(store: DemoStore, ev: LiveEvent) {
  for (const rule of store.alertRules) {
    if (!rule.enabled) continue;
    const c = rule.condition;
    let hit = false;
    if (c.type === "whale_buy" && (ev.kind === "whale_buy" || ev.kind === "smart_money_buy") && (ev.amountUsd ?? 0) >= c.minUsd)
      hit = !c.mint || c.mint === ev.mint;
    if (c.type === "whale_sell" && (ev.kind === "whale_sell" || ev.kind === "smart_money_sell") && (ev.amountUsd ?? 0) >= c.minUsd)
      hit = !c.mint || c.mint === ev.mint;
    if (c.type === "wallet_activity" && ev.wallet === c.wallet) hit = true;
    if (hit) {
      const alert: AlertEvent = {
        id: store.nextId("ae"),
        ruleId: rule.id,
        ts: ev.ts,
        headline: rule.name,
        detail: ev.detail,
        mint: ev.mint,
        wallet: ev.wallet,
        read: false,
      };
      store.alertEvents.unshift(alert);
      if (store.alertEvents.length > 200) store.alertEvents.pop();
    }
  }
}

/** periodic signal sweep: emits signal_created events for fresh high scores */
let lastSweep = 0;
function signalSweep(store: DemoStore) {
  const now = Date.now();
  if (now - lastSweep < 90_000) return;
  lastSweep = now;
  const sigs = signalsAt(store, now, "balanced").slice(0, 12);
  for (const s of sigs) {
    if (s.score < 80 || s.label === "NO TRADE") continue;
    if (store.events.some((e) => e.kind === "signal_created" && e.mint === s.mint && now - e.ts < 45 * 60_000)) continue;
    const sym = store.token(s.mint)?.info.symbol ?? "?";
    const ev: LiveEvent = {
      id: store.nextId("ev"),
      kind: "signal_created",
      ts: now,
      mint: s.mint,
      headline: `SIGNAL ${s.score}/100`,
      detail: `${sym}: ${s.kind.replace(/_/g, " ")} — ${s.why[0] ?? ""}`,
      confidence: s.confidence,
    };
    store.pushEvent(ev);
    for (const rule of store.alertRules) {
      if (rule.enabled && rule.condition.type === "signal_score_above" && s.score >= rule.condition.threshold) {
        store.alertEvents.unshift({
          id: store.nextId("ae"),
          ruleId: rule.id,
          ts: now,
          headline: rule.name,
          detail: ev.detail,
          mint: s.mint,
          read: false,
        });
      }
    }
  }
}

declare global {
  var __whalenovaSim: ReturnType<typeof setInterval> | undefined;
}

/** Idempotent: first API touch starts the simulator for the process. */
export function ensureSimulator(): DemoStore {
  const store = getStore();
  if (!globalThis.__whalenovaSim) {
    globalThis.__whalenovaSim = setInterval(() => {
      const s = getStore();
      try {
        tick(s);
        signalSweep(s);
      } catch (err) {
        console.error("[rom-nova] simulator tick failed", err);
      }
    }, TICK_MS);
    // don't hold the process open just for the sim
    if (typeof globalThis.__whalenovaSim === "object" && "unref" in globalThis.__whalenovaSim) {
      globalThis.__whalenovaSim.unref();
    }
    tick(store);
  }
  return store;
}
