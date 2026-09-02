// PumpPortal's creation stream, into the launch feed.
//
// WHAT THIS IS
//
// `wss://pumpportal.fun/api/data` with `{"method":"subscribeNewToken"}` pushes
// one frame per pump.fun token creation. Keyless, and it answers this app's
// origins — verified from both `app://rom-nova` and `https://romapps.xyz`.
// Measured 2026-09-01: handshake 275ms, subscribe ack 60-290ms, 27-58
// creations a minute at ~0.3 KB/s. The frame carries signature, mint, the
// creating wallet, the bonding-curve account, the curve's reserves, name,
// symbol, uri and the launchpad — and NO TIMESTAMP.
//
// WHAT IT IS NOT
//
// Not the trade feed. `subscribeTokenTrade` and `subscribeAccountTrade`
// require an API key, and this app is keyless by rule, so the only thing this
// socket ever asks for is creations. Not a clock, either: because the frame
// has no timestamp, a pushed row is stamped with its RECEIPT time on this
// machine's clock and nothing else. It gains a creation time only when a
// polled source lists the mint, and only then can anyone say how far ahead
// the push was. The row says "dated by: not yet" until that happens.
//
// WHY IT IS HELD, NOT ALWAYS ON
//
// The launches page holds the socket while it is visible, the way its poll
// only runs while it is visible. A socket left open in a background tab for
// rows nobody will look at is the same battery bug the poll already fixed,
// and the whole "N pushed this session" count would then describe a tab
// nobody was reading.

import { observeLaunchPush, PUSH_SOURCE } from "../api/launches";
import { emitLiveEvent } from "./bus";
import { ReconnectingSocket, registerSocket, socketByName } from "./socket";

export const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";
export const PUMPPORTAL_NAME = PUSH_SOURCE;

/**
 * Heartbeat. Creations arrive every 1-2 seconds on a normal afternoon, so
 * thirty seconds of silence is already unusual; a ping then settles it. The
 * server answers an unknown method with an `errors` frame in ~60ms (probed),
 * which is a reply — proof the socket is alive — and nothing more is read
 * into it. A socket that stays silent through the ping is declared dead at
 * forty-five seconds and reconnected, with the reason on /status.
 */
export const PUMPPORTAL_HEARTBEAT = { everyMs: 30_000, timeoutMs: 45_000 };

interface CreateFrame {
  txType?: string;
  mint?: string;
  name?: string;
  symbol?: string;
  traderPublicKey?: string;
  bondingCurveKey?: string;
  pool?: string;
  signature?: string;
}

const short = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

/**
 * One frame in, one row and one bus event out — or nothing, for frames that
 * are not creations. Exported so the tests can push a captured frame through
 * the real path without a socket.
 *
 * Returns whether the frame was a creation this feed accepted.
 */
export function handlePumpPortalFrame(msg: unknown, receivedAt: number): boolean {
  const f = msg as CreateFrame | null;
  if (!f || typeof f !== "object" || f.txType !== "create" || typeof f.mint !== "string") return false;
  const { added } = observeLaunchPush(
    {
      mint: f.mint,
      name: typeof f.name === "string" ? f.name : undefined,
      symbol: typeof f.symbol === "string" ? f.symbol : undefined,
      dev: typeof f.traderPublicKey === "string" ? f.traderPublicKey : undefined,
      curveAccount: typeof f.bondingCurveKey === "string" ? f.bondingCurveKey : undefined,
      pool: typeof f.pool === "string" ? f.pool : undefined,
      signature: typeof f.signature === "string" ? f.signature : undefined,
    },
    receivedAt,
  );
  // Only a row this feed had not seen is news. A poll that listed the mint
  // first has already shown it; the push then only adds its curve key.
  if (added) {
    const label = f.symbol || short(f.mint);
    emitLiveEvent({
      kind: "launch_seen",
      ts: receivedAt,
      mint: f.mint,
      wallet: typeof f.traderPublicKey === "string" ? f.traderPublicKey : undefined,
      symbol: f.symbol || undefined,
      headline: `LAUNCH PUSHED · ${label}`,
      detail:
        `${f.name || f.symbol || f.mint}: creation pushed by ${PUSH_SOURCE}, received at ` +
        `${new Date(receivedAt).toISOString()} on this machine's clock (uncorrected)` +
        (f.traderPublicKey ? `. Deployer ${short(f.traderPublicKey)}` : "") +
        (f.bondingCurveKey ? `, curve ${short(f.bondingCurveKey)}` : "") +
        ". The frame carries no creation time; the launch feed dates the row when a poll lists it.",
      real: true,
      source: PUSH_SOURCE,
    });
  }
  return added;
}

let holds = 0;

/** The socket, created on first use and registered for /status. */
export function pumpPortalSocket(): ReconnectingSocket {
  const existing = socketByName(PUMPPORTAL_NAME);
  if (existing) return existing;
  const sock = new ReconnectingSocket({
    name: PUMPPORTAL_NAME,
    url: PUMPPORTAL_URL,
    heartbeat: { ...PUMPPORTAL_HEARTBEAT, ping: () => ({ method: "ping" }) },
    onMessage: (msg, at) => {
      handlePumpPortalFrame(msg, at);
    },
  });
  sock.subscribe({
    key: "newToken",
    request: () => ({ method: "subscribeNewToken" }),
    // Verbatim from the probe: {"message":"Successfully subscribed to token creation events."}
    isAck: (msg) => {
      const m = msg as { message?: unknown } | null;
      return Boolean(m && typeof m === "object" && typeof m.message === "string" && /subscribed/i.test(m.message));
    },
  });
  return registerSocket(sock);
}

/**
 * Keep the socket open while the caller needs it. Returns the release.
 *
 * Reference-counted so two holders (a visible launches page and, one day, an
 * armed launch rule) do not close each other's socket.
 */
export function holdPumpPortal(): () => void {
  holds++;
  pumpPortalSocket().connect();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) pumpPortalSocket().disconnect("nothing is watching the launch feed");
  };
}

export function pumpPortalHolds(): number {
  return holds;
}
