// Recovering a fill from a transaction, and refusing to when it cannot be done.
//
// The failure mode here is not a crash; it is a plausible number. A misread
// quote leg produces a price that looks like a price, flows into FIFO, and
// comes out the other end as a confident PnL figure nobody can audit. Every
// case below is one specific way this file could invent one.

import { describe, it, expect } from "vitest";
import {
  fillsFromTx,
  walletMintDeltas,
  nativeQuoteLamports,
  isPlausibleAddress,
  MIN_SOL_LEG_LAMPORTS,
  WSOL,
  type ParsedTx,
} from "@/lib/providers/wallet-chain";
import type { SolBar } from "@/lib/providers/sol-history";

const WALLET = "EmNnGUq5eeVRhU175SswgkUWiVD3E6gagJKQE6aomqRK";
const OTHER = "7JCe3GfEcAcpBcNrEvXkPZoM5nJhH8b7vJgFvnHLXzTr";
const TOKEN = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** SOL at exactly $100, so any arithmetic error is visible by eye. */
const BARS: SolBar[] = [
  { t: 1_700_000_000_000 - 3_600_000, close: 100 },
  { t: 1_700_000_000_000, close: 100 },
];
const TS = 1_700_000_000_000 + 60_000;

interface BalanceSpec {
  idx: number;
  mint: string;
  owner: string;
  amount: string;
  decimals: number;
}

function tx(spec: {
  keys?: string[];
  fee?: number;
  pre?: BalanceSpec[];
  post?: BalanceSpec[];
  lamports?: Record<number, [number, number]>;
  err?: unknown;
}): ParsedTx {
  const keys = spec.keys ?? [WALLET];
  const preBalances = keys.map((_, i) => spec.lamports?.[i]?.[0] ?? 0);
  const postBalances = keys.map((_, i) => spec.lamports?.[i]?.[1] ?? 0);
  const row = (b: BalanceSpec) => ({
    accountIndex: b.idx,
    mint: b.mint,
    owner: b.owner,
    uiTokenAmount: { amount: b.amount, decimals: b.decimals },
  });
  return {
    slot: 1,
    blockTime: TS / 1000,
    transaction: { signatures: ["sig1"], message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
    meta: {
      err: spec.err ?? null,
      fee: spec.fee ?? 5000,
      preBalances,
      postBalances,
      preTokenBalances: (spec.pre ?? []).map(row),
      postTokenBalances: (spec.post ?? []).map(row),
    },
  };
}

describe("walletMintDeltas — only this wallet's accounts count", () => {
  it("ignores balances owned by anyone else", () => {
    const d = walletMintDeltas(
      tx({
        pre: [{ idx: 1, mint: TOKEN, owner: OTHER, amount: "100", decimals: 6 }],
        post: [{ idx: 1, mint: TOKEN, owner: OTHER, amount: "900", decimals: 6 }],
      }),
      WALLET,
    );
    expect(d).toHaveLength(0);
  });

  // An account absent from preTokenBalances was created by this transaction.
  it("treats a created account as having started at zero", () => {
    const d = walletMintDeltas(
      tx({ post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500", decimals: 6 }] }),
      WALLET,
    );
    expect(d[0].delta).toBe(BigInt(500));
  });

  // Absent from postTokenBalances means closed, which means emptied.
  it("treats a closed account as having ended at zero", () => {
    const d = walletMintDeltas(
      tx({ pre: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500", decimals: 6 }] }),
      WALLET,
    );
    expect(d[0].delta).toBe(BigInt(-500));
  });

  // A wallet can hold several accounts for one mint; reading only one would
  // understate the move and, worse, do it inconsistently between pre and post.
  it("sums several accounts of the same mint", () => {
    const d = walletMintDeltas(
      tx({
        pre: [
          { idx: 1, mint: TOKEN, owner: WALLET, amount: "100", decimals: 6 },
          { idx: 2, mint: TOKEN, owner: WALLET, amount: "100", decimals: 6 },
        ],
        post: [
          { idx: 1, mint: TOKEN, owner: WALLET, amount: "400", decimals: 6 },
          { idx: 2, mint: TOKEN, owner: WALLET, amount: "100", decimals: 6 },
        ],
      }),
      WALLET,
    );
    expect(d).toHaveLength(1);
    expect(d[0].delta).toBe(BigInt(300));
  });

  it("drops a mint whose balance did not change", () => {
    const d = walletMintDeltas(
      tx({
        pre: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "100", decimals: 6 }],
        post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "100", decimals: 6 }],
      }),
      WALLET,
    );
    expect(d).toHaveLength(0);
  });

  // SPL amounts routinely exceed 2^53. Number would round the big ones.
  it("keeps precision past Number.MAX_SAFE_INTEGER", () => {
    const d = walletMintDeltas(
      tx({
        pre: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "8799457825361551324", decimals: 9 }],
        post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "8799457825361551325", decimals: 9 }],
      }),
      WALLET,
    );
    expect(d[0].delta).toBe(BigInt(1));
  });
});

describe("nativeQuoteLamports — fee and rent are not part of the price", () => {
  it("adds the fee back when this wallet paid it", () => {
    // Wallet spent 1 SOL plus a 5000-lamport fee. The trade was 1 SOL.
    const t = tx({ keys: [WALLET], fee: 5000, lamports: { 0: [2_000_000_000, 999_995_000] } });
    expect(nativeQuoteLamports(t, WALLET, [])).toBe(-1_000_000_000);
  });

  it("does not add a fee this wallet did not pay", () => {
    const t = tx({ keys: [OTHER, WALLET], fee: 5000, lamports: { 1: [1_000, 1_000] } });
    expect(nativeQuoteLamports(t, WALLET, [])).toBe(0);
  });

  // Rent moving from the wallet into an account the wallet still owns has not
  // left the wallet. Counting it would read as a 0.00204 SOL purchase.
  it("cancels rent paid into this wallet's own new token account", () => {
    const t = tx({
      keys: [WALLET, "AtaAddress1111111111111111111111111111111111"],
      fee: 0,
      lamports: { 0: [5_000_000, 2_960_720], 1: [0, 2_039_280] },
      post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500", decimals: 6 }],
    });
    const deltas = walletMintDeltas(t, WALLET);
    expect(nativeQuoteLamports(t, WALLET, deltas)).toBe(0);
  });

  // Wrapped SOL is excluded from that correction: its lamports ARE the traded
  // SOL, and cancelling them would erase the trade.
  it("leaves a wrapped-SOL account out of the rent correction", () => {
    const t = tx({
      keys: [WALLET, "WsolAta11111111111111111111111111111111111111"],
      fee: 0,
      lamports: { 0: [5_000_000_000, 4_000_000_000], 1: [0, 1_000_000_000] },
      post: [{ idx: 1, mint: WSOL, owner: WALLET, amount: "1000000000", decimals: 9 }],
    });
    const deltas = walletMintDeltas(t, WALLET);
    expect(nativeQuoteLamports(t, WALLET, deltas)).toBe(-1_000_000_000);
  });
});

describe("fillsFromTx — a price, or an honest absence of one", () => {
  it("prices a stablecoin-quoted buy at one dollar", () => {
    const fills = fillsFromTx(
      tx({
        pre: [{ idx: 2, mint: USDC, owner: WALLET, amount: "100000000", decimals: 6 }],
        post: [
          { idx: 1, mint: TOKEN, owner: WALLET, amount: "200000000", decimals: 6 },
          { idx: 2, mint: USDC, owner: WALLET, amount: "0", decimals: 6 },
        ],
      }),
      WALLET,
      BARS,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0].side).toBe("buy");
    expect(fills[0].tokens).toBe(200);
    expect(fills[0].valueUsd).toBe(100);
    expect(fills[0].priceUsd).toBeCloseTo(0.5, 10);
    expect(fills[0].pricing).toBe("stable");
  });

  it("prices a SOL-quoted sell at the SOL price for that hour", () => {
    const fills = fillsFromTx(
      tx({
        keys: [WALLET],
        fee: 5000,
        // Sold tokens for 2 SOL. At $100/SOL that is $200.
        lamports: { 0: [1_000_000_000, 2_999_995_000] },
        pre: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "400000000", decimals: 6 }],
        post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "0", decimals: 6 }],
      }),
      WALLET,
      BARS,
    );
    expect(fills[0].side).toBe("sell");
    expect(fills[0].quoteMint).toBe(WSOL);
    expect(fills[0].quoteAmount).toBeCloseTo(2, 9);
    expect(fills[0].valueUsd).toBeCloseTo(200, 6);
    expect(fills[0].priceUsd).toBeCloseTo(0.5, 9);
  });

  // Measured on real wallets: 46% of token movements look like this. The tokens
  // arrived and nothing this wallet owned went the other way.
  it("refuses to price a movement with no quote leg", () => {
    const fills = fillsFromTx(
      tx({ post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500000000", decimals: 6 }] }),
      WALLET,
      BARS,
    );
    expect(fills[0].pricing).toBe("unpriced");
    expect(fills[0].priceUsd).toBeUndefined();
    expect(fills[0].valueUsd).toBeUndefined();
    expect(fills[0].classification).toBe("transfer");
    // The direction is still real: tokens came in.
    expect(fills[0].side).toBe("buy");
    expect(fills[0].tokens).toBe(500);
  });

  // The case that surprised the probe: a Jupiter swap signed and paid for by
  // somebody else, delivering tokens here. Real tokens, someone else's cost.
  it("names a third-party-paid transaction rather than guessing a price", () => {
    const fills = fillsFromTx(
      tx({
        keys: [OTHER, WALLET],
        post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500000000", decimals: 6 }],
      }),
      WALLET,
      BARS,
    );
    expect(fills[0].pricing).toBe("unpriced");
    expect(fills[0].unpricedReason).toMatch(/another wallet signed and paid/i);
  });

  // A token-for-token rotation has one quote leg belonging to two sides, or
  // none at all. Attributing it to either would invent the split.
  it("emits both legs of a rotation unpriced", () => {
    const fills = fillsFromTx(
      tx({
        pre: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500000000", decimals: 6 }],
        post: [{ idx: 2, mint: "MintBBBB1111111111111111111111111111111111", owner: WALLET, amount: "900", decimals: 0 }],
      }),
      WALLET,
      BARS,
    );
    expect(fills).toHaveLength(2);
    expect(fills.every((f) => f.pricing === "unpriced")).toBe(true);
    expect(fills.every((f) => f.priceUsd === undefined)).toBe(true);
    // UNPRICED IS NOT UNTRADED. All four unpriceable situations used to be
    // stamped "transfer", which read as "nobody paid for this" the moment
    // anything said the classification out loud — over a swap.
    expect(fills.every((f) => f.classification === "rotate")).toBe(true);
  });

  it("calls a same-direction pair a pool movement, not a transfer", () => {
    // Base and quote both leaving is a deposit, not a swap: the ratio of the
    // two numbers is not a price, and neither is it a gift.
    const fills = fillsFromTx(
      tx({
        pre: [
          { idx: 1, mint: TOKEN, owner: WALLET, amount: "500000000", decimals: 6 },
          { idx: 2, mint: WSOL, owner: WALLET, amount: "2000000000", decimals: 9 },
        ],
        post: [
          { idx: 1, mint: TOKEN, owner: WALLET, amount: "100000000", decimals: 6 },
          { idx: 2, mint: WSOL, owner: WALLET, amount: "1000000000", decimals: 9 },
        ],
      }),
      WALLET,
      BARS,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0].classification).toBe("lp");
    expect(fills[0].pricing).toBe("unpriced");
  });

  // Rent is 0.00204 SOL. A leg below the floor is mostly rent, and a price
  // derived from it would be off by tens of percent.
  it("leaves a SOL leg smaller than the rent floor unpriced", () => {
    const fills = fillsFromTx(
      tx({
        keys: [WALLET],
        fee: 0,
        lamports: { 0: [10_000_000, 10_000_000 - (MIN_SOL_LEG_LAMPORTS - 1)] },
        post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500000000", decimals: 6 }],
      }),
      WALLET,
      BARS,
    );
    expect(fills[0].pricing).toBe("unpriced");
    expect(fills[0].unpricedReason).toMatch(/account rent/i);
  });

  // Both legs moving the same way is a deposit, not a swap; their ratio is not
  // a price.
  it("refuses when base and quote both increase", () => {
    const fills = fillsFromTx(
      tx({
        post: [
          { idx: 1, mint: TOKEN, owner: WALLET, amount: "500000000", decimals: 6 },
          { idx: 2, mint: USDC, owner: WALLET, amount: "100000000", decimals: 6 },
        ],
      }),
      WALLET,
      BARS,
    );
    expect(fills[0].pricing).toBe("unpriced");
    expect(fills[0].unpricedReason).toMatch(/same way/i);
  });

  // Without a SOL bar covering the hour, the trade is real and its dollar value
  // is not. Reaching for today's SOL price would misstate an old entry badly —
  // SOL moved $74 to $105 inside the readable series.
  it("keeps the SOL leg but drops the USD when no bar covers the fill", () => {
    const fills = fillsFromTx(
      tx({
        keys: [WALLET],
        fee: 0,
        lamports: { 0: [3_000_000_000, 1_000_000_000] },
        post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "400000000", decimals: 6 }],
      }),
      WALLET,
      [],
    );
    expect(fills[0].quoteAmount).toBeCloseTo(2, 9);
    expect(fills[0].priceUsd).toBeUndefined();
    expect(fills[0].pricing).toBe("unpriced");
  });

  it("ignores a failed transaction entirely", () => {
    const fills = fillsFromTx(
      tx({
        err: { InstructionError: [0, "Custom"] },
        post: [{ idx: 1, mint: TOKEN, owner: WALLET, amount: "500", decimals: 6 }],
      }),
      WALLET,
      BARS,
    );
    expect(fills).toHaveLength(0);
  });

  it("produces nothing for a transaction that moved no non-quote token", () => {
    const fills = fillsFromTx(
      tx({
        pre: [{ idx: 1, mint: USDC, owner: WALLET, amount: "100", decimals: 6 }],
        post: [{ idx: 1, mint: USDC, owner: WALLET, amount: "900", decimals: 6 }],
      }),
      WALLET,
      BARS,
    );
    expect(fills).toHaveLength(0);
  });
});

describe("isPlausibleAddress", () => {
  it("accepts a real Solana pubkey", () => {
    expect(isPlausibleAddress(WALLET)).toBe(true);
  });

  // Base58 has no 0, O, I or l. Rejecting them here saves a pointless request
  // and, more usefully, tells the user it was a typo rather than a dead wallet.
  it("rejects the base58-excluded characters", () => {
    expect(isPlausibleAddress("0".repeat(44))).toBe(false);
    expect(isPlausibleAddress("O".repeat(44))).toBe(false);
    expect(isPlausibleAddress("l".repeat(44))).toBe(false);
  });

  it("rejects anything the wrong length", () => {
    expect(isPlausibleAddress("abc")).toBe(false);
    expect(isPlausibleAddress("a".repeat(45))).toBe(false);
    expect(isPlausibleAddress("")).toBe(false);
  });
});
