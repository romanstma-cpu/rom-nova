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
import { applyFill, newWallet, scoreOf } from "./engine/score.js";
import { RadarState } from "./engine/state.js";
import { clearRadarJournal } from "./journal";
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
  counts: { launches: number; tradesSeen: number; whales: number; journaled: number; signals: number; tracked: number };
  streams: { pump: HunterStream | null; rpc: HunterStream | null };
  helius: HunterHeliusStatus;
  /** What the journal handed back at start — the proof persistence works. */
  hydrated: { wallets: number; fills: number };
  top: HunterWalletRow[];
  signals: (RadarSignalRow & { at: number })[];
  whales: HunterWhale[];
  launches: HunterLaunch[];
  trades: (HunterTrade & { at: number })[];
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
  counts: { launches: 0, tradesSeen: 0, whales: 0, journaled: 0, signals: 0, tracked: 0 },
  streams: { pump: null, rpc: null },
  helius: HELIUS_OFF,
  hydrated: { wallets: 0, fills: 0 },
  top: [],
  signals: [],
  whales: [],
  launches: [],
  trades: [],
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
      : { launches: 0, tradesSeen: 0, whales: 0, journaled: 0, signals: 0, tracked: journalCounts().wallets },
    streams: { pump: streamOf("pump", pumpSock), rpc: streamOf("rpc", rpcSock) },
    helius: heliusStatusOf(),
    hydrated,
    top: state ? (state.top(10) as HunterWalletRow[]) : [],
    signals: [...rings.signals],
    whales: [...rings.whales],
    launches: [...rings.launches],
    trades: [...rings.trades],
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
      emitLiveEvent({
        kind: "radar_signal",
        ts: Date.parse(s.timestamp) || Date.now(),
        wallet: s.wallet_address,
        mint: s.token_address,
        headline: `RADAR SIGNAL · score ${s.wallet_score} wallet bought ${s.buy_amount_sol.toFixed(2)} SOL`,
        detail:
          `${s.token_name ?? s.token_address}: bought by a wallet this radar scored ${s.wallet_score}` +
          ` on ${e.settledSells ?? "?"} settled sells — measured in this browser from its observed pump.fun fills.`,
        real: true,
        source: "radar-hunter",
      });
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

  state = s;
  const cfgLike = { pumpPortalUrl: PUMPPORTAL_URL, rpcWsUrl: RPC_WS_URL };
  pumpSock = startPumpPortal(cfgLike, (launch, at) => {
    state?.onLaunch(launch, at);
  }) as EngineSocket;
  rpcSock = startRpcStream(cfgLike, (t) => {
    state?.onTrade(t);
  }) as EngineSocket;
  restartHelius();
  clock = setInterval(scheduleFlush, CLOCK_MS);
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
