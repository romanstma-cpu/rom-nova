// Solana's own chain, read directly, with no key and no vendor.
//
// Every keyless provider in this stack reports mint and freeze authority as NOT
// revoked, and live-features grades that honestly: "a token nobody has checked
// is never graded as safely renounced." Right as a default and wrong as a fact
// — BONK renounced both years ago, and the app has been marking it, and every
// other legitimate token, as if the deployer could still mint at will.
//
// The chain answers this for free. `getAccountInfo` with `jsonParsed` on a mint
// account returns `mintAuthority` and `freezeAuthority` as null when revoked,
// which is the single most load-bearing safety fact about an SPL token: a live
// mint authority means the supply can be inflated out from under a holder, and
// a live freeze authority means their balance can be frozen in place.
//
// WHICH ENDPOINT, AND WHY IT IS NOT THE OBVIOUS ONE
//
// api.mainnet-beta.solana.com works perfectly from a server and returns 403 to
// a browser. That matters more than it sounds: romapps.xyz/nova is a static
// export that runs entirely in the visitor's tab, so an endpoint that refuses
// browser origins is useless for most of this app's users. Measured from the
// deployed origin, publicnode answered in ~330ms where mainnet-beta refused, so
// publicnode leads and mainnet-beta is the server-side fallback.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM
//
// `getTokenSupply` and `getTokenLargestAccounts` — which together would give
// the top-10 concentration this app most wants — return "Request blocked" on
// the free endpoints. So `top10Pct` stays unmeasured, and `top10Known` says so
// rather than letting a zero be read as a perfectly distributed cap table.
// Closing one gap is not a licence to imply the others are closed.

import type { SecurityDataProvider } from "./types";
import { ProviderError, providerFetch } from "./http";

/** Browser-reachable first. The official endpoint 403s cross-origin. */
export const RPC_ENDPOINTS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
] as const;

interface ParsedMintInfo {
  decimals: number;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  supply: string;
  isInitialized: boolean;
}

interface AccountInfoResponse {
  result?: {
    value?: {
      data?: { parsed?: { info?: ParsedMintInfo; type?: string }; program?: string };
      owner?: string;
    } | null;
  };
  error?: { message?: string };
}

/** The parsed mint account, or null when the address is not an SPL mint. */
export function readMintInfo(body: AccountInfoResponse): ParsedMintInfo | null {
  if (body.error) return null;
  const parsed = body.result?.value?.data?.parsed;
  if (!parsed || parsed.type !== "mint" || !parsed.info) return null;
  const info = parsed.info;
  // A mint that has not been initialised describes nothing; treating its nulls
  // as "revoked" would be the most generous possible reading of an empty
  // account.
  return info.isInitialized ? info : null;
}

/**
 * Warnings a human should actually see, phrased as what is true rather than
 * what scored.
 */
export function authorityWarnings(info: ParsedMintInfo): string[] {
  const out: string[] = [];
  if (info.mintAuthority !== null) {
    out.push("mint authority is LIVE — supply can still be increased by the holder of that key");
  }
  if (info.freezeAuthority !== null) {
    out.push("freeze authority is LIVE — balances can be frozen by the holder of that key");
  }
  return out;
}

export class SolanaRpcSecurityProvider implements SecurityDataProvider {
  readonly name = "solana-rpc";

  async getTokenSecurity(mint: string) {
    let lastError: unknown = null;
    for (const endpoint of RPC_ENDPOINTS) {
      try {
        const body = await providerFetch<AccountInfoResponse>(this.name, endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getAccountInfo",
            params: [mint, { encoding: "jsonParsed" }],
          }),
          timeoutMs: 6_000,
        });
        const info = readMintInfo(body);
        if (!info) return null;
        return {
          mintAuthorityRevoked: info.mintAuthority === null,
          freezeAuthorityRevoked: info.freezeAuthority === null,
          // Not readable on a free endpoint. `top10Known: false` keeps this in
          // the unmeasured set instead of reporting a flawless distribution.
          top10Pct: 0,
          top10Known: false,
          warnings: authorityWarnings(info),
        };
      } catch (err) {
        // One endpoint refusing is expected — mainnet-beta 403s browsers and
        // publicnode blocks some methods. Try the next before giving up, and
        // keep the last reason so a total failure is diagnosable.
        lastError = err;
      }
    }
    if (lastError instanceof ProviderError) throw lastError;
    if (lastError) throw lastError;
    return null;
  }
}
