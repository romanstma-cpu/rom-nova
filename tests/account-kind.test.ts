// Is this address a wallet at all?
//
// The blind review pasted a token mint into the wallet page and got back
// "REAL · SOLANA, $520.8K portfolio, 144 positions". It pasted the Raydium AMM
// program and got a trader with no labels. Neither number was arithmetically
// wrong — a mint really does own token accounts — they were answers to a
// question nobody asked, and presenting a token's own liquidity as somebody's
// book is the most confidently wrong this app has been.

import { describe, it, expect } from "vitest";
import { classifyAccount } from "@/lib/providers/account-kind";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

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
      expect(id.detail).toMatch(/never been funded/i);
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
