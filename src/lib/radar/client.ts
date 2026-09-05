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
import { accessToken } from "@/lib/account/auth";
import { emitLiveEvent } from "@/lib/live/bus";
import { HORIZON_FIELD, signalKeyOf, type RadarHorizon, type RadarSignalRow } from "./journal";

const CONFIG_KEY = "whalenova_radar_v1";

/**
 * Why a worker refused this connection, when it did — keyed on the status
 * the worker's gate sends: 401 wants a sign-in, 402 wants a subscription,
 * 503 could not check right now and will be retried.
 */
export type RadarGate = "signin" | "subscribe" | "unavailable" | null;

export interface RadarWalletRow {
  wallet_address: string;
  score: number;
  win_rate: number;
  total_trades: number;
  realized_pnl: number;
  avg_roi: number;
  settled_sells: number;
  unmeasured_sells: number;
  labels: string[];
  consistency: number | null;
  max_drawdown_sol: number;
  avg_hold_ms: number | null;
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

export interface RadarBehaviour {
  behaviour: string;
  wallet: string;
  mint: string;
  sol: number;
  detail: string;
  at: number;
}

export interface RadarState {
  phase: "off" | "connecting" | "connected" | "error";
  url: string;
  enabled: boolean;
  error: string | null;
  gate: RadarGate;
  health: Record<string, unknown> | null;
  coverage: string | null;
  wallets: RadarWalletRow[];
  signals: RadarSignal[];
  launches: RadarLaunch[];
  whales: RadarWhale[];
  trades: RadarTrade[];
  behaviours: RadarBehaviour[];
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
  gate: null,
  health: null,
  coverage: null,
  wallets: [],
  signals: [],
  launches: [],
  whales: [],
  trades: [],
  behaviours: [],
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
    labels: Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === "string") : [],
    consistency: numOrNull(o.consistency),
    max_drawdown_sol: num(o.max_drawdown_sol),
    avg_hold_ms: numOrNull(o.avg_hold_ms),
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
    launch_age_ms: numOrNull(o.launch_age_ms),
    model_p: numOrNull(o.model_p),
    model_version: typeof o.model_version === "string" ? o.model_version : null,
    followers: num(o.followers),
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

/** A behaviour read, with the sentence the app prints for it. */
function normBehaviour(b: unknown): RadarBehaviour {
  const o = (b ?? {}) as Record<string, unknown>;
  const kind = str(o.behaviour);
  const r = (o.read ?? {}) as Record<string, unknown>;
  const mint = str(o.mint);
  const detail =
    kind === "dormant_buy"
      ? `quiet for ${Math.round(num(r.gapMs) / 86_400_000)}d, then bought ${num(o.sol).toFixed(2)} SOL of ${shortA(mint)}`
      : kind === "accumulation"
        ? `${num(r.buys)} buys of ${shortA(mint)} with no sell: building a position`
        : kind === "distribution"
          ? `${num(r.sells)} sells of ${shortA(mint)} with no buy in sight: unloading`
          : `${num(r.legs)} alternating legs on ${shortA(mint)} inside ten minutes, ending flat: volume, not conviction`;
  return { behaviour: kind, wallet: str(o.wallet), mint, sol: num(o.sol), detail, at: num(o.at) || Date.now() };
}

function healthOf(h: unknown): { health: Record<string, unknown> | null; coverage: string | null } {
  const o = h && typeof h === "object" ? (h as Record<string, unknown>) : null;
  return { health: o, coverage: o && typeof o.coverage === "string" ? o.coverage : null };
}

function openSocket(url: string) {
  closeSocket();
  notify({ phase: "connecting", url, error: null, gate: null });
  const s = io(url, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelayMax: 15_000,
    timeout: 8_000,
    // The account's token, fetched fresh for every attempt: a worker with a
    // gate reads it at the handshake, an open one ignores it. The function
    // form means a reconnect after a refresh carries the new token.
    auth: (cb) => {
      accessToken()
        .then((t) => cb(t ? { token: t } : {}))
        .catch(() => cb({}));
    },
  });
  socket = s;

  s.on("connect", () => notify({ phase: "connected", error: null, gate: null }));
  s.on("connect_error", (err) => {
    const status = (err as { data?: { status?: unknown } }).data?.status;
    const gate: RadarGate = status === 401 ? "signin" : status === 402 ? "subscribe" : status === 503 ? "unavailable" : null;
    notify({ phase: "error", error: err?.message ? String(err.message) : "connection failed", gate });
    // A refusal the next retry cannot change. Stop; the account page
    // reconnects after a sign-in or a purchase.
    if (gate === "signin" || gate === "subscribe") s.disconnect();
  });
  // The worker closing a connection on purpose: a session that expired or
  // a subscription that lapsed. It says why first, then disconnects, and
  // socket.io does not retry a server-side disconnect on its own.
  s.on("gate", (g: unknown) => {
    const o = (g ?? {}) as Record<string, unknown>;
    const gate: RadarGate = o.status === 401 ? "signin" : o.status === 402 ? "subscribe" : "unavailable";
    notify({ phase: "error", error: str(o.reason) || "the radar closed the connection", gate });
  });
  s.on("disconnect", (reason) => {
    if (reason === "io server disconnect") {
      if (state.phase !== "error") notify({ phase: "error", error: "the radar closed the connection" });
      return;
    }
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
      behaviours: Array.isArray(o.behaviours) ? o.behaviours.map(normBehaviour).reverse() : [],
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
  s.on("behaviour", (raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const kind = str(o.behaviour);
    notify({ behaviours: [normBehaviour(raw), ...state.behaviours].slice(0, 80) });
    if (kind !== "dormant_buy" && kind !== "wash_like") return;
    const r = (o.read ?? {}) as Record<string, unknown>;
    const detail =
      kind === "dormant_buy"
        ? `quiet for ${Math.round(num(r.gapMs) / 86_400_000)}d, then bought ${num(o.sol).toFixed(2)} SOL of ${shortA(str(o.mint))}`
        : `${num(r.legs)} alternating legs on ${shortA(str(o.mint))} inside ten minutes, ending flat`;
    emitLiveEvent({
      kind: "radar_behaviour",
      ts: num(o.at) || Date.now(),
      wallet: str(o.wallet),
      mint: str(o.mint),
      headline: kind === "dormant_buy" ? "RADAR · DORMANT WALLET WOKE UP" : "RADAR · WASH-LIKE TRADING",
      detail: `${shortA(str(o.wallet))}: ${detail} — heard by your Radar worker.`,
      real: true,
      source: "radar-worker",
    });
  });
  // One more reader counted on a signal: a number on the card, nothing else.
  s.on("signal_followers", (raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (str(o.signal_key)) patchSignal(str(o.signal_key), { followers: num(o.followers) });
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
  notify({ phase: "off", enabled: false, error: null, gate: null });
}

/** The worker URL this browser remembers, connected or not. */
export function radarConfiguredUrl(): string {
  return readConfig().url;
}

/**
 * Try again with the current account: after a sign-in or a purchase, when
 * the gate that refused the last attempt would now let it through.
 */
export function radarReconnect(): void {
  const cfg = readConfig();
  const url = state.url || cfg.url;
  if (!url || (!state.enabled && !cfg.enabled) || holds === 0) return;
  openSocket(url);
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
