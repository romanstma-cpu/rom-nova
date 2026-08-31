// What a wallet holds RIGHT NOW, read rather than reconstructed.
//
// The obvious way to answer this is `getTokenAccountsByOwner`, and it is
// blocked: measured against publicnode with `Origin: app://rom-nova` it
// returns HTTP 403, and every other keyless RPC refuses the method or refuses
// the caller. So the chain will hand out a wallet's TRANSACTIONS for free and
// not its BALANCES, which is the opposite of what you would expect.
//
// Jupiter's Ultra holdings endpoint answers it in ~150ms, keyless, and
// reflects `app://rom-nova` back as the allowed origin — the same property
// that made `lite-api.jup.ag` the token source for this app.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
//
// A position derived from trade history is only as complete as the history,
// and the history here is a two-day window. A position READ from the chain is
// complete regardless. Having both is what makes the difference visible:
// when the fills account for 400 tokens and the wallet holds 10,000, the other
// 9,600 were acquired where nobody could see, and no cost basis for that
// position is honest. That reconciliation is in `wallet-profile.ts`, and it is
// the single thing this file exists to enable.

import { providerFetch } from "./http";

const HOLDINGS_URL = "https://lite-api.jup.ag/ultra/v1/holdings";
const PRICE_URL = "https://lite-api.jup.ag/price/v3";
const SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";
/** One search request's worth. Fifty 44-char mints keep the URL under 3KB. */
export const MAX_SYMBOL_MINTS = 50;

/**
 * Mints per price request.
 *
 * Jupiter's price endpoint takes a comma-separated list; fifty keeps the URL
 * short enough to stay clear of gateway limits and is the batch size the
 * token list already uses successfully.
 */
export const PRICE_BATCH = 50;

/**
 * Ceiling on mints priced for one wallet.
 *
 * Measured on a real trader: 1,434 token accounts, 312 with a non-zero
 * balance. Pricing all of them is seven round trips for a tail of dust. Two
 * hundred covers any position that matters, and `unpricedMints` reports the
 * remainder rather than valuing them at zero — a wallet is not worth less
 * because we stopped asking.
 */
export const MAX_PRICED_MINTS = 200;

interface JupAccount {
  amount: string;
  uiAmount: number;
  decimals: number;
  isFrozen?: boolean;
  excludeFromNetWorth?: boolean;
}

interface JupHoldingsResponse {
  /** Native SOL, in lamports, as a string. */
  amount?: string;
  uiAmount?: number;
  tokens?: Record<string, JupAccount[]>;
}

export interface HeldToken {
  mint: string;
  tokens: number;
  decimals: number;
  frozen: boolean;
  excludeFromNetWorth: boolean;
}

export interface WalletHoldingsResult {
  source: string;
  address: string;
  solBalance: number;
  tokens: HeldToken[];
}

export class JupiterHoldingsProvider {
  readonly name = "jupiter";

  async getHoldings(address: string): Promise<WalletHoldingsResult | null> {
    let body: JupHoldingsResponse;
    try {
      body = await providerFetch<JupHoldingsResponse>("jupiter", `${HOLDINGS_URL}/${address}`, {
        // Slower than the token endpoints because it walks every account the
        // wallet ever opened. Measured at 110-175ms for normal wallets; the
        // pathological ones (an AMM authority with tens of thousands of
        // accounts) time out at the vendor and 500, which is a miss, not a
        // zero-balance wallet.
        timeoutMs: 20_000,
      });
    } catch {
      return null;
    }
    return { source: this.name, address, ...parseHoldings(body) };
  }

  /**
   * Batch prices, in insertion order, skipping what the budget cannot reach.
   *
   * Order is the caller's priority: `wallet-profile` puts the mints the wallet
   * actually traded in the window first, so a budget that runs out drops the
   * dust rather than the position being asked about.
   */
  async priceMints(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const wanted = mints.slice(0, MAX_PRICED_MINTS);
    for (let i = 0; i < wanted.length; i += PRICE_BATCH) {
      const batch = wanted.slice(i, i + PRICE_BATCH);
      try {
        const body = await providerFetch<Record<string, { usdPrice?: number }>>(
          "jupiter",
          `${PRICE_URL}?ids=${batch.join(",")}`,
          { timeoutMs: 8_000 },
        );
        for (const [mint, row] of Object.entries(body ?? {})) {
          if (typeof row?.usdPrice === "number" && Number.isFinite(row.usdPrice)) {
            out.set(mint, row.usdPrice);
          }
        }
      } catch {
        // A failed batch leaves those mints unpriced, which the caller reports
        // as unpriced. Retrying here would turn one slow wallet into a stall.
      }
    }
    return out;
  }

  /**
   * Symbols for these mints, one request, best effort.
   *
   * The price endpoint carries no symbols, so the wallet page rendered every
   * position as a truncated mint — "BvsA…pump" for a token Jupiter itself
   * lists as USELESSV2. `tokens/v2/search` accepts a comma-separated batch
   * (probed live: two mints in, two rows out), so fifty symbols cost one
   * request. Cosmetic and must never gate a figure: any failure is an address
   * on screen, not a missing row.
   */
  async symbolsFor(mints: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const wanted = [...new Set(mints)].slice(0, MAX_SYMBOL_MINTS);
    if (wanted.length === 0) return out;
    try {
      const body = await providerFetch<{ id?: string; symbol?: string }[]>(
        "jupiter",
        `${SEARCH_URL}?query=${wanted.join(",")}`,
        { timeoutMs: 8_000 },
      );
      for (const row of body ?? []) {
        if (typeof row?.id === "string" && typeof row?.symbol === "string" && row.symbol) {
          out.set(row.id, row.symbol);
        }
      }
    } catch {
      // An empty map, by design.
    }
    return out;
  }
}

/**
 * Jupiter's shape to ours, dropping empty accounts.
 *
 * A wallet keeps a token account after selling out of the position — 1,122 of
 * one real trader's 1,434 accounts held nothing. Listing those as holdings
 * would fill the positions table with tokens the wallet does not own.
 */
export function parseHoldings(body: JupHoldingsResponse): Omit<WalletHoldingsResult, "source" | "address"> {
  const tokens: HeldToken[] = [];
  for (const [mint, accounts] of Object.entries(body.tokens ?? {})) {
    if (!Array.isArray(accounts)) continue;
    let total = 0;
    let decimals = 0;
    let frozen = false;
    let excluded = false;
    for (const a of accounts) {
      const amount = Number(a?.uiAmount);
      if (Number.isFinite(amount)) total += amount;
      if (typeof a?.decimals === "number") decimals = a.decimals;
      if (a?.isFrozen) frozen = true;
      if (a?.excludeFromNetWorth) excluded = true;
    }
    if (total <= 0) continue;
    tokens.push({ mint, tokens: total, decimals, frozen, excludeFromNetWorth: excluded });
  }
  tokens.sort((a, b) => b.tokens - a.tokens);
  const sol = Number(body.uiAmount);
  return { solBalance: Number.isFinite(sol) ? sol : 0, tokens };
}
