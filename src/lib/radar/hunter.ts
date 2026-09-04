"use client";

// The in-app hunter: the Radar engine running inside ROM Nova itself.
//
// Same pipeline as the deployable worker — the engine under ./engine/ IS the
// worker's engine, one implementation, two drivers — wired to browser organs
// instead of server ones: IndexedDB where the worker has Supabase, the live
// event bus where it has Socket.io, and this store where it has /health.
// Arm it once and the app discovers whale wallets at launch, journals every
// fill they make on the pump.fun curve, scores them from observed round
// trips, and fires a signal when a proven one buys again. The evidence
// persists; scores are replayed from it on every start.
//
// THE BANDWIDTH THIS BUYS, SAID PLAINLY
//
// The trade stream is one program-wide logsSubscribe — the thing rpc-ws.ts
// refuses on principle, and its principle stands: for extracting a couple of
// per-account events a minute, a firehose is waste. The hunter is the
// opposite case: it decodes and uses EVERY frame (that is what whale
// discovery over all wallets means), so the stream buys the product. It is
// still ~0.3–0.6 MB/s while armed (probed 2026-09-01 and 2026-09-03, quiet
// hour vs busy), which is why hunting is an explicit switch with the
// measured rate printed beside it, never a default. Each open tab hunts on
// its own socket; the journal deduplicates their writes by signature.

import { emitLiveEvent } from "@/lib/live/bus";
import { isSignalBuy } from "./engine/classify.js";
import { HeliusStream } from "./engine/helius.js";
import { startPumpPortal } from "./engine/pumpportal.js";
import { startRpcStream } from "./engine/rpcstream.js";
import { applyFill, applyFollowGrade, newWallet, scoreOf } from "./engine/score.js";
import { RadarState } from "./engine/state.js";
import { lookupSolPrices } from "./engine/pricelookup.js";
import { clearRadarJournal, HORIZON_FIELD, journalSignalPatch, signalKeyOf, type RadarHorizon } from "./journal";
import { deliverRadarNotification } from "@/lib/alerts/notify";
import {
  journalCounts,
  journalFill,
  journalSignal,
  journalSignals,
  journalWallets,
  radarBackendName,
  radarJournalReady,
  type RadarSignalRow,
} from "./journal";

// The same endpoints live/pumpportal.ts and live/rpc-ws.ts hold — repeated
// here as constants so the hunter's bundle does not drag in the launch feed
// and the alert cadence with it.
const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";
const RPC_WS_URL = "wss://solana-rpc.publicnode.com";

const CONFIG_KEY = "whalenova_radar_hunt_v1";
const HELIUS_KEY = "whalenova_radar_helius_v1";
const FLUSH_MS = 500;
const CLOCK_MS = 5_000;
/** Top-scored wallets the optional Helius stream follows off the curve. */
const HELIUS_WALLET_SUBS = 20;
/** Helius getTransaction budget, req/s — free tier allows 10; leave headroom. */
const HELIUS_RPS = 6;

export interface HunterGates {
  whaleThresholdSol: number;
  whaleWindowMs: number;
  signalMinScore: number;
  signalMinSettled: number;
  signalMinBuySol: number;
}

/** Production gates. Only the discovery threshold is a knob. */
export const HUNTER_DEFAULTS: HunterGates = {
  whaleThresholdSol: 10,
  whaleWindowMs: 10 * 60_000,
  signalMinScore: 70,
  signalMinSettled: 3,
  signalMinBuySol: 1,
};
export const THRESHOLD_CHOICES = [5, 10, 20] as const;
const MAX_TRACKED = 200;

export interface HunterStream {
  connected: boolean;
  connects: number;
  frames: number;
  bytes: number;
  /** Measured over the interval since the last flush that sampled it. */
  kbps: number;
  lastFrameAgoMs: number | null;
}

export interface HunterWalletRow {
  wallet_address: string;
  score: number;
  win_rate: number;
  total_trades: number;
  realized_pnl: number;
  avg_roi: number;
  settled_sells: number;
  unmeasured_sells: number;
  /** labels earned from measured fills: sniper, flipper, holder, accumulator, distributor, wash-like, dev */
  labels: string[];
  /** mean over spread of per-trade ROI — the shape of a Sharpe ratio on settled sells, not annualized */
  consistency: number | null;
  max_drawdown_sol: number;
  avg_hold_ms: number | null;
  /** median settled hold, ms — how long a copier has before this wallet is out */
  median_hold_ms: number | null;
  /** median of what its signals were worth five minutes later, as a fraction */
  follow_ret_5m: number | null;
  follow_hit_rate: number | null;
  signals_graded: number;
  last_active: string;
}

export interface HunterWhale {
  wallet: string;
  mint: string;
  sol: number;
  launchAgeMs: number | null;
  at: number;
}

export interface HunterTrade {
  wallet_address: string;
  token_address: string;
  buy_or_sell: "buy" | "sell";
  amount_sol: number;
  timestamp: string;
}

export interface HunterBehaviour {
  behaviour: "dormant_buy" | "accumulation" | "distribution" | "wash_like";
  wallet: string;
  mint: string;
  sol: number;
  detail: string;
  at: number;
}

export interface HunterLaunch {
  mint: string;
  name?: string;
  symbol?: string;
  vSol: number | null;
  at: number;
}

export interface HunterHeliusStatus {
  /** A key is saved in this browser. */
  keySet: boolean;
  /** The stream is running (hunting + key). */
  active: boolean;
  connected: boolean;
  following: number;
  txFetches: number;
  txErrors: number;
  offCurveFills: number;
}

export interface HunterSnapshot {
  running: boolean;
  phase: "off" | "starting" | "hunting";
  backend: "indexeddb" | "memory";
  gates: HunterGates;
  counts: {
    launches: number;
    tradesSeen: number;
    whales: number;
    journaled: number;
    signals: number;
    graded: number;
    exits: number;
    behaviours: number;
    tracked: number;
  };
  streams: { pump: HunterStream | null; rpc: HunterStream | null };
  helius: HunterHeliusStatus;
  /** What the journal handed back at start — the proof persistence works. */
  hydrated: { wallets: number; fills: number };
  top: HunterWalletRow[];
  signals: (RadarSignalRow & { at: number })[];
  whales: HunterWhale[];
  launches: HunterLaunch[];
  trades: (HunterTrade & { at: number })[];
  /** What tracked wallets are doing: the reads that fired this session. */
  behaviours: HunterBehaviour[];
  /** Last trade seen on each pinned mint — the copy desk's live marks. */
  prices: Record<string, { priceSol: number; at: number }>;
  asOf: number;
}

const HELIUS_OFF: HunterHeliusStatus = {
  keySet: false,
  active: false,
  connected: false,
  following: 0,
  txFetches: 0,
  txErrors: 0,
  offCurveFills: 0,
};

const SERVER_SNAPSHOT: HunterSnapshot = {
  running: false,
  phase: "off",
  backend: "memory",
  gates: HUNTER_DEFAULTS,
  counts: { launches: 0, tradesSeen: 0, whales: 0, journaled: 0, signals: 0, graded: 0, exits: 0, behaviours: 0, tracked: 0 },
  streams: { pump: null, rpc: null },
  helius: HELIUS_OFF,
  hydrated: { wallets: 0, fills: 0 },
  top: [],
  signals: [],
  whales: [],
  launches: [],
  trades: [],
  behaviours: [],
  prices: {},
  asOf: 0,
};

interface EngineSocket {
  stop(): void;
  status(): { connected: boolean; connects: number; frames: number; bytes?: number; lastFrameAgoMs: number | null };
}

// ------------------------------------------------------------------- state

let snapshot: HunterSnapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();

let state: InstanceType<typeof RadarState> | null = null;
let pumpSock: EngineSocket | null = null;
let rpcSock: EngineSocket | null = null;
let helius: InstanceType<typeof HeliusStream> | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let startSeq = 0;

// Mutable buffers between flushes; the immutable snapshot is built from them.
const rings = {
  signals: [] as (RadarSignalRow & { at: number })[],
  whales: [] as HunterWhale[],
  launches: [] as HunterLaunch[],
  trades: [] as (HunterTrade & { at: number })[],
  behaviours: [] as HunterBehaviour[],
};
let hydrated = { wallets: 0, fills: 0 };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function hunterConfig(): { on: boolean; thresholdSol: number } {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CONFIG_KEY);
    if (!raw) return { on: false, thresholdSol: HUNTER_DEFAULTS.whaleThresholdSol };
    const p = JSON.parse(raw) as { on?: unknown; thresholdSol?: unknown };
    const t = typeof p.thresholdSol === "number" && (THRESHOLD_CHOICES as readonly number[]).includes(p.thresholdSol)
      ? p.thresholdSol
      : HUNTER_DEFAULTS.whaleThresholdSol;
    return { on: p.on === true, thresholdSol: t };
  } catch {
    return { on: false, thresholdSol: HUNTER_DEFAULTS.whaleThresholdSol };
  }
}

function saveConfig(cfg: { on: boolean; thresholdSol: number }): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* still applies for this page load */
  }
}

// ------------------------------------------------------- optional Helius key
//
// Stored in this browser alone (same contract as the AI key on settings),
// sent to helius-rpc.com and nowhere else — it rides the WebSocket URL and
// the RPC POSTs because that is Helius's own auth scheme. What it buys: the
// program firehose goes blind when a token migrates off the bonding curve;
// with a key the hunter also follows its top-scored wallets' transactions
// on every venue, so a proven wallet's record keeps growing after
// graduation instead of freezing at the curve's edge.

export function heliusKeyValue(): string {
  try {
    return typeof localStorage === "undefined" ? "" : (localStorage.getItem(HELIUS_KEY) ?? "");
  } catch {
    return "";
  }
}

/** Helius keys are UUIDs. Loose on purpose — the live stream is the real test. */
export function looksLikeHeliusKey(k: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k.trim());
}

export function maskHeliusKey(k: string): string {
  return k.length <= 8 ? "····" : `${k.slice(0, 4)}····${k.slice(-4)}`;
}

/** Save (or clear, with "") and apply live — the Helius leg restarts alone;
 * the firehose and the journal never notice. */
export function setHeliusKey(raw: string): void {
  const key = raw.trim();
  try {
    if (key) localStorage.setItem(HELIUS_KEY, key);
    else localStorage.removeItem(HELIUS_KEY);
  } catch {
    /* applies for this page load regardless */
  }
  restartHelius();
  scheduleFlush();
}

function restartHelius(): void {
  helius?.stop();
  helius = null;
  const key = heliusKeyValue();
  if (!state || !key) return;
  const h = new HeliusStream(
    { heliusApiKey: key, heliusWalletSubs: HELIUS_WALLET_SUBS, heliusRps: HELIUS_RPS },
    () => state?.top(HELIUS_WALLET_SUBS).map((w: { wallet_address: string }) => w.wallet_address) ?? [],
    (t) => {
      state?.onTrade(t);
    },
  );
  h.start();
  helius = h;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

/** How often the hunter asks DexScreener for marks the stream cannot give. */
const LOOKUP_EVERY_MS = 10_000;
let lookupBusy = false;
let lastLookupAt = 0;

/**
 * The clock. Every few seconds: if any grading horizon has passed with no
 * trade since, or a followed mint has gone quiet, fetch those prices off
 * the curve first, then let the tick mark whatever is still unanswered.
 */
function tickClock(): void {
  const now = Date.now();
  if (state && !lookupBusy && now - lastLookupAt >= LOOKUP_EVERY_MS) {
    const wanted = state.marksWanted(now);
    if (wanted.length > 0) {
      lookupBusy = true;
      lastLookupAt = now;
      void lookupSolPrices(wanted)
        .then((marks) => {
          for (const [mint, m] of marks) state?.markExternal(mint, m.priceSol, m.at);
        })
        .finally(() => {
          lookupBusy = false;
          state?.tick(Date.now());
          scheduleFlush();
        });
      return;
    }
  }
  state?.tick(now);
  scheduleFlush();
}

/** A signal whose launch this tab never saw has no name; DexScreener usually does. */
function enrichSignalName(key: string, mint: string): void {
  void lookupSolPrices([mint]).then((marks) => {
    const name = marks.get(mint)?.name;
    if (!name) return;
    const patch: Partial<RadarSignalRow> = { token_name: name };
    journalSignalPatch(key, patch);
    const i = rings.signals.findIndex((r) => (r.signal_key ?? signalKeyOf(r)) === key);
    if (i >= 0) rings.signals[i] = { ...rings.signals[i], ...patch };
    scheduleFlush();
  });
}

// ------------------------------------------------------------ the desk

/**
 * Mints whose last price the reader wants kept — their own follows. Held
 * here as well as in the engine so a pin survives a disarm and re-arm, and
 * so pinning before the first arm is not lost.
 */
const pinned = new Set<string>();

export function pinMint(mint: string, on: boolean): void {
  if (!mint) return;
  if (on) pinned.add(mint);
  else pinned.delete(mint);
  state?.pinMint(mint, on);
  scheduleFlush();
}

export function lastPriceOf(mint: string): { priceSol: number; at: number } | null {
  return state?.lastPrice(mint) ?? null;
}

function pricesOf(): Record<string, { priceSol: number; at: number }> {
  const out: Record<string, { priceSol: number; at: number }> = {};
  if (!state) return out;
  for (const m of pinned) {
    const p = state.lastPrice(m);
    if (p) out[m] = p;
  }
  return out;
}

const shortA = (a: string): string => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);
const fmtRet = (r: number): string => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(0)}%`;
const fmtAfter = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

/** byte counters at the previous flush, keyed by stream, for the rate. */
const rateSamples = new Map<string, { at: number; bytes: number }>();

function streamOf(name: string, sock: EngineSocket | null): HunterStream | null {
  if (!sock) {
    rateSamples.delete(name);
    return null;
  }
  const s = sock.status();
  const bytes = s.bytes ?? 0;
  const now = Date.now();
  const prev = rateSamples.get(name);
  // Sampled no more often than once a second so a burst of flushes cannot
  // divide a few bytes by a few milliseconds into nonsense.
  let kbps = 0;
  if (prev && now - prev.at >= 1_000) {
    kbps = ((bytes - prev.bytes) / (now - prev.at)) * (1000 / 1024);
    rateSamples.set(name, { at: now, bytes });
  } else if (!prev) {
    rateSamples.set(name, { at: now, bytes });
  } else {
    kbps = snapshot.streams[name === "pump" ? "pump" : "rpc"]?.kbps ?? 0;
  }
  return {
    connected: s.connected,
    connects: s.connects,
    frames: s.frames,
    bytes,
    kbps: Math.max(0, Math.round(kbps * 10) / 10),
    lastFrameAgoMs: s.lastFrameAgoMs,
  };
}

function heliusStatusOf(): HunterHeliusStatus {
  const keySet = heliusKeyValue() !== "";
  if (!helius) return { ...HELIUS_OFF, keySet };
  const s = helius.status() as {
    enabled: boolean;
    socket?: { connected?: boolean } | null;
    following?: number;
    txFetches?: number;
    txErrors?: number;
    offCurveFills?: number;
  };
  return {
    keySet,
    active: s.enabled === true,
    connected: s.socket?.connected === true,
    following: s.following ?? 0,
    txFetches: s.txFetches ?? 0,
    txErrors: s.txErrors ?? 0,
    offCurveFills: s.offCurveFills ?? 0,
  };
}

/** Rebuild the immutable snapshot from the buffers. At most twice a second —
 * the trade stream would otherwise render this app at 220fps. */
function flush(): void {
  flushTimer = null;
  const running = state !== null;
  snapshot = {
    running,
    phase: running ? "hunting" : snapshot.phase === "starting" ? "starting" : "off",
    backend: radarBackendName(),
    gates: state ? (state.gates as HunterGates) : { ...HUNTER_DEFAULTS, whaleThresholdSol: hunterConfig().thresholdSol },
    counts: state
      ? { ...state.counts, tracked: state.tracked.size }
      : { launches: 0, tradesSeen: 0, whales: 0, journaled: 0, signals: 0, graded: 0, exits: 0, behaviours: 0, tracked: journalCounts().wallets },
    streams: { pump: streamOf("pump", pumpSock), rpc: streamOf("rpc", rpcSock) },
    helius: heliusStatusOf(),
    hydrated,
    top: state ? (state.top(10) as HunterWalletRow[]) : [],
    signals: [...rings.signals],
    whales: [...rings.whales],
    launches: [...rings.launches],
    trades: [...rings.trades],
    behaviours: [...rings.behaviours],
    prices: pricesOf(),
    asOf: Date.now(),
  };
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* one broken listener must not stop the rest */
    }
  }
}

// ------------------------------------------------------------------ effects

function onEffect(e: {
  kind: string;
  launch?: { mint: string; name?: string; symbol?: string; vSol?: number | null; at: number };
  wallet?: string;
  mint?: string;
  sol?: number;
  launchAgeMs?: number | null;
  at?: number;
  trade?: HunterTrade & { price_at_trade: number; signature: string | null };
  signal?: RadarSignalRow;
  settledSells?: number;
  // signal_outcome and exit
  signal_key?: string;
  horizon?: RadarHorizon;
  ret?: number;
  peak_ret?: number;
  price_sol?: number;
  stale?: boolean;
  source?: "stream" | "lookup" | "last-mark";
  done?: boolean;
  fraction?: number | null;
  first?: boolean;
  after_ms?: number;
  // behaviour
  behaviour?: HunterBehaviour["behaviour"];
  read?: { gapMs?: number; buys?: number; sells?: number; legs?: number };
}): void {
  switch (e.kind) {
    case "launch": {
      const l = e.launch!;
      rings.launches.unshift({ mint: l.mint, name: l.name, symbol: l.symbol, vSol: l.vSol ?? null, at: l.at });
      rings.launches.splice(60);
      break;
    }
    case "whale": {
      rings.whales.unshift({
        wallet: e.wallet!,
        mint: e.mint!,
        sol: e.sol!,
        launchAgeMs: e.launchAgeMs ?? null,
        at: e.at ?? Date.now(),
      });
      rings.whales.splice(60);
      // Feed-visible, never a toast: discoveries are context, the signal is
      // the alert.
      emitLiveEvent({
        kind: "radar_whale",
        ts: e.at ?? Date.now(),
        wallet: e.wallet,
        mint: e.mint,
        headline: `RADAR · WHALE ENTERED · ${e.sol!.toFixed(1)} SOL`,
        detail:
          `${str(e.wallet).slice(0, 4)}… bought ${e.sol!.toFixed(2)} SOL of ${str(e.mint).slice(0, 4)}… ` +
          `${e.launchAgeMs != null ? Math.max(0, Math.round(e.launchAgeMs / 1000)) + "s" : "moments"} after launch. ` +
          "Now tracked: every pump.fun fill it makes will be journaled and scored from observed round trips.",
        real: true,
        source: "radar-hunter",
      });
      break;
    }
    case "trade": {
      const t = e.trade!;
      const w = state?.tracked.get(t.wallet_address);
      const sol = t.amount_sol;
      const price = t.price_at_trade;
      journalFill(
        t.wallet_address,
        {
          mint: t.token_address,
          isBuy: t.buy_or_sell === "buy",
          sol,
          tokens: price > 0 ? sol / price : 0,
          ts: Date.parse(t.timestamp) || Date.now(),
          sig: t.signature ?? undefined,
        },
        w?.firstSeen ?? Date.now(),
      );
      rings.trades.unshift({
        wallet_address: t.wallet_address,
        token_address: t.token_address,
        buy_or_sell: t.buy_or_sell,
        amount_sol: t.amount_sol,
        timestamp: t.timestamp,
        at: Date.parse(t.timestamp) || Date.now(),
      });
      rings.trades.splice(120);
      break;
    }
    case "signal": {
      const s = e.signal!;
      journalSignal(s);
      rings.signals.unshift({ ...s, at: Date.parse(s.timestamp) || Date.now() });
      rings.signals.splice(100);
      const headline = `RADAR SIGNAL · score ${s.wallet_score} wallet bought ${s.buy_amount_sol.toFixed(2)} SOL`;
      const detail =
        `${s.token_name ?? s.token_address}: bought by a wallet this radar scored ${s.wallet_score}` +
        ` on ${e.settledSells ?? "?"} settled sells — measured in this browser from its observed pump.fun fills.`;
      emitLiveEvent({
        kind: "radar_signal",
        ts: Date.parse(s.timestamp) || Date.now(),
        wallet: s.wallet_address,
        mint: s.token_address,
        headline,
        detail,
        real: true,
        source: "radar-hunter",
      });
      deliverRadarNotification(headline, detail, s.signal_key ?? signalKeyOf(s));
      if (!s.token_name) enrichSignalName(s.signal_key ?? signalKeyOf(s), s.token_address);
      break;
    }
    case "signal_outcome": {
      const key = e.signal_key!;
      const field = HORIZON_FIELD[e.horizon!];
      const patch: Partial<RadarSignalRow> = { [field]: e.ret ?? null, peak_ret_1h: e.peak_ret ?? null };
      if (e.stale) patch.graded_stale = true;
      if (e.source === "lookup") patch.graded_lookup = true;
      journalSignalPatch(key, patch);
      const i = rings.signals.findIndex((r) => (r.signal_key ?? signalKeyOf(r)) === key);
      if (i >= 0) rings.signals[i] = { ...rings.signals[i], ...patch };
      break;
    }
    case "exit": {
      const key = e.signal_key!;
      if (e.first) {
        const patch: Partial<RadarSignalRow> = {
          whale_exit_ret: e.ret ?? null,
          whale_exit_after_ms: e.after_ms ?? null,
          whale_exit_fraction: e.fraction ?? null,
        };
        journalSignalPatch(key, patch);
        const i = rings.signals.findIndex((r) => (r.signal_key ?? signalKeyOf(r)) === key);
        if (i >= 0) rings.signals[i] = { ...rings.signals[i], ...patch };
        const sold = e.fraction === null || e.fraction === undefined ? "some" : `${Math.round(e.fraction * 100)}%`;
        const headline = `RADAR EXIT · signal wallet sold ${sold} at ${fmtRet(e.ret ?? 0)}`;
        const detail =
          `${shortA(str(e.wallet))} sold ${(e.sol ?? 0).toFixed(2)} SOL of ${shortA(str(e.mint))} ${fmtAfter(e.after_ms ?? 0)} after its signal, ` +
          `${fmtRet(e.ret ?? 0)} from the signal price. If you followed, this is the exit the wallet took.`;
        emitLiveEvent({
          kind: "radar_exit",
          ts: e.at ?? Date.now(),
          wallet: e.wallet,
          mint: e.mint,
          headline,
          detail,
          real: true,
          source: "radar-hunter",
        });
        deliverRadarNotification(headline, detail, `${key}:exit`);
      }
      break;
    }
    case "behaviour": {
      const kind = e.behaviour!;
      const r = e.read ?? {};
      const detail =
        kind === "dormant_buy"
          ? `quiet for ${fmtAfter(r.gapMs ?? 0)}, then bought ${(e.sol ?? 0).toFixed(2)} SOL of ${shortA(str(e.mint))}`
          : kind === "accumulation"
            ? `${r.buys ?? 0} buys of ${shortA(str(e.mint))} with no sell — building a position`
            : kind === "distribution"
              ? `${r.sells ?? 0} sells of ${shortA(str(e.mint))} with no buy in sight — unloading`
              : `${r.legs ?? 0} alternating legs on ${shortA(str(e.mint))} inside ten minutes, ending flat — volume, not conviction`;
      rings.behaviours.unshift({ behaviour: kind, wallet: str(e.wallet), mint: str(e.mint), sol: e.sol ?? 0, detail, at: e.at ?? Date.now() });
      rings.behaviours.splice(80);
      // Two of the four are worth interrupting for: a dormant wallet waking
      // up big, and a wash pattern that says a chart is being painted.
      if (kind === "dormant_buy" || kind === "wash_like") {
        const headline = kind === "dormant_buy" ? "RADAR · DORMANT WALLET WOKE UP" : "RADAR · WASH-LIKE TRADING";
        const text = `${shortA(str(e.wallet))}: ${detail}.`;
        emitLiveEvent({ kind: "radar_behaviour", ts: e.at ?? Date.now(), wallet: e.wallet, mint: e.mint, headline, detail: text, real: true, source: "radar-hunter" });
        if (kind === "dormant_buy") deliverRadarNotification(headline, text, `${str(e.wallet)}:${str(e.mint)}:dormant`);
      }
      break;
    }
    // "wallet" effects only move the leaderboard, which the flush recomputes.
  }
  scheduleFlush();
}

// ---------------------------------------------------------------- lifecycle

/** Arm and start hunting. Idempotent; persists the intent. */
export async function startHunting(thresholdSol?: number): Promise<void> {
  const cfg = hunterConfig();
  const threshold = thresholdSol ?? cfg.thresholdSol;
  saveConfig({ on: true, thresholdSol: threshold });
  if (state) return;
  const seq = ++startSeq;
  snapshot = { ...snapshot, phase: "starting" };
  scheduleFlush();

  await radarJournalReady();
  // A stop (or another start) that happened while the disk loaded wins.
  if (seq !== startSeq || state) return;

  const gates: HunterGates = { ...HUNTER_DEFAULTS, whaleThresholdSol: threshold };
  const s = new RadarState(gates, MAX_TRACKED, onEffect);

  // Replay the journal: evidence in, scores out. A wallet proven before the
  // reload walks back in proven.
  let fills = 0;
  for (const rec of journalWallets().values()) {
    const w = newWallet(rec.firstSeen);
    for (const f of rec.fills) {
      applyFill(w, { mint: f.mint, isBuy: f.isBuy, sol: f.sol, tokens: f.tokens, ts: f.ts });
      fills++;
    }
    s.tracked.set(rec.address, w);
  }
  hydrated = { wallets: journalWallets().size, fills };
  rings.signals = journalSignals().map((row) => ({ ...row, at: Date.parse(row.timestamp) || 0 }));

  // The journaled grades walk back in too, so a wallet's follower return
  // survives a reload the way its score does — and any signal young enough
  // to still be grading, or still waiting for its wallet to sell, resumes.
  const now = Date.now();
  for (const row of journalSignals()) {
    const w = s.tracked.get(row.wallet_address);
    if (w && typeof row.ret_5m === "number") applyFollowGrade(w, row.ret_5m);
    const at = Date.parse(row.timestamp);
    if (!at || !(typeof row.price_at_signal === "number" && row.price_at_signal > 0)) continue;
    const resolved = {
      m1: typeof row.ret_1m === "number",
      m5: typeof row.ret_5m === "number",
      m15: typeof row.ret_15m === "number",
      h1: typeof row.ret_1h === "number",
    };
    const stillGrading = Object.values(resolved).some((v) => !v) && now - at < 2 * 3_600_000;
    const exited = typeof row.whale_exit_ret === "number";
    const watchExit = !exited && now - at < 24 * 3_600_000;
    if (!stillGrading && !watchExit) continue;
    s.registerSignal(
      { signal_key: row.signal_key ?? signalKeyOf(row), wallet_address: row.wallet_address, token_address: row.token_address },
      at,
      row.price_at_signal,
      {
        resolved: stillGrading ? resolved : { m1: true, m5: true, m15: true, h1: true },
        exited: !watchExit,
        peak: row.price_at_signal * (1 + (typeof row.peak_ret_1h === "number" ? row.peak_ret_1h : 0)),
      },
    );
  }
  for (const m of pinned) s.pinMint(m, true);

  state = s;
  const cfgLike = { pumpPortalUrl: PUMPPORTAL_URL, rpcWsUrl: RPC_WS_URL };
  pumpSock = startPumpPortal(cfgLike, (launch, at) => {
    state?.onLaunch(launch, at);
  }) as EngineSocket;
  rpcSock = startRpcStream(cfgLike, (t) => {
    state?.onTrade(t);
  }) as EngineSocket;
  restartHelius();
  clock = setInterval(tickClock, CLOCK_MS);
  scheduleFlush();
}

/** Disarm. The journal keeps everything; the sockets close now. */
export function stopHunting(): void {
  saveConfig({ on: false, thresholdSol: hunterConfig().thresholdSol });
  startSeq++;
  pumpSock?.stop();
  rpcSock?.stop();
  helius?.stop();
  pumpSock = null;
  rpcSock = null;
  helius = null;
  state = null;
  if (clock) clearInterval(clock);
  clock = null;
  snapshot = { ...snapshot, phase: "off" };
  scheduleFlush();
}

/** Change the discovery threshold. Applies live by restarting the pipeline —
 * tracked wallets survive (they replay from the journal). */
export async function setHunterThreshold(thresholdSol: number): Promise<void> {
  const was = state !== null;
  saveConfig({ on: hunterConfig().on, thresholdSol });
  if (was) {
    stopHunting();
    await startHunting(thresholdSol);
  } else {
    scheduleFlush();
  }
}

/**
 * Forget every wallet, fill and signal the radar has journaled. A running
 * hunt restarts from zero with the same threshold; the switch position is
 * kept. Returns whether the disk copy was cleared too (see the journal).
 */
export async function forgetRadarJournal(): Promise<boolean> {
  const was = state !== null || snapshot.phase === "starting";
  const threshold = hunterConfig().thresholdSol;
  if (was) stopHunting();
  const ok = await clearRadarJournal();
  rings.signals = [];
  rings.whales = [];
  rings.launches = [];
  rings.trades = [];
  hydrated = { wallets: 0, fills: 0 };
  if (was) await startHunting(threshold);
  else scheduleFlush();
  return ok;
}

/** Called once by the shell: resume hunting when the stored intent says so. */
export function resumeHuntingIfArmed(): void {
  if (hunterConfig().on && !state) void startHunting();
}

// ---------------------------------------------------------------- reactive

export function subscribeHunter(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const hunterSnapshot = (): HunterSnapshot => snapshot;
export const hunterServerSnapshot = (): HunterSnapshot => SERVER_SNAPSHOT;

/** For a quick sanity check in tests: whether the pipe would fire right now. */
export function wouldSignal(trade: { isBuy: boolean; sol: number }, wallet: string): boolean {
  const w = state?.tracked.get(wallet);
  if (!state || !w) return false;
  return isSignalBuy(trade, { score: scoreOf(w), settledSells: w.settledSells }, state.gates);
}

/** Test seam. */
export function resetHunter(): void {
  stopHunting();
  rings.signals = [];
  rings.whales = [];
  rings.launches = [];
  rings.trades = [];
  hydrated = { wallets: 0, fills: 0 };
  snapshot = SERVER_SNAPSHOT;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
