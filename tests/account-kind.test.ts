// Is this address a wallet at all?
//
// The blind review pasted a token mint into the wallet page and got back
// "REAL · SOLANA, $520.8K portfolio, 144 positions". It pasted the Raydium AMM
// program and got a trader with no labels. Neither number was arithmetically
// wrong — a mint really does own token accounts — they were answers to a
// question nobody asked, and presenting a token's own liquidity as somebody's
// book is the most confidently wrong this app has been.

import { describe, it, expect } from "vitest";
import { classifyAccount, decodeAddress, isOnCurve, KNOWN_ADDRESSES } from "@/lib/providers/account-kind";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Ground truth for the curve check, spanning both answers. The off-curve entry
// is the address that shipped broken: Solscan's page for it says
// isOnCurve: FALSE and titles it Raydium Authority V4.
const RAYDIUM_AUTHORITY_V4 = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const REAL_KEYPAIRS = [
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", // exchange hot wallet
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK mint (mints are keypairs)
  "AN47o2eFxxMakqU1SNjLCE4YCPwoDJ83tzumk8Ec2wQ7", // retail trader
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM program id
];

describe("isOnCurve — the PDA test, offline", () => {
  it("rejects the Raydium Authority V4, the address that profiled as a trader", () => {
    // System-owned with no data, so the ownership test called it a wallet and
    // the page printed "win rate 50%, profit factor 4.38" for a pool's churn.
    // Off-curve is the chain fact that separates it from every real wallet.
    expect(isOnCurve(RAYDIUM_AUTHORITY_V4)).toBe(false);
  });

  it("accepts every real keypair address", () => {
    for (const a of REAL_KEYPAIRS) {
      expect(isOnCurve(a), `${a} is a real keypair and must be on-curve`).toBe(true);
    }
  });

  it("rejects garbage rather than guessing", () => {
    expect(isOnCurve("not-base58-0OIl")).toBe(false);
    expect(isOnCurve("")).toBe(false);
  });

  it("decodes to exactly 32 bytes or not at all", () => {
    expect(decodeAddress(RAYDIUM_AUTHORITY_V4)?.length).toBe(32);
    expect(decodeAddress("x".repeat(90))).toBeNull();
  });
});

describe("the curve verdict inside classifyAccount", () => {
  it("refuses a system-owned account at an off-curve address", () => {
    // The exact shape the Raydium authority presents: owner = System Program,
    // executable false, no data. Indistinguishable from a wallet by ownership.
    const id = classifyAccount({ owner: SYSTEM, executable: false }, RAYDIUM_AUTHORITY_V4);
    expect(id.kind).toBe("program-owned");
    expect(id.profilable).toBe(false);
    expect(id.detail).toMatch(/no private key can exist/i);
  });

  it("still accepts a system-owned account at an on-curve address", () => {
    const id = classifyAccount({ owner: SYSTEM, executable: false }, REAL_KEYPAIRS[0]);
    expect(id.kind).toBe("wallet");
    expect(id.profilable).toBe(true);
  });

  it("keeps working without an address, as every existing caller does", () => {
    expect(classifyAccount({ owner: SYSTEM, executable: false }).kind).toBe("wallet");
  });
});

describe("known constants and the empty copy", () => {
  it("names the burn address as what it is", () => {
    // The movers list showed it receiving $10.4K; one click later the wallet
    // page said it had "never been funded or used". Two adjacent screens,
    // two answers.
    const known = KNOWN_ADDRESSES["1nc1nerator11111111111111111111111111111111"];
    expect(known).toBeDefined();
    expect(known.profilable).toBe(false);
    expect(known.detail).toMatch(/BURN ADDRESS/);
  });

  it("no longer claims an absent system account was never used", () => {
    // getAccountInfo === null means no system account exists NOW. The burn
    // address owns thousands of token accounts and returns null here.
    const id = classifyAccount(null, REAL_KEYPAIRS[2]);
    expect(id.kind).toBe("empty");
    expect(id.detail).not.toMatch(/never been funded or used/);
    expect(id.detail).toMatch(/no system account/i);
  });
});

describe("classifyAccount", () => {
  it("accepts a system-owned account as a wallet", () => {
    const id = classifyAccount({ owner: SYSTEM, executable: false });
    expect(id.kind).toBe("wallet");
    expect(id.profilable).toBe(true);
  });

  // The one that shipped broken.
  it("refuses a token mint", () => {
    const id = classifyAccount({
      owner: TOKEN_PROGRAM,
      executable: false,
      data: { parsed: { type: "mint", info: { decimals: 6 } } },
    });
    expect(id.kind).toBe("mint");
    expect(id.profilable).toBe(false);
    expect(id.detail).toMatch(/token mint/i);
  });

  it("refuses an executable program however it is owned", () => {
    const id = classifyAccount({ owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true });
    expect(id.kind).toBe("program");
    expect(id.profilable).toBe(false);
  });

  // A token account is one wallet's holding of one mint. Profiling it would
  // report the holding as though it were the holder.
  it("refuses a token account and names its owner", () => {
    const id = classifyAccount({
      owner: TOKEN_PROGRAM,
      executable: false,
      data: { parsed: { type: "account", info: { owner: "EmNnGUq5eeVRhU175SswgkUWiVD3E6gagJKQE6aomqRK" } } },
    });
    expect(id.kind).toBe("token-account");
    expect(id.profilable).toBe(false);
    expect(id.detail).toMatch(/EmNnGUq5/);
  });

  it("handles Token-2022 accounts the same way", () => {
    const id = classifyAccount({
      owner: TOKEN_2022,
      executable: false,
      data: { parsed: { type: "account", info: {} } },
    });
    expect(id.kind).toBe("token-account");
  });

  it("refuses a program-derived account, which is a protocol's and not a person's", () => {
    const id = classifyAccount({ owner: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", executable: false });
    expect(id.kind).toBe("program-owned");
    expect(id.profilable).toBe(false);
  });

  // A valid key nobody has funded. Rendered "12/31/1969" before.
  it("names an empty account rather than profiling a void", () => {
    for (const empty of [null, undefined]) {
      const id = classifyAccount(empty);
      expect(id.kind).toBe("empty");
      expect(id.profilable).toBe(false);
      // Was "never been funded or used", which a null result cannot establish:
      // the burn address returns null here and owns thousands of token
      // accounts. The copy now claims only what the lookup measured.
      expect(id.detail).toMatch(/no system account/i);
    }
  });

  // A failed lookup is not evidence of anything. Refusing to profile a real
  // wallet because one request timed out trades a rare wrong answer for a
  // common missing one, so unknown stays profilable.
  it("treats an unchecked account as profilable", () => {
    const id = classifyAccount({ owner: SYSTEM, executable: false });
    expect(id.profilable).toBe(true);
  });
});
