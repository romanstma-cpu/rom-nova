// One reconnecting WebSocket, and the vocabulary for telling the truth about it.
//
// THE ONLY TWO STATES A READER MAY BE SHOWN
//
// A socket is CONNECTED, with the age of its last message beside it, or it is
// NOT — connecting, closed, failed. There is no "live" chip that outlives the
// connection it describes: the launch feed already learned that lesson from a
// pulsing dot that beat through a 74-second outage, and a socket is a worse
// liar than a poll, because a poll that fails returns an error and a socket
// that dies returns nothing at all. Every consumer reads `snapshot()`, and
// every snapshot carries `lastMessageAt`, so the age is never inferred.
//
// SUBSCRIBED MEANS ACKNOWLEDGED
//
// Both keyless sockets this app uses acknowledge a subscription — PumpPortal
// with a `message` frame, Solana's pubsub with a JSON-RPC result carrying the
// server's subscription id — measured at 60-290ms. During the probe that set
// the rates in LIVE-SPEC.md, two acks never arrived in 15 seconds. A request
// that was sent and not answered is not a subscription; it is a hope, and a
// rule that thinks it has a socket-triggered re-read when it has a hope is
// exactly the silence-reads-as-all-clear failure the alert system exists to
// refuse. So a subscription is `sent` until its ack lands and `unacked` after
// ACK_TIMEOUT_MS without one, and both are disclosed as NOT subscribed.
//
// HEARTBEAT, MEASURED RATHER THAN ASSUMED
//
// Silence is ambiguous on a per-account subscription: a bonding curve nobody
// buys into produces zero notifications for minutes, which looks identical to
// a dead socket. Both servers answer an application-level ping over the same
// socket — publicnode returns "ok" to `getHealth` in ~55ms, PumpPortal returns
// an `errors` frame to an unknown method in ~60ms (probed 2026-09-01). So
// after `everyMs` of silence a ping goes out, and after `timeoutMs` of silence
// the socket is declared dead and reconnected. A ping that draws no reply is
// the measurement; nothing here assumes a quiet socket is a healthy one.
//
// Framework-free, and every side effect — the WebSocket constructor, the
// clock, the timers, the jitter — is injectable, so the tests drive a fake
// socket through reconnect, backoff, ack timeout and heartbeat with fake time.

export type SocketState = "connecting" | "open" | "closed" | "failed";

/**
 * `pending`   registered, socket not open — nothing has been sent
 * `sent`      request on the wire, ack not yet seen
 * `subscribed` ack received; the server has this subscription
 * `unacked`   no ack inside ACK_TIMEOUT_MS — treated as NOT subscribed
 */
export type SubscriptionState = "pending" | "sent" | "subscribed" | "unacked";

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export type SocketFactory = (url: string) => WebSocketLike;

export interface SubscriptionSpec {
  /** Stable identity — "logs:<address>", "account:<curve>", "newToken". */
  key: string;
  /** The frame to send, given the request id this socket assigns. */
  request: (id: number) => unknown;
  /** Whether a parsed frame is the ack for this request. */
  isAck: (msg: unknown, id: number) => boolean;
  /** Pull the server's own subscription id out of the ack, when it has one. */
  serverIdOf?: (ack: unknown) => number | string | undefined;
  /** Whether a parsed frame is a notification belonging to this subscription. */
  isMessage?: (msg: unknown, serverId: number | string | undefined) => boolean;
  onMessage?: (msg: unknown, receivedAt: number) => void;
  /** The frame that releases the server-side subscription, when the protocol has one. */
  unsubscribe?: (serverId: number | string) => unknown;
}

export interface SubscriptionStatus {
  key: string;
  state: SubscriptionState;
  requestedAt?: number;
  ackedAt?: number;
  serverId?: number | string;
  messages: number;
  lastMessageAt?: number;
}

export interface SocketSnapshot {
  name: string;
  url: string;
  state: SocketState;
  /** True while something holds the socket open. False = closed on purpose. */
  wanted: boolean;
  connectedAt?: number;
  /** Receipt time of the last frame, this machine's clock, uncorrected. */
  lastMessageAt?: number;
  lastError?: string;
  lastCloseReason?: string;
  /** Times an OPEN socket dropped and was re-established. */
  reconnects: number;
  /** Consecutive failed connection attempts; drives the backoff. */
  attempts: number;
  nextRetryAt?: number;
  messages: number;
  bytes: number;
  subscriptions: SubscriptionStatus[];
  /** Sent, ack not yet seen, inside the timeout. */
  acksPending: number;
  /** Sent, ack never came. Disclosed as NOT subscribed. */
  unacked: number;
  subscribed: number;
  heartbeat: { everyMs: number; timeoutMs: number; pings: number; timeouts: number };
}

export interface SocketOptions {
  name: string;
  url: string;
  factory?: SocketFactory;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** 0..1, for the backoff jitter. Injectable so a test can pin it. */
  random?: () => number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  ackTimeoutMs?: number;
  heartbeat: {
    everyMs: number;
    timeoutMs: number;
    /** The frame to send after `everyMs` of silence. Null = no ping, timeout only. */
    ping: () => unknown | null;
  };
  /** Frames not claimed by a subscription. */
  onMessage?: (msg: unknown, receivedAt: number) => void;
  parse?: (data: unknown) => unknown;
}

/** 1s → 30s, doubling. The spec's numbers. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** No ack in this long = not subscribed. Two acks missed 15s during probing. */
export const ACK_TIMEOUT_MS = 10_000;

/** WebSocket.OPEN without depending on the global existing at import time. */
const WS_OPEN = 1;

interface SubscriptionEntry {
  spec: SubscriptionSpec;
  status: SubscriptionStatus;
  requestId?: number;
  ackTimer?: unknown;
}

const defaultParse = (data: unknown): unknown => {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

const byteLength = (data: unknown): number => {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
};

export class ReconnectingSocket {
  readonly name: string;
  readonly url: string;
  private readonly factory: SocketFactory;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly ackTimeoutMs: number;
  private readonly heartbeat: SocketOptions["heartbeat"];
  private readonly onMessage?: SocketOptions["onMessage"];
  private readonly parse: (data: unknown) => unknown;

  private ws: WebSocketLike | null = null;
  private state: SocketState = "closed";
  private wanted = false;
  private connectedAt?: number;
  private lastMessageAt?: number;
  private lastError?: string;
  private lastCloseReason?: string;
  private reconnects = 0;
  private everOpened = false;
  private attempts = 0;
  private nextRetryAt?: number;
  private messages = 0;
  private bytes = 0;
  private pings = 0;
  private heartbeatTimeouts = 0;
  private nextRequestId = 1;
  private retryTimer?: unknown;
  private pingTimer?: unknown;
  private deadTimer?: unknown;
  private readonly subs = new Map<string, SubscriptionEntry>();
  private readonly listeners = new Set<() => void>();
  private cached: SocketSnapshot | null = null;

  constructor(opts: SocketOptions) {
    this.name = opts.name;
    this.url = opts.url;
    this.factory =
      opts.factory ??
      ((url) => {
        if (typeof WebSocket === "undefined") throw new Error("WebSocket is not available in this runtime");
        return new WebSocket(url) as unknown as WebSocketLike;
      });
    this.now = opts.now ?? (() => Date.now());
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
    this.backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffCapMs = opts.backoffCapMs ?? BACKOFF_CAP_MS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.heartbeat = opts.heartbeat;
    this.onMessage = opts.onMessage;
    this.parse = opts.parse ?? defaultParse;
  }

  // ------------------------------------------------------------ lifecycle

  /** Open, and keep open until `disconnect`. Safe to call repeatedly. */
  connect(): void {
    this.wanted = true;
    if (this.ws || this.retryTimer) return;
    this.open();
  }

  /** Close on purpose. Subscriptions are kept and resent on the next connect. */
  disconnect(reason = "closed by the app"): void {
    this.wanted = false;
    this.clearRetry();
    this.detach();
    this.afterClose(reason, false);
  }

  private open(): void {
    this.clearRetry();
    this.setState("connecting");
    let ws: WebSocketLike;
    try {
      ws = this.factory(this.url);
    } catch (err) {
      // No runtime WebSocket, or the constructor refused the URL. Same path as
      // a failed handshake: back off and try again, with the reason visible.
      this.lastError = err instanceof Error ? err.message : String(err);
      this.afterClose("constructor threw", true);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const now = this.now();
      this.connectedAt = now;
      this.lastMessageAt = now;
      this.attempts = 0;
      this.nextRetryAt = undefined;
      this.lastCloseReason = undefined;
      // A re-establishment, counted at the moment it succeeds — not at the
      // drop, and not at the attempt. "reconnects: 3" means three times this
      // socket was open, died, and came back.
      if (this.everOpened) this.reconnects++;
      this.everOpened = true;
      this.setState("open");
      for (const entry of this.subs.values()) this.sendSubscribe(entry);
      this.armHeartbeat();
      this.changed();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.receive(ev.data);
    };
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      const e = ev as { message?: string; error?: { message?: string } } | undefined;
      this.lastError = e?.message ?? e?.error?.message ?? "socket error";
      this.changed();
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      const wasOpen = this.state === "open";
      this.ws = null;
      this.afterClose(ev?.reason || (ev?.code ? `close ${ev.code}` : "closed by peer"), !wasOpen);
    };
  }

  /**
   * Detach the handlers and close the raw socket, without touching state.
   *
   * A browser fires `onclose` only after the closing handshake completes — or
   * after its own timeout on a peer that has vanished, which is precisely the
   * heartbeat-timeout case. Waiting for it would leave the state at "open"
   * for seconds after the socket was declared dead. So the handlers come off
   * first (a late `onclose` from the old socket then fails the identity check
   * and is ignored) and `afterClose` does the bookkeeping immediately.
   */
  private detach(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearHeartbeat();
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  }

  /** The socket is gone. Record why, and come back if anyone still wants it. */
  private afterClose(reason: string, failedToOpen: boolean): void {
    this.clearHeartbeat();
    this.lastCloseReason = reason;
    this.connectedAt = undefined;
    for (const entry of this.subs.values()) this.resetSubscription(entry);
    if (!this.wanted) {
      this.setState("closed");
      this.changed();
      return;
    }
    if (failedToOpen) this.attempts++;
    this.setState(failedToOpen ? "failed" : "closed");
    this.scheduleRetry();
    this.changed();
  }

  /**
   * Exponential backoff with jitter, capped.
   *
   * Doubling from the base, and the jitter spreads a retry across ±25% so a
   * hundred tabs coming back from the same outage do not all knock at once.
   * The cap is a hard cap: jitter can never push a delay past it.
   */
  retryDelayMs(attempts = this.attempts): number {
    const exp = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** Math.max(0, attempts - 1));
    const jittered = exp * (0.75 + this.random() * 0.5);
    return Math.max(0, Math.min(this.backoffCapMs, Math.round(jittered)));
  }

  private scheduleRetry(): void {
    this.clearRetry();
    // A drop after a healthy connection retries promptly (attempt 0 → base);
    // a run of failed handshakes backs off from there.
    const delay = this.retryDelayMs(Math.max(1, this.attempts));
    this.nextRetryAt = this.now() + delay;
    this.retryTimer = this.setT(() => {
      this.retryTimer = undefined;
      this.nextRetryAt = undefined;
      if (this.wanted) this.open();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) this.clearT(this.retryTimer);
    this.retryTimer = undefined;
    this.nextRetryAt = undefined;
  }

  // ------------------------------------------------------------- messages

  private receive(data: unknown): void {
    const at = this.now();
    this.lastMessageAt = at;
    this.messages++;
    this.bytes += byteLength(data);
    this.armHeartbeat();
    const msg = this.parse(data);

    // Acks first: a subscription's ack is the one frame that changes what the
    // page may claim, and it must be matched before any routing.
    for (const entry of this.subs.values()) {
      if (entry.status.state === "sent" && entry.requestId !== undefined && entry.spec.isAck(msg, entry.requestId)) {
        this.clearAckTimer(entry);
        entry.status = {
          ...entry.status,
          state: "subscribed",
          ackedAt: at,
          serverId: entry.spec.serverIdOf?.(msg) ?? entry.status.serverId,
        };
        this.changed();
        return;
      }
    }
    for (const entry of this.subs.values()) {
      if (entry.spec.isMessage?.(msg, entry.status.serverId)) {
        entry.status = { ...entry.status, messages: entry.status.messages + 1, lastMessageAt: at };
        this.safely(() => entry.spec.onMessage?.(msg, at));
        this.changed();
        return;
      }
    }
    this.safely(() => this.onMessage?.(msg, at));
    this.changed();
  }

  /** Send a frame if the socket is open. Returns whether it went out. */
  send(payload: unknown): boolean {
    if (!this.ws || this.state !== "open") return false;
    try {
      this.ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.changed();
      return false;
    }
  }

  /** A subscriber's handler must never take the socket down with it. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.lastError = `handler threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -------------------------------------------------------- subscriptions

  /** Register; sent now if open, on the next open otherwise. Idempotent by key. */
  subscribe(spec: SubscriptionSpec): void {
    if (this.subs.has(spec.key)) return;
    const entry: SubscriptionEntry = { spec, status: { key: spec.key, state: "pending", messages: 0 } };
    this.subs.set(spec.key, entry);
    if (this.state === "open") this.sendSubscribe(entry);
    this.changed();
  }

  /** Forget a subscription, telling the server when the protocol allows it. */
  unsubscribe(key: string): void {
    const entry = this.subs.get(key);
    if (!entry) return;
    this.clearAckTimer(entry);
    this.subs.delete(key);
    if (entry.status.state === "subscribed" && entry.status.serverId !== undefined && entry.spec.unsubscribe) {
      this.send(entry.spec.unsubscribe(entry.status.serverId));
    }
    this.changed();
  }

  subscriptionKeys(): string[] {
    return [...this.subs.keys()];
  }

  private sendSubscribe(entry: SubscriptionEntry): void {
    const id = this.nextRequestId++;
    entry.requestId = id;
    const at = this.now();
    entry.status = { ...entry.status, state: "sent", requestedAt: at, ackedAt: undefined, serverId: undefined };
    if (!this.send(entry.spec.request(id))) {
      entry.status = { ...entry.status, state: "pending" };
      return;
    }
    this.clearAckTimer(entry);
    entry.ackTimer = this.setT(() => {
      entry.ackTimer = undefined;
      if (entry.status.state === "sent") {
        // Sent, never answered. The server may or may not hold this
        // subscription; the honest claim is that WE do not know, and a
        // re-read trigger nobody can vouch for is disclosed as absent.
        entry.status = { ...entry.status, state: "unacked" };
        this.changed();
      }
    }, this.ackTimeoutMs);
  }

  private resetSubscription(entry: SubscriptionEntry): void {
    this.clearAckTimer(entry);
    entry.requestId = undefined;
    entry.status = { ...entry.status, state: "pending", requestedAt: undefined, ackedAt: undefined, serverId: undefined };
  }

  private clearAckTimer(entry: SubscriptionEntry): void {
    if (entry.ackTimer !== undefined) this.clearT(entry.ackTimer);
    entry.ackTimer = undefined;
  }

  // ------------------------------------------------------------ heartbeat

  private armHeartbeat(): void {
    this.clearHeartbeat();
    if (this.state !== "open") return;
    const { everyMs, timeoutMs, ping } = this.heartbeat;
    if (everyMs > 0 && everyMs < timeoutMs) {
      this.pingTimer = this.setT(() => {
        this.pingTimer = undefined;
        const frame = ping();
        if (frame !== null && frame !== undefined && this.send(frame)) this.pings++;
        this.changed();
      }, everyMs);
    }
    this.deadTimer = this.setT(() => {
      this.deadTimer = undefined;
      this.heartbeatTimeouts++;
      // Declared dead by measurement: a ping went out and nothing came back.
      // Torn down by us, so the state flips NOW rather than whenever the
      // browser finishes waiting on a peer that is not there.
      this.detach();
      this.afterClose(`heartbeat timeout — no frame in ${Math.round(timeoutMs / 1000)}s`, false);
    }, timeoutMs);
  }

  private clearHeartbeat(): void {
    if (this.pingTimer !== undefined) this.clearT(this.pingTimer);
    if (this.deadTimer !== undefined) this.clearT(this.deadTimer);
    this.pingTimer = undefined;
    this.deadTimer = undefined;
  }

  // ------------------------------------------------------------- snapshot

  private setState(s: SocketState): void {
    if (this.state !== s) {
      this.state = s;
      this.changed();
    }
  }

  private changed(): void {
    this.cached = null;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a broken listener must not stop the rest */
      }
    }
  }

  /**
   * The state, for `useSyncExternalStore`.
   *
   * Cached until something changes, so an unchanged socket returns the same
   * object and React does not re-render every page that watches it. Never
   * reads storage; the socket IS the state.
   */
  snapshot(): SocketSnapshot {
    if (this.cached) return this.cached;
    const subscriptions = [...this.subs.values()].map((e) => e.status);
    this.cached = {
      name: this.name,
      url: this.url,
      state: this.state,
      wanted: this.wanted,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      lastCloseReason: this.lastCloseReason,
      reconnects: this.reconnects,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      messages: this.messages,
      bytes: this.bytes,
      subscriptions,
      acksPending: subscriptions.filter((s) => s.state === "sent").length,
      unacked: subscriptions.filter((s) => s.state === "unacked").length,
      subscribed: subscriptions.filter((s) => s.state === "subscribed").length,
      heartbeat: {
        everyMs: this.heartbeat.everyMs,
        timeoutMs: this.heartbeat.timeoutMs,
        pings: this.pings,
        timeouts: this.heartbeatTimeouts,
      },
    };
    return this.cached;
  }

  subscribeChanges(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /** True only when the socket is open AND has heard something within `maxSilenceMs`. */
  isLive(maxSilenceMs: number, now = this.now()): boolean {
    return this.state === "open" && this.lastMessageAt !== undefined && now - this.lastMessageAt <= maxSilenceMs;
  }

  /** Whether the raw socket itself reports open — a cross-check for the probes. */
  rawOpen(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }
}

// ----------------------------------------------------------------- registry
//
// Every socket the app opens registers here, so /status can list all of them
// without importing each adapter, and so one `useSyncExternalStore` hook can
// watch the lot. Snapshots are recomputed only when a socket reports a change,
// which keeps the array reference stable between changes — the contract the
// hook needs to avoid re-rendering on every poll.

const registry = new Map<string, ReconnectingSocket>();
const registryListeners = new Set<() => void>();
let registrySnapshot: SocketSnapshot[] | null = null;

export function registerSocket(sock: ReconnectingSocket): ReconnectingSocket {
  registry.set(sock.name, sock);
  sock.subscribeChanges(() => {
    registrySnapshot = null;
    for (const l of registryListeners) l();
  });
  registrySnapshot = null;
  for (const l of registryListeners) l();
  return sock;
}

export function socketByName(name: string): ReconnectingSocket | undefined {
  return registry.get(name);
}

export function socketsSnapshot(): SocketSnapshot[] {
  if (!registrySnapshot) registrySnapshot = [...registry.values()].map((s) => s.snapshot());
  return registrySnapshot;
}

/** The prerender has no sockets. A stable empty array keeps hydration clean. */
const SERVER_SNAPSHOT: SocketSnapshot[] = [];
export function socketsSnapshotServer(): SocketSnapshot[] {
  return SERVER_SNAPSHOT;
}

export function subscribeSockets(l: () => void): () => void {
  registryListeners.add(l);
  return () => {
    registryListeners.delete(l);
  };
}

/** Test seam. */
export function resetSocketRegistry(): void {
  registry.clear();
  registrySnapshot = null;
}

/** "connected · 3s ago" / "down" — the two-state wording every surface shares. */
export function describeSocket(s: SocketSnapshot | undefined, now = Date.now()): { up: boolean; label: string } {
  if (!s) return { up: false, label: "not started" };
  if (s.state === "open") {
    const age = s.lastMessageAt === undefined ? null : Math.max(0, now - s.lastMessageAt);
    return {
      up: true,
      label: age === null ? "connected · no frame yet" : `connected · last frame ${age < 1_000 ? "<1s" : `${Math.round(age / 1000)}s`} ago`,
    };
  }
  if (s.state === "connecting") return { up: false, label: "connecting" };
  const retry = s.nextRetryAt !== undefined ? ` · retry in ${Math.max(0, Math.round((s.nextRetryAt - now) / 1000))}s` : "";
  return { up: false, label: `down${s.lastCloseReason ? ` (${s.lastCloseReason})` : ""}${retry}` };
}
