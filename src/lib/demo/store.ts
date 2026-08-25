// The demo data store. One instance per server process (globalThis-cached
// so Next dev HMR doesn't rebuild the world). Every read that feeds the
// signal engine takes an `asOf` timestamp and refuses to look past it —
// the time machine and the backtester get anti-lookahead behavior from the
// same code path the dashboard uses.

import { buildUniverse, DemoUniverse, TokenSeries, HOUR, DAY } from "./universe";
import { Rng } from "./rng";
import {
  measurePerformance,
  replayWallet,
  smartMoneyScore,
  WalletLedger,
} from "../engine/perf";
import type {
  AlertEvent,
  AlertRule,
  Candle,
  LiveEvent,
  MarketRegime,
  MarketState,
  PaperPortfolio,
  TokenSnapshot,
  WalletInfo,
  WalletPerformance,
  WalletTrade,
  Watchlist,
} from "../types";

// stable 32-bit hash for deterministic per-entity randomness
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export interface TokenStats {
  top10Pct: number;
  devHoldsPct: number;
  organicScore: number;
  socialScore: number;
  bundlerPct: number;
  sniperPct: number;
  insiderPct: number;
  devSold: boolean;
}

export class DemoStore {
  readonly universe: DemoUniverse;
  readonly ledgers = new Map<string, WalletLedger>();
  readonly perfs = new Map<string, WalletPerformance>();
  /** trades per mint, ascending ts */
  readonly tradesByMint = new Map<string, WalletTrade[]>();
  /** trades per wallet, ascending ts */
  readonly tradesByWallet = new Map<string, WalletTrade[]>();

  // ---- live overlay, written by the simulator ----
  /** latest live price per mint (after genesis) */
  readonly livePrice = new Map<string, { ts: number; price: number }>();
  /** live trades appended after genesis */
  liveTrades: WalletTrade[] = [];
  /** ring buffer of feed events */
  events: LiveEvent[] = [];
  private listeners = new Set<(e: LiveEvent) => void>();
  simulatedUntil: number;

  // ---- user state (in-memory, demo) ----
  watchlists: Watchlist[] = [];
  alertRules: AlertRule[] = [];
  alertEvents: AlertEvent[] = [];
  portfolios: PaperPortfolio[] = [];
  research: { id: string; mint: string; ts: number; note: string; snapshot: TokenSnapshot }[] = [];
  private seq = 0;

  /** bumped when persisted user state fails to parse, for diagnostics */
  hydrated = false;

  constructor(seed?: number) {
    this.universe = buildUniverse(seed);
    this.simulatedUntil = this.universe.genesis;

    for (const t of this.universe.trades) {
      let a = this.tradesByMint.get(t.mint);
      if (!a) this.tradesByMint.set(t.mint, (a = []));
      a.push(t);
      let b = this.tradesByWallet.get(t.wallet);
      if (!b) this.tradesByWallet.set(t.wallet, (b = []));
      b.push(t);
    }

    // measure every wallet and replace the placeholder smart-money scores
    for (const w of this.universe.wallets.values()) {
      const ledger = replayWallet(w.address, this.tradesByWallet.get(w.address) ?? []);
      this.ledgers.set(w.address, ledger);
      const perf = measurePerformance(ledger, (mint) => this.lastPrice(mint));
      this.perfs.set(w.address, perf);
      w.smartMoney = smartMoneyScore(perf, ledger);
    }

    this.seedUserState();
    this.hydrateUserState();
  }

  nextId(prefix: string): string {
    return `${prefix}_${(++this.seq).toString(36)}${(this.universe.seed % 97).toString(36)}`;
  }

  // ---------------------------------------------------- browser persistence
  // In the static (browser-only) build, user state is private to the visitor
  // and survives reloads via localStorage. On the server this is a no-op —
  // server mode is a single-tenant dev tool, not the public artifact.

  private static readonly LS_KEY = "romnova_user_v1";
  /** pre-rename key — read once so early visitors keep their workspace */
  private static readonly LS_KEY_LEGACY = "whalenova_user_v1";

  persistUserState() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        DemoStore.LS_KEY,
        JSON.stringify({
          seed: this.universe.seed,
          seq: this.seq,
          watchlists: this.watchlists,
          alertRules: this.alertRules,
          alertEvents: this.alertEvents.slice(0, 100),
          portfolios: this.portfolios,
          research: this.research.slice(0, 50),
        }),
      );
    } catch {
      // storage full or blocked — the session still works, it just won't persist
    }
  }

  private hydrateUserState() {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(DemoStore.LS_KEY) ?? localStorage.getItem(DemoStore.LS_KEY_LEGACY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.seed !== this.universe.seed) return; // different world — keep seeds
      if (Array.isArray(saved.watchlists)) this.watchlists = saved.watchlists;
      if (Array.isArray(saved.alertRules)) this.alertRules = saved.alertRules;
      if (Array.isArray(saved.alertEvents)) this.alertEvents = saved.alertEvents;
      if (Array.isArray(saved.portfolios)) this.portfolios = saved.portfolios;
      if (Array.isArray(saved.research)) this.research = saved.research;
      if (typeof saved.seq === "number") this.seq = Math.max(this.seq, saved.seq);
      this.hydrated = true;
    } catch {
      // corrupted state — fall back to the seeded defaults
    }
  }

  // -------------------------------------------------------------- tokens

  tokenList(): TokenSeries[] {
    return [...this.universe.tokens.values()];
  }

  token(mint: string): TokenSeries | undefined {
    return this.universe.tokens.get(mint);
  }

  /** last candle index at or before asOf; -1 if token didn't exist yet */
  private idxAt(tok: TokenSeries, asOf: number): number {
    const first = tok.candles[0]?.t ?? Infinity;
    if (asOf < first) return -1;
    const i = Math.floor((asOf - first) / HOUR);
    return Math.min(i, tok.candles.length - 1);
  }

  lastPrice(mint: string, asOf?: number): number | undefined {
    const tok = this.universe.tokens.get(mint);
    if (!tok) return undefined;
    const now = asOf ?? this.simulatedUntil;
    if (!asOf || asOf >= this.universe.genesis) {
      const live = this.livePrice.get(mint);
      if (live && live.ts <= now) return live.price;
    }
    const i = this.idxAt(tok, now);
    return i >= 0 ? tok.candles[i].c : undefined;
  }

  /** deterministic slow-moving structural stats per token per 6h bucket */
  tokenStats(tok: TokenSeries, asOf: number): TokenStats {
    const bucket = Math.floor(asOf / (6 * HOUR));
    const rng = new Rng(hash32(`${tok.info.mint}:${bucket}`));
    const arch = tok.archetype;
    const base = {
      rug: { top10: [0.35, 0.6], organic: [0.12, 0.35], insider: [0.15, 0.3], dev: [0.08, 0.2] },
      fresh: { top10: [0.22, 0.42], organic: [0.35, 0.65], insider: [0.04, 0.12], dev: [0.03, 0.1] },
      moonshot: { top10: [0.14, 0.28], organic: [0.55, 0.85], insider: [0.02, 0.08], dev: [0.01, 0.05] },
      sleeper: { top10: [0.16, 0.3], organic: [0.5, 0.8], insider: [0.02, 0.09], dev: [0.02, 0.06] },
      grinder: { top10: [0.12, 0.25], organic: [0.6, 0.9], insider: [0.01, 0.06], dev: [0.01, 0.04] },
      chopper: { top10: [0.15, 0.32], organic: [0.4, 0.7], insider: [0.02, 0.1], dev: [0.02, 0.07] },
      fader: { top10: [0.2, 0.4], organic: [0.3, 0.6], insider: [0.05, 0.15], dev: [0.03, 0.12] },
    }[arch];
    const i = this.idxAt(tok, asOf);
    const n = tok.candles.length;
    const late = n > 0 ? Math.max(0, Math.min(1, i / n)) : 0;
    // momentum & volume feed social attention
    const mom = i > 24 ? Math.log(tok.candles[i].c / tok.candles[i - 24].c) : 0;
    const volNow = i >= 6 ? tok.candles.slice(i - 5, i + 1).reduce((s, c) => s + c.v, 0) : 0;
    const volBase = i >= 30 ? tok.candles.slice(i - 29, i - 5).reduce((s, c) => s + c.v, 0) / 4 : volNow;
    const volAccel = volBase > 0 ? volNow / volBase : 1;
    const social = Math.max(0.02, Math.min(0.98, 0.18 + mom * 1.6 + Math.log(Math.max(volAccel, 0.2)) * 0.18 + rng.range(-0.06, 0.06)));

    return {
      top10Pct: rng.range(base.top10[0], base.top10[1]) * (arch === "rug" && late > 0.3 ? 1.25 : 1),
      devHoldsPct: rng.range(base.dev[0], base.dev[1]),
      organicScore: Math.min(0.98, rng.range(base.organic[0], base.organic[1])),
      socialScore: social,
      bundlerPct: arch === "fresh" ? rng.range(0.05, 0.22) : rng.range(0.005, 0.08),
      sniperPct: arch === "fresh" ? rng.range(0.04, 0.18) : rng.range(0.005, 0.06),
      insiderPct: rng.range(base.insider[0], base.insider[1]),
      devSold: arch === "rug" ? late > 0.25 : arch === "fader" ? rng.chance(0.4) : rng.chance(0.06),
    };
  }

  snapshot(mint: string, asOf?: number): TokenSnapshot | undefined {
    const tok = this.universe.tokens.get(mint);
    if (!tok) return undefined;
    const now = asOf ?? this.simulatedUntil;
    const i = this.idxAt(tok, now);
    if (i < 0) return undefined;
    const price = this.lastPrice(mint, asOf) ?? tok.candles[i].c;
    const mcap = price * tok.supply;
    const from24 = Math.max(0, i - 23);
    const vol24 = tok.candles.slice(from24, i + 1).reduce((s, c) => s + c.v, 0);
    const stats = this.tokenStats(tok, now);

    // 1h flow counts: derived from candle volume, deterministic per hour
    const hRng = new Rng(hash32(`${mint}:${tok.candles[i].t}`));
    const bar = tok.candles[i];
    const up = bar.c >= bar.o;
    const tradeCount = Math.max(2, Math.round(bar.v / 900));
    const buyShare = up ? hRng.range(0.53, 0.72) : hRng.range(0.3, 0.47);
    const buys = Math.round(tradeCount * buyShare);

    return {
      mint,
      ts: now,
      priceUsd: price,
      marketCapUsd: mcap,
      fdvUsd: mcap,
      liquidityUsd: tok.liquidityUsd[i],
      volume24hUsd: vol24,
      buys1h: buys,
      sells1h: tradeCount - buys,
      uniqueBuyers1h: Math.max(1, Math.round(buys * hRng.range(0.4, 0.8))),
      uniqueSellers1h: Math.max(1, Math.round((tradeCount - buys) * hRng.range(0.4, 0.8))),
      holders: tok.holders[i],
      top10Pct: stats.top10Pct,
      devHoldsPct: stats.devHoldsPct,
      organicScore: stats.organicScore,
      socialScore: stats.socialScore,
      bundlerPct: stats.bundlerPct,
      sniperPct: stats.sniperPct,
      insiderPct: stats.insiderPct,
    };
  }

  snapshots(asOf?: number): TokenSnapshot[] {
    const out: TokenSnapshot[] = [];
    for (const mint of this.universe.tokens.keys()) {
      const s = this.snapshot(mint, asOf);
      if (s) out.push(s);
    }
    return out;
  }

  candles(mint: string, from?: number, to?: number): Candle[] {
    const tok = this.universe.tokens.get(mint);
    if (!tok) return [];
    let arr = tok.candles;
    if (from !== undefined) arr = arr.filter((c) => c.t >= from);
    if (to !== undefined) arr = arr.filter((c) => c.t <= to);
    return arr;
  }

  holdersSeries(mint: string): { ts: number; holders: number; liquidityUsd: number }[] {
    const tok = this.universe.tokens.get(mint);
    if (!tok) return [];
    return tok.candles.map((c, i) => ({ ts: c.t, holders: tok.holders[i], liquidityUsd: tok.liquidityUsd[i] }));
  }

  // -------------------------------------------------------------- wallets

  walletList(): WalletInfo[] {
    return [...this.universe.wallets.values()];
  }

  wallet(address: string): WalletInfo | undefined {
    return this.universe.wallets.get(address);
  }

  walletTrades(address: string, asOf?: number): WalletTrade[] {
    const arr = this.tradesByWallet.get(address) ?? [];
    const live = this.liveTrades.filter((t) => t.wallet === address);
    const all = live.length ? [...arr, ...live] : arr;
    const cut = asOf ?? this.simulatedUntil;
    return all.filter((t) => t.ts <= cut);
  }

  mintTrades(mint: string, from: number, to: number): WalletTrade[] {
    const arr = this.tradesByMint.get(mint) ?? [];
    const base = arr.filter((t) => t.ts >= from && t.ts <= to);
    if (to >= this.universe.genesis) {
      const live = this.liveTrades.filter((t) => t.mint === mint && t.ts >= from && t.ts <= to);
      return [...base, ...live];
    }
    return base;
  }

  // -------------------------------------------------------------- market

  solPrice(asOf?: number): number {
    const now = asOf ?? this.simulatedUntil;
    const path = this.universe.solPath;
    const first = path[0].t;
    const i = Math.max(0, Math.min(path.length - 1, Math.floor((now - first) / HOUR)));
    return path[i].c;
  }

  marketState(asOf?: number): MarketState {
    const now = asOf ?? this.simulatedUntil;
    const snaps = this.snapshots(now);
    const sol = this.solPrice(now);
    const sol24 = this.solPrice(now - DAY);

    // meme momentum index: share of tokens with positive 24h + avg magnitude
    let upCount = 0;
    let momSum = 0;
    let n = 0;
    for (const tok of this.universe.tokens.values()) {
      const i = this.idxAt(tok, now);
      if (i < 24) continue;
      const r = Math.log(tok.candles[i].c / tok.candles[i - 24].c);
      if (r > 0) upCount++;
      momSum += Math.abs(r);
      n++;
    }
    const breadth = n ? upCount / n : 0.5;
    const avgMove = n ? momSum / n : 0;
    const memeIndex = Math.round(Math.max(0, Math.min(100, breadth * 70 + avgMove * 180)));

    // smart money net flow over 24h
    const cut = now - DAY;
    let smFlow = 0;
    const activeWhales = new Set<string>();
    for (const t of [...this.universe.trades, ...this.liveTrades]) {
      if (t.ts < cut || t.ts > now) continue;
      const w = this.universe.wallets.get(t.wallet);
      if (!w) continue;
      if (w.smartMoney.total >= 70) smFlow += t.side === "buy" ? t.amountUsd : -t.amountUsd;
      if (w.labels.includes("whale") || t.amountUsd >= 25_000) activeWhales.add(t.wallet);
    }

    let regime: MarketRegime;
    const solRet = sol24 > 0 ? sol / sol24 - 1 : 0;
    const avgLiq = snaps.reduce((s, x) => s + x.liquidityUsd, 0) / Math.max(1, snaps.length);
    if (memeIndex > 72 && breadth > 0.6) regime = "meme_mania";
    else if (breadth > 0.58 && solRet > 0) regime = "risk_on";
    else if (breadth < 0.34 && solRet < -0.02) regime = "risk_off";
    else if (avgMove > 0.16) regime = "high_volatility";
    else if (avgLiq < 90_000) regime = "low_liquidity";
    else if (breadth < 0.45 && smFlow < 0) regime = "distribution";
    else if (Math.abs(breadth - 0.5) < 0.06 && avgMove > 0.1) regime = "rotation";
    else regime = "neutral";

    return {
      ts: now,
      solPriceUsd: sol,
      solChange24hPct: solRet * 100,
      regime,
      regimeConfidence: Math.min(0.95, 0.45 + Math.abs(breadth - 0.5) * 1.4 + Math.min(0.2, n / 400)),
      memeMomentumIndex: memeIndex,
      netSmartMoneyFlowUsd: smFlow,
      activeWhales24h: activeWhales.size,
      slot: 285_000_000 + Math.floor((now - this.universe.genesis) / 400) + (hash32(String(Math.floor(now / 60000))) % 149),
    };
  }

  // -------------------------------------------------------------- live

  pushEvent(e: LiveEvent) {
    this.events.push(e);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    for (const fn of this.listeners) fn(e);
  }

  onEvent(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recentEvents(limit = 60): LiveEvent[] {
    return this.events.slice(-limit).reverse();
  }

  // -------------------------------------------------------------- seed user state

  private seedUserState() {
    const smart = this.walletList()
      .filter((w) => w.smartMoney.total >= 65)
      .sort((a, b) => b.smartMoney.total - a.smartMoney.total);
    const whales = this.walletList().filter((w) => w.labels.includes("whale"));
    const now = this.universe.genesis;
    this.watchlists = [
      {
        id: this.nextId("wl"),
        name: "Top Smart Money",
        createdAt: now - 6 * DAY,
        items: smart.slice(0, 6).map((w) => ({ kind: "wallet" as const, ref: w.address, addedAt: now - 6 * DAY })),
      },
      {
        id: this.nextId("wl"),
        name: "Meme Whales",
        createdAt: now - 4 * DAY,
        items: whales.slice(0, 5).map((w) => ({ kind: "wallet" as const, ref: w.address, addedAt: now - 4 * DAY })),
      },
    ];
    this.alertRules = [
      {
        id: this.nextId("al"),
        name: "Whale buys over $50K",
        condition: { type: "whale_buy", minUsd: 50_000 },
        channels: ["in_app"],
        enabled: true,
        createdAt: now - 3 * DAY,
      },
      {
        id: this.nextId("al"),
        name: "Signal score crosses 80",
        condition: { type: "signal_score_above", threshold: 80 },
        channels: ["in_app", "browser"],
        enabled: true,
        createdAt: now - 2 * DAY,
      },
    ];
    this.portfolios = [
      {
        id: this.nextId("pf"),
        name: "Main Paper",
        createdAt: now - 7 * DAY,
        startingUsd: 10_000,
        cashUsd: 10_000,
        positions: [],
        orders: [],
        fills: [],
        realizedPnlUsd: 0,
      },
    ];
  }
}

// -------------------------------------------------------------- singleton

declare global {
  var __whalenovaStore: DemoStore | undefined;
}

export function getStore(): DemoStore {
  if (!globalThis.__whalenovaStore) {
    globalThis.__whalenovaStore = new DemoStore(Number(process.env.ROMNOVA_DEMO_SEED ?? 77));
  }
  return globalThis.__whalenovaStore;
}
