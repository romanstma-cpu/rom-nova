// Solana's pubsub socket, PER ACCOUNT, and never wider than that.
//
// THE RULE, AND THE NUMBERS THAT MADE IT
//
// `wss://solana-rpc.publicnode.com` answers `logsSubscribe` and
// `accountSubscribe` keylessly from a browser origin (`api.mainnet-beta`
// refuses, the same 403 it gives every browser fetch). Measured 2026-09-01
// over 10-15s samples at `commitment: processed`:
//
//   logsSubscribe mentions:[pump.fun program]   567 notifications/s   612 KB/s
//   logsSubscribe mentions:[PumpSwap program]   109/s                 358 KB/s
//   logsSubscribe mentions:[exchange hot wallet]  0.33/s                0.4 KB/s
//   logsSubscribe mentions:[one bonding curve]    0/s                   quiet
//   accountSubscribe [hot wallet]                 0.33/s                0.1 KB/s
//   accountSubscribe [bonding curve]              0/s                   quiet
//
// A program-wide subscription from a tab is two gigabytes an hour to extract
// a couple of events a minute, and the browser would spend it decoding JSON
// nobody asked for. So NOTHING here subscribes to a program. Every
// subscription names one account — a wallet with an armed rule, a mint with
// an armed rule, a bonding curve the launch feed is watching — and the total
// is capped and disclosed.
//
// WHAT A NOTIFICATION IS ALLOWED TO MEAN
//
// A `logsNotification` says a transaction mentioning the account landed. It
// does not say what moved, or whether anything did. So the socket never
// asserts a fill: it NUDGES the alert monitor to re-read that source NOW,
// through the same rate-gated path and the same evaluator, instead of at the
// four-minute wallet cadence or the one-minute detail cadence. The read is
// the measurement; the socket only moved it forward. Likewise a curve
// account changing is not a graduation until the poll confirms it — the
// bus event says the account changed and stops there.
//
// A subscription request that draws no ack inside ten seconds is NOT a
// subscription (two never answered during probing). It is disclosed as
// `unacked` and the rule beside it says its instant re-read is OFF.

import { nudge } from "../alerts/cadence";
import { emitLiveEvent } from "./bus";
import { ReconnectingSocket, registerSocket, socketByName, type SubscriptionState } from "./socket";

export const RPC_WS_URL = "wss://solana-rpc.publicnode.com";
export const RPC_WS_NAME = "solana-rpc-ws";

/** Total per-account subscriptions one tab will hold. Disclosed on /status and /alerts. */
export const SUBSCRIPTION_CAP = 40;
/** Of the cap, how many bonding curves the launch feed may claim: the 20 newest on-curve rows. */
export const CURVE_CAP = 20;
/** One bus event per account per this window; further notifications are counted, not emitted. */
export const EVENT_COALESCE_MS = 15_000;

/**
 * Heartbeat. A per-account subscription can legitimately be silent for
 * minutes, so silence proves nothing; `getHealth` over the same socket
 * returns "ok" in ~55ms (probed), and THAT is what the timeout waits for.
 */
export const RPC_WS_HEARTBEAT = { everyMs: 20_000, timeoutMs: 35_000 };

/** The measured rates, as /status prints them beside the cap. */
export const PROGRAM_WIDE_RATES = [
  { subject: "logsSubscribe mentions:[pump.fun program]", perSecond: 567, kbPerSecond: 612 },
  { subject: "logsSubscribe mentions:[PumpSwap program]", perSecond: 109, kbPerSecond: 358 },
  { subject: "logsSubscribe mentions:[one exchange hot wallet]", perSecond: 0.33, kbPerSecond: 0.4 },
  { subject: "accountSubscribe [one bonding curve]", perSecond: 0, kbPerSecond: 0 },
] as const;
export const RATES_MEASURED_ON = "2026-09-01, 10-15s samples, commitment processed";

export interface WatchedCurve {
  account: string;
  mint: string;
  symbol?: string;
}

export interface Watched {
  wallets: string[];
  mints: string[];
  /** Newest first — the cap keeps the head of the list. */
  curves: WatchedCurve[];
}

export interface RpcPlan {
  wallets: string[];
  mints: string[];
  curves: WatchedCurve[];
  /** What the cap left out, so the page can say so. */
  droppedWallets: number;
  droppedMints: number;
  droppedCurves: number;
  total: number;
  cap: number;
}

type Owner = "alerts" | "launches";

const desired: Record<Owner, Watched> = {
  alerts: { wallets: [], mints: [], curves: [] },
  launches: { wallets: [], mints: [], curves: [] },
};

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Which accounts get a subscription, under the cap.
 *
 * Rules first — a wallet or mint somebody armed an alert on is a promise
 * made to a reader — then curves with whatever is left, newest first, up to
 * their own smaller cap. An address that is both a wallet and a mint holds
 * one subscription; the notification nudges both keys.
 */
export function planSubscriptions(want: Watched, cap = SUBSCRIPTION_CAP, curveCap = CURVE_CAP): RpcPlan {
  const wallets = uniq(want.wallets);
  const mintsAll = uniq(want.mints).filter((m) => !wallets.includes(m));
  const walletsKept = wallets.slice(0, cap);
  const mintsKept = mintsAll.slice(0, Math.max(0, cap - walletsKept.length));
  const room = Math.max(0, Math.min(curveCap, cap - walletsKept.length - mintsKept.length));
  const seenCurves = new Set<string>();
  const curvesAll = want.curves.filter((c) => {
    if (seenCurves.has(c.account)) return false;
    seenCurves.add(c.account);
    return true;
  });
  const curvesKept = curvesAll.slice(0, room);
  return {
    wallets: walletsKept,
    mints: mintsKept,
    curves: curvesKept,
    droppedWallets: wallets.length - walletsKept.length,
    droppedMints: mintsAll.length - mintsKept.length,
    droppedCurves: curvesAll.length - curvesKept.length,
    total: walletsKept.length + mintsKept.length + curvesKept.length,
    cap,
  };
}

function merged(): Watched {
  return {
    wallets: [...desired.alerts.wallets, ...desired.launches.wallets],
    mints: [...desired.alerts.mints, ...desired.launches.mints],
    curves: [...desired.launches.curves, ...desired.alerts.curves],
  };
}

let plan: RpcPlan = planSubscriptions(merged());

export function rpcPlan(): RpcPlan {
  return plan;
}

// ---------------------------------------------------------------- socket

interface JsonRpcAck {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface Notification {
  method?: string;
  params?: { subscription?: number; result?: { context?: { slot?: number }; value?: unknown } };
}

const isAckFor = (msg: unknown, id: number): boolean => {
  const m = msg as JsonRpcAck | null;
  return Boolean(m && typeof m === "object" && m.id === id && ("result" in m || "error" in m));
};

const serverIdOf = (ack: unknown): number | undefined => {
  const m = ack as JsonRpcAck;
  return typeof m.result === "number" ? m.result : undefined;
};

const isNotification = (method: string) => (msg: unknown, serverId: number | string | undefined) => {
  const m = msg as Notification | null;
  return Boolean(
    m && typeof m === "object" && m.method === method && serverId !== undefined && m.params?.subscription === serverId,
  );
};

const short = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

/** Per-account event throttle: the nudge fires every time, the bus event once per window. */
const lastEmit = new Map<string, { at: number; suppressed: number }>();

function coalesce(key: string, now: number): { emit: boolean; suppressed: number } {
  const prev = lastEmit.get(key);
  if (prev && now - prev.at < EVENT_COALESCE_MS) {
    prev.suppressed++;
    return { emit: false, suppressed: prev.suppressed };
  }
  const suppressed = prev?.suppressed ?? 0;
  lastEmit.set(key, { at: now, suppressed: 0 });
  return { emit: true, suppressed };
}

function onLogs(address: string, roles: { wallet: boolean; mint: boolean }, msg: unknown, at: number): void {
  // The nudge is the point. Everything below is disclosure.
  if (roles.wallet) nudge(`wallet:${address}`, at);
  if (roles.mint) nudge(`detail:${address}`, at);

  const n = msg as Notification;
  const value = n.params?.result?.value as { signature?: string; err?: unknown } | undefined;
  const slot = n.params?.result?.context?.slot;
  const { emit, suppressed } = coalesce(`logs:${address}`, at);
  if (!emit) return;
  const what = roles.wallet ? "wallet" : "mint";
  emitLiveEvent({
    kind: roles.wallet ? "wallet_activity" : "mint_activity",
    ts: at,
    wallet: roles.wallet ? address : undefined,
    mint: roles.mint ? address : undefined,
    headline: `${what.toUpperCase()} ACTIVITY · ${short(address)}`,
    detail:
      `A transaction mentioning ${short(address)} landed` +
      (slot !== undefined ? ` (slot ${slot}` : "") +
      (value?.signature ? `${slot !== undefined ? ", " : " ("}signature ${short(value.signature)})` : slot !== undefined ? ")" : "") +
      (value?.err ? " — the transaction FAILED on chain" : "") +
      `. Received ${new Date(at).toISOString()} on this machine's clock, uncorrected. ` +
      (roles.wallet
        ? "The alert monitor is re-reading this wallet now instead of at its 4-minute cadence; what moved, if anything, is what that read will say."
        : "The alert monitor is re-reading this token's detail now instead of at its 60-second cadence; the notification itself says nothing about price or liquidity.") +
      (suppressed > 0 ? ` ${suppressed} further notification${suppressed === 1 ? "" : "s"} in the last ${EVENT_COALESCE_MS / 1000}s were counted, not listed.` : ""),
    real: true,
    source: RPC_WS_NAME,
  });
}

function onCurve(curve: WatchedCurve, msg: unknown, at: number): void {
  // A curve account changing is what a graduation looks like from here — and
  // also what a buy looks like. The launch pass re-reads and decides.
  nudge("launches", at);

  const n = msg as Notification;
  const value = n.params?.result?.value as { lamports?: number } | undefined;
  const slot = n.params?.result?.context?.slot;
  const { emit, suppressed } = coalesce(`account:${curve.account}`, at);
  if (!emit) return;
  const label = curve.symbol || short(curve.mint);
  emitLiveEvent({
    kind: "curve_change",
    ts: at,
    mint: curve.mint,
    symbol: curve.symbol,
    headline: `CURVE CHANGE · ${label}`,
    detail:
      `The bonding-curve account ${short(curve.account)} for ${label} changed` +
      (slot !== undefined ? ` at slot ${slot}` : "") +
      (typeof value?.lamports === "number" ? ` (account now holds ${(value.lamports / 1e9).toFixed(3)} SOL)` : "") +
      `. Received ${new Date(at).toISOString()} on this machine's clock, uncorrected. ` +
      "A completed curve is a graduation and a trade is not; the launch feed's poll says which within its 3s cadence — this only says the account moved." +
      (suppressed > 0 ? ` ${suppressed} further change${suppressed === 1 ? "" : "s"} in the last ${EVENT_COALESCE_MS / 1000}s were counted, not listed.` : ""),
    real: true,
    source: RPC_WS_NAME,
  });
}

let nextHealthId = 1_000_000;

/** The socket, created on first use and registered for /status. */
export function rpcSocket(): ReconnectingSocket {
  const existing = socketByName(RPC_WS_NAME);
  if (existing) return existing;
  const sock = new ReconnectingSocket({
    name: RPC_WS_NAME,
    url: RPC_WS_URL,
    heartbeat: {
      ...RPC_WS_HEARTBEAT,
      // Ids from a range no subscription request uses, so a late "ok" can
      // never be mistaken for an ack.
      ping: () => ({ jsonrpc: "2.0", id: nextHealthId++, method: "getHealth" }),
    },
  });
  return registerSocket(sock);
}

const logsKey = (address: string) => `logs:${address}`;
const curveKey = (account: string) => `account:${account}`;

/** Apply the current plan to the socket: subscribe the new, release the gone. */
function apply(): void {
  const sock = rpcSocket();
  const wanted = new Map<string, () => void>();
  const roles = new Map<string, { wallet: boolean; mint: boolean }>();
  for (const w of plan.wallets) roles.set(w, { wallet: true, mint: false });
  for (const m of plan.mints) {
    const r = roles.get(m);
    if (r) r.mint = true;
    else roles.set(m, { wallet: false, mint: true });
  }
  for (const [address, role] of roles) {
    wanted.set(logsKey(address), () =>
      sock.subscribe({
        key: logsKey(address),
        request: (id) => ({
          jsonrpc: "2.0",
          id,
          method: "logsSubscribe",
          params: [{ mentions: [address] }, { commitment: "processed" }],
        }),
        isAck: isAckFor,
        serverIdOf,
        isMessage: isNotification("logsNotification"),
        onMessage: (msg, at) => onLogs(address, role, msg, at),
        unsubscribe: (serverId) => ({ jsonrpc: "2.0", id: nextHealthId++, method: "logsUnsubscribe", params: [serverId] }),
      }),
    );
  }
  for (const curve of plan.curves) {
    wanted.set(curveKey(curve.account), () =>
      sock.subscribe({
        key: curveKey(curve.account),
        request: (id) => ({
          jsonrpc: "2.0",
          id,
          method: "accountSubscribe",
          params: [curve.account, { encoding: "base64", commitment: "processed" }],
        }),
        isAck: isAckFor,
        serverIdOf,
        isMessage: isNotification("accountNotification"),
        onMessage: (msg, at) => onCurve(curve, msg, at),
        unsubscribe: (serverId) => ({
          jsonrpc: "2.0",
          id: nextHealthId++,
          method: "accountUnsubscribe",
          params: [serverId],
        }),
      }),
    );
  }

  for (const key of sock.subscriptionKeys()) if (!wanted.has(key)) sock.unsubscribe(key);
  for (const add of wanted.values()) add();

  // No accounts, no socket. A connection held open for nothing is a
  // heartbeat's worth of traffic and a "connected" chip describing nothing.
  if (wanted.size === 0) sock.disconnect("no accounts to watch");
  else sock.connect();
}

/**
 * Declare what one owner wants watched. The plan is recomputed across both
 * owners and applied; the return is what actually made the cut.
 */
export function setWatched(owner: Owner, part: Partial<Watched>): RpcPlan {
  desired[owner] = { ...desired[owner], ...part };
  plan = planSubscriptions(merged());
  apply();
  return plan;
}

/** What the socket says about one account's subscription, for a rule's chip. */
export function subscriptionStateFor(address: string, kind: "logs" | "account"): SubscriptionState | "not planned" {
  const key = kind === "logs" ? logsKey(address) : curveKey(address);
  const sock = socketByName(RPC_WS_NAME);
  const sub = sock?.snapshot().subscriptions.find((s) => s.key === key);
  return sub?.state ?? "not planned";
}

/** Test seam. */
export function resetRpcWatch(): void {
  desired.alerts = { wallets: [], mints: [], curves: [] };
  desired.launches = { wallets: [], mints: [], curves: [] };
  plan = planSubscriptions(merged());
  lastEmit.clear();
}
