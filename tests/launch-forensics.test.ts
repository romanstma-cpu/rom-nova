// Launch forensics, pinned on fixtures of what the chain actually returns.
//
// The creation transaction mints the supply into the curve (a PDA) and the
// deployer's own buy; a bundle is a second wallet bought inside that same
// transaction; the creation slot and the next three are snipers; anything
// later is a trader and is not classified. Pool accounts never count as
// buyers, a wallet that added later is not "sold", and a token whose
// creation cannot be read is refused rather than zeroed.

import { describe, it, expect } from "vitest";
import type { ParsedTx } from "@/lib/providers/wallet-chain";
import { analyseWindow, applyHoldings, mintedSupply, ownerDeltas, SNIPE_SLOTS, type WindowTx } from "@/lib/providers/launch-forensics";

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const CURVE = "CurvePDAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const DEV = "DevWalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BUNDLE = "BundleWalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SNIPER0 = "Sniper0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SNIPER2 = "Sniper2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const LATE = "LateTraderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const isWallet = (o: string) => o !== CURVE;
const D = 6;
const raw = (tokens: number) => String(Math.round(tokens * 10 ** D));

function bal(owner: string, tokens: number, idx = 0) {
  return { accountIndex: idx, mint: MINT, owner, uiTokenAmount: { amount: raw(tokens), decimals: D } };
}

/**
 * Account keys are laid out the way the chain lays them out: the payer, the
 * mint, then one token account per owner — `ata-<owner>` — with every
 * balance row's `accountIndex` pointing at its owner's account.
 */
function tx(slot: number, payer: string, pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[], blockTime = 1_700_000_000): ParsedTx {
  const owners = [...new Set([...pre, ...post].map((r) => r.owner))];
  const keys = [{ pubkey: payer }, { pubkey: MINT }, ...owners.map((o) => ({ pubkey: `ata-${o}` }))];
  const index = (r: ReturnType<typeof bal>) => ({ ...r, accountIndex: 2 + owners.indexOf(r.owner) });
  return {
    slot,
    blockTime,
    transaction: { signatures: [`sig-${slot}-${payer.slice(0, 4)}`], message: { accountKeys: keys } },
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: pre.map(index), postTokenBalances: post.map(index) },
  };
}

const SUPPLY = 1_000_000_000;

/** The creation: supply minted to the curve, dev buys 30M, a bundled wallet buys 50M in the same tx. */
const createTx = tx(100, DEV, [], [bal(CURVE, SUPPLY - 80_000_000, 0), bal(DEV, 30_000_000, 1), bal(BUNDLE, 50_000_000, 2)]);

const window: WindowTx[] = [
  { tx: createTx, signature: "create" },
  // Same slot, different tx: a sniper takes 20M off the curve.
  { tx: tx(100, SNIPER0, [bal(CURVE, SUPPLY - 80_000_000)], [bal(CURVE, SUPPLY - 100_000_000), bal(SNIPER0, 20_000_000)]), signature: "s0" },
  // Slot +2: another 10M.
  { tx: tx(102, SNIPER2, [bal(CURVE, SUPPLY - 100_000_000)], [bal(CURVE, SUPPLY - 110_000_000), bal(SNIPER2, 10_000_000)]), signature: "s2" },
  // Slot +2: the bundled wallet dumps 40M of its 50M inside the window.
  { tx: tx(102, BUNDLE, [bal(BUNDLE, 50_000_000), bal(CURVE, SUPPLY - 110_000_000)], [bal(BUNDLE, 10_000_000), bal(CURVE, SUPPLY - 70_000_000)]), signature: "dump" },
  // Slot +9: a late trader — not a sniper, not classified.
  { tx: tx(109, LATE, [bal(CURVE, SUPPLY - 70_000_000)], [bal(CURVE, SUPPLY - 75_000_000), bal(LATE, 5_000_000)]), signature: "late" },
];

describe("deltas and supply", () => {
  it("differences balances per owner and treats an absent pre as zero", () => {
    const d = ownerDeltas(createTx, MINT).sort((a, b) => a.owner.localeCompare(b.owner));
    expect(d.map((x) => [x.owner, Number(x.delta) / 10 ** D])).toEqual(
      [
        [BUNDLE, 50_000_000],
        [CURVE, SUPPLY - 80_000_000],
        [DEV, 30_000_000],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });

  it("measures the minted supply from the creation's post balances, PDAs included", () => {
    expect(mintedSupply(createTx, MINT)).toEqual({ raw: BigInt(raw(SUPPLY)), decimals: D });
    expect(mintedSupply(tx(1, DEV, [], []), MINT)).toBeUndefined();
  });
});

describe("the launch window", () => {
  const a = analyseWindow(MINT, window, isWallet)!;

  it("names the deployer, its buy, and the measured supply", () => {
    expect(a.createSig).toBe("create");
    expect(a.createSlot).toBe(100);
    expect(a.supplyTokens).toBe(SUPPLY);
    expect(a.dev?.owner).toBe(DEV);
    expect(a.dev?.boughtTokens).toBe(30_000_000);
    expect(a.dev?.boughtPct).toBeCloseTo(0.03, 9);
  });

  it("remembers the token account each wallet bought into, for the balance read", () => {
    expect(a.bundled[0].account).toBe(`ata-${BUNDLE}`);
    expect(a.creationSlot[0].account).toBe(`ata-${SNIPER0}`);
    expect(a.dev?.account).toBe(`ata-${DEV}`);
  });

  it("separates bundled, creation-slot and next-slot buyers, and leaves the late trader out", () => {
    expect(a.bundled.map((w) => w.owner)).toEqual([BUNDLE]);
    expect(a.creationSlot.map((w) => w.owner)).toEqual([SNIPER0]);
    expect(a.nextSlots.map((w) => w.owner)).toEqual([SNIPER2]);
    expect(a.nextSlots[0].slotOffset).toBe(2);
    expect(a.nextSlots[0].slotOffset).toBeLessThanOrEqual(SNIPE_SLOTS);
    const all = [...a.bundled, ...a.creationSlot, ...a.nextSlots].map((w) => w.owner);
    expect(all).not.toContain(LATE);
    expect(all).not.toContain(CURVE);
  });

  it("computes bundler and sniper shares of the measured supply", () => {
    expect(a.bundlerPct).toBeCloseTo(0.05, 9);
    expect(a.sniperPct).toBeCloseTo(0.03, 9);
  });

  it("sees a dump inside the window", () => {
    expect(a.bundled[0].soldInWindowTokens).toBe(40_000_000);
    expect(a.windowTxs).toBe(5);
    expect(a.windowSlots).toBe(10);
  });

  it("refuses to invent shares when the creation carried no balances", () => {
    const bare = analyseWindow(MINT, [{ tx: tx(5, DEV, [], []), signature: "x" }], isWallet)!;
    expect(bare.supplyTokens).toBeUndefined();
    expect(bare.bundlerPct).toBeUndefined();
    expect(bare.sniperPct).toBeUndefined();
    expect(bare.dev?.owner).toBe(DEV);
  });

  it("returns nothing for an empty window", () => {
    expect(analyseWindow(MINT, [], isWallet)).toBeUndefined();
  });
});

describe("what is still held", () => {
  it("folds current balances into sold shares and never counts a later add as a sale", () => {
    const a = analyseWindow(MINT, window, isWallet)!;
    const held = applyHoldings(
      a,
      new Map([
        [BUNDLE, 10_000_000], // sold 80%
        [SNIPER0, 25_000_000], // added later: holds everything it bought
        [DEV, 0], // dev out
        // SNIPER2 not looked up
      ]),
    );
    expect(a.bundled[0].soldPct).toBeCloseTo(0.8, 9);
    expect(a.creationSlot[0].soldPct).toBe(0);
    expect(a.nextSlots[0].soldPct).toBeUndefined();
    expect(held.devSoldPct).toBe(1);
    // Of the two looked-up early wallets: bought 70M, still held min(10,50)+min(25,20)=30M.
    expect(held.earlyStillHeldPct).toBeCloseTo(30 / 70, 9);
  });
});
