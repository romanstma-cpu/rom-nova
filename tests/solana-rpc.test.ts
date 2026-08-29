// Reading the chain closes one gap and must not imply it closed the others.
//
// Solana's public RPC gives mint and freeze authority away for free, which is
// worth having: before this the app graded BONK as if its deployer could still
// mint, because every keyless provider reports both as not-revoked and the
// scorer takes that at face value.
//
// It does NOT give holder distribution — getTokenSupply and
// getTokenLargestAccounts return "Request blocked" on the free endpoints. So
// the interesting tests here are the ones that check the provider stays quiet
// about what it did not read.

import { describe, it, expect } from "vitest";
import { readMintInfo, authorityWarnings, RPC_ENDPOINTS } from "@/lib/providers/solana-rpc";

const mint = (over: Record<string, unknown> = {}) => ({
  result: {
    value: {
      data: {
        program: "spl-token",
        parsed: {
          type: "mint",
          info: {
            decimals: 5,
            freezeAuthority: null,
            mintAuthority: null,
            supply: "8799457825361551324",
            isInitialized: true,
            ...over,
          },
        },
      },
    },
  },
});

describe("readMintInfo", () => {
  it("parses a real mint account", () => {
    const info = readMintInfo(mint() as never);
    expect(info?.decimals).toBe(5);
    expect(info?.mintAuthority).toBeNull();
  });

  it("keeps a live authority as the address, not a boolean", () => {
    const info = readMintInfo(mint({ mintAuthority: "BQ72nSv9d3pRxXZ3JBEEwmMBM3sZ4yJ8xTa6zTsxN2yJ" }) as never);
    expect(info?.mintAuthority).toBe("BQ72nSv9d3pRxXZ3JBEEwmMBM3sZ4yJ8xTa6zTsxN2yJ");
  });

  it("rejects an account that is not a mint", () => {
    const wrong = mint() as never as { result: { value: { data: { parsed: { type: string } } } } };
    wrong.result.value.data.parsed.type = "account";
    expect(readMintInfo(wrong as never)).toBeNull();
  });

  // An uninitialised mint has null authorities too. Reading that as "revoked"
  // would be the most generous possible reading of an empty account.
  it("refuses an uninitialised mint rather than reading its nulls as revoked", () => {
    expect(readMintInfo(mint({ isInitialized: false }) as never)).toBeNull();
  });

  it("returns null on an RPC error rather than guessing", () => {
    expect(readMintInfo({ error: { message: "Request blocked" } } as never)).toBeNull();
    expect(readMintInfo({ result: { value: null } } as never)).toBeNull();
  });
});

describe("authorityWarnings", () => {
  const info = (over: Record<string, unknown> = {}) =>
    ({ decimals: 5, supply: "1", isInitialized: true, mintAuthority: null, freezeAuthority: null, ...over }) as never;

  it("says nothing when both are revoked", () => {
    expect(authorityWarnings(info())).toEqual([]);
  });

  it("warns that supply can still be inflated", () => {
    const w = authorityWarnings(info({ mintAuthority: "abc" }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("supply can still be increased");
  });

  it("warns separately about freezing", () => {
    const w = authorityWarnings(info({ freezeAuthority: "abc" }));
    expect(w[0]).toContain("frozen");
  });

  it("reports both when both are live", () => {
    expect(authorityWarnings(info({ mintAuthority: "a", freezeAuthority: "b" }))).toHaveLength(2);
  });
});

describe("endpoint order", () => {
  // Measured from the deployed origin: api.mainnet-beta.solana.com answers a
  // server and returns 403 to a browser. romapps.xyz/nova is a static export
  // running in the visitor's tab, so the browser-reachable endpoint has to lead
  // or the feature simply does not exist for most users.
  it("puts the browser-reachable endpoint first", () => {
    expect(RPC_ENDPOINTS[0]).toContain("publicnode");
    expect(RPC_ENDPOINTS).toContain("https://api.mainnet-beta.solana.com");
  });
});
