// Helius adapter. Enhanced transaction history for wallet activity:
//   GET https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=KEY
// plus standard Solana JSON-RPC at https://mainnet.helius-rpc.com/?api-key=KEY.
// Live ingestion at scale should use Helius webhooks; this adapter covers
// on-demand reads.

import { providerFetch } from "./http";
import type { WalletDataProvider } from "./types";
import type { WalletTrade } from "../types";

interface HeliusTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string } | null;
      nativeOutput?: { account: string; amount: string } | null;
      tokenInputs?: { mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
      tokenOutputs?: { mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
    };
  };
}

export class HeliusWalletProvider implements WalletDataProvider {
  readonly name = "helius";

  async getWalletTrades(address: string, limit: number): Promise<WalletTrade[]> {
    const key = process.env.HELIUS_API_KEY;
    if (!key) return [];
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${key}&type=SWAP&limit=${limit}`;
    const txs = await providerFetch<HeliusTx[]>(this.name, url);
    const out: WalletTrade[] = [];
    for (const tx of txs) {
      const swap = tx.events?.swap;
      if (!swap) continue;
      const bought = swap.tokenOutputs?.[0];
      const sold = swap.tokenInputs?.[0];
      const leg = bought ?? sold;
      if (!leg) continue;
      const tokens = Number(leg.rawTokenAmount.tokenAmount) / 10 ** leg.rawTokenAmount.decimals;
      out.push({
        id: tx.signature.slice(0, 16),
        signature: tx.signature,
        wallet: address,
        mint: leg.mint,
        ts: tx.timestamp * 1000,
        side: bought ? "buy" : "sell",
        amountUsd: 0, // enrichment (price at ts) happens downstream
        amountTokens: tokens,
        priceUsd: 0,
        dex: "Raydium",
        classification: "unknown",
        confidence: 0.7,
      });
    }
    return out;
  }

  async getWalletLabels(): Promise<string[]> {
    return []; // Helius doesn't label wallets; Nansen/Birdeye provide labels
  }
}
