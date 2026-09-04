// The Radar worker's TradeEvent decoder, pinned against constructed frames
// laid out exactly as the live probe measured them (2026-09-03, publicnode).

import { describe, expect, it } from "vitest";
import { decodeLogsValue, decodeTradeLine, TRADE_DISCRIMINATOR } from "../worker/src/decode.js";
import { base58 } from "../worker/src/util.js";

const MINT_BYTES = new Uint8Array(32).fill(3);
const USER_BYTES = new Uint8Array(32).fill(7);
const MINT = base58(MINT_BYTES);
const USER = base58(USER_BYTES);

function tradeLine(opts: {
  sol?: bigint;
  tok?: bigint;
  isBuy?: number;
  ts?: bigint;
  vSol?: bigint;
  disc?: string;
  truncateAt?: number;
}): string {
  // BigInt() calls, not literals — the app tsconfig targets ES2017 and these
  // values are all exactly representable on the way in.
  const buf = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8);
  Buffer.from(opts.disc ?? TRADE_DISCRIMINATOR, "hex").copy(buf, 0);
  Buffer.from(MINT_BYTES).copy(buf, 8);
  buf.writeBigUInt64LE(opts.sol ?? BigInt(1_500_000_000), 40); // 1.5 SOL
  buf.writeBigUInt64LE(opts.tok ?? BigInt(3_000_000_000), 48); // 3,000 tokens at 6 decimals
  buf.writeUInt8(opts.isBuy ?? 1, 56);
  Buffer.from(USER_BYTES).copy(buf, 57);
  buf.writeBigInt64LE(opts.ts ?? BigInt(1_788_484_270), 89);
  buf.writeBigUInt64LE(opts.vSol ?? BigInt(42_000_000_000), 97);
  buf.writeBigUInt64LE(BigInt(1), 105);
  const body = opts.truncateAt !== undefined ? buf.subarray(0, opts.truncateAt) : buf;
  return "Program data: " + Buffer.from(body).toString("base64");
}

describe("decodeTradeLine", () => {
  it("round-trips a buy with amounts, price, chain time and reserves", () => {
    const t = decodeTradeLine(tradeLine({}));
    expect(t).not.toBeNull();
    expect(t!.mint).toBe(MINT);
    expect(t!.user).toBe(USER);
    expect(t!.isBuy).toBe(true);
    expect(t!.sol).toBeCloseTo(1.5, 9);
    expect(t!.tokens).toBeCloseTo(3_000, 6);
    expect(t!.priceSol).toBeCloseTo(1.5 / 3_000, 12);
    expect(t!.chainTs).toBe(1_788_484_270_000);
    expect(t!.vSol).toBeCloseTo(42, 9);
  });

  it("reads a sell", () => {
    const t = decodeTradeLine(tradeLine({ isBuy: 0 }));
    expect(t!.isBuy).toBe(false);
  });

  it("rejects a wrong discriminator — the create/complete events must not decode as trades", () => {
    expect(decodeTradeLine(tradeLine({ disc: "31487b2d6e40b085" }))).toBeNull();
  });

  it("rejects an isBuy byte outside {0,1}", () => {
    expect(decodeTradeLine(tradeLine({ isBuy: 7 }))).toBeNull();
  });

  it("rejects a buffer shorter than the prefix", () => {
    expect(decodeTradeLine(tradeLine({ truncateAt: 60 }))).toBeNull();
  });

  it("survives an event truncated before the reserves — vSol becomes null, not zero", () => {
    const t = decodeTradeLine(tradeLine({ truncateAt: 97 }));
    expect(t).not.toBeNull();
    expect(t!.vSol).toBeNull();
  });

  it("ignores non-data log lines", () => {
    expect(decodeTradeLine("Program log: Instruction: Buy")).toBeNull();
  });
});

describe("decodeLogsValue", () => {
  it("skips failed transactions entirely — their fills did not happen", () => {
    expect(decodeLogsValue({ err: { InstructionError: [0, "Custom"] }, logs: [tradeLine({})] })).toEqual([]);
  });

  it("decodes every trade event in a successful transaction", () => {
    const out = decodeLogsValue({ err: null, logs: ["Program log: x", tradeLine({}), tradeLine({ isBuy: 0 })] });
    expect(out).toHaveLength(2);
    expect(out[0].isBuy).toBe(true);
    expect(out[1].isBuy).toBe(false);
  });
});
