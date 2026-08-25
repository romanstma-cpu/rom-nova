// Nansen adapter (optional premium enrichment). Current API base
// https://api.nansen.ai/api/v1 with an `apiKey` header. Used for wallet
// labels and smart-money context when a key is configured.

import { providerFetch } from "./http";
import type { WalletDataProvider } from "./types";
import type { WalletTrade } from "../types";

const BASE = "https://api.nansen.ai/api/v1";

export class NansenWalletProvider implements WalletDataProvider {
  readonly name = "nansen";

  private headers(): Record<string, string> {
    return { apiKey: process.env.NANSEN_API_KEY ?? "", "Content-Type": "application/json" };
  }

  async getWalletLabels(address: string): Promise<string[]> {
    if (!process.env.NANSEN_API_KEY) return [];
    const res = await providerFetch<{ data?: { labels?: { name: string }[] } }>(
      this.name,
      `${BASE}/wallet/labels?address=${address}&chain=solana`,
      { headers: this.headers() },
    );
    return res.data?.labels?.map((l) => l.name) ?? [];
  }

  async getWalletTrades(): Promise<WalletTrade[]> {
    return []; // trade history comes from Helius; Nansen supplies labels/PnL context
  }
}
