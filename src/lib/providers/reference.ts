// Reference-price providers: CoinGecko, Crypto.com Exchange, InfStones.
// These are keyless (or key-optional) public APIs, so even demo mode can
// carry one honest live number — the SOL reference price — clearly labeled
// and cross-checked across sources. Response shapes verified against the
// live services on 2026-08-25.

import { providerFetch } from "./http";

export interface SolReferenceSource {
  name: "coingecko" | "cryptocom" | "infstones";
  priceUsd: number;
  change24hPct: number | null;
}

export interface SolReference {
  priceUsd: number;
  change24hPct: number | null;
  sources: SolReferenceSource[];
  /** max relative deviation between sources, e.g. 0.002 = 0.2% */
  maxDeviation: number;
  fetchedAt: number;
}

// ---- CoinGecko: GET /api/v3/coins/markets?vs_currency=usd&ids=solana ----
interface CgMarketRow {
  id: string;
  current_price: number;
  price_change_percentage_24h: number | null;
}

async function fromCoinGecko(): Promise<SolReferenceSource> {
  const key = process.env.COINGECKO_API_KEY;
  const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=solana";
  const rows = await providerFetch<CgMarketRow[]>("coingecko", url, {
    headers: key ? { "x-cg-demo-api-key": key } : {},
    timeoutMs: 6000,
  });
  const sol = rows.find((r) => r.id === "solana");
  if (!sol) throw new Error("solana missing from CoinGecko response");
  return { name: "coingecko", priceUsd: sol.current_price, change24hPct: sol.price_change_percentage_24h };
}

// ---- Crypto.com Exchange: GET /exchange/v1/public/get-tickers?instrument_name=SOL_USD ----
// Envelope: { code: 0, result: { data: [{ a: last, c: 24h change ratio, ... }] } }
// (field names per Crypto.com Exchange v1 public API; values arrive as strings)
interface CdcTickerEnvelope {
  code: number;
  result?: { data?: { a?: string; c?: string; k?: string; b?: string }[] };
}

async function fromCryptoCom(): Promise<SolReferenceSource> {
  const url = "https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=SOL_USD";
  const res = await providerFetch<CdcTickerEnvelope>("cryptocom", url, { timeoutMs: 6000 });
  const row = res.result?.data?.[0];
  const last = Number(row?.a);
  if (!row || !Number.isFinite(last) || last <= 0) throw new Error("no SOL_USD ticker from Crypto.com");
  const changeRatio = Number(row.c);
  return {
    name: "cryptocom",
    priceUsd: last,
    change24hPct: Number.isFinite(changeRatio) ? changeRatio * 100 : null,
  };
}

// ---- InfStones (key-gated cross-check) ----
async function fromInfStones(): Promise<SolReferenceSource> {
  const key = process.env.INFSTONES_API_KEY;
  if (!key) throw new Error("INFSTONES_API_KEY not set");
  // InfStones' intelligence API proxies market data; used purely as a
  // third opinion for the agreement check.
  const url = "https://api.infstones.com/core/rest/v1/market/price?token=solana&vs=usd";
  const res = await providerFetch<{ price_usd?: number; change_24h_percent?: number }>("infstones", url, {
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: 6000,
  });
  if (!res.price_usd) throw new Error("no price from InfStones");
  return { name: "infstones", priceUsd: res.price_usd, change24hPct: res.change_24h_percent ?? null };
}

// ---------------------------------------------------------------- aggregate

let cached: SolReference | null = null;
let inflight: Promise<SolReference | null> | null = null;
const TTL = 60_000;

const flag = (name: string, dflt: boolean) => {
  const v = process.env[name];
  return v === undefined ? dflt : v !== "false" && v !== "0";
};

export async function getSolReference(): Promise<SolReference | null> {
  if (cached && Date.now() - cached.fetchedAt < TTL) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const attempts: Promise<SolReferenceSource>[] = [];
    if (flag("ENABLE_COINGECKO", true)) attempts.push(fromCoinGecko());
    if (flag("ENABLE_CRYPTOCOM", true)) attempts.push(fromCryptoCom());
    if (flag("ENABLE_INFSTONES", true) && process.env.INFSTONES_API_KEY) attempts.push(fromInfStones());

    const settled = await Promise.allSettled(attempts);
    const sources = settled
      .filter((s): s is PromiseFulfilledResult<SolReferenceSource> => s.status === "fulfilled")
      .map((s) => s.value)
      .filter((s) => Number.isFinite(s.priceUsd) && s.priceUsd > 0);

    if (sources.length === 0) {
      inflight = null;
      return cached; // stale-if-error
    }
    const prices = sources.map((s) => s.priceUsd);
    const mid = prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)];
    const maxDeviation = Math.max(...prices.map((p) => Math.abs(p / mid - 1)));
    cached = {
      priceUsd: mid,
      change24hPct: sources.find((s) => s.change24hPct !== null)?.change24hPct ?? null,
      sources,
      maxDeviation,
      fetchedAt: Date.now(),
    };
    inflight = null;
    return cached;
  })();

  return inflight;
}
