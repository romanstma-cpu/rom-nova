// The trade firehose: one keyless logsSubscribe on the pump.fun program.
//
// Probed 2026-09-03 against wss://solana-rpc.publicnode.com: ~220
// notifications/s at ~284 KB/s, of which ~34/s decode as TradeEvents. One
// subscription therefore sees EVERY pump.fun bonding-curve trade by every
// wallet — whale discovery and tracked-wallet journaling are both just
// filters over it, and no per-wallet or per-token subscription budget
// exists to run out of.
//
// `confirmed` commitment, deliberately: `processed` also delivers trades from
// forks that never land, and a journaling engine must not score fills that
// did not happen. What this stream can never see: trades after a token
// migrates off the bonding curve, and trades on other venues — that boundary
// is printed on /health and in the app, not papered over.

import { decodeLogsValue, PUMP_PROGRAM } from "./decode.js";
import { ReconnectingWs } from "./sockets.js";

/**
 * @param {import("./config.js").Config} cfg
 * @param {(trade: import("./decode.js").PumpTrade & { signature?: string }) => void} onTrade
 */
export function startRpcStream(cfg, onTrade) {
  let decoded = 0;
  const ws = new ReconnectingWs({
    name: "rpc-logs",
    url: cfg.rpcWsUrl,
    onOpenSend: () => [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }],
      },
    ],
    // A healthy subscription never has five quiet seconds; fifteen means the
    // upstream dropped us without a close frame.
    silenceMs: 15_000,
    ping: undefined,
    onMessage: (msg) => {
      if (msg?.method !== "logsNotification") return;
      const value = msg.params?.result?.value;
      const signature = typeof value?.signature === "string" ? value.signature : undefined;
      for (const trade of decodeLogsValue(value)) {
        decoded++;
        onTrade({ ...trade, signature });
      }
    },
  });
  ws.start();
  return Object.assign(ws, {
    decodedCount: () => decoded,
  });
}
