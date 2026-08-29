// Wallet-level flow, from SQD's Solana Portal.
//
// This is the gap the whole app has been built around and never had. Every
// live feature vector so far has carried these five fields as literal zeros:
//
//   smartMoneyNetFlowUsd: 0,  smartMoneyWallets: 0,
//   whaleNetFlowUsd: 0,       whaleBuys: 0,  whaleSells: 0,
//
// declared unmeasured rather than faked, because no keyless source publishes
// who is buying. SQD does: its `tokenBalances` stream carries preOwner/postOwner
// with preAmount/postAmount, filterable by mint, keyless, real-time, and — the
// part that matters for a static export — reachable from a browser.
//
// THE CONSTRAINT THAT SHAPES EVERY DECISION HERE
//
// Measured from the deployed origin against wrapped SOL, the busiest mint on
// the chain:
//
//   200 blocks (~80 seconds)     26 MB
//   2,000 blocks (~13 minutes)  262 MB
//
// An hour would be over a gigabyte, in a tab. wSOL is the worst case rather
// than the typical one — it is touched by nearly every swap — but a provider
// that only works on quiet tokens and melts a browser on busy ones is not a
// provider, it is a trap. So this streams with a hard byte budget and stops
// when it hits it.
//
// Stopping early is not failure; PRETENDING not to have stopped is. A partial
// read reports `complete: false` with the blocks it actually covered, so a
// caller can say "flow over the last 4 minutes" instead of quietly presenting a
// truncated window as a full one.
//
// Two more things the raw stream will mislead you about:
//
//  - Most rows are accounts merely TOUCHED by a transaction, where preAmount
//    equals postAmount. The share that is real movement varies enormously by
//    mint — measured at 25% on wSOL and 7% on a trending memecoin — so counting
//    rows instead of changes would overstate participation by four to fourteen
//    times, and worst on exactly the small tokens this app is about.
//  - Amounts are raw base units. They mean nothing without the mint's decimals,
//    and nothing in USD without a price, so this returns units and leaves both
//    conversions to a caller that has them.

import type { TokenFlow, TokenFlowProvider } from "./types";

const PORTAL = "https://portal.sqd.dev/datasets/solana-mainnet";

/**
 * How much of a response we are willing to read.
 *
 * Eight megabytes is roughly sixty blocks of wSOL and many minutes of a
 * memecoin. It is chosen to be survivable in a browser tab rather than to be
 * enough — the whole point of the partial-result contract is that "enough"
 * depends on the mint and cannot be known in advance.
 */
export const DEFAULT_BYTE_BUDGET = 8 * 1024 * 1024;

/** Solana produces a block roughly every 400ms. */
export const BLOCKS_PER_MINUTE = 150;

/** `0n` literals need an ES2020 target; this project builds below it. */
const ZERO = BigInt(0);

export interface FlowOptions {
  /** How far back to look. Converted to blocks at the chain's own rate. */
  minutes?: number;
  byteBudget?: number;
  /** Owners moving at least this many raw units are reported individually. */
  topMovers?: number;
  signal?: AbortSignal;
}

interface RawBalance {
  account?: string;
  preOwner?: string | null;
  postOwner?: string | null;
  preAmount?: string | null;
  postAmount?: string | null;
  postMint?: string | null;
  preMint?: string | null;
}

/**
 * Folds one streamed row into the running tally, or ignores it.
 *
 * Pure so the suite can prove the two rules that matter without a network: an
 * unchanged balance is not flow, and a closed account still attributes to the
 * owner it had before it closed.
 */
export function foldBalance(
  row: RawBalance,
  into: Map<string, bigint>,
): "counted" | "unchanged" | "unattributable" {
  const pre = row.preAmount ?? null;
  const post = row.postAmount ?? null;
  if (pre === post) return "unchanged";

  // postOwner is null when the token account was closed in this transaction.
  // The movement is still real and still belongs to whoever held it.
  const owner = row.postOwner ?? row.preOwner ?? null;
  if (!owner) return "unattributable";

  // BigInt rather than Number: an SPL supply routinely exceeds 2^53 — wrapped
  // SOL's is 8.8e18 — so parsing these as numbers would silently round the
  // large balances that matter most.
  let delta: bigint;
  try {
    delta = BigInt(post ?? "0") - BigInt(pre ?? "0");
  } catch {
    return "unattributable";
  }
  if (delta === ZERO) return "unchanged";
  into.set(owner, (into.get(owner) ?? ZERO) + delta);
  return "counted";
}

/** Turns the per-owner ledger into the shape a feature vector wants. */
export function summarise(
  byOwner: Map<string, bigint>,
  topMovers: number,
): Pick<TokenFlow, "wallets" | "netUnits" | "inflowUnits" | "outflowUnits" | "buyers" | "sellers" | "largest"> {
  let inflow = ZERO;
  let outflow = ZERO;
  let buyers = 0;
  let sellers = 0;
  for (const delta of byOwner.values()) {
    if (delta > ZERO) {
      inflow += delta;
      buyers++;
    } else if (delta < ZERO) {
      outflow += -delta;
      sellers++;
    }
  }
  const largest = [...byOwner.entries()]
    .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))
    .filter(([, d]) => d !== ZERO);
  // Biggest accumulation and biggest distribution both matter; taking only the
  // top of a descending sort would report buyers and never the wallet quietly
  // unloading.
  const head = largest.slice(0, topMovers);
  const tail = largest.slice(-topMovers).reverse();
  const seen = new Set<string>();
  const movers: TokenFlow["largest"] = [];
  for (const [owner, deltaUnits] of [...head, ...tail]) {
    if (seen.has(owner)) continue;
    seen.add(owner);
    movers.push({ owner, deltaUnits: deltaUnits.toString() });
  }

  return {
    wallets: byOwner.size,
    netUnits: (inflow - outflow).toString(),
    inflowUnits: inflow.toString(),
    outflowUnits: outflow.toString(),
    buyers,
    sellers,
    largest: movers,
  };
}

export class SqdFlowProvider implements TokenFlowProvider {
  readonly name = "sqd";

  async head(): Promise<number | null> {
    try {
      const r = await fetch(`${PORTAL}/head`, { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const j = (await r.json()) as { number?: number };
      return typeof j.number === "number" ? j.number : null;
    } catch {
      return null;
    }
  }

  async getTokenFlow(mint: string, opts: FlowOptions = {}): Promise<TokenFlow | null> {
    const minutes = Math.max(1, opts.minutes ?? 10);
    const byteBudget = opts.byteBudget ?? DEFAULT_BYTE_BUDGET;
    const topMovers = opts.topMovers ?? 5;

    const head = await this.head();
    if (head === null) return null;
    const fromBlock = Math.max(0, head - minutes * BLOCKS_PER_MINUTE);

    const ctl = new AbortController();
    // An externally-cancelled request must still cancel the stream, or a
    // navigated-away page keeps pulling megabytes.
    opts.signal?.addEventListener("abort", () => ctl.abort(), { once: true });

    let res: Response;
    try {
      res = await fetch(`${PORTAL}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          type: "solana",
          fromBlock,
          toBlock: head,
          fields: {
            block: { number: true, timestamp: true },
            tokenBalance: {
              postOwner: true,
              preOwner: true,
              preAmount: true,
              postAmount: true,
              postMint: true,
            },
          },
          // postMint only: a row whose mint CHANGED is not this token's flow,
          // and matching preMint as well would count a swap's other leg.
          tokenBalances: [{ postMint: [mint] }],
        }),
      });
    } catch {
      return null;
    }
    if (!res.ok || !res.body) return null;

    const byOwner = new Map<string, bigint>();
    let bytesRead = 0;
    let movements = 0;
    let unchanged = 0;
    let lastBlock = fromBlock;
    let lastTimestamp = 0;
    let complete = true;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (line: string): void => {
      if (!line.trim()) return;
      let parsed: { header?: { number?: number; timestamp?: number }; tokenBalances?: RawBalance[] };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        return; // a torn final line is expected when the budget cuts the stream
      }
      if (typeof parsed.header?.number === "number") lastBlock = parsed.header.number;
      if (typeof parsed.header?.timestamp === "number") lastTimestamp = parsed.header.timestamp;
      for (const row of parsed.tokenBalances ?? []) {
        const verdict = foldBalance(row, byOwner);
        if (verdict === "counted") movements++;
        else if (verdict === "unchanged") unchanged++;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          consume(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
        if (bytesRead >= byteBudget) {
          // Budget reached. Everything folded so far is real; the window just
          // ends earlier than asked, and `complete: false` says so.
          complete = false;
          void reader.cancel().catch(() => {});
          break;
        }
      }
      if (complete) consume(buffer);
    } catch {
      // A dropped connection mid-stream is a partial read, not an empty one.
      complete = false;
    }

    return {
      mint,
      source: this.name,
      fromBlock,
      toBlock: head,
      reachedBlock: lastBlock,
      blocksRequested: head - fromBlock,
      blocksCovered: Math.max(0, lastBlock - fromBlock),
      lastTimestamp,
      complete,
      bytesRead,
      movements,
      touchedNotMoved: unchanged,
      ...summarise(byOwner, topMovers),
    };
  }
}

/**
 * The share of the requested window a partial read actually covered.
 *
 * Callers should print this rather than the window they asked for. "Flow over
 * the last ten minutes" is false when the budget stopped at four.
 */
export function coveragePct(flow: TokenFlow): number {
  if (flow.blocksRequested <= 0) return 0;
  return Math.min(100, (flow.blocksCovered / flow.blocksRequested) * 100);
}

/** Raw base units to a human amount, once the mint's decimals are known. */
export function toUnits(raw: string, decimals: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
}
