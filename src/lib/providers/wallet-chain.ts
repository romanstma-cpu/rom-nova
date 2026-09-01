// A real wallet's trades, read off Solana with no key and no vendor.
//
// Wallet tracking was the last entirely synthetic capability in this app.
// Every address in it came from `demo/universe.ts` with an invented name, and
// /status said so. This is what replaces it: paste a Solana address, get the
// fills that address actually made.
//
// HOW A FILL IS RECOVERED
//
// `getSignaturesForAddress` lists the transactions an address took part in.
// `getTransaction` with `jsonParsed` returns `preTokenBalances` and
// `postTokenBalances`, each carrying an OWNER. Difference the entries owned by
// this wallet and you have exactly what it gained and gave up, in raw units,
// from the ledger itself rather than from a vendor's interpretation of it.
//
// THE MEASUREMENT THAT DECIDED THE DESIGN
//
// Across five real trading wallets, 577 transactions, every token movement
// classified:
//
//   quote leg in the wallet's own wSOL / USDC account      59
//   quote leg in the wallet's native SOL balance          201
//   BOTH                                                    0
//   NEITHER                                               218
//
// Two things fall out of that. The first is that the two quote sources are
// mutually exclusive — a router either leaves the wallet a wrapped-SOL account
// or moves native lamports, never both — so taking whichever is present cannot
// double-count.
//
// The second is that 46% of token movements (the NEITHER row) had no quote
// source at all: nothing this wallet owned moved against the tokens, so there
// is no price to recover. They are recorded `pricing: "unpriced"` and never
// enter a PnL figure. Guessing a price for them — from the token's price now,
// say — would fabricate 46% of every number on the page.
//
// THAT 46% IS A FLOOR ON `unpriced`, NOT ITS RATE, and this comment used to
// say otherwise. It counts one cause. A movement can have a perfectly good
// quote leg and still be unpriceable: a rotation's belongs to two sides at
// once, a pool deposit's moves the same way as the base, and a swap can want
// a SOL/USD bar that does not exist for its hour. Each fill carries its own
// `unpricedReason` and its own `classification` precisely so that no summary
// anywhere has to guess which applied — the enumerations that tried drifted
// out of date twice.
//
// TWO DEPTHS, NOT ONE — SEE rpc-endpoint.ts FOR THE MEASUREMENTS
//
// The first version of this file hardcoded one endpoint and reported one depth
// for every runtime. Both halves of that were wrong.
//
// The INDEX is archival wherever no Origin header reaches the server: from
// Node and from the desktop shell's main-process proxy, `getSignaturesForAddress`
// on mainnet-beta reaches 375+ days, against publicnode's 2.02. So a wallet's
// real age and lifetime transaction count are free, and withholding them made
// a two-year-old whale and a thirty-three-minute-old wallet look identical.
//
// The FILLS are not. Handed signatures from 3, 10, 30 and 60 days ago,
// publicnode returns null for every one, and mainnet-beta — which serves them
// all — allows exactly TEN `getTransaction` calls per window whatever the
// concurrency or pacing (measured three ways: 10 of 80 each time). Four
// hundred transactions through it would take minutes. So the priced window
// stays at ~2 days in every runtime, and this file says which of the two
// numbers a reader is looking at.

import type { TradeClassification, WalletCoverage, WalletFill } from "../types";
import { getSolBars, solUsdAt, type SolBar } from "./sol-history";
import { resolveRpcRoute, TX_RETENTION_DAYS, type RpcRoute } from "./rpc-endpoint";
import { identifyAccount, type AccountIdentity } from "./account-kind";

export const WSOL = "So11111111111111111111111111111111111111112";

/**
 * Mints treated as the QUOTE side of a swap rather than as a position.
 *
 * Stablecoins are valued at a dollar, which is an assumption and not a
 * measurement — USDC broke its peg to $0.87 in March 2023 and USDT has
 * wobbled repeatedly. Over the two-day window this provider can read, a live
 * depeg is the only case where it matters, and the alternative is refusing to
 * price every USDC-quoted fill on the chain.
 */
export const STABLE_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

const isQuoteMint = (mint: string): boolean => mint === WSOL || mint in STABLE_MINTS;

/**
 * Smallest native-SOL leg this will price, in lamports.
 *
 * A token account costs 0.00204 SOL of rent. Most of that cancels — see
 * `nativeQuoteLamports` — but a wrapped-SOL account that a router opened and
 * closed inside the same transaction appears in no balance list at all, so its
 * rent lands in the wallet's native delta with nothing to net it against. At
 * 0.005 SOL that residue is at worst a 40% error, which is why anything
 * smaller is left unpriced instead of being reported as a fill.
 */
export const MIN_SOL_LEG_LAMPORTS = 5_000_000;

const LAMPORTS_PER_SOL = 1_000_000_000;

// ---------------------------------------------------------------- RPC shapes

interface SignatureRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface TokenBalanceRow {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface ParsedTx {
  slot: number;
  blockTime?: number | null;
  transaction: {
    signatures?: string[];
    message: { accountKeys: ({ pubkey: string } | string)[] };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceRow[];
    postTokenBalances?: TokenBalanceRow[];
  } | null;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * The endpoint's own limit, quoted back in its 429 body: 2400rqs/60s.
 *
 * Found by a probe and not by reading docs, and it behaves worse than the
 * number suggests. Crossing it does not slow the next request down — it
 * BLACKLISTS THE CALLER for the rest of the window. Measured: 600 fetches at
 * concurrency 12 got 359 through and 241 refused, and the same 600 retried at
 * concurrency 6 got ZERO through, because the minute was already spent. So
 * backing off after the fact does not recover; the only thing that works is
 * not crossing it.
 */
export const RPC_LIMIT_PER_MINUTE = 2_400;

/**
 * What this client will actually spend, leaving a fifth of the budget behind.
 *
 * The headroom is not politeness. A second Nova tab, the Electron shell and
 * the browser share one IP and one bucket, and the punishment for the overrun
 * lands on whichever of them asks next — which would look, from inside the app,
 * like the wallet endpoint being down.
 */
export const RPC_BUDGET_PER_MINUTE = 1_800;

const WINDOW_MS = 60_000;

/**
 * A sliding-window limiter, module-scoped so every caller shares one budget.
 *
 * Deliberately not a fixed rate. Rate-limiting to 30/s would make a 400
 * transaction read take thirteen seconds every time, when the endpoint is
 * perfectly happy to serve that burst in three. This lets the burst through and
 * only waits once the last sixty seconds are genuinely full.
 */
const spent: number[] = [];

/**
 * A shared pause, set whenever the endpoint refuses one request.
 *
 * The request budget is necessary and not sufficient: profiling two wallets
 * back to back stayed under 1,800 requests and still had 139 of 400 refused,
 * because `getSignaturesForAddress` with a limit of 1,000 plainly costs the
 * endpoint more than a single `getTransaction` and its accounting is not the
 * flat request count its error message quotes.
 *
 * So a refusal anywhere backs EVERY worker off, not just the one that saw it.
 * Twelve workers each retrying on their own would arrive together and be
 * refused together, which is how a throttle becomes an outage.
 */
let cooldownUntil = 0;
const COOLDOWN_MS = 800;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function takeSlot(signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new Error("aborted while waiting for rate-limit budget");
    const now = Date.now();
    if (now < cooldownUntil) {
      await sleep(Math.min(cooldownUntil - now, 250));
      continue;
    }
    while (spent.length > 0 && now - spent[0] >= WINDOW_MS) spent.shift();
    if (spent.length < RPC_BUDGET_PER_MINUTE) {
      spent.push(now);
      return;
    }
    // Wait exactly until the oldest request ages out, plus a tick.
    await sleep(Math.min(WINDOW_MS - (now - spent[0]) + 5, 1_000));
  }
}

export class RateLimitedError extends Error {
  constructor() {
    super("rate limited by the public RPC");
  }
}

/**
 * How many times a refused request is retried.
 *
 * Two, because a refusal has two very different causes and only one of them is
 * worth waiting out. Intermittent throttling clears in under a second and the
 * request succeeds; a spent minute does not clear at all, and measured, every
 * request in it fails — 600 retried at lower concurrency got ZERO through. Two
 * attempts recover the first case and give up quickly on the second, instead of
 * turning a busy wallet into a thirty-second stall.
 */
export const RATE_LIMIT_RETRIES = 2;

async function rpcOnce<T>(
  endpoint: string,
  method: string,
  params: unknown[],
  opts: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  await takeSlot(opts.signal);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
  opts.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (res.status === 429) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      throw new RateLimitedError();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${method}`);
    const body = (await res.json()) as RpcEnvelope<T>;
    // -32005 is the same refusal arriving as a JSON-RPC error instead of a 429;
    // the endpoint uses both shapes for it, sometimes within one burst.
    if (body.error) {
      if (body.error.code === -32005) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        throw new RateLimitedError();
      }
      throw new Error(`${method}: ${body.error.message}`);
    }
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc<T>(
  endpoint: string,
  method: string,
  params: unknown[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await rpcOnce<T>(endpoint, method, params, opts);
    } catch (err) {
      // Only refusals are retried. A malformed request or a dead transaction
      // will fail identically every time, and hammering it spends budget the
      // recoverable requests need.
      if (!(err instanceof RateLimitedError)) throw err;
      last = err;
      // Jittered so twelve workers coming off the same cooldown do not arrive
      // in the same millisecond and refuse each other again.
      if (attempt < RATE_LIMIT_RETRIES) await sleep(150 + Math.random() * 350);
    }
  }
  throw last;
}

// ---------------------------------------------------------------- extraction

const keyAt = (k: { pubkey: string } | string): string => (typeof k === "string" ? k : k.pubkey);

/** Per-mint raw balance change for the token accounts this wallet owns. */
export interface MintDelta {
  mint: string;
  decimals: number;
  /** Raw base units. Negative means the wallet gave the token up. */
  delta: bigint;
  /** Account indexes, so rent can be netted out of the native leg. */
  accountIndexes: number[];
}

const ZERO = BigInt(0);

/**
 * Differences the wallet's own token accounts across one transaction.
 *
 * An account absent from `preTokenBalances` was created by this transaction
 * and started at zero; one absent from `postTokenBalances` was closed by it and
 * ended at zero. Both absences are meaningful and both default to zero here,
 * which is the one place in this codebase where treating a missing value as
 * zero is correct rather than dangerous — the SPL token program guarantees it.
 */
export function walletMintDeltas(tx: ParsedTx, wallet: string): MintDelta[] {
  const meta = tx.meta;
  if (!meta) return [];
  const acc = new Map<string, { decimals: number; pre: bigint; post: bigint; idx: Set<number> }>();
  const put = (row: TokenBalanceRow, side: "pre" | "post"): void => {
    if (row.owner !== wallet) return;
    let e = acc.get(row.mint);
    if (!e) acc.set(row.mint, (e = { decimals: row.uiTokenAmount.decimals, pre: ZERO, post: ZERO, idx: new Set() }));
    e.decimals = row.uiTokenAmount.decimals;
    e.idx.add(row.accountIndex);
    let amount: bigint;
    try {
      amount = BigInt(row.uiTokenAmount.amount);
    } catch {
      return;
    }
    // A wallet can hold several accounts for one mint. Summing rather than
    // assigning is what keeps a two-account holder from reporting only one.
    e[side] += amount;
  };
  for (const row of meta.preTokenBalances ?? []) put(row, "pre");
  for (const row of meta.postTokenBalances ?? []) put(row, "post");

  const out: MintDelta[] = [];
  for (const [mint, e] of acc) {
    const delta = e.post - e.pre;
    if (delta === ZERO) continue;
    out.push({ mint, decimals: e.decimals, delta, accountIndexes: [...e.idx] });
  }
  return out;
}

/**
 * The wallet's native SOL movement, with fee and rent taken back out.
 *
 * Three corrections, each for a specific way the raw lamport delta lies:
 *
 *  - The transaction fee leaves the fee payer's balance and is a cost of
 *    trading, not part of the price paid for the token.
 *  - Rent for a token account the wallet opens moves from the wallet INTO an
 *    account the wallet still owns. It has not left. Adding those accounts'
 *    lamport deltas back cancels it exactly, in both directions, so a closed
 *    account's returned rent does not read as profit either.
 *  - Wrapped-SOL accounts are excluded from that rent correction, because
 *    their lamports are the traded SOL itself. When one is present the token
 *    path claims the leg anyway — measured at 0 of 577 transactions where both
 *    paths fired — so this returns zero for them rather than competing.
 */
export function nativeQuoteLamports(tx: ParsedTx, wallet: string, deltas: MintDelta[]): number {
  const meta = tx.meta;
  if (!meta) return 0;
  const keys = tx.transaction.message.accountKeys.map(keyAt);
  const wi = keys.indexOf(wallet);
  if (wi < 0) return 0;

  let native = meta.postBalances[wi] - meta.preBalances[wi];
  if (keys[0] === wallet) native += meta.fee;

  for (const d of deltas) {
    if (isQuoteMint(d.mint)) continue;
    for (const idx of d.accountIndexes) {
      if (idx === wi || idx >= meta.postBalances.length) continue;
      native += meta.postBalances[idx] - meta.preBalances[idx];
    }
  }
  return native;
}

const toUnits = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

/**
 * One transaction to at most one fill.
 *
 * Refuses to price several kinds of movement, all of them honestly — the list
 * below is illustrative, not closed, because it has grown twice since it was
 * written and the count in this sentence did not follow either time:
 *
 *  - No non-quote token moved: this is a SOL or stablecoin transfer, not a
 *    position change.
 *  - More than one non-quote token moved: a rotation, where a single quote leg
 *    cannot be attributed to one side without inventing the split. Both legs
 *    are emitted unpriced rather than one being credited with the whole cost.
 *  - The base and quote legs move the same direction: not a swap. An LP
 *    deposit does this, and pricing it would divide two unrelated numbers.
 */
export function fillsFromTx(
  tx: ParsedTx,
  wallet: string,
  solBars: readonly SolBar[],
): WalletFill[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const ts = (tx.blockTime ?? 0) * 1000;
  const signature = tx.transaction.signatures?.[0] ?? "";
  const deltas = walletMintDeltas(tx, wallet);
  const base = deltas.filter((d) => !isQuoteMint(d.mint));
  if (base.length === 0) return [];

  const quotes = deltas.filter((d) => isQuoteMint(d.mint));
  const nativeLamports = nativeQuoteLamports(tx, wallet, deltas);

  // UNPRICED IS NOT ONE THING, and calling it all "transfer" was a lie of
  // convenience. Four different situations reach this helper — a rotation, a
  // pool deposit, a genuine transfer, an ambiguity — and only one of them is a
  // movement nobody paid for. The union has had `rotate` and `lp` all along.
  //
  // Nothing surfaced the collapse while `classification` was only a faint
  // column on two tables. The moment an alert started SAYING what it meant,
  // it said "a transfer, not a trade: nothing was paid or received for it"
  // over a token-for-token swap, contradicting the reason printed beside it.
  const unpriced = (
    d: MintDelta,
    reason: string,
    classification: TradeClassification = "transfer",
  ): WalletFill => ({
    signature,
    slot: tx.slot,
    ts,
    wallet,
    mint: d.mint,
    decimals: d.decimals,
    side: d.delta > ZERO ? "buy" : "sell",
    tokens: Math.abs(toUnits(d.delta, d.decimals)),
    pricing: "unpriced",
    unpricedReason: reason,
    classification,
  });

  // A rotation: the wallet swapped one token straight into another. Real, and
  // unpriceable here — nothing keyless publishes what either token was worth at
  // that moment, and the quote leg (if any) belongs to both sides at once.
  if (base.length > 1) {
    return base.map((d) =>
      unpriced(d, "token-for-token rotation — no single quote leg to price against", "rotate"),
    );
  }

  const b = base[0];
  const baseUnits = toUnits(b.delta, b.decimals);
  const side: "buy" | "sell" = b.delta > ZERO ? "buy" : "sell";

  // Quote resolution. Token-account leg first; native lamports only when there
  // is no token leg at all, which is exactly how the two were measured to
  // divide.
  let quoteMint: string | undefined;
  let quoteUnits = 0;
  if (quotes.length > 0) {
    const biggest = quotes.reduce((a, c) => (absBig(c.delta) > absBig(a.delta) ? c : a));
    quoteMint = biggest.mint;
    quoteUnits = toUnits(biggest.delta, biggest.decimals);
  } else if (Math.abs(nativeLamports) >= MIN_SOL_LEG_LAMPORTS) {
    quoteMint = WSOL;
    quoteUnits = nativeLamports / LAMPORTS_PER_SOL;
  }

  if (quoteMint === undefined) {
    // Distinguishable causes, and a reader should be told which. The one that
    // surprises: a wallet whose ANSEM balance grew four
    // times with no SOL leaving it, because a Jupiter swap signed and PAID FOR
    // by a different wallet delivered the tokens. Terminal bots and desks work
    // that way. The tokens are real and the cost belongs to someone else's
    // balance sheet, so this wallet has no observable entry price — and
    // borrowing the pool price would be inventing one.
    const keys = tx.transaction.message.accountKeys.map(keyAt);
    if (Math.abs(nativeLamports) > 0) {
      // A sub-rent-floor SOL residue means two opposite things depending on
      // WHICH WAY THE TOKENS WENT, and calling both "transfer" asserted
      // certainty on top of a reason that admits ambiguity — the sentence
      // said "too small to separate from account rent" and the label said
      // "nothing was paid or received for it".
      //
      //   tokens OUT: the residue is the 2,039,280 lamports of ATA rent the
      //     SENDER pays to open the RECIPIENT's account. Rent-explainable, and
      //     the dominant case — sampled live, 2 of 3 such fills on one wallet
      //     were plain `transferChecked` sends whose entire residue was that.
      //
      //   tokens IN: nothing about receiving tokens obliges this wallet to pay
      //     rent for someone else, so a residue is NOT rent-explainable. It
      //     may be a genuine micro-purchase — an ordinary pump.fun buy is
      //     0.002 SOL, below this floor — and announcing "nothing was paid"
      //     over a purchase is the same class of lie as selling a transfer.
      //
      // The honest label for the second case already existed and was
      // unreachable: `unknown` says the price could not be determined without
      // claiming there was none.
      const inbound = b.delta > ZERO;
      return [
        unpriced(
          b,
          inbound
            ? "no quote leg — a SOL residue too small to separate from account rent, so a micro-purchase and a transfer look identical here"
            : "no quote leg — SOL movement too small to separate from account rent",
          inbound ? "unknown" : "transfer",
        ),
      ];
    }
    return [
      unpriced(
        b,
        keys[0] === wallet
          ? "no quote leg — tokens moved without this wallet paying or receiving"
          : "another wallet signed and paid for this transaction — no cost attributable here",
      ),
    ];
  }

  // A swap sends the legs opposite ways. Same-sign means something else
  // happened — a liquidity deposit, a two-sided mint — and the ratio of the two
  // numbers would not be a price.
  if (Math.sign(baseUnits) === Math.sign(quoteUnits) || quoteUnits === 0) {
    return [unpriced(b, "base and quote moved the same way — not a swap", "lp")];
  }

  const quoteAmount = Math.abs(quoteUnits);
  const tokens = Math.abs(baseUnits);
  const quoteUsd =
    quoteMint === WSOL ? solUsdAt(solBars, ts) : quoteMint in STABLE_MINTS ? 1 : undefined;

  const fill: WalletFill = {
    signature,
    slot: tx.slot,
    ts,
    wallet,
    mint: b.mint,
    decimals: b.decimals,
    side,
    tokens,
    quoteMint,
    quoteAmount,
    pricing: quoteMint === WSOL ? "wsol" : "stable",
    classification: side === "buy" ? "open" : "reduce",
  };

  if (quoteUsd === undefined) {
    // The trade is real and its dollar value is not. Keeping the SOL leg and
    // dropping only the USD is the honest half-answer.
    fill.pricing = "unpriced";
    fill.unpricedReason = "no SOL/USD bar covering this hour";
  } else if (tokens > 0) {
    fill.valueUsd = quoteAmount * quoteUsd;
    fill.priceUsd = fill.valueUsd / tokens;
  }

  return [fill];
}

const absBig = (x: bigint): bigint => (x < ZERO ? -x : x);

// ---------------------------------------------------------------- the provider

export interface ActivityOptions {
  /** Hard cap on signatures listed. Each page is one request for 1,000. */
  maxSignatures?: number;
  /** Hard cap on transactions fetched. This is the expensive half. */
  maxTransactions?: number;
  /** Parallel `getTransaction` calls. Measured: 20.7ms/tx at 4, 6.1ms at 16. */
  concurrency?: number;
  /** Wall-clock ceiling on the transaction fetch. See `DEFAULT_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Pre-resolved route, so a caller reading several wallets detects once. */
  route?: RpcRoute;
  /** Pre-resolved identity, so the caller can refuse a mint before paying for it. */
  identity?: AccountIdentity;
  signal?: AbortSignal;
}

export interface WalletActivity {
  address: string;
  identity: AccountIdentity;
  fills: WalletFill[];
  coverage: WalletCoverage;
}

/**
 * Defaults sized from the measurement, not from a guess.
 *
 * Retail wallets in the sample carried 33 to 214 signatures over their whole
 * readable window and were fully covered by one page. Bots carried 6,000+
 * inside twelve minutes and cannot be covered by any budget — which is a fact
 * about bots, and `cappedByBudget` says it rather than pretending otherwise.
 */
export const DEFAULT_MAX_SIGNATURES = 3_000;
/**
 * Four hundred, not six.
 *
 * Six hundred was chosen for coverage and measured into a rate limit: four
 * wallets in one minute is 2,400 requests, which is the endpoint's entire
 * budget, and the fourth wallet came back with 544 of 600 transactions
 * refused. Four hundred plus a signature page fits four wallet reads inside
 * `RPC_BUDGET_PER_MINUTE`, and it fully covers every retail wallet measured —
 * they carried 33 to 214 transactions across their whole readable window.
 */
export const DEFAULT_MAX_TRANSACTIONS = 400;
export const DEFAULT_CONCURRENCY = 12;

/**
 * When to stop fetching whatever is left, and say so.
 *
 * A cold single wallet measured 3.3 to 3.7 seconds, which is the case that
 * actually happens: the profile is cached for forty-five seconds, so a person
 * reading one wallet never sees the throttle. Three wallets back to back is a
 * different story — the shared cooldown and the retries stretched the third one
 * to forty seconds, and forty seconds of a spinner is a page a user assumes is
 * broken.
 *
 * So the read stops and reports a smaller window. Cutting the data is
 * recoverable; the user reloads and the cache-warmed second attempt completes.
 * Cutting the honesty is not, which is why the transactions this skips are
 * counted rather than dropped.
 *
 * Twelve seconds, down from twenty-five. The blind review measured a 28.7s
 * worst case against GMGN's one to two, and a page that takes half a minute is
 * one a trader assumes is broken — the two-stage load in `walletProfile` puts
 * the balances on screen in a few hundred milliseconds, so this ceiling now
 * only bounds how much TRADE history arrives behind them.
 */
export const DEFAULT_DEADLINE_MS = 12_000;

/** Solana addresses are base58 and 32 bytes; nothing else is worth a request. */
export function isPlausibleAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export class ChainWalletProvider {
  readonly name = "solana-rpc";

  /**
   * Signatures, newest first, paging until the cap or the index runs out.
   *
   * Two things come back rather than one. `exhausted` says the index had
   * nothing older — which on the archival endpoint is the wallet's genuine
   * first transaction, and on publicnode is a two-day retention edge. Keeping
   * them apart is the whole reason `RpcRoute.archivalIndex` exists.
   */
  private async listSignatures(
    address: string,
    max: number,
    route: RpcRoute,
    signal?: AbortSignal,
  ): Promise<{ rows: SignatureRow[]; exhausted: boolean }> {
    const rows: SignatureRow[] = [];
    let before: string | undefined;
    let exhausted = false;
    while (rows.length < max) {
      const page = await rpc<SignatureRow[]>(
        route.signatures,
        "getSignaturesForAddress",
        [address, before ? { limit: 1000, before } : { limit: 1000 }],
        { signal, timeoutMs: 20_000 },
      );
      if (!Array.isArray(page) || page.length === 0) {
        exhausted = true;
        break;
      }
      rows.push(...page);
      if (page.length < 1000) {
        exhausted = true;
        break;
      }
      before = page[page.length - 1].signature;
    }
    return { rows: rows.slice(0, max), exhausted };
  }

  async getActivity(address: string, opts: ActivityOptions = {}): Promise<WalletActivity | null> {
    if (!isPlausibleAddress(address)) return null;
    const maxSignatures = opts.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
    const maxTransactions = opts.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    const route = opts.route ?? (await resolveRpcRoute());

    // What kind of address this even is, before spending four hundred requests
    // profiling a token mint as though it were a trader.
    const identity =
      opts.identity ?? (await identifyAccount(address, route.transactions, opts.signal));

    let listed: { rows: SignatureRow[]; exhausted: boolean };
    try {
      listed = await this.listSignatures(address, maxSignatures, route, opts.signal);
    } catch {
      return null;
    }

    // Failed transactions changed nothing and cost a request to confirm it.
    const usable = listed.rows.filter((r) => !r.err && r.blockTime !== null);
    // Newest first is the order that matters when the budget bites: a reader
    // wants what a wallet is doing NOW, and an old slice of a bot's day is
    // worth less than a fresh one.
    const wanted = usable.slice(0, maxTransactions);

    const solBars = await getSolBars().catch(() => [] as SolBar[]);

    const fills: WalletFill[] = [];
    const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    let read = 0;
    let failed = 0;
    let refused = 0;
    let unavailable = 0;
    let skipped = 0;
    let cursor = 0;
    // Timestamps of transactions actually READ. The window must be timed off
    // these and not off what was attempted: with an archival index the newest
    // 400 signatures can span five days while only the newest two days still
    // have bodies, and timing off attempts claimed a 123-hour fill window
    // holding two days of fills.
    const readTimes: number[] = [];
    // Signatures come back newest-first, so a RUN of nulls means the read has
    // crossed the body-retention edge and everything beyond it is gone too.
    // Detecting that saved 256 pointless requests on one measured wallet and
    // took it from a 15-second deadline overrun to a clean finish.
    let nullStreak = 0;
    let pastRetention = false;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, wanted.length) }, async () => {
        while (cursor < wanted.length) {
          if (opts.signal?.aborted) return;
          if (pastRetention || Date.now() > deadline) {
            // Whoever notices first claims the rest, so the count is right and
            // the other workers fall straight out of their loops.
            const rest = wanted.length - cursor;
            if (pastRetention) unavailable += rest;
            else skipped += rest;
            cursor = wanted.length;
            return;
          }
          const row = wanted[cursor++];
          try {
            const tx = await rpc<ParsedTx | null>(
              route.transactions,
              "getTransaction",
              [row.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
              { signal: opts.signal },
            );
            if (!tx) {
              // Null is not an error. The endpoint no longer holds the body:
              // measured, publicnode returns null for every signature older
              // than about two days while serving recent ones perfectly. Filing
              // that under "failed" would report an outage where there is a
              // documented retention edge.
              unavailable++;
              if (++nullStreak >= RETENTION_RUN) pastRetention = true;
              continue;
            }
            nullStreak = 0;
            read++;
            if (row.blockTime) readTimes.push(row.blockTime * 1000);
            fills.push(...fillsFromTx(tx, address, solBars));
          } catch (err) {
            // Counted separately because they mean different things. A refusal
            // is another tab or another minute having spent the budget and is
            // recoverable; a failure is a transaction this read will never see.
            // Both are reported, because a read that quietly lost a fifth of
            // its fills would produce a confident, wrong PnL.
            if (err instanceof RateLimitedError) refused++;
            else failed++;
          }
        }
      }),
    );

    fills.sort((a, b) => a.ts - b.ts || a.slot - b.slot);

    // The PRICED window is what was actually read — not what was listed, not
    // what was attempted, and not what the index reached. Four different spans,
    // and conflating any two of them is how a two-day fill history gets
    // presented as a career.
    const newestTs = readTimes.length ? Math.max(...readTimes) : 0;
    const oldestTs = readTimes.length ? Math.min(...readTimes) : 0;
    const cappedByBudget = !listed.exhausted || usable.length > wanted.length || skipped > 0;

    // The index span: how long this address has been active at all. Free on the
    // archival endpoints, and the single most misleading omission in the first
    // version — every wallet reported "2.0 days" whatever its real age.
    const indexTimes = listed.rows.map((r) => (r.blockTime ?? 0) * 1000).filter((t) => t > 0);
    const firstSeenTs = indexTimes.length ? Math.min(...indexTimes) : 0;

    return {
      address,
      identity,
      fills,
      coverage: {
        source: this.name,
        runtime: route.runtime,
        newestTs,
        oldestTs,
        windowHours: newestTs && oldestTs ? (newestTs - oldestTs) / 3_600_000 : 0,
        signaturesListed: listed.rows.length,
        transactionsRead: read,
        transactionsFailed: failed + refused,
        transactionsRefused: refused,
        transactionsUnavailable: unavailable,
        cappedByBudget,
        reachedEndpointLimit: listed.exhausted && !cappedByBudget,
        lifetime: false,
        indexArchival: route.archivalIndex,
        indexComplete: listed.exhausted,
        firstSeenTs,
        historyDays: firstSeenTs ? (Date.now() - firstSeenTs) / 86_400_000 : 0,
        note: coverageNote({
          exhausted: listed.exhausted,
          capped: cappedByBudget,
          oldestTs,
          refused,
          skipped,
          unavailable,
          archival: route.archivalIndex,
          hasSignatures: listed.rows.length > 0,
        }),
      },
    };
  }
}

interface NoteInput {
  exhausted: boolean;
  capped: boolean;
  oldestTs: number;
  refused: number;
  skipped: number;
  unavailable: number;
  archival: boolean;
  hasSignatures: boolean;
}

function coverageNote(n: NoteInput): string {
  const days = n.oldestTs ? (Date.now() - n.oldestTs) / 86_400_000 : 0;
  // An address with no signatures at all has no window, and the old wording
  // told one "your first activity was 0.0 days ago" — a sentence about activity
  // that never happened. Said first because every clause below assumes a read.
  if (!n.hasSignatures) {
    return n.archival
      ? "this address has never transacted — the archival index returned nothing for it at any depth"
      : "no transactions in the last ~2 days; older activity is not readable from a browser";
  }
  if (n.skipped > 0) {
    return (
      `the read ran out of time with ${n.skipped} transactions still unfetched — the window below is ` +
      `what was actually read, and a reload will get further`
    );
  }
  if (n.refused > 0) {
    return (
      `${n.refused} transactions were REFUSED by the public RPC's rate limit and are missing from ` +
      `every figure here — reload in a minute for a complete read`
    );
  }
  // The retention edge on the BODIES, which is what actually bounds the fills.
  // Distinct from the index edge, and the two now differ by months.
  if (n.unavailable > 0) {
    return (
      `${n.unavailable} older transactions are no longer served by the fast endpoint (~${TX_RETENTION_DAYS}-day ` +
      `body retention) — their fills are not in any figure here, though the index still counts them`
    );
  }
  if (n.capped) {
    return (
      `read budget reached — this is the most recent slice of a busier history, ` +
      `not the whole of it`
    );
  }
  if (n.exhausted) {
    // Two very different situations wearing the same shape, and the first
    // version asserted the wrong one on new wallets: it told a fourteen-minute-
    // old address that a two-day retention was hiding its past.
    if (n.archival) {
      return `every transaction this address has ever made was listed, and the readable ones are priced below`;
    }
    if (days >= RETENTION_EDGE_DAYS) {
      return (
        `no signatures older than ${days.toFixed(1)} days. The browser build is limited to the ~2-day ` +
        `public window, so this is where the ENDPOINT stops, not where the wallet started`
      );
    }
    return (
      `this wallet's first activity inside the ~2-day browser window was ${days.toFixed(1)} ` +
      `days ago. It may well be older — the desktop app reads the full index`
    );
  }
  return "window read in full";
}

/**
 * Where the retention explanation starts being the likely one.
 *
 * Measured at 2.02, 2.03 and 2.04 days on a quiet, years-old address across
 * three runs. 1.5 leaves room for the edge drifting with the endpoint's pruning
 * schedule without claiming retention for a wallet that is simply new.
 */
export const RETENTION_EDGE_DAYS = 1.5;

/**
 * How many consecutive missing bodies mean the retention edge, not a gap.
 *
 * Signatures arrive newest-first, so one null could be a pruned oddity but a
 * run of them is the endpoint's horizon. Twelve is one full concurrency wave —
 * long enough that a single flaky response cannot end the read, short enough
 * that crossing the edge costs a dozen requests rather than the 256 it cost
 * before this existed.
 */
export const RETENTION_RUN = 12;
