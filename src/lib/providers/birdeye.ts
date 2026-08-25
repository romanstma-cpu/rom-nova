// Birdeye adapter. Base https://public-api.birdeye.so with X-API-KEY and
// x-chain headers. Endpoints used:
//   GET /defi/token_overview?address=<mint>
//   GET /defi/token_security?address=<mint>
//   GET /defi/ohlcv?address=<mint>&type=1H&time_from&time_to
//   GET /token/v1/holder-profile?address=<mint>   (holder tags incl. bundler/sniper/insider/dev)

import { providerFetch } from "./http";
import type { MarketDataProvider, SecurityDataProvider } from "./types";
import type { Candle } from "../types";

const BASE = "https://public-api.birdeye.so";

function headers(): Record<string, string> {
  return {
    "X-API-KEY": process.env.BIRDEYE_API_KEY ?? "",
    "x-chain": "solana",
    accept: "application/json",
  };
}

interface BirdeyeEnvelope<T> {
  success: boolean;
  data: T;
}

export class BirdeyeMarketProvider implements MarketDataProvider {
  readonly name = "birdeye";

  async getCandles(mint: string, fromTs: number, toTs: number): Promise<Candle[]> {
    const url = `${BASE}/defi/ohlcv?address=${mint}&type=1H&time_from=${Math.floor(fromTs / 1000)}&time_to=${Math.floor(toTs / 1000)}`;
    const res = await providerFetch<BirdeyeEnvelope<{ items: { unixTime: number; o: number; h: number; l: number; c: number; v: number }[] }>>(
      this.name,
      url,
      { headers: headers() },
    );
    return (res.data?.items ?? []).map((x) => ({ t: x.unixTime * 1000, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
  }

  async getPrice(mint: string): Promise<number | null> {
    const res = await providerFetch<BirdeyeEnvelope<{ value: number }>>(
      this.name,
      `${BASE}/defi/price?address=${mint}`,
      { headers: headers() },
    );
    return res.data?.value ?? null;
  }
}

export class BirdeyeSecurityProvider implements SecurityDataProvider {
  readonly name = "birdeye-security";

  async getTokenSecurity(mint: string) {
    const res = await providerFetch<
      BirdeyeEnvelope<{
        ownerAddress?: string | null;
        freezeable?: boolean | null;
        freezeAuthority?: string | null;
        top10HolderPercent?: number;
        mutableMetadata?: boolean;
      }>
    >(this.name, `${BASE}/defi/token_security?address=${mint}`, { headers: headers() });
    if (!res.data) return null;
    const warnings: string[] = [];
    if (res.data.freezeAuthority) warnings.push("freeze authority present");
    if (res.data.ownerAddress) warnings.push("mint authority present");
    if (res.data.mutableMetadata) warnings.push("metadata is mutable");
    return {
      mintAuthorityRevoked: !res.data.ownerAddress,
      freezeAuthorityRevoked: !res.data.freezeAuthority,
      top10Pct: res.data.top10HolderPercent ?? 0,
      warnings,
    };
  }
}
