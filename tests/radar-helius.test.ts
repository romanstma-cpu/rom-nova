// The optional Helius off-curve parser: a wallet's own balance deltas read
// out of a jsonParsed transaction. Fixtures shaped like getTransaction's
// jsonParsed output — the structural half of a path that has not yet run
// against a live key (the module says so on /health).

import { describe, expect, it } from "vitest";
import { PUMP_PROGRAM } from "../worker/src/decode.js";
import { parseHeliusTx } from "../worker/src/helius.js";

const WALLET = "TrackedWallet1111111111111111111111111111111";

function tx(opts: {
  err?: unknown;
  keys?: string[];
  preLamports?: number[];
  postLamports?: number[];
  preTok?: { mint: string; owner: string; ui: number }[];
  postTok?: { mint: string; owner: string; ui: number }[];
  blockTime?: number;
}) {
  const bal = (b: { mint: string; owner: string; ui: number }) => ({
    accountIndex: 9,
    mint: b.mint,
    owner: b.owner,
    uiTokenAmount: { uiAmount: b.ui, decimals: 6, amount: String(b.ui * 1e6) },
  });
  return {
    blockTime: opts.blockTime ?? 1_788_484_270,
    meta: {
      err: opts.err ?? null,
      preBalances: opts.preLamports ?? [10_000_000_000],
      postBalances: opts.postLamports ?? [10_000_000_000],
      preTokenBalances: (opts.preTok ?? []).map(bal),
      postTokenBalances: (opts.postTok ?? []).map(bal),
    },
    transaction: { message: { accountKeys: (opts.keys ?? [WALLET]).map((pubkey) => ({ pubkey })) } },
  };
}

describe("parseHeliusTx", () => {
  it("reads a buy: token up, SOL down", () => {
    const fills = parseHeliusTx(
      tx({
        preLamports: [10_000_000_000],
        postLamports: [7_995_000_000], // spent ~2.005 SOL incl. fee
        preTok: [],
        postTok: [{ mint: "MINTX", owner: WALLET, ui: 5000 }],
      }),
      WALLET,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0].isBuy).toBe(true);
    expect(fills[0].mint).toBe("MINTX");
    expect(fills[0].tokens).toBeCloseTo(5000, 6);
    expect(fills[0].sol).toBeCloseTo(2.005, 6);
    expect(fills[0].chainTs).toBe(1_788_484_270_000);
  });

  it("reads a sell: token down, SOL up", () => {
    const fills = parseHeliusTx(
      tx({
        preLamports: [5_000_000_000],
        postLamports: [6_500_000_000],
        preTok: [{ mint: "MINTX", owner: WALLET, ui: 5000 }],
        postTok: [{ mint: "MINTX", owner: WALLET, ui: 1000 }],
      }),
      WALLET,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0].isBuy).toBe(false);
    expect(fills[0].tokens).toBeCloseTo(4000, 6);
    expect(fills[0].sol).toBeCloseTo(1.5, 6);
  });

  it("skips pump.fun transactions — the program stream already carries them", () => {
    const fills = parseHeliusTx(
      tx({
        keys: [WALLET, PUMP_PROGRAM],
        postTok: [{ mint: "MINTX", owner: WALLET, ui: 5000 }],
        preLamports: [10_000_000_000, 0],
        postLamports: [8_000_000_000, 0],
      }),
      WALLET,
    );
    expect(fills).toEqual([]);
  });

  it("skips failed transactions", () => {
    expect(parseHeliusTx(tx({ err: { InstructionError: [0, {}] } }), WALLET)).toEqual([]);
  });

  it("does not invent a trade from a transfer-in — token up with SOL up is not a buy", () => {
    const fills = parseHeliusTx(
      tx({
        preLamports: [5_000_000_000],
        postLamports: [5_000_000_000],
        postTok: [{ mint: "MINTX", owner: WALLET, ui: 5000 }],
      }),
      WALLET,
    );
    expect(fills).toEqual([]);
  });

  it("ignores other owners' balances in the same transaction", () => {
    const fills = parseHeliusTx(
      tx({
        preLamports: [10_000_000_000],
        postLamports: [9_000_000_000],
        postTok: [{ mint: "MINTX", owner: "SomeoneElse", ui: 5000 }],
      }),
      WALLET,
    );
    expect(fills).toEqual([]);
  });
});
