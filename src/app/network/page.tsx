"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useApi, useEventStream, fmtUsd, fmtPct, shortAddr, fmtAgo } from "@/lib/client";
import type { NetworkPayload, SceneMode } from "@/components/three/graph";
import type { SceneSettings } from "@/components/three/Network3D";
import { Score } from "@/components/ui/bits";
import { Legend } from "@/components/three/Legend";

const Network3D = dynamic(() => import("@/components/three/Network3D").then((m) => m.Network3D), { ssr: false });

const MODES: { id: SceneMode; label: string }[] = [
  { id: "universe", label: "Whale Universe" },
  { id: "flow", label: "Money Flow" },
  { id: "constellation", label: "Constellation" },
  { id: "clusters", label: "Whale Clusters" },
  { id: "signals", label: "Signal Galaxy" },
];

const DAY = 86_400_000;

export default function NetworkPage() {
  const [mode, setMode] = useState<SceneMode>("universe");
  const [asOf, setAsOf] = useState<number | null>(null);
  const [sliderOffset, setSliderOffset] = useState(0);
  const [selected, setSelected] = useState<{ id: string; kind: "token" | "wallet" } | null>(null);
  const [toggles, setToggles] = useState({ particles: true, labels: true, trails: true, riskOverlay: true, autoRotate: true });
  // Open on a desktop where it costs nothing; on a phone the sheet starts shut
  // so the scene is the first thing on screen.
  const [legendOpen, setLegendOpen] = useState(true);
  const [hudOpen, setHudOpen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [resetSignal, setResetSignal] = useState(0);
  const [mobile, setMobile] = useState(false);
  const burstsRef = useRef<{ from: string; to: string; sell: boolean; usd: number }[]>([]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const url = asOf ? `/api/network?asOf=${asOf}` : "/api/network";
  const { data } = useApi<NetworkPayload>(url, asOf ? undefined : 12_000);

  useEventStream((e) => {
    if (asOf || !data || !e.wallet || !e.mint) return;
    if (!data.wallets.some((w) => w.id === e.wallet) || !data.tokens.some((t) => t.id === e.mint)) return;
    burstsRef.current.push({ from: e.wallet, to: e.mint, sell: e.kind.includes("sell"), usd: e.amountUsd ?? 10_000 });
  }, !asOf);

  const settings: SceneSettings = useMemo(
    () => ({ mode, speed, ...toggles }),
    [mode, speed, toggles],
  );

  const selToken = selected?.kind === "token" ? data?.tokens.find((t) => t.id === selected.id) : undefined;
  const selWallet = selected?.kind === "wallet" ? data?.wallets.find((w) => w.id === selected.id) : undefined;
  const selCluster = selWallet?.cluster ? data?.clusters.find((c) => c.id === selWallet.cluster) : undefined;

  return (
    <div className="relative h-full min-h-0">
      {data ? (
        <Network3D
          payload={data}
          settings={settings}
          selectedId={selected?.id ?? null}
          onSelect={(id, kind) => setSelected(id && kind ? { id, kind } : null)}
          burstsRef={burstsRef}
          className="absolute inset-0"
          resetSignal={resetSignal}
          mobile={mobile}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center faint text-[12px] tracking-[0.2em]">
          REBUILDING NETWORK…
        </div>
      )}

      {/* On a phone the three HUD panels stacked to roughly 55% of the screen,
          so the controls hid the thing they control. One button, one sheet,
          closed until asked for. On a desktop there is room and it is always
          open — the toggle is display:none there. */}
      <button
        type="button"
        className="galaxy-hud-toggle btn absolute top-3 right-3 z-20"
        onClick={() => setHudOpen((v) => !v)}
        aria-expanded={hudOpen}
        aria-controls="galaxy-hud"
      >
        {hudOpen ? "✕ Close" : "☰ Scene"}
      </button>

      {/* mode + toggles HUD */}
      <div
        id="galaxy-hud"
        className="galaxy-hud absolute top-3 left-3 flex flex-col gap-2 w-[210px] md:top-3 max-md:top-14"
        hidden={mobile && !hudOpen}
      >
        <div className="panel p-2 flex flex-col gap-1">
          <div className="panel-title px-1 pb-1">Scene Mode</div>
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`text-left text-[12px] rounded px-2 py-1 ${
                mode === m.id ? "bg-[rgba(56,225,255,0.1)] text-[var(--accent)]" : "dim hover:text-[var(--text)]"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="panel p-2.5 flex flex-col gap-1.5 text-[11.5px]">
          {(
            [
              ["particles", "Particles"],
              ["trails", "Position trails"],
              ["labels", "Labels"],
              ["riskOverlay", "Risk overlays"],
              ["autoRotate", "Auto-rotate"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer dim hover:text-[var(--text)]">
              <input
                type="checkbox"
                checked={toggles[key]}
                onChange={() => setToggles((t) => ({ ...t, [key]: !t[key] }))}
                className="accent-[#38e1ff]"
              />
              {label}
            </label>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <span className="faint text-[10px] w-10">speed</span>
            <input type="range" min={0} max={3} step={0.5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="flex-1 accent-[#38e1ff]" />
            <span className="num text-[10px] w-6">{speed === 0 ? "⏸" : `${speed}x`}</span>
          </div>
          <button
            className="btn text-[11px] justify-center mt-1"
            onClick={() => {
              setSelected(null);
              setResetSignal((n) => n + 1);
            }}
          >
            ⌂ Reset view
          </button>
        </div>
        {/* The frame rate used to live here. A number only its author could
            use, sitting where a reader looks for something about the market —
            and "200 fps" on a desktop says nothing about the phone it will be
            read on. What is in the scene is worth the space; how fast it draws
            is not. */}
        <div className="panel px-2.5 py-1.5 text-[10px] num faint">
          {data ? `${data.tokens.length} tokens · ${data.wallets.length} wallets` : "…"}
        </div>

        {/* On a phone the legend joins the sheet; on a desktop it is pinned
            bottom-right, below, where there is dead space. */}
        {mobile && <Legend mode={mode} open={legendOpen} onToggle={() => setLegendOpen((v) => !v)} />}
      </div>

      {!mobile && (
        <div className="absolute bottom-20 right-3 w-[236px]">
          <Legend mode={mode} open={legendOpen} onToggle={() => setLegendOpen((v) => !v)} />
        </div>
      )}

      {/* time machine
          The positioning lives on a wrapper because .panel sets
          `position: relative` in globals.css, which is unlayered and therefore
          beats Tailwind's `.absolute` from the utilities layer. Combined on one
          element the panel won, so this bar computed to `position: relative`
          and `bottom-3` nudged it twelve pixels UP from the top of the flow —
          it has been sitting at the top of the scene, on every viewport, since
          it was written. */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 w-[min(680px,90%)] z-10">
      <div className="panel px-4 py-2.5 flex items-center gap-3">
        <button
          className={`btn text-[10px] ${asOf ? "" : "btn-primary"}`}
          onClick={() => {
            setAsOf(null);
            setSliderOffset(0);
          }}
        >
          ● LIVE
        </button>
        <input
          type="range"
          min={-7 * DAY}
          max={0}
          step={3_600_000}
          value={sliderOffset}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSliderOffset(v);
            setAsOf(v === 0 ? null : Date.now() + v);
          }}
          className="flex-1 accent-[#38e1ff]"
        />
        <span className="num text-[11px] dim w-[130px] text-right">
          {asOf ? `${fmtAgo(asOf)} (historical)` : "now"}
        </span>
      </div>
      </div>
      {asOf && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 chip chip-warn">
          TIME MACHINE — showing only what was knowable {fmtAgo(asOf)}
        </div>
      )}

      {/* selection panel — positioning on a wrapper, same reason as above */}
      {(selToken || selWallet) && (
        <div className="absolute top-3 right-3 w-[270px] z-10 max-md:top-14">
        <div className="panel p-3.5 fade-up">
          {selToken && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-semibold">{selToken.symbol}</span>
                <span className="chip">{selToken.narrative}</span>
              </div>
              <div className="mt-2 space-y-1.5 text-[12px]">
                <Row k="Signal">
                  <Score value={selToken.signalScore} />
                </Row>
                <Row k="Market cap">{fmtUsd(selToken.marketCapUsd)}</Row>
                <Row k="Liquidity">{fmtUsd(selToken.liquidityUsd)}</Row>
                <Row k="Volume 24h">{fmtUsd(selToken.volume24hUsd)}</Row>
                <Row k="24h move">
                  <span className={selToken.momentum24h >= 0 ? "pos" : "neg"}>{fmtPct(selToken.momentum24h)}</span>
                </Row>
                {selToken.riskHigh && <div className="chip chip-neg w-full justify-center mt-1">HIGH RISK FLAGS ACTIVE</div>}
              </div>
              <Link href={`/token?m=${selToken.id}`} className="btn btn-primary w-full justify-center mt-3">
                Open token intelligence
              </Link>
            </>
          )}
          {selWallet && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold num">{selWallet.entity ?? shortAddr(selWallet.id)}</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {selWallet.labels.map((l) => (
                  <span key={l} className="chip">{l.replace("_", " ")}</span>
                ))}
              </div>
              <div className="mt-2 space-y-1.5 text-[12px]">
                <Row k="Smart money">
                  <Score value={selWallet.smartMoneyScore} />
                </Row>
                <Row k="SOL balance">{selWallet.solBalance.toFixed(0)} SOL</Row>
                {selCluster && <Row k="Cluster">{selCluster.name}</Row>}
              </div>
              <Link href={`/whale?a=${selWallet.id}`} className="btn btn-primary w-full justify-center mt-3">
                Open wallet intelligence
              </Link>
            </>
          )}
        </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="faint text-[11px]">{k}</span>
      <span className="num">{children}</span>
    </div>
  );
}
