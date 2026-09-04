"use client";

// The Whale Radar's client: one Socket.io connection to the operator's own
// Radar worker, folded into React through the external-store seam.
//
// The worker is the autonomous half of the app — a Node process (worker/ in
// this repo) that watches every pump.fun launch and trade around the clock,
// discovers wallets that enter launches big, scores them from observed fills
// only, and pushes signals. This module holds its feed while the Radar page
// is open, the way the launches page holds PumpPortal: a socket streaming
// into a tab nobody is reading is a battery bug, and the worker persists
// everything to its own database anyway — closing the page loses nothing.
//
// Everything that arrives is treated as data from a user-configured server:
// normalized field by field before it touches state, never executed, never
// trusted to be well-formed.

import { io, type Socket } from "socket.io-client";
import { emitLiveEvent } from "@/lib/live/bus";
import { HORIZON_FIELD, signalKeyOf, type RadarHorizon, type RadarSignalRow } from "./journal";

const CONFIG_KEY = "whalenova_radar_v1";

export interface RadarWalletRow {
  wallet_address: string;
  score: number;
  win_rate: number;
  total_trades: number;
  realized_pnl: number;
  avg_roi: number;
  settled_sells: number;
  unmeasured_sells: number;
  median_hold_ms: number | null;
  follow_ret_5m: number | null;
  follow_hit_rate: number | null;
  signals_graded: number;
  last_active: string;
}

/** One shape with the in-app hunter's rows, so the page renders either plane the same way. */
export type RadarSignal = RadarSignalRow & { at: number };

export interface RadarLaunch {
  mint: string;
  name?: string;
  symbol?: string;
  vSol: number | null;
  at: number;
}

export interface RadarWhale {
  wallet: string;
  mint: string;
  sol: number;
  launchAgeMs: number | null;
  at: number;
}

export interface RadarTrade {
  wallet_address: string;
  token_address: string;
  buy_or_sell: "buy" | "sell";
  amount_sol: number;
  timestamp: string;
  venue: string;
  at: number;
}

export interface RadarState {
  phase: "off" | "connecting" | "connected" | "error";
  url: string;
  enabled: boolean;
  error: string | null;
  health: Record<string, unknown> | null;
  coverage: string | null;
  wallets: RadarWalletRow[];
  signals: RadarSignal[];
  launches: RadarLaunch[];
  whales: RadarWhale[];
  trades: RadarTrade[];
  /** receipt clock for "ago" rendering — ticks in the store, never in render */
  asOf: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readConfig(): { url: string; enabled: boolean } {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CONFIG_KEY);
    if (!raw) return { url: "", enabled: false };
    const p = JSON.parse(raw) as { url?: unknown; enabled?: unknown };
    return { url: str(p.url), enabled: p.enabled === true };
  } catch {
    return { url: "", enabled: false };
  }
}

// Server snapshot must be one stable reference, or hydration loops.
const SERVER_STATE: RadarState = {
  phase: "off",
  url: "",
  enabled: false,
  error: null,
  health: null,
  coverage: null,
  wallets: [],
  signals: [],
  launches: [],
  whales: [],
  trades: [],
  asOf: 0,
};

let state: RadarState = SERVER_STATE;
let socket: Socket | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let holds = 0;
const listeners = new Set<() => void>();

function notify(next: Partial<RadarState>) {
  state = { ...state, ...next, asOf: Date.now() };
  for (const l of listeners) l();
}

function normWallet(w: unknown): RadarWalletRow {
  const o = (w ?? {}) as Record<string, unknown>;
  return {
    wallet_address: str(o.wallet_address),
    score: num(o.score),
    win_rate: num(o.win_rate),
    total_trades: num(o.total_trades),
    realized_pnl: num(o.realized_pnl),
    avg_roi: num(o.avg_roi),
    settled_sells: num(o.settled_sells),
    unmeasured_sells: num(o.unmeasured_sells),
    median_hold_ms: numOrNull(o.median_hold_ms),
    follow_ret_5m: numOrNull(o.follow_ret_5m),
    follow_hit_rate: numOrNull(o.follow_hit_rate),
    signals_graded: num(o.signals_graded),
    last_active: str(o.last_active),
  };
}

function normSignal(s: unknown): RadarSignal {
  const o = (s ?? {}) as Record<string, unknown>;
  const base = {
    wallet_address: str(o.wallet_address),
    wallet_score: num(o.wallet_score),
    token_address: str(o.token_address),
    token_name: typeof o.token_name === "string" ? o.token_name : null,
    buy_amount_sol: num(o.buy_amount_sol),
    timestamp: str(o.timestamp),
  };
  return {
    ...base,
    settled_sells: num(o.settled_sells),
    signal_key: str(o.signal_key) || signalKeyOf(base),
    price_at_signal: numOrNull(o.price_at_signal) ?? undefined,
    ret_1m: numOrNull(o.ret_1m),
    ret_5m: numOrNull(o.ret_5m),
    ret_15m: numOrNull(o.ret_15m),
    ret_1h: numOrNull(o.ret_1h),
    peak_ret_1h: numOrNull(o.peak_ret_1h),
    graded_stale: o.graded_stale === true,
    graded_lookup: o.graded_lookup === true,
    whale_exit_ret: numOrNull(o.whale_exit_ret),
    whale_exit_after_ms: numOrNull(o.whale_exit_after_ms),
    whale_exit_fraction: numOrNull(o.whale_exit_fraction),
    at: Date.parse(str(o.timestamp)) || Date.now(),
  };
}

/** Fold a grade or an exit into the signal it belongs to, by key. */
function patchSignal(key: string, patch: Partial<RadarSignalRow>): void {
  const i = state.signals.findIndex((s) => (s.signal_key ?? signalKeyOf(s)) === key);
  if (i < 0) return;
  notify({ signals: state.signals.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
}

const shortA = (a: string): string => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);
const fmtRet = (r: number): string => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(0)}%`;

function normLaunch(l: unknown): RadarLaunch {
  const o = (l ?? {}) as Record<string, unknown>;
  return {
    mint: str(o.mint),
    name: str(o.name) || undefined,
    symbol: str(o.symbol) || undefined,
    vSol: numOrNull(o.vSol),
    at: num(o.at) || Date.now(),
  };
}

function normWhale(w: unknown): RadarWhale {
  const o = (w ?? {}) as Record<string, unknown>;
  return { wallet: str(o.wallet), mint: str(o.mint), sol: num(o.sol), launchAgeMs: numOrNull(o.launchAgeMs), at: num(o.at) || Date.now() };
}

function normTrade(t: unknown): RadarTrade {
  const o = (t ?? {}) as Record<string, unknown>;
  return {
    wallet_address: str(o.wallet_address),
    token_address: str(o.token_address),
    buy_or_sell: o.buy_or_sell === "sell" ? "sell" : "buy",
    amount_sol: num(o.amount_sol),
    timestamp: str(o.timestamp),
    venue: str(o.venue) || "pumpfun",
    at: Date.parse(str(o.timestamp)) || Date.now(),
  };
}

function healthOf(h: unknown): { health: Record<string, unknown> | null; coverage: string | null } {
  const o = h && typeof h === "object" ? (h as Record<string, unknown>) : null;
  return { health: o, coverage: o && typeof o.coverage === "string" ? o.coverage : null };
}

function openSocket(url: string) {
  closeSocket();
  notify({ phase: "connecting", url, error: null });
  const s = io(url, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelayMax: 15_000,
    timeout: 8_000,
  });
  socket = s;

  s.on("connect", () => notify({ phase: "connected", error: null }));
  s.on("connect_error", (err) => notify({ phase: "error", error: err?.message ? String(err.message) : "connection failed" }));
  s.on("disconnect", (reason) => {
    if (state.enabled) notify({ phase: "connecting", error: String(reason) });
  });

  s.on("snapshot", (snap: unknown) => {
    const o = (snap ?? {}) as Record<string, unknown>;
    notify({
      wallets: Array.isArray(o.wallets) ? o.wallets.map(normWallet) : [],
      signals: Array.isArray(o.signals) ? o.signals.map(normSignal).reverse() : [],
      launches: Array.isArray(o.launches) ? o.launches.map(normLaunch).reverse() : [],
      whales: Array.isArray(o.whales) ? o.whales.map(normWhale).reverse() : [],
      trades: Array.isArray(o.trades) ? o.trades.map(normTrade).reverse() : [],
      ...healthOf(o.status),
    });
  });
  s.on("status", (h: unknown) => notify(healthOf(h)));
  s.on("leaderboard", (rows: unknown) => {
    if (Array.isArray(rows)) notify({ wallets: rows.map(normWallet) });
  });
  s.on("launch", (l: unknown) => notify({ launches: [normLaunch(l), ...state.launches].slice(0, 60) }));
  s.on("whale_seen", (w: unknown) => notify({ whales: [normWhale(w), ...state.whales].slice(0, 60) }));
  s.on("trade", (t: unknown) => notify({ trades: [normTrade(t), ...state.trades].slice(0, 120) }));
  s.on("signal", (raw: unknown) => {
    const sig = normSignal(raw);
    notify({ signals: [sig, ...state.signals].slice(0, 100) });
    // Into the app's live event stream, so the toast rail and activity feed
    // carry it too while the radar is connected.
    emitLiveEvent({
      kind: "radar_signal",
      ts: sig.at,
      mint: sig.token_address,
      wallet: sig.wallet_address,
      headline: `RADAR SIGNAL · score ${sig.wallet_score} wallet bought ${sig.buy_amount_sol.toFixed(2)} SOL`,
      detail:
        `${sig.token_name ?? sig.token_address}: bought by a radar-tracked wallet scoring ${sig.wallet_score}` +
        ` on ${sig.settled_sells ?? "?"} settled sells — measured by your own Radar worker from observed fills.`,
      real: true,
      source: "radar-worker",
    });
  });
  s.on("signal_outcome", (raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const h = str(o.horizon) as RadarHorizon;
    const field = HORIZON_FIELD[h];
    if (!field || !str(o.signal_key)) return;
    const patch: Partial<RadarSignalRow> = { [field]: numOrNull(o.ret), peak_ret_1h: numOrNull(o.peak_ret) };
    if (o.stale === true) patch.graded_stale = true;
    if (o.source === "lookup") patch.graded_lookup = true;
    patchSignal(str(o.signal_key), patch);
  });
  s.on("exit", (raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (!str(o.signal_key) || o.first !== true) return;
    const ret = num(o.ret);
    const fraction = numOrNull(o.fraction);
    patchSignal(str(o.signal_key), {
      whale_exit_ret: ret,
      whale_exit_after_ms: numOrNull(o.after_ms),
      whale_exit_fraction: fraction,
    });
    const afterMs = num(o.after_ms);
    const after = afterMs < 60_000 ? `${Math.round(afterMs / 1000)}s` : `${Math.round(afterMs / 60_000)}m`;
    emitLiveEvent({
      kind: "radar_exit",
      ts: num(o.at) || Date.now(),
      wallet: str(o.wallet),
      mint: str(o.mint),
      headline: `RADAR EXIT · signal wallet sold ${fraction === null ? "some" : `${Math.round(fraction * 100)}%`} at ${fmtRet(ret)}`,
      detail:
        `${shortA(str(o.wallet))} sold ${num(o.sol).toFixed(2)} SOL of ${shortA(str(o.mint))} ${after} after its signal, ` +
        `${fmtRet(ret)} from the signal price — heard by your Radar worker. If you followed, this is the exit the wallet took.`,
      real: true,
      source: "radar-worker",
    });
  });

  if (!clock) clock = setInterval(() => notify({}), 10_000);
}

function closeSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  if (clock) {
    clearInterval(clock);
    clock = null;
  }
}

// ---------------------------------------------------------------------------

export function subscribeRadar(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const radarSnapshot = (): RadarState => state;
export const radarServerSnapshot = (): RadarState => SERVER_STATE;

/** Set the worker URL and connect. Persists intent for the next visit. */
export function radarConnect(rawUrl: string): void {
  const url = rawUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    notify({ phase: "error", error: "the worker URL must start with http:// or https://" });
    return;
  }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, enabled: true }));
  } catch {
    /* still connects for this page load */
  }
  notify({ enabled: true });
  openSocket(url);
}

/** Disconnect and remember the choice. The URL stays for next time. */
export function radarDisconnect(): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: state.url || readConfig().url, enabled: false }));
  } catch {
    /* fine */
  }
  closeSocket();
  notify({ phase: "off", enabled: false, error: null });
}

/**
 * Page-mount hold: connects when the stored intent says to, releases the
 * socket when the last holder leaves. Returns the release.
 */
export function holdRadar(): () => void {
  holds++;
  if (holds === 1) {
    const cfg = readConfig();
    if (state.phase === "off") notify({ url: cfg.url, enabled: cfg.enabled });
    if (cfg.enabled && cfg.url) openSocket(cfg.url);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) {
      closeSocket();
      if (state.phase !== "off") notify({ phase: state.enabled ? "off" : state.phase });
    }
  };
}
