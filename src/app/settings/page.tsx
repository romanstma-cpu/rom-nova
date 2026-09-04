"use client";

// Settings, ordered by what a reader can actually change from here.
//
// The page used to be titled DATA PROVIDERS and lead with a paragraph about
// server mode — a list of eight vendors, seven of which cannot be configured
// from a browser at all. The things a visitor CAN set were scattered: the AI
// key here, the Helius key three panels down the radar page, the intro and
// the explainers with no way back at all. Now: your keys, this browser's
// memory, then the provider list folded behind one line for the people
// running the project themselves.

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useApi } from "@/lib/client";
import { IS_STATIC } from "@/lib/local";
import type { ProviderHealth } from "@/lib/types";
import { AiKeyCard } from "@/components/ui/AiKeyCard";
import { HeliusKeyCard } from "@/components/radar/HeliusKeyCard";
import { PageTitle } from "@/components/ui/PageTitle";
import { foldAllHints, hintsServerSnapshot, hintsSnapshot, openHintCount, subscribeHints } from "@/components/ui/Hint";
import { introSeenServer, introSeenSnapshot, showIntroAgain, subscribeIntro } from "@/components/FirstRun";
import { journalCounts, radarJournalReady } from "@/lib/radar/journal";
import { forgetRadarJournal } from "@/lib/radar/hunter";

const PROVIDERS: { name: string; healthKey: string; env: string[]; role: string; keyless?: boolean }[] = [
  { name: "CoinGecko", healthKey: "coingecko", env: ["keyless (COINGECKO_API_KEY optional)"], role: "live SOL reference price + global market context — active by default", keyless: true },
  { name: "Crypto.com Exchange", healthKey: "cryptocom", env: ["keyless"], role: "live SOL_USD ticker from the public exchange API — cross-checks CoinGecko", keyless: true },
  { name: "Jupiter Tokens V2 + Swap V2", healthKey: "jupiter", env: ["JUPITER_API_KEY"], role: "token info, verification, organic score, swap routing (Ultra is superseded — not used)" },
  { name: "Birdeye", healthKey: "birdeye", env: ["BIRDEYE_API_KEY"], role: "OHLCV market data, token security, holder positions & labels (smart_trader / insider / dev / sniper / bundler)" },
  { name: "Helius", healthKey: "helius", env: ["HELIUS_API_KEY"], role: "enhanced wallet transactions, webhooks, Solana RPC/WebSocket — the browser-side key above covers the Whale Radar without server mode" },
  { name: "Nansen", healthKey: "nansen", env: ["NANSEN_API_KEY"], role: "optional premium wallet labels and smart-money datasets" },
  { name: "InfStones", healthKey: "infstones", env: ["INFSTONES_API_KEY"], role: "blockchain intelligence: third-opinion price cross-check" },
  { name: "DEX Screener", healthKey: "dexscreener", env: ["ENABLE_DEXSCREENER=true"], role: "keyless fallback for pairs, liquidity and price", keyless: true },
];

/** One row of "this browser remembers X" with its one action. */
function MemoryRow({ title, detail, action, onAction, disabled }: { title: string; detail: string; action: string; onAction: () => void; disabled?: boolean }) {
  return (
    <div className="px-4 py-3 border-b border-[rgba(27,35,51,0.5)] flex items-center gap-4 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">{title}</div>
        <div className="text-[11px] dim mt-0.5">{detail}</div>
      </div>
      <button type="button" className="btn text-[11px] shrink-0" onClick={onAction} disabled={disabled}>
        {action}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { data } = useApi<{ providers: ProviderHealth[] }>("/api/status");
  const byName = new Map((data?.providers ?? []).map((p) => [p.name, p]));

  // Browser-only facts through their stores' own seams, so the prerendered
  // page and the first paint agree; the radar counts come off the disk after
  // mount, and `tick` re-reads them after a forget.
  const seen = useSyncExternalStore(subscribeIntro, introSeenSnapshot, introSeenServer);
  const hintsOpen = openHintCount(useSyncExternalStore(subscribeHints, hintsSnapshot, hintsServerSnapshot));
  const [tick, setTick] = useState(0);
  const [radar, setRadar] = useState<{ wallets: number; fills: number; signals: number } | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetNote, setForgetNote] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    void radarJournalReady().then(() => {
      if (!dead) setRadar(journalCounts());
    });
    return () => {
      dead = true;
    };
  }, [tick]);
  const bump = () => setTick((t) => t + 1);

  return (
    <div className="p-3 flex flex-col gap-3 max-w-[980px]">
      <div className="flex items-center gap-2 flex-wrap">
        <PageTitle title="SETTINGS" lede="Your keys, what this browser remembers, and where the data comes from" />
      </div>

      <div className="flex flex-col gap-2">
        <div className="panel-title px-1">Your keys · stored in this browser only</div>
        <AiKeyCard />
        <HeliusKeyCard />
      </div>

      <div className="flex flex-col gap-2">
        <div className="panel-title px-1">What this browser remembers</div>
        <div className="panel">
          <MemoryRow
            title="Introduction"
            detail={seen ? "Dismissed. The three-step start on the dashboard can come back." : "Showing on the dashboard."}
            action="Show it again"
            disabled={!seen}
            onAction={showIntroAgain}
          />
          <MemoryRow
            title="Explainers"
            detail={
              hintsOpen > 0
                ? `${hintsOpen} page explainer${hintsOpen === 1 ? "" : "s"} left open. Fold them all back to one line.`
                : "Every page explainer is folded to its one line; 'how to read this' opens one."
            }
            action="Fold them all"
            disabled={hintsOpen === 0}
            onAction={foldAllHints}
          />
          <div className="px-4 py-3 flex items-center gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold">Whale Radar journal</div>
              <div className="text-[11px] dim mt-0.5">
                {radar
                  ? radar.wallets + radar.fills + radar.signals === 0
                    ? "Empty. The radar journals tracked wallets and their fills here as it hunts."
                    : `${radar.wallets} tracked wallet${radar.wallets === 1 ? "" : "s"} · ${radar.fills} journaled fill${radar.fills === 1 ? "" : "s"} · ${radar.signals} signal${radar.signals === 1 ? "" : "s"}. Scores are recomputed from this on every start; forgetting it starts every wallet from zero.`
                  : "reading…"}
                {forgetNote && <span className="warn"> {forgetNote}</span>}
              </div>
            </div>
            {confirmForget ? (
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] warn">This cannot be undone.</span>
                <button
                  type="button"
                  className="btn btn-danger text-[11px]"
                  onClick={() => {
                    setConfirmForget(false);
                    void forgetRadarJournal().then((ok) => {
                      setForgetNote(ok ? null : "The disk copy could not be cleared; it will reload next start.");
                      bump();
                    });
                  }}
                >
                  Forget it
                </button>
                <button type="button" className="btn text-[11px]" onClick={() => setConfirmForget(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn text-[11px] shrink-0"
                disabled={!radar || radar.wallets + radar.fills + radar.signals === 0}
                onClick={() => setConfirmForget(true)}
              >
                Forget it…
              </button>
            )}
          </div>
        </div>
        <div className="text-[10.5px] faint px-1">
          Watchlists, alert rules, the paper desk and the wallet ledger live in this browser too, and are managed on
          their own pages. Clearing this site&apos;s data in the browser removes all of it.
        </div>
      </div>

      <details className="panel p-3.5 fold" open={!IS_STATIC}>
        <summary>
          <span className="panel-title">Data providers</span>
          <span className="text-[11px] dim">
            {IS_STATIC ? "what is live in this build, and what needs the project run in server mode" : "server mode — keys in .env.local"}
          </span>
        </summary>
        <div className="fold-body">
          <div className="text-[11.5px] dim leading-relaxed">
            {IS_STATIC ? (
              <>
                This build runs <b className="text-[var(--warn)]">entirely in your browser</b>. Live token, launch,
                wallet and price data come from keyless public sources; wallet reputation and a few panels are a
                labelled simulation. Vendor integrations below marked <i>server mode + key</i> require running the
                open-source project yourself with your own API keys — the adapters ship in the codebase, and those
                keys never reach a browser.
              </>
            ) : (
              <>
                Server mode. With no API keys the app runs on keyless sources plus the deterministic simulation. To
                activate a vendor, copy <code className="num text-[var(--accent)]">.env.example</code> to{" "}
                <code className="num text-[var(--accent)]">.env.local</code>, add its key, and restart. Providers
                activate individually; anything unconfigured keeps serving simulated data, labelled as such on{" "}
                <Link href="/status" className="link">Status</Link>.
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
        </div>
      </details>

      <div className="panel p-3.5 text-[11.5px] dim leading-relaxed">
        <span className="panel-title block mb-1.5">Security posture</span>
        No accounts, no personal data collected, no cookies beyond your browser&apos;s own storage of your workspace.
        Vendor API keys exist only server-side in server mode; the two exceptions are the keys YOU choose to paste
        above — the optional AI key and the Whale Radar&apos;s optional Helius key — which are stored in your browser
        alone and sent only to their own vendors. There is no private-key or seed-phrase handling anywhere in this
        application, and live trading is not implemented: real-wallet integration is spec&apos;d to use wallet-adapter
        signatures with explicit per-trade confirmation, behind ENABLE_REAL_TRADING, and ships disabled. See{" "}
        <Link href="/legal" className="link">the disclaimer</Link> for the full data-honesty statement.
      </div>
    </div>
  );
}
