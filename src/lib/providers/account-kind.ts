// Is this address a wallet at all?
//
// The blind review pasted `9cRCn9rGT8…pump` — a TOKEN MINT — into the wallet
// page and got back "REAL · SOLANA, $520.8K portfolio, 144 positions" with no
// warning. It also pasted the Raydium AMM program. Both rendered as traders.
//
// The numbers were not even wrong: a mint account really does own token
// accounts, and a program's authority really does hold balances. They are just
// answers to a question nobody asked, and presenting a mint's own liquidity as
// somebody's portfolio is the most confidently wrong the app has ever been.
//
// One `getAccountInfo` settles it, and this codebase already makes that call
// in `solana-rpc.ts` for mint and freeze authority. Solscan and GMGN detect it
// instantly and route to the token page; so does Nova now.
//
// WHAT THIS DELIBERATELY DOES NOT ANSWER: "Binance hot wallet"
//
// Account TYPE is a chain fact and is free. Entity IDENTITY is somebody's
// database, and measured, there is no keyless one:
//
//   public-api.solscan.io/account      404
//   pro-api.solscan.io/v2.0/account    401 "Token is missing"
//   api-v2.solscan.io/v2/account       403, CORS locked to https://solscan.io
//   api.solana.fm/v0/accounts          502
//   api.helius.xyz/v0/addresses/names  key required
//
// The one free, CORS-open source is SNS reverse lookup, and it is worse than
// nothing. Asked about Binance's hot wallet it returns `["cif🧢😺",
// "helpmegetcamaro_hc5d3…", "kiing"]` — .sol domains that ANY third party can
// point at ANY address. Rendering those as labels would let an attacker name a
// drainer wallet "Binance" inside this app. So a real wallet wears no entity
// label here, and `/status` says why rather than leaving a blank that looks
// like an oversight.

/** What an address turned out to be. */
export type AccountKind =
  /** A normal account owned by the System Program. What people mean by "wallet". */
  | "wallet"
  /** An SPL mint. Belongs on the token page. */
  | "mint"
  /** An SPL token account — a wallet's holding of one mint, not the wallet. */
  | "token-account"
  /** Executable. A program, not a trader. */
  | "program"
  /** Owned by some other program: a PDA, a pool, a vault, a stake account. */
  | "program-owned"
  /** Nothing at this address. Valid key, never funded. */
  | "empty"
  /** The lookup itself failed; the address is not disqualified, just unchecked. */
  | "unknown";

export interface AccountIdentity {
  kind: AccountKind;
  /** The program that owns the account, when one was read. */
  owner?: string;
  /** Set for a mint, so the caller can link straight to the token page. */
  mint?: string;
  /** One sentence for the reader, in plain language. */
  detail: string;
  /** False when this address should not be profiled as a trader. */
  profilable: boolean;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

interface AccountInfoValue {
  owner?: string;
  executable?: boolean;
  data?: { parsed?: { type?: string; info?: Record<string, unknown> }; program?: string };
}

/**
 * Classifies one `getAccountInfo` result.
 *
 * Split out from the fetch so the suite can prove every branch — including the
 * two that matter most and are hardest to reach live: a mint and an executable
 * program.
 */
export function classifyAccount(value: AccountInfoValue | null | undefined): AccountIdentity {
  if (value === null || value === undefined) {
    return {
      kind: "empty",
      detail:
        "nothing exists at this address — a valid Solana key that has never been funded or used",
      profilable: false,
    };
  }
  const owner = value.owner;
  if (value.executable) {
    return {
      kind: "program",
      owner,
      detail: "this is an on-chain PROGRAM, not a wallet — it executes code, it does not trade",
      profilable: false,
    };
  }
  const parsedType = value.data?.parsed?.type;
  if (parsedType === "mint") {
    return {
      kind: "mint",
      owner,
      detail: "this is a TOKEN MINT, not a wallet — the balances under it are the token's own, not a trader's",
      profilable: false,
    };
  }
  if (parsedType === "account" && (owner === TOKEN_PROGRAM || owner === TOKEN_2022)) {
    const holder = value.data?.parsed?.info?.owner;
    return {
      kind: "token-account",
      owner,
      detail:
        "this is a TOKEN ACCOUNT — one wallet's holding of one mint" +
        (typeof holder === "string" ? `, owned by ${holder}` : ""),
      profilable: false,
    };
  }
  if (owner === SYSTEM_PROGRAM) {
    return { kind: "wallet", owner, detail: "a normal Solana wallet", profilable: true };
  }
  return {
    kind: "program-owned",
    owner,
    detail:
      `owned by program ${owner ?? "unknown"} rather than by a person — a pool, vault, stake or ` +
      `other derived account, so its balances are a protocol's, not a trader's`,
    profilable: false,
  };
}

/**
 * The address's identity, or `unknown` when the chain could not be reached.
 *
 * Unknown is deliberately PROFILABLE. A failed lookup is not evidence that an
 * address is a mint, and refusing to profile a real wallet because one request
 * timed out would trade a rare wrong answer for a common missing one.
 */
export async function identifyAccount(
  address: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<AccountIdentity> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "jsonParsed" }],
      }),
      signal: signal ?? AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { value?: AccountInfoValue | null };
      error?: unknown;
    };
    if (body.error) throw new Error("rpc error");
    return classifyAccount(body.result?.value);
  } catch {
    return {
      kind: "unknown",
      detail: "the account type could not be checked — treating it as a wallet",
      profilable: true,
    };
  }
}
