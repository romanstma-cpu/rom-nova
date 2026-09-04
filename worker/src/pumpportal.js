// PumpPortal creations — the launch stream.
//
// Same socket the app holds on its launches page, same measured facts: the
// public data endpoint answers subscribeNewToken keylessly at 27–58 creations
// a minute, and its trade subscriptions do NOT work here — probed again
// 2026-09-03, they answer "only available when connecting with an API key
// funded with at least 0.02 SOL". Trades come from the RPC program stream
// instead (rpcstream.js), which needs no key at all.

import { ReconnectingWs } from "./sockets.js";

/**
 * @param {import("./config.js").Config} cfg
 * @param {(launch: { mint: string, name?: string, symbol?: string, dev?: string, vSol?: number | null, signature?: string }, at: number) => void} onLaunch
 */
export function startPumpPortal(cfg, onLaunch) {
  const ws = new ReconnectingWs({
    name: "pumpportal",
    url: cfg.pumpPortalUrl,
    onOpenSend: () => [{ method: "subscribeNewToken" }],
    // Creations arrive every 1–2s on a normal afternoon; a minute of silence
    // is a dead socket. The server answers unknown methods in ~60ms, which is
    // all the ping needs to prove.
    silenceMs: 60_000,
    ping: () => ({ method: "ping" }),
    onMessage: (msg, at) => {
      if (!msg || typeof msg !== "object" || msg.txType !== "create" || typeof msg.mint !== "string") return;
      // Reserve fields observed on live creation frames; absent ones stay
      // null rather than becoming a guessed zero.
      const vSol =
        typeof msg.vSolInBondingCurve === "number"
          ? msg.vSolInBondingCurve
          : typeof msg.solInPool === "number"
            ? msg.solInPool
            : null;
      onLaunch(
        {
          mint: msg.mint,
          name: typeof msg.name === "string" ? msg.name : undefined,
          symbol: typeof msg.symbol === "string" ? msg.symbol : undefined,
          dev: typeof msg.traderPublicKey === "string" ? msg.traderPublicKey : undefined,
          vSol,
          signature: typeof msg.signature === "string" ? msg.signature : undefined,
        },
        at,
      );
    },
  });
  ws.start();
  return ws;
}
