// Launch forensics: who got in during the creation slot, and are they still in.
//
// THE CHECK EVERY MEMECOIN TRADER MAKES BEFORE BUYING
//
// A pump.fun mint's first second decides most of what follows. The deployer's
// own buy in the creation transaction, the wallets that bought in the same
// slot (a Jito bundle lands them beside the create, ~400ms), and the ones in
// the next few slots (bots watching the program) can hold a third of the
// supply between them before a human has read the ticker. Whether that supply
// is still held or has already been dumped is the difference between a
// launch and an exit-liquidity event, and GMGN and Axiom charge for exactly
// this readout: "bundled 23% · snipers 11% · dev sold".
//
// Nova's risk model has carried `bundlerPct` and `sniperPct` since the first
// version and has never been able to measure either — no keyless vendor
// publishes them, so the factor stood down on every live token. This file
// measures them from the chain, on demand, per token.
//
// HOW
//
// The mint's own transaction list, oldest first. The oldest signature IS the
// creation: its `postTokenBalances` show the full minted supply (measured, not
// assumed), its fee payer is the deployer, and any other on-curve owner with a
// positive balance in that same transaction bought inside the create — the
// strict definition of bundled. The following transactions are classified by
// slot offset from the creation: offset 0 is the creation slot, 1..3 is the
// next ~1.2 seconds. Every positive balance change to a wallet (an on-curve
// owner — pool and curve accounts are PDAs and are off the curve) is a buy;
// the buys are summed per wallet and divided by the measured supply.
//
// Then the present: one `getTokenAccountsByOwner` per early wallet says how
// much of what it bought it still holds. "Snipers took 14% and have sold 90%
// of it" is the sentence this exists to produce.
//
// WHAT IT REFUSES
//
// A token whose creation is more than a few thousand transactions back, or
// older than the endpoint's ~2-day body retention, cannot be read this way
// from a browser, and the panel says so instead of showing a zero. Zero here
// would be the most dangerous number on the page.

import type { ParsedTx, SignatureRow, TokenBalanceRow } from "./wallet-chain";
import { rpcCall, keyAt, RateLimitedError } from "./wallet-chain";
import { resolveRpcRoute } from "./rpc-endpoint";
import { isOnCurve } from "./account-kind";

/** Signature pages read newest-first before the creation is declared out of reach. */
export const MAX_SIGNATURE_PAGES = 5;
/** Transactions read from the creation forward — the launch window. */
export const LAUNCH_WINDOW_TXS = 48;
/** Slots after the creation slot that still count as sniping (~400ms each). */
export const SNIPE_SLOTS = 3;
/** Early wallets whose current balance is looked up. */
export const HOLDINGS_LOOKUPS = 12;
/**
 * Accounts per `getMultipleAccounts` call.
 *
 * Measured against publicnode: ten accounts answer as a plain read and
 * eleven come back 403 "Request blocked". Eight leaves a margin for the
 * threshold moving.
 */
export const ACCOUNTS_PER_CALL = 8;
export const FORENSICS_CACHE_MS = 10 * 60_000;
/**
 * A refusal is cached briefly, not for ten minutes: a spent RPC minute or an
 * index that had not caught up yet is a fact about the last thirty seconds,
 * and "re-read" must be able to try again.
 */
export const REFUSAL_CACHE_MS = 30_000;
const CONCURRENCY = 8;

export interface EarlyWallet {
  owner: string;
  /** The token account the launch buy landed in — where the current balance is read. */
  account?: string;
  /** Slots after the creation slot. 0 with `inCreateTx` is the bundle itself. */
  slotOffset: number;
  inCreateTx: boolean;
  isDev: boolean;
  boughtTokens: number;
  /** Of the measured supply. */
  boughtPct?: number;
  /** Sold again inside the launch window itself. */
  soldInWindowTokens: number;
  /** Current balance, when looked up. Absent means nobody asked (past the lookup cap). */
  holdsTokens?: number;
  holdsPct?: number;
  /** 1 − holds/bought, floored at 0: a wallet that added later reads as holding everything. */
  soldPct?: number;
}

export interface LaunchForensics {
  ok: true;
  mint: string;
  createSig: string;
  createSlot: number;
  createTs?: number;
  decimals: number;
  /** Minted supply, summed from the creation transaction's post balances. */
  supplyTokens?: number;
  dev?: EarlyWallet;
  /** Bought inside the creation transaction — bundled with the create. */
  bundled: EarlyWallet[];
  /** Bought in the creation slot, in other transactions. */
  creationSlot: EarlyWallet[];
  /** Bought in the next SNIPE_SLOTS slots. */
  nextSlots: EarlyWallet[];
  bundlerPct?: number;
  sniperPct?: number;
  /** Of everything the early wallets bought, the share their current balances still hold. */
  earlyStillHeldPct?: number;
  devSoldPct?: number;
  windowTxs: number;
  windowSlots: number;
  signaturesListed: number;
  holdingsLookedUp: number;
  requests: number;
  durationMs: number;
  readAt: number;
  runtime: string;
  provenance: string[];
}

export interface LaunchForensicsRefusal {
  ok: false;
  mint: string;
  reason: string;
  readAt: number;
  requests: number;
}

export type LaunchForensicsResult = LaunchForensics | LaunchForensicsRefusal;

// -------------------------------------------------------------- pure analysis

interface OwnerDelta {
  owner: string;
  /** Raw units, signed. */
  delta: bigint;
  decimals: number;
  /**
   * The token ACCOUNT that received the tokens, from the transaction's own
   * account list. Kept because the public endpoint refuses
   * `getTokenAccountsByOwner` ("indexed requests require a personal token")
   * while `getTokenAccountBalance` on a known account is a plain read — so
   * "what does this wallet still hold" is asked of the account it bought into.
   */
  account?: string;
}

/** Per-owner balance change for one mint across one transaction. */
export function ownerDeltas(tx: ParsedTx, mint: string): OwnerDelta[] {
  const meta = tx.meta;
  if (!meta) return [];
  const keys = tx.transaction.message.accountKeys;
  const pre = new Map<string, { amount: bigint; decimals: number; account?: string }>();
  const post = new Map<string, { amount: bigint; decimals: number; account?: string }>();
  const put = (map: Map<string, { amount: bigint; decimals: number; account?: string }>, row: TokenBalanceRow) => {
    if (row.mint !== mint || !row.owner) return;
    const cur = map.get(row.owner);
    const amount = BigInt(row.uiTokenAmount.amount);
    const key = keys[row.accountIndex];
    map.set(row.owner, {
      amount: (cur?.amount ?? BigInt(0)) + amount,
      decimals: row.uiTokenAmount.decimals,
      account: cur?.account ?? (key === undefined ? undefined : keyAt(key)),
    });
  };
  for (const row of meta.preTokenBalances ?? []) put(pre, row);
  for (const row of meta.postTokenBalances ?? []) put(post, row);
  const owners = new Set([...pre.keys(), ...post.keys()]);
  const out: OwnerDelta[] = [];
  for (const owner of owners) {
    const a = pre.get(owner);
    const b = post.get(owner);
    const delta = (b?.amount ?? BigInt(0)) - (a?.amount ?? BigInt(0));
    if (delta === BigInt(0)) continue;
    out.push({ owner, delta, decimals: (b ?? a)!.decimals, account: b?.account ?? a?.account });
  }
  return out;
}

/** The fee payer — the first account key — which on every launchpad is the deployer. */
export function feePayer(tx: ParsedTx): string | undefined {
  const k = tx.transaction.message.accountKeys[0];
  return k === undefined ? undefined : keyAt(k);
}

/** Total minted in the creation transaction: every post balance for the mint, all owners, PDAs included. */
export function mintedSupply(createTx: ParsedTx, mint: string): { raw: bigint; decimals: number } | undefined {
  const rows = (createTx.meta?.postTokenBalances ?? []).filter((r) => r.mint === mint);
  if (rows.length === 0) return undefined;
  let raw = BigInt(0);
  for (const r of rows) raw += BigInt(r.uiTokenAmount.amount);
  return { raw, decimals: rows[0].uiTokenAmount.decimals };
}

export interface WindowTx {
  tx: ParsedTx;
  signature: string;
}

/**
 * Classify the launch window. Pure, so it can be pinned on fixtures.
 *
 * `isWallet` separates traders from program-owned accounts: the bonding curve
 * and the pool hold most of the supply and their owners are PDAs, which are
 * off the ed25519 curve. Injected so a test can say which is which without
 * forging keys.
 */
export function analyseWindow(
  mint: string,
  window: readonly WindowTx[],
  isWallet: (owner: string) => boolean = isOnCurve,
): Pick<LaunchForensics, "createSig" | "createSlot" | "createTs" | "decimals" | "supplyTokens" | "dev" | "bundled" | "creationSlot" | "nextSlots" | "bundlerPct" | "sniperPct" | "windowTxs" | "windowSlots"> | undefined {
  if (window.length === 0) return undefined;
  const create = window[0];
  const supply = mintedSupply(create.tx, mint);
  const decimals = supply?.decimals ?? 6;
  const scale = 10 ** decimals;
  const supplyTokens = supply ? Number(supply.raw) / scale : undefined;
  const dev = feePayer(create.tx);

  const byOwner = new Map<string, EarlyWallet>();
  const touch = (owner: string, slotOffset: number, inCreateTx: boolean, account?: string): EarlyWallet => {
    let w = byOwner.get(owner);
    if (!w) {
      w = { owner, account, slotOffset, inCreateTx, isDev: owner === dev, boughtTokens: 0, soldInWindowTokens: 0 };
      byOwner.set(owner, w);
    } else if (!w.account && account) {
      w.account = account;
    }
    return w;
  };

  let lastSlot = create.tx.slot;
  for (const { tx } of window) {
    const offset = tx.slot - create.tx.slot;
    lastSlot = Math.max(lastSlot, tx.slot);
    const inCreate = tx === create.tx;
    // Past the sniping horizon the window only serves to see whether the
    // early wallets sold again; nobody new is classified from there.
    for (const d of ownerDeltas(tx, mint)) {
      if (!isWallet(d.owner)) continue;
      const tokens = Number(d.delta) / scale;
      if (tokens > 0) {
        if (offset <= SNIPE_SLOTS || d.owner === dev) {
          const w = touch(d.owner, offset, inCreate, d.account);
          w.boughtTokens += tokens;
        }
      } else {
        const w = byOwner.get(d.owner);
        if (w) w.soldInWindowTokens += -tokens;
      }
    }
  }

  const pct = (tokens: number) => (supplyTokens ? tokens / supplyTokens : undefined);
  for (const w of byOwner.values()) w.boughtPct = pct(w.boughtTokens);

  const devWallet = dev ? byOwner.get(dev) : undefined;
  const others = [...byOwner.values()].filter((w) => !w.isDev);
  const bundled = others.filter((w) => w.inCreateTx).sort((a, b) => b.boughtTokens - a.boughtTokens);
  const creationSlot = others.filter((w) => !w.inCreateTx && w.slotOffset === 0).sort((a, b) => b.boughtTokens - a.boughtTokens);
  const nextSlots = others.filter((w) => !w.inCreateTx && w.slotOffset > 0 && w.slotOffset <= SNIPE_SLOTS).sort((a, b) => b.boughtTokens - a.boughtTokens);
  const sum = (ws: EarlyWallet[]) => ws.reduce((s, w) => s + w.boughtTokens, 0);

  return {
    createSig: create.signature,
    createSlot: create.tx.slot,
    createTs: create.tx.blockTime ? create.tx.blockTime * 1000 : undefined,
    decimals,
    supplyTokens,
    dev: devWallet ?? (dev ? { owner: dev, account: undefined, slotOffset: 0, inCreateTx: true, isDev: true, boughtTokens: 0, boughtPct: pct(0), soldInWindowTokens: 0 } : undefined),
    bundled,
    creationSlot,
    nextSlots,
    bundlerPct: pct(sum(bundled)),
    sniperPct: pct(sum(creationSlot) + sum(nextSlots)),
    windowTxs: window.length,
    windowSlots: lastSlot - create.tx.slot + 1,
  };
}

/** Fold current balances into the early wallets and compute what is still held. */
export function applyHoldings(
  analysis: Pick<LaunchForensics, "dev" | "bundled" | "creationSlot" | "nextSlots" | "supplyTokens">,
  holdings: Map<string, number>,
): { earlyStillHeldPct?: number; devSoldPct?: number } {
  const fold = (w: EarlyWallet) => {
    const h = holdings.get(w.owner);
    if (h === undefined) return;
    w.holdsTokens = h;
    w.holdsPct = analysis.supplyTokens ? h / analysis.supplyTokens : undefined;
    w.soldPct = w.boughtTokens > 0 ? Math.max(0, Math.min(1, 1 - h / w.boughtTokens)) : undefined;
  };
  const early = [...analysis.bundled, ...analysis.creationSlot, ...analysis.nextSlots];
  for (const w of early) fold(w);
  if (analysis.dev) fold(analysis.dev);
  const looked = early.filter((w) => w.holdsTokens !== undefined);
  const bought = looked.reduce((s, w) => s + w.boughtTokens, 0);
  const held = looked.reduce((s, w) => s + Math.min(w.holdsTokens as number, w.boughtTokens), 0);
  return {
    earlyStillHeldPct: bought > 0 ? held / bought : undefined,
    devSoldPct: analysis.dev?.soldPct,
  };
}

// ------------------------------------------------------------------ the read

/** `getMultipleAccounts` with jsonParsed: one entry per requested account, null for one that no longer exists. */
interface MultipleAccountsResponse {
  value: ({ data?: { parsed?: { info?: { tokenAmount?: { uiAmount: number | null; amount: string; decimals: number } } } } } | null)[];
}

const cache = new Map<string, { at: number; value: LaunchForensicsResult }>();
const inFlight = new Map<string, Promise<LaunchForensicsResult>>();

/** Sync read of a finished analysis, for the scorer. Undefined until someone asked. */
export function forensicsFor(mint: string, now = Date.now()): LaunchForensics | undefined {
  const hit = cache.get(mint);
  if (!hit || now - hit.at > FORENSICS_CACHE_MS || !hit.value.ok) return undefined;
  return hit.value;
}

export function resetForensics(): void {
  cache.clear();
  inFlight.clear();
}

export async function readLaunchForensics(mint: string, now = Date.now()): Promise<LaunchForensicsResult> {
  const hit = cache.get(mint);
  if (hit && now - hit.at < (hit.value.ok ? FORENSICS_CACHE_MS : REFUSAL_CACHE_MS)) return hit.value;
  const pending = inFlight.get(mint);
  if (pending) return pending;
  const run = readUncached(mint, now).finally(() => inFlight.delete(mint));
  inFlight.set(mint, run);
  const result = await run;
  cache.set(mint, { at: Date.now(), value: result });
  return result;
}

async function readUncached(mint: string, now: number): Promise<LaunchForensicsResult> {
  const started = Date.now();
  let requests = 0;
  const route = await resolveRpcRoute();
  const refuse = (reason: string): LaunchForensicsRefusal => ({ ok: false, mint, reason, readAt: now, requests });

  // Newest first, paging back until the index runs out — which is the
  // creation, for a mint young enough to read. Past the page cap it is not.
  const rows: SignatureRow[] = [];
  let before: string | undefined;
  let exhausted = false;
  try {
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      requests++;
      const batch = await rpcCall<SignatureRow[]>(
        route.signatures,
        "getSignaturesForAddress",
        [mint, before ? { limit: 1000, before } : { limit: 1000 }],
        { timeoutMs: 20_000 },
      );
      if (!Array.isArray(batch) || batch.length === 0) {
        exhausted = true;
        break;
      }
      rows.push(...batch);
      if (batch.length < 1000) {
        exhausted = true;
        break;
      }
      before = batch[batch.length - 1].signature;
    }
  } catch (err) {
    return refuse(
      err instanceof RateLimitedError
        ? "the public RPC refused the signature listing — its minute is spent; try again shortly"
        : `could not list the mint's transactions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (rows.length === 0) return refuse("the endpoint lists no transactions for this mint — it may be older than the ~2-day index a browser can reach");
  if (!exhausted) {
    return refuse(
      `the creation is more than ${(MAX_SIGNATURE_PAGES * 1000).toLocaleString()} transactions back — too deep to read keylessly from a tab. ` +
        `Forensics answer for fresh mints, which is where the question matters.`,
    );
  }

  // Oldest first; failed transactions changed nothing.
  const usable = rows.filter((r) => !r.err).reverse();
  const wanted = usable.slice(0, LAUNCH_WINDOW_TXS);
  const bodies = new Map<string, ParsedTx>();
  let unavailable = 0;
  let cursor = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
        while (cursor < wanted.length) {
          const row = wanted[cursor++];
          requests++;
          const tx = await rpcCall<ParsedTx | null>(route.transactions, "getTransaction", [
            row.signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ]);
          if (tx) bodies.set(row.signature, tx);
          else unavailable++;
        }
      }),
    );
  } catch (err) {
    return refuse(
      err instanceof RateLimitedError
        ? "the public RPC refused part of the launch window — its minute is spent; try again shortly"
        : `could not read the launch transactions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const create = wanted[0];
  if (!create || !bodies.has(create.signature)) {
    return refuse(
      "the creation transaction's body is no longer served — the endpoint keeps bodies for about two days, so this mint is too old to read from a browser" +
        (route.archivalIndex ? "" : "; the desktop app's archival route reaches further"),
    );
  }
  const window: WindowTx[] = wanted.filter((r) => bodies.has(r.signature)).map((r) => ({ tx: bodies.get(r.signature)!, signature: r.signature }));
  const analysis = analyseWindow(mint, window);
  if (!analysis) return refuse("the launch window was empty after filtering");

  // The present: the balance of the account each early wallet bought into,
  // and the deployer's, in ONE call. Measured on publicnode: both
  // `getTokenAccountsByOwner` and `getTokenAccountBalance` are refused as
  // "indexed requests" (403, personal token required); `getMultipleAccounts`
  // with jsonParsed is a plain read and answers a hundred accounts at once.
  // A null entry is an account that no longer exists — a wallet that sold
  // out and reclaimed the rent — and reads as holding nothing.
  const early = [...analysis.bundled, ...analysis.creationSlot, ...analysis.nextSlots]
    .sort((a, b) => b.boughtTokens - a.boughtTokens)
    .slice(0, HOLDINGS_LOOKUPS);
  const targets = [...(analysis.dev ? [analysis.dev] : []), ...early].filter(
    (w, i, arr) => w.account !== undefined && arr.findIndex((x) => x.owner === w.owner) === i,
  );
  const owners = [...new Set([...(analysis.dev ? [analysis.dev.owner] : []), ...early.map((w) => w.owner)])];
  const holdings = new Map<string, number>();
  let looked = 0;
  let refusedLookups = 0;
  let failedLookups = 0;
  let lookupError: string | undefined;
  // In chunks: measured, the endpoint answers up to ten accounts in one
  // plain call and refuses eleven as "Request blocked" (403).
  for (let start = 0; start < targets.length; start += ACCOUNTS_PER_CALL) {
    const chunk = targets.slice(start, start + ACCOUNTS_PER_CALL);
    try {
      requests++;
      const res = await rpcCall<MultipleAccountsResponse>(route.transactions, "getMultipleAccounts", [
        chunk.map((w) => w.account),
        { encoding: "jsonParsed" },
      ]);
      chunk.forEach((w, i) => {
        const v = res.value?.[i];
        if (v === null) {
          holdings.set(w.owner, 0);
          looked++;
          return;
        }
        const amt = v?.data?.parsed?.info?.tokenAmount;
        if (!amt) {
          failedLookups++;
          lookupError = "account exists but is not a parsed token account";
          return;
        }
        holdings.set(w.owner, amt.uiAmount ?? Number(amt.amount) / 10 ** amt.decimals);
        looked++;
      });
    } catch (err) {
      // Balances unknown are never counted as sold; the reason is kept so
      // the panel can say why instead of showing a silent zero of twelve.
      if (err instanceof RateLimitedError) refusedLookups += chunk.length;
      else {
        failedLookups += chunk.length;
        lookupError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const held = applyHoldings(analysis, holdings);

  const fmtPct = (x: number | undefined) => (x === undefined ? "unmeasured" : `${(x * 100).toFixed(1)}%`);
  const provenance: string[] = [
    `solana-rpc (${route.runtime}): ${rows.length.toLocaleString()} signatures listed back to the creation, ${window.length} of the first ${wanted.length} transaction bodies read` +
      (unavailable ? ` (${unavailable} no longer served)` : "") +
      `, spanning ${analysis.windowSlots} slots`,
    analysis.supplyTokens !== undefined
      ? `supply ${analysis.supplyTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} measured from the creation transaction's post balances`
      : "no token balances in the creation transaction — shares of supply are unmeasured, token counts are shown raw",
    `bundled (bought inside the create): ${analysis.bundled.length} wallet${analysis.bundled.length === 1 ? "" : "s"}, ${fmtPct(analysis.bundlerPct)}; ` +
      `creation slot: ${analysis.creationSlot.length}; next ${SNIPE_SLOTS} slots: ${analysis.nextSlots.length}; snipers ${fmtPct(analysis.sniperPct)}`,
    `current balances read for ${looked} of ${owners.length} early wallets, in the account each bought into (cap ${HOLDINGS_LOOKUPS})` +
      (owners.length > targets.length ? `, ${owners.length - targets.length} with no readable account` : "") +
      (refusedLookups > 0 ? `, ${refusedLookups} refused by the public RPC's rate limit — re-read in a minute for those` : "") +
      (failedLookups > 0 ? `, ${failedLookups} failed (${lookupError})` : "") +
      `; ` +
      (held.earlyStillHeldPct === undefined ? "still-held share unmeasured" : `${(held.earlyStillHeldPct * 100).toFixed(0)}% of what they bought is still held`),
  ];

  return {
    ok: true,
    mint,
    ...analysis,
    ...held,
    signaturesListed: rows.length,
    holdingsLookedUp: looked,
    requests,
    durationMs: Date.now() - started,
    readAt: now,
    runtime: route.runtime,
    provenance,
  };
}
