"use client";

import Link from "next/link";
import { useApi } from "@/lib/client";
import { IS_STATIC } from "@/lib/local";
import type { ProviderHealth } from "@/lib/types";

const PROVIDERS: { name: string; healthKey: string; env: string[]; role: string; keyless?: boolean }[] = [
  { name: "CoinGecko", healthKey: "coingecko", env: ["keyless (COINGECKO_API_KEY optional)"], role: "live SOL reference price + global market context — active by default", keyless: true },
  { name: "Crypto.com Exchange", healthKey: "cryptocom", env: ["keyless"], role: "live SOL_USD ticker from the public exchange API — cross-checks CoinGecko", keyless: true },
  { name: "Jupiter Tokens V2 + Swap V2", healthKey: "jupiter", env: ["JUPITER_API_KEY"], role: "token info, verification, organic score, swap routing (Ultra is superseded — not used)" },
  { name: "Birdeye", healthKey: "birdeye", env: ["BIRDEYE_API_KEY"], role: "OHLCV market data, token security, holder positions & labels (smart_trader / insider / dev / sniper / bundler)" },
  { name: "Helius", healthKey: "helius", env: ["HELIUS_API_KEY"], role: "enhanced wallet transactions, webhooks, Solana RPC/WebSocket" },
  { name: "Nansen", healthKey: "nansen", env: ["NANSEN_API_KEY"], role: "optional premium wallet labels and smart-money datasets" },
  { name: "InfStones", healthKey: "infstones", env: ["INFSTONES_API_KEY"], role: "blockchain intelligence: third-opinion price cross-check" },
  { name: "DEX Screener", healthKey: "dexscreener", env: ["ENABLE_DEXSCREENER=true"], role: "keyless fallback for pairs, liquidity and price", keyless: true },
];

export default function SettingsPage() {
  const { data } = useApi<{ providers: ProviderHealth[] }>("/api/status");
  const byName = new Map((data?.providers ?? []).map((p) => [p.name, p]));

  return (
    <div className="p-3 flex flex-col gap-3 max-w-[980px]">
      <h1 className="text-[15px] font-semibold tracking-wide">SETTINGS · DATA PROVIDERS</h1>

      <div className="panel p-3.5 text-[12px] dim leading-relaxed">
        {IS_STATIC ? (
          <>
            This deployment runs <b className="text-[var(--warn)]">entirely in your browser</b>: the analytics universe is a
            deterministic simulation, your watchlists / alerts / paper desk live in your browser&apos;s local storage, and the
            SOL reference price is genuinely live from keyless public APIs. Vendor integrations (Jupiter, Birdeye, Helius,
            Nansen, InfStones) require running the open-source project in server mode with your own API keys — the adapters
            ship in the codebase, keys never reach a browser.
          </>
        ) : (
          <>
            Server mode. With no API keys the app runs on the deterministic simulation, plus the live SOL reference from
            keyless public APIs. To activate a vendor, copy <code className="num text-[var(--accent)]">.env.example</code> to{" "}
            <code className="num text-[var(--accent)]">.env.local</code>, add its key, and restart. Providers activate
            individually; anything unconfigured keeps serving simulated data, labeled as such on{" "}
            <Link href="/status" className="link">/status</Link>.
          </>
        )}
      </div>

      <div className="panel">
        {PROVIDERS.map((p) => {
          const health = byName.get(p.healthKey);
          const live = health?.mode === "live";
          return (
            <div key={p.name} className="px-4 py-3 border-b border-[rgba(27,35,51,0.5)] flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold">{p.name}</span>
                  <span className={`chip ${live ? "chip-pos" : p.keyless ? "chip-accent" : ""}`}>
                    {live ? "LIVE" : p.keyless ? "available keyless" : "server mode + key"}
                  </span>
                </div>
                <div className="text-[11.5px] dim mt-1">{p.role}</div>
              </div>
              <div className="num text-[10.5px] faint text-right shrink-0">
                {p.env.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel p-3.5 text-[11.5px] dim leading-relaxed">
        <span className="panel-title block mb-1.5">Security posture</span>
        No accounts, no personal data collected, no cookies beyond your browser&apos;s own storage of your workspace. API
        keys exist only server-side in server mode and never reach a browser in any mode. There is no private-key or
        seed-phrase handling anywhere in this application, and live trading is not implemented: real-wallet integration is
        spec&apos;d to use wallet-adapter signatures with explicit per-trade confirmation, behind ENABLE_REAL_TRADING, and
        ships disabled. See <Link href="/legal" className="link">the disclaimer</Link> for the full data-honesty statement.
      </div>
    </div>
  );
}
