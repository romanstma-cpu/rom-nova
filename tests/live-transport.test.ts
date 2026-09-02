// The real-time transport, driven through a fake socket on a fake clock.
//
// Every behaviour a blind critic would stage against the running app is
// pinned here first: a socket that will not open, one that opens and dies,
// one that opens and goes silent, a subscribe that is never acknowledged, a
// push that arrives before the poll and one that arrives after it, and more
// accounts than the cap allows. None of these need a network, and none of
// them should ever be discovered on a page.

import { describe, it, expect, beforeEach } from "vitest";
import {
  ReconnectingSocket,
  ACK_TIMEOUT_MS,
  BACKOFF_CAP_MS,
  registerSocket,
  resetSocketRegistry,
  socketsSnapshot,
  describeSocket,
  type WebSocketLike,
} from "@/lib/live/socket";
import { mergeLaunch, observeLaunchPush, resetLaunchFeed, currentLaunches, PUSH_SOURCE } from "@/lib/api/launches";
import { handlePumpPortalFrame } from "@/lib/live/pumpportal";
import { subscribeLiveEvents, type LiveEvent } from "@/lib/live/bus";
import { due, lastAttemptAt, noteAttempt, nudge, resetCadence, subscribeNudges } from "@/lib/alerts/cadence";
import {
  planSubscriptions,
  setWatched,
  resetRpcWatch,
  rpcPlan,
  subscriptionStateFor,
  RPC_WS_NAME,
  RPC_WS_URL,
  RPC_WS_HEARTBEAT,
  SUBSCRIPTION_CAP,
  CURVE_CAP,
} from "@/lib/live/rpc-ws";
import { toLaunch } from "@/lib/providers/jupiter";
import type { TokenLaunch } from "@/lib/types";

// ------------------------------------------------------------- the fakes

class FakeClock {
  t = 1_700_000_000_000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  /** Advance, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x.id !== next.id);
      this.t = next.at;
      next.fn();
    }
    this.t = until;
  }
  pending(): number {
    return this.timers.length;
  }
}

class FakeWS implements WebSocketLike {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  /** Server side. */
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(reason = "peer went away") {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason });
  }
  refuse() {
    this.readyState = 3;
    this.onerror?.({ message: "connection refused" });
    this.onclose?.({ code: 1006 });
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function makeSocket(clock: FakeClock, over: Partial<ConstructorParameters<typeof ReconnectingSocket>[0]> = {}) {
  return new ReconnectingSocket({
    name: over.name ?? "fake",
    url: "wss://example.invalid",
    factory: (url) => new FakeWS(url),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // Pinned at the midpoint: 0.75 + 0.5 * 0.5 = exactly 1.0x, so the
    // backoff assertions below read the schedule, not the dice.
    random: () => 0.5,
    heartbeat: { everyMs: 20_000, timeoutMs: 35_000, ping: () => ({ method: "ping" }) },
    ...over,
  });
}

const latest = () => FakeWS.all[FakeWS.all.length - 1];

beforeEach(() => {
  FakeWS.all = [];
  resetSocketRegistry();
  resetLaunchFeed();
  resetCadence();
  resetRpcWatch();
});

// ------------------------------------------------------- reconnect/backoff

describe("reconnect and backoff", () => {
  it("doubles the retry from 1s and caps at 30s, with jitter pinned", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    sock.connect();
    expect(sock.snapshot().state).toBe("connecting");

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = clock.now();
      latest().refuse();
      const s = sock.snapshot();
      expect(s.state).toBe("failed");
      expect(s.nextRetryAt).toBeDefined();
      delays.push(s.nextRetryAt! - before);
      clock.advance(s.nextRetryAt! - before);
    }
    // attempts 1..8 → 1s 2s 4s 8s 16s 30s 30s 30s
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, BACKOFF_CAP_MS, BACKOFF_CAP_MS, BACKOFF_CAP_MS]);
    expect(sock.snapshot().attempts).toBe(8);
    // Never a reconnect: nothing ever opened.
    expect(sock.snapshot().reconnects).toBe(0);
  });

  it("jitter spreads a retry across ±25% and never past the cap", () => {
    const clock = new FakeClock();
    const low = makeSocket(clock, { random: () => 0 });
    const high = makeSocket(clock, { random: () => 1 });
    expect(low.retryDelayMs(2)).toBe(1_500);
    expect(high.retryDelayMs(2)).toBe(2_500);
    expect(high.retryDelayMs(20)).toBe(BACKOFF_CAP_MS);
  });

  it("comes back after a drop, counts the re-establishment, and resends every subscription", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    sock.subscribe({ key: "a", request: (id) => ({ id, sub: "a" }), isAck: (m, id) => (m as { id?: number }).id === id });
    sock.connect();
    const first = latest();
    first.open();
    expect(sock.snapshot().state).toBe("open");
    expect(first.frames()).toEqual([{ id: 1, sub: "a" }]);
    first.deliver({ id: 1, result: 7 });
    expect(sock.snapshot().subscribed).toBe(1);

    first.drop();
    const s = sock.snapshot();
    // Not silently stale: the drop is a state, and the subscription with it.
    expect(s.state).toBe("closed");
    expect(s.subscribed).toBe(0);
    expect(s.subscriptions[0].state).toBe("pending");
    expect(s.lastCloseReason).toBe("peer went away");
    // A drop after a healthy connection retries promptly, not from the top of a backoff.
    expect(s.nextRetryAt! - clock.now()).toBe(1_000);

    clock.advance(1_000);
    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    expect(sock.snapshot().reconnects).toBe(1);
    // Resent with a fresh id — the old ack can never satisfy it.
    expect(second.frames()).toEqual([{ id: 2, sub: "a" }]);
    expect(sock.snapshot().subscriptions[0].state).toBe("sent");
  });

  it("stays closed when nobody wants it", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    sock.connect();
    latest().open();
    sock.disconnect("test done");
    expect(latest().closed).toBe(true);
    expect(sock.snapshot().state).toBe("closed");
    expect(sock.snapshot().wanted).toBe(false);
    clock.advance(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });
});

// ------------------------------------------------------------ ack timeout

describe("a subscription is acknowledged or it is not one", () => {
  it("marks a request unacked after 10s and never calls it subscribed", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    sock.subscribe({ key: "quiet", request: (id) => ({ id }), isAck: (m, id) => (m as { id?: number }).id === id });
    sock.connect();
    latest().open();
    expect(sock.snapshot().acksPending).toBe(1);
    clock.advance(ACK_TIMEOUT_MS - 1);
    expect(sock.snapshot().subscriptions[0].state).toBe("sent");
    clock.advance(1);
    const s = sock.snapshot();
    expect(s.subscriptions[0].state).toBe("unacked");
    expect(s.unacked).toBe(1);
    expect(s.subscribed).toBe(0);
    expect(s.acksPending).toBe(0);
    // A late ack after the timeout does not resurrect it: `sent` is the only
    // state an ack is matched against, so the disclosure stands.
    latest().deliver({ id: 1, result: 3 });
    expect(sock.snapshot().subscriptions[0].state).toBe("unacked");
  });

  it("records the server's subscription id from the ack and routes notifications by it", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    const got: unknown[] = [];
    sock.subscribe({
      key: "logs:x",
      request: (id) => ({ id }),
      isAck: (m, id) => (m as { id?: number }).id === id,
      serverIdOf: (ack) => (ack as { result: number }).result,
      isMessage: (m, serverId) => (m as { params?: { subscription?: number } }).params?.subscription === serverId,
      onMessage: (m) => got.push(m),
    });
    sock.connect();
    latest().open();
    latest().deliver({ jsonrpc: "2.0", id: 1, result: 473675 });
    expect(sock.snapshot().subscriptions[0]).toMatchObject({ state: "subscribed", serverId: 473675 });
    latest().deliver({ method: "logsNotification", params: { subscription: 999 } });
    latest().deliver({ method: "logsNotification", params: { subscription: 473675 } });
    expect(got).toHaveLength(1);
    expect(sock.snapshot().subscriptions[0].messages).toBe(1);
  });

  it("tells the server to release a subscription it acknowledged", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    sock.subscribe({
      key: "logs:x",
      request: (id) => ({ id }),
      isAck: (m, id) => (m as { id?: number }).id === id,
      serverIdOf: (ack) => (ack as { result: number }).result,
      unsubscribe: (serverId) => ({ method: "logsUnsubscribe", params: [serverId] }),
    });
    sock.connect();
    latest().open();
    latest().deliver({ id: 1, result: 42 });
    sock.unsubscribe("logs:x");
    expect(latest().frames().at(-1)).toEqual({ method: "logsUnsubscribe", params: [42] });
    expect(sock.snapshot().subscriptions).toHaveLength(0);
  });
});

// -------------------------------------------------------------- heartbeat

describe("heartbeat — silence is measured, not assumed", () => {
  it("pings after everyMs of silence and tears the socket down at timeoutMs", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    sock.connect();
    const ws = latest();
    ws.open();
    clock.advance(19_999);
    expect(ws.frames()).toEqual([]);
    clock.advance(1);
    expect(ws.frames()).toEqual([{ method: "ping" }]);
    expect(sock.snapshot().heartbeat.pings).toBe(1);
    // A reply resets both clocks.
    ws.deliver({ errors: "Invalid message" });
    clock.advance(34_000);
    expect(sock.snapshot().state).toBe("open");
    // No reply this time: dead at 35s after the last frame.
    clock.advance(1_000);
    const s = sock.snapshot();
    expect(s.state).toBe("closed");
    expect(s.heartbeat.timeouts).toBe(1);
    expect(s.lastCloseReason).toMatch(/heartbeat timeout/);
    expect(ws.closed).toBe(true);
    // And it comes back on its own.
    clock.advance(1_000);
    expect(FakeWS.all).toHaveLength(2);
    latest().open();
    expect(sock.snapshot().reconnects).toBe(1);
  });

  it("reports the last-message age, never a bare 'live'", () => {
    const clock = new FakeClock();
    const sock = makeSocket(clock);
    sock.connect();
    latest().open();
    latest().deliver({ hello: true });
    clock.advance(4_000);
    expect(describeSocket(sock.snapshot(), clock.now()).label).toBe("connected · last frame 4s ago");
    expect(sock.isLive(5_000, clock.now())).toBe(true);
    expect(sock.isLive(3_000, clock.now())).toBe(false);
    latest().drop();
    expect(describeSocket(sock.snapshot(), clock.now())).toMatchObject({ up: false });
    expect(describeSocket(undefined).label).toBe("not started");
  });

  it("registers for /status and keeps the snapshot array stable until something changes", () => {
    const clock = new FakeClock();
    const sock = registerSocket(makeSocket(clock, { name: "registered" }));
    const a = socketsSnapshot();
    const b = socketsSnapshot();
    expect(a).toBe(b);
    sock.connect();
    expect(socketsSnapshot()).not.toBe(a);
    expect(socketsSnapshot()[0].name).toBe("registered");
  });
});

// ------------------------------------------------------------ push → feed

/** The frame exactly as PumpPortal delivered it, 2026-09-01. */
const CREATE_FRAME = {
  signature: "5a25wHP6nnG86e4gD3PtZpJwat1MpWQf8Dv4DCsdZBQuHLR1Q6WtVChK9TSBJ6wbSPP1cQpU7uQtVbdn1x2WDCsM",
  mint: "BW29viMhoj7FeEN2cyWzfjSAxL3XG7k6qVrDsRJZpump",
  traderPublicKey: "2evtQQ9C5atKF4h6TjA3KCHYsmh2PzjuPo6KaiRvvt34",
  txType: "create",
  initialBuy: 34199203.154141,
  solAmount: 0.98765432,
  bondingCurveKey: "4SbPTKGoyrhnMPM427hsZxGS283G7TKCi6LDWCkon8rz",
  vTokensInBondingCurve: 1038800796.845859,
  vSolInBondingCurve: 30.987654319999976,
  marketCapSol: 29.830218088096093,
  name: "Memecoin Wars",
  symbol: "WARS",
  uri: "https://ipfs.io/ipfs/bafkreiftmx7uhdbum5dptkmhdn54ntsjurujacooo4etoam5rzcr3idwwe",
  is_mayhem_mode: false,
  pool: "pump",
};

/** The same mint as Jupiter's `recent` endpoint would list it a few seconds later. */
const JUP_ROW = {
  id: CREATE_FRAME.mint,
  name: "Memecoin Wars",
  symbol: "WARS",
  decimals: 6,
  dev: CREATE_FRAME.traderPublicKey,
  launchpad: "pump.fun",
  holderCount: 4,
  usdPrice: 0.0000031,
  liquidity: 6_120,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devMints: 1 },
  stats5m: { numBuys: 2, numSells: 0, numTraders: 2 },
  firstPool: { createdAt: "2026-09-01T20:00:00Z" },
  createdAt: "2026-09-01T20:00:00Z",
};

const RECEIPT = Date.parse("2026-09-01T20:00:01.500Z");
const POLL_SEEN = Date.parse("2026-09-01T20:00:06Z");

describe("push → feed: receipt time is the only claim, and it is never a creation time", () => {
  it("adds the row undated, sourced to the socket, with the curve key", () => {
    const { added } = observeLaunchPush(
      { mint: CREATE_FRAME.mint, name: "Memecoin Wars", symbol: "WARS", dev: CREATE_FRAME.traderPublicKey, curveAccount: CREATE_FRAME.bondingCurveKey, pool: "pump" },
      RECEIPT,
    );
    expect(added).toBe(true);
    const row = currentLaunches()[0];
    expect(row.firstSeenAt).toBe(RECEIPT);
    expect(row.poolCreatedAt).toBeUndefined();
    expect(row.datedBy).toBeUndefined();
    expect(row.source).toBe(PUSH_SOURCE);
    expect(row.launchpad).toBe("pump.fun");
    expect(row.curveAccount).toBe(CREATE_FRAME.bondingCurveKey);
    expect(row.dev).toBe(CREATE_FRAME.traderPublicKey);
    // Nothing the frame does not say: no price, no liquidity, no audit.
    expect(row.priceUsd).toBeUndefined();
    expect(row.liquidityUsd).toBeUndefined();
    expect(row.authorityKnown).toBe(false);
    expect(row.triage.verdict).toBeDefined();
  });

  it("keeps the earlier firstSeenAt and takes the date from the poll that lists it", () => {
    observeLaunchPush({ mint: CREATE_FRAME.mint, symbol: "WARS", curveAccount: CREATE_FRAME.bondingCurveKey, pool: "pump" }, RECEIPT);
    const rows = new Map<string, TokenLaunch>(currentLaunches().map((l) => [l.mint, l]));
    mergeLaunch(rows, toLaunch(JUP_ROW, POLL_SEEN), undefined, POLL_SEEN);
    const row = rows.get(CREATE_FRAME.mint)!;
    // The whole win: the sighting is the push's, 4.5s before the poll saw it.
    expect(row.firstSeenAt).toBe(RECEIPT);
    expect(row.poolCreatedAt).toBe(Date.parse("2026-09-01T20:00:00Z"));
    expect(row.datedBy).toBe("jupiter");
    expect(row.source).toBe(PUSH_SOURCE);
    // The poll's numbers land; the push's curve key survives.
    expect(row.liquidityUsd).toBe(6_120);
    expect(row.authorityKnown).toBe(true);
    expect(row.curveAccount).toBe(CREATE_FRAME.bondingCurveKey);
    // And the lag is now stateable: receipt minus the source's claim.
    expect(row.firstSeenAt - row.poolCreatedAt!).toBe(1_500);
  });

  it("does not move a dated row's date or sighting when the push arrives second", () => {
    const rows = new Map<string, TokenLaunch>();
    mergeLaunch(rows, toLaunch(JUP_ROW, POLL_SEEN), undefined, POLL_SEEN);
    const later = POLL_SEEN + 2_000;
    const before = rows.get(CREATE_FRAME.mint)!;
    // Through the module path, so the feed's own map is exercised.
    observeLaunchPush({ mint: CREATE_FRAME.mint, curveAccount: CREATE_FRAME.bondingCurveKey, pool: "pump" }, later);
    // The module's map had no such row (the poll wrote to a local map above),
    // so assert the merge rule directly on the shared map instead.
    mergeLaunch(
      rows,
      { ...before, firstSeenAt: later, poolCreatedAt: undefined, datedBy: undefined, source: PUSH_SOURCE, curveAccount: CREATE_FRAME.bondingCurveKey },
      undefined,
      later,
    );
    const row = rows.get(CREATE_FRAME.mint)!;
    expect(row.firstSeenAt).toBe(POLL_SEEN);
    expect(row.poolCreatedAt).toBe(before.poolCreatedAt);
    expect(row.datedBy).toBe("jupiter");
    expect(row.source).toBe("jupiter");
    expect(row.curveAccount).toBe(CREATE_FRAME.bondingCurveKey);
  });

  it("turns a captured frame into a row and a REAL bus event, and ignores everything else", () => {
    const events: LiveEvent[] = [];
    const off = subscribeLiveEvents((e) => events.push(e));
    try {
      expect(handlePumpPortalFrame({ message: "Successfully subscribed to token creation events." }, RECEIPT)).toBe(false);
      expect(handlePumpPortalFrame({ ...CREATE_FRAME, txType: "buy" }, RECEIPT)).toBe(false);
      expect(handlePumpPortalFrame(CREATE_FRAME, RECEIPT)).toBe(true);
      // A second delivery of the same mint is not a second launch.
      expect(handlePumpPortalFrame(CREATE_FRAME, RECEIPT + 10)).toBe(false);
    } finally {
      off();
    }
    expect(currentLaunches()).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "launch_seen", real: true, source: PUSH_SOURCE, mint: CREATE_FRAME.mint, ts: RECEIPT });
    expect(events[0].detail).toMatch(/received at .* on this machine's clock/);
    expect(events[0].detail).toMatch(/carries no creation time/);
  });
});

// ------------------------------------------------------------------ nudge

describe("nudge — the socket decides WHEN, never WHAT", () => {
  it("clears the key's last attempt so it is due, and wakes the listener", () => {
    const now = 1_700_000_000_000;
    noteAttempt("wallet:abc", now);
    expect(due("wallet:abc", 240_000, now + 60_000)).toBe(false);
    const woken: string[] = [];
    const off = subscribeNudges((k) => woken.push(k));
    nudge("wallet:abc", now + 60_000);
    off();
    expect(lastAttemptAt("wallet:abc")).toBe(0);
    expect(due("wallet:abc", 240_000, now + 60_000)).toBe(true);
    expect(woken).toEqual(["wallet:abc"]);
    // Other keys untouched.
    noteAttempt("scanner", now);
    nudge("wallet:abc");
    expect(lastAttemptAt("scanner")).toBe(now);
  });
});

// ------------------------------------------------------- subscription cap

describe("subscription cap — per account, forty in total, curves last", () => {
  const w = (n: number) => Array.from({ length: n }, (_, i) => `W${String(i).padStart(43, "x")}`);
  const c = (n: number) => Array.from({ length: n }, (_, i) => ({ account: `C${i}`, mint: `M${i}`, symbol: `S${i}` }));

  it("keeps rules over curves and says what it dropped", () => {
    const p = planSubscriptions({ wallets: w(45), mints: [], curves: c(30) });
    expect(p.wallets).toHaveLength(SUBSCRIPTION_CAP);
    expect(p.droppedWallets).toBe(5);
    expect(p.curves).toHaveLength(0);
    expect(p.droppedCurves).toBe(30);
    expect(p.total).toBe(SUBSCRIPTION_CAP);
  });

  it("caps curves at twenty even with room to spare, newest first", () => {
    const p = planSubscriptions({ wallets: w(5), mints: ["Mx"], curves: c(30) });
    expect(p.curves).toHaveLength(CURVE_CAP);
    expect(p.curves[0].account).toBe("C0");
    expect(p.droppedCurves).toBe(10);
    expect(p.total).toBe(5 + 1 + CURVE_CAP);
  });

  it("gives curves only what the rules leave", () => {
    const p = planSubscriptions({ wallets: w(25), mints: w(5).map((x) => `m${x}`), curves: c(30) });
    expect(p.curves).toHaveLength(10);
    expect(p.total).toBe(SUBSCRIPTION_CAP);
  });

  it("holds one subscription for an address that is both a wallet and a mint", () => {
    const p = planSubscriptions({ wallets: ["A"], mints: ["A", "B"], curves: [] });
    expect(p.wallets).toEqual(["A"]);
    expect(p.mints).toEqual(["B"]);
    expect(p.total).toBe(2);
  });
});

// ---------------------------------------------------- the RPC socket, wired

describe("rpc-ws — per-account frames, acks, notifications → nudges and events", () => {
  function fakeRpc() {
    const clock = new FakeClock();
    // Pre-registered under the adapter's name, so `rpcSocket()` finds this
    // one and never constructs a real WebSocket.
    const sock = registerSocket(
      makeSocket(clock, {
        name: RPC_WS_NAME,
        url: RPC_WS_URL,
        heartbeat: { ...RPC_WS_HEARTBEAT, ping: () => ({ jsonrpc: "2.0", id: 1_000_000, method: "getHealth" }) },
      }),
    );
    return { clock, sock };
  }

  it("subscribes each armed account by name and nothing program-wide", () => {
    fakeRpc();
    const plan = setWatched("alerts", { wallets: ["WALLET1"], mints: ["MINT1"] });
    expect(plan.total).toBe(2);
    const ws = latest();
    ws.open();
    const frames = ws.frames();
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: ["WALLET1"] }, { commitment: "processed" }] });
    expect(frames[1]).toMatchObject({ method: "logsSubscribe", params: [{ mentions: ["MINT1"] }, { commitment: "processed" }] });
    for (const f of frames) {
      const mentions = (f.params as [{ mentions: string[] }])[0].mentions;
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).not.toMatch(/^6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P$/);
    }
    expect(subscriptionStateFor("WALLET1", "logs")).toBe("sent");
    ws.deliver({ jsonrpc: "2.0", id: 1, result: 473675 });
    expect(subscriptionStateFor("WALLET1", "logs")).toBe("subscribed");
    expect(subscriptionStateFor("MINT1", "logs")).toBe("sent");
    expect(subscriptionStateFor("NOBODY", "logs")).toBe("not planned");
  });

  it("a logs notification nudges the wallet's read and publishes one REAL event per window", () => {
    const { clock } = fakeRpc();
    setWatched("alerts", { wallets: ["WALLET1"] });
    const ws = latest();
    ws.open();
    ws.deliver({ jsonrpc: "2.0", id: 1, result: 11 });
    noteAttempt("wallet:WALLET1", clock.now());
    const events: LiveEvent[] = [];
    const off = subscribeLiveEvents((e) => events.push(e));
    const woken: string[] = [];
    const offN = subscribeNudges((k) => woken.push(k));
    try {
      const notif = (sig: string) => ({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: { subscription: 11, result: { context: { slot: 443566230 }, value: { signature: sig, err: null, logs: [] } } },
      });
      ws.deliver(notif("SIG1"));
      clock.advance(3_000);
      ws.deliver(notif("SIG2"));
      ws.deliver(notif("SIG3"));
      clock.advance(13_000);
      ws.deliver(notif("SIG4"));
    } finally {
      off();
      offN();
    }
    expect(woken).toEqual(["wallet:WALLET1", "wallet:WALLET1", "wallet:WALLET1", "wallet:WALLET1"]);
    expect(lastAttemptAt("wallet:WALLET1")).toBe(0);
    // Four notifications, two events: the second window says what it swallowed.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "wallet_activity", real: true, source: RPC_WS_NAME, wallet: "WALLET1" });
    expect(events[0].detail).toMatch(/slot 443566230/);
    expect(events[0].detail).toMatch(/this machine's clock, uncorrected/);
    expect(events[0].detail).toMatch(/re-reading this wallet now/);
    expect(events[1].detail).toMatch(/2 further notifications/);
  });

  it("a curve account change nudges the launch pass and names the mint", () => {
    fakeRpc();
    setWatched("launches", { curves: [{ account: "CURVE1", mint: "MINT9", symbol: "NINE" }] });
    const ws = latest();
    ws.open();
    expect(ws.frames()[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: ["CURVE1", { encoding: "base64", commitment: "processed" }] });
    ws.deliver({ jsonrpc: "2.0", id: 1, result: 400648 });
    const events: LiveEvent[] = [];
    const off = subscribeLiveEvents((e) => events.push(e));
    noteAttempt("launches", 5);
    try {
      ws.deliver({
        jsonrpc: "2.0",
        method: "accountNotification",
        params: { subscription: 400648, result: { context: { slot: 1 }, value: { lamports: 31_000_000_000, data: ["", "base64"] } } },
      });
    } finally {
      off();
    }
    expect(lastAttemptAt("launches")).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "curve_change", mint: "MINT9", symbol: "NINE", real: true });
    expect(events[0].detail).toMatch(/31\.000 SOL/);
    expect(events[0].detail).toMatch(/only says the account moved/);
  });

  it("releases what an owner stops wanting and closes the socket at zero", () => {
    fakeRpc();
    setWatched("alerts", { wallets: ["WALLET1"] });
    setWatched("launches", { curves: [{ account: "CURVE1", mint: "M" }] });
    const ws = latest();
    ws.open();
    ws.deliver({ jsonrpc: "2.0", id: 1, result: 5 });
    ws.deliver({ jsonrpc: "2.0", id: 2, result: 6 });
    expect(rpcPlan().total).toBe(2);
    setWatched("launches", { curves: [] });
    expect(ws.frames().at(-1)).toMatchObject({ method: "accountUnsubscribe", params: [6] });
    expect(rpcPlan().total).toBe(1);
    setWatched("alerts", { wallets: [] });
    expect(rpcPlan().total).toBe(0);
    expect(ws.closed).toBe(true);
    expect(socketsSnapshot().find((s) => s.name === RPC_WS_NAME)!.state).toBe("closed");
  });
});
