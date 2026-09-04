// pump.fun TradeEvent, straight off the program's own logs.
//
// Every pump.fun bonding-curve trade emits an anchor event as a
// "Program data: <base64>" log line. Probed live 2026-09-03 against
// wss://solana-rpc.publicnode.com with logsSubscribe on the program:
// 1,378 events in 40s decoded under this layout with sane amounts, buy/sell
// flags in {0,1}, and chain timestamps matching the wall clock —
//
//   offset  field                 type
//   0       discriminator         8 bytes = bddb7fd34ee661ee
//   8       mint                  32 bytes
//   40      solAmount             u64 LE, lamports
//   48      tokenAmount           u64 LE, raw (pump.fun mints are 6 decimals)
//   56      isBuy                 u8
//   57      user                  32 bytes
//   89      timestamp             i64 LE, unix seconds (the chain's clock)
//   97      virtualSolReserves    u64 LE, lamports
//   105     virtualTokenReserves  u64 LE, raw
//
// Later program versions append fields (real reserves, fee accounts); prefix
// decoding survives appends, which is why only the prefix is read.
//
// This file runs in TWO runtimes — the Radar worker under Node and the app's
// in-browser hunter — so it reads bytes through Uint8Array + DataView only.
// Buffer would be free in Node and a polyfill gamble in the browser bundle.

import { base58 } from "./util.js";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const TRADE_DISCRIMINATOR = "bddb7fd34ee661ee";

const PREFIX = "Program data: ";
const MIN_LEN = 8 + 32 + 8 + 8 + 1 + 32 + 8; // through timestamp
const WITH_RESERVES = MIN_LEN + 16;

/** Raw-unit → human conversions, in one place. */
export const LAMPORTS = 1e9;
export const PUMP_TOKEN_RAW = 1e6;

/**
 * @param {string} s
 * @returns {Uint8Array | null}
 */
function fromBase64(s) {
  try {
    if (typeof Buffer !== "undefined") return Buffer.from(s, "base64");
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** @param {Uint8Array} bytes @param {number} from @param {number} to */
function hexOf(bytes, from, to) {
  let out = "";
  for (let i = from; i < to; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** A DataView that respects the Uint8Array's own offset into its buffer. */
const viewOf = (/** @type {Uint8Array} */ b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * @typedef {object} PumpTrade
 * @property {string} mint
 * @property {string} user
 * @property {boolean} isBuy
 * @property {number} sol        SOL (not lamports)
 * @property {number} tokens     whole tokens (not raw)
 * @property {number} priceSol   SOL per token at this fill
 * @property {number} chainTs    ms epoch, from the event's own timestamp
 * @property {number | null} vSol curve's virtual SOL reserves after the fill, or null on a short event
 */

/**
 * Decode one log line. Returns null for anything that is not a TradeEvent —
 * which is most lines: creates, completes, ATA chatter, vote noise.
 *
 * @param {string} line one entry of a logsNotification's `logs` array
 * @returns {PumpTrade | null}
 */
export function decodeTradeLine(line) {
  if (!line.startsWith(PREFIX)) return null;
  const buf = fromBase64(line.slice(PREFIX.length));
  if (!buf || buf.length < MIN_LEN) return null;
  if (hexOf(buf, 0, 8) !== TRADE_DISCRIMINATOR) return null;

  const isBuyByte = buf[56];
  if (isBuyByte !== 0 && isBuyByte !== 1) return null;

  const view = viewOf(buf);
  const sol = Number(view.getBigUint64(40, true)) / LAMPORTS;
  const tokens = Number(view.getBigUint64(48, true)) / PUMP_TOKEN_RAW;
  return {
    mint: base58(buf.subarray(8, 40)),
    user: base58(buf.subarray(57, 89)),
    isBuy: isBuyByte === 1,
    sol,
    tokens,
    priceSol: tokens > 0 ? sol / tokens : 0,
    chainTs: Number(view.getBigInt64(89, true)) * 1000,
    vSol: buf.length >= WITH_RESERVES ? Number(view.getBigUint64(97, true)) / LAMPORTS : null,
  };
}

/**
 * Decode a whole logsNotification. Failed transactions are skipped — their
 * events describe fills that did not happen.
 *
 * @param {{ signature?: string, err?: unknown, logs?: string[] }} value
 *   `params.result.value` of a logsNotification
 * @returns {PumpTrade[]}
 */
export function decodeLogsValue(value) {
  if (!value || value.err !== null || !Array.isArray(value.logs)) return [];
  const out = [];
  for (const line of value.logs) {
    const t = decodeTradeLine(line);
    if (t) out.push(t);
  }
  return out;
}
