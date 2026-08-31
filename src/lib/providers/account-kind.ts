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
  /**
   * The WALLET that owns a token account, so the page can link to the profile
   * the reader was actually after. It was named in prose and unlinked — the one
   * useful next step from a token-account page, left as a copy-paste job.
   */
  holder?: string;
  /** One sentence for the reader, in plain language. */
  detail: string;
  /** False when this address should not be profiled as a trader. */
  profilable: boolean;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// ---------------------------------------------------------------- the curve
//
// Ownership was not enough. The Raydium Authority V4 —
// 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1, a party to half the swaps on
// Solana — is a SYSTEM-OWNED account with no data, so the ownership test called
// it a wallet and the page profiled it as a trader: "win rate 50%, profit
// factor 4.38". A pool's churn dressed as a person's skill, on the most famous
// AMM address there is. Solscan's page for it says isOnCurve: FALSE.
//
// That flag is the real distinction, and it is pure math. A wallet is a public
// key someone can hold the private key FOR, which means the 32 bytes must
// decompress to a point on the ed25519 curve. Program-derived addresses are
// hashed specifically until they FAIL that test — off-curve is the definition
// of a PDA — so "no private key can exist" is checkable offline, with no RPC,
// no vendor, and no list to maintain.

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, i] as const));

/** Base58 → 32 bytes, or null when the string is not a valid Solana key. */
export function decodeAddress(address: string): Uint8Array | null {
  // Length first: an empty string would decode to 32 zero bytes, and the
  // all-zeros key is mathematically ON the curve — so without this guard,
  // `isOnCurve("")` answered yes.
  if (address.length < 32 || address.length > 44) return null;
  let n = BigInt(0);
  const FIFTY_EIGHT = BigInt(58);
  for (const ch of address) {
    const v = B58_INDEX.get(ch);
    if (v === undefined) return null;
    n = n * FIFTY_EIGHT + BigInt(v);
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & BigInt(255));
    n >>= BigInt(8);
  }
  if (n !== BigInt(0)) return null; // more than 32 bytes of payload
  // Leading '1's encode leading zero bytes; the loop above already produces
  // them, so no separate handling is needed for a fixed 32-byte output.
  return out;
}

// Curve constants. Written as strings because this tsconfig targets < ES2020,
// where a bigint literal is a compile error — the same constraint sqd.ts hit.
const P = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949"); // 2^255 - 19
const D = BigInt("37095705934669439343138083508754565189542113879843219016388785533085940283555"); // -121665/121666
const SQRT_M1 = BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752"); // √-1 mod p

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1);
  let b = base % mod;
  let e = exp;
  while (e > BigInt(0)) {
    if (e & BigInt(1)) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= BigInt(1);
  }
  return result;
}

/**
 * Whether these 32 bytes decompress to a point on ed25519.
 *
 * Standard RFC 8032 decompression: read y (little-endian, sign bit stripped),
 * solve x² = (y² − 1)/(d·y² + 1), and accept if a root exists. PDAs are ground
 * out by Solana's runtime until this exact test fails, so failing it here IS
 * the finding "no private key can exist for this address".
 */
export function isOnCurve(address: string): boolean {
  const bytes = decodeAddress(address);
  if (!bytes) return false;
  let y = BigInt(0);
  for (let i = 31; i >= 0; i--) {
    const b = i === 31 ? bytes[i] & 0x7f : bytes[i];
    y = (y << BigInt(8)) | BigInt(b);
  }
  if (y >= P) return false;
  const yy = (y * y) % P;
  const u = (yy - BigInt(1) + P) % P;
  const v = ((D * yy) % P + BigInt(1)) % P;
  const v3 = (((v * v) % P) * v) % P;
  const v7 = (((v3 * v3) % P) * v) % P;
  let x = (((u * v3) % P) * modPow((u * v7) % P, (P - BigInt(5)) / BigInt(8), P)) % P;
  const vxx = (((v * x) % P) * x) % P;
  if (vxx !== u && vxx !== (P - u) % P) return false;
  if (vxx === (P - u) % P) x = (x * SQRT_M1) % P;
  // x = 0 with the sign bit set encodes no valid point.
  const signBit = (bytes[31] & 0x80) !== 0;
  if (x === BigInt(0) && signBit) return false;
  return true;
}

/**
 * Addresses whose IDENTITY is a chain-wide constant, not somebody's database.
 *
 * This is deliberately tiny. The refusal to label entities stands — a name
 * list is an attack surface — but the incinerator is not an entity, it is a
 * convention the whole chain shares, and calling it "a wallet that has never
 * been used" (which the empty-account copy did, one click after the movers
 * list showed it receiving $10.4K) is worse than naming it.
 */
export const KNOWN_ADDRESSES: Record<string, AccountIdentity> = {
  "1nc1nerator11111111111111111111111111111111": {
    kind: "program-owned",
    detail:
      "the BURN ADDRESS — tokens sent here are destroyed. It appears in flow because " +
      "burning IS a transfer, but nothing here trades",
    profilable: false,
  },
};

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
export function classifyAccount(
  value: AccountInfoValue | null | undefined,
  address?: string,
): AccountIdentity {
  // The curve verdict outranks the account read: an off-curve address has no
  // private key BY CONSTRUCTION, whatever the account at it looks like. The
  // Raydium Authority V4 is system-owned with no data — indistinguishable from
  // a wallet by ownership alone — and it profiled as a trader until this check
  // existed.
  const offCurve = address !== undefined && !isOnCurve(address);
  if (offCurve) {
    return {
      kind: "program-owned",
      owner: value?.owner,
      detail:
        "a PROGRAM-DERIVED ADDRESS — the 32 bytes are off the ed25519 curve, so no private " +
        "key can exist for it. It belongs to a program (a pool authority, a vault, an escrow), " +
        "not to a person, and its activity is a protocol's, not a trader's",
      profilable: false,
    };
  }
  if (value === null || value === undefined) {
    return {
      kind: "empty",
      // "never been funded or used" was FALSE for the burn address, which the
      // movers list had shown receiving $10.4K one click earlier — a null here
      // means no SYSTEM account exists now, and says nothing about token
      // accounts the address may own.
      detail:
        "no system account exists at this address — it holds no SOL. Token accounts it owns, " +
        "if any, are not visible from this lookup",
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
      holder: typeof holder === "string" ? holder : undefined,
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
  // Two verdicts need no network at all. A known constant has a fixed meaning,
  // and an off-curve address is a PDA by definition — both are decided before
  // spending an RPC call, which also means they still work when the chain is
  // unreachable.
  const known = KNOWN_ADDRESSES[address];
  if (known) return known;
  if (!isOnCurve(address)) return classifyAccount(undefined, address);
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
    return classifyAccount(body.result?.value, address);
  } catch {
    return {
      kind: "unknown",
      detail: "the account type could not be checked — treating it as a wallet",
      profilable: true,
    };
  }
}
