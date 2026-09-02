"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useApi, useEventStream, fmtUsd, fmtPct, fmtAge, whaleFlowCell } from "@/lib/client";
import { Score, Skel, SkeletonRows, Stat, TokenMark } from "@/components/ui/bits";
import { FirstRun } from "@/components/FirstRun";
import { ActivityFeed } from "@/components/feed/ActivityFeed";
import { FlowChart } from "@/components/charts/FlowChart";
import type { MarketState, Signal } from "@/lib/types";
import type { TokenRow, FlowPoint } from "@/lib/api/rows";
import type { NetworkPayload } from "@/components/three/graph";
import type { SceneSettings } from "@/components/three/Network3D";

const Network3D = dynamic(() => import("@/components/three/Network3D").then((m) => m.Network3D), { ssr: false });

type SignalWithMeta = Signal & { symbol: string; name: string; hue: number };

const SCENE: SceneSettings = {
  mode: "universe",
  particles: true,
  labels: true,
  trails: true,
  riskOverlay: true,
  autoRotate: true,
  speed: 1,
};

interface SolReference {
  priceUsd: number;
  change24hPct: number | null;
}

export default function Dashboard() {
  const { data: market } = useApi<{ market: MarketState; reference: SolReference | null }>("/api/market", 8000);
  const { data: sigData } = useApi<{ signals: SignalWithMeta[]; demo?: boolean }>("/api/signals", 30_000);
  const { data: rowData } = useApi<{ rows: TokenRow[] }>("/api/tokens?sort=h24&limit=10", 20_000);
  const { data: net } = useApi<NetworkPayload>("/api/network", 15_000);
  const { data: flowData } = useApi<{ flow: FlowPoint[]; demo?: boolean }>("/api/flow?hours=72", 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const burstsRef = useRef<{ from: string; to: string; sell: boolean; usd: number }[]>([]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEventStream((e) => {
    if (!net || !e.wallet || !e.mint) return;
    if (!net.wallets.some((w) => w.id === e.wallet) || !net.tokens.some((t) => t.id === e.mint)) return;
    burstsRef.current.push({ from: e.wallet, to: e.mint, sell: e.kind.includes("sell"), usd: e.amountUsd ?? 10_000 });
  });

  const m = market?.market;
  const ref = market?.reference;
  const conviction = useMemo(
    () => (sigData?.signals ?? []).filter((s) => s.label !== "NO TRADE" && s.score >= 55).slice(0, 6),
    [sigData],
  );
  const highConviction = (sigData?.signals ?? []).filter((s) => s.score >= 64 && s.label !== "NO TRADE").length;

  return (
    <div className="p-3 flex flex-col gap-3 min-h-full">
      {/* Shown once, above everything, then never again. A visitor arriving
          from the site's hero has clicked "Launch it live" and landed on a
          wall of numbers with no idea what any of it is for. */}
      <FirstRun />

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {ref ? (
          <Stat label="SOL · live ref" sub={ref.change24hPct !== null ? fmtPct(ref.change24hPct) + " 24h" : "cross-checked"}>
            <span className="text-[var(--accent)]">{fmtUsd(ref.priceUsd)}</span>
          </Stat>
        ) : (
          <Stat label="SOL · simulated" sub={m ? fmtPct(m.solChange24hPct) + " 24h (sim)" : undefined}>
            {m ? fmtUsd(m.solPriceUsd) : "—"}
          </Stat>
        )}
        {/* Seven tiles was the review's "wall of numbers", and four of them
            were the simulator's — regime, meme momentum, smart-money flow,
            active whales — sitting unlabelled beside a live SOL price. One
            tile now carries the simulated market, says so, and links to it. */}
        <Stat label="Simulated market" sub={m ? `${m.regime.replace(/_/g, " ")} · meme ${m.memeMomentumIndex}/100 · SIMULATED` : "SIMULATED"}>
          <Link href="/flow" className="text-[13px] tracking-wide uppercase link">
            {m ? `${m.activeWhales24h} sim whales` : "—"}
          </Link>
        </Stat>
        {/* The review found this counter reading simulator signals while the
            Momentum Leaders table beside it showed live scores the counter
            could not see (H7). The feed underneath is live now when a live
            token source answers, and this label says which universe was
            counted rather than leaving the reader to assume. */}
        <Stat
          label="Actionable Signals"
          sub={sigData ? (sigData.demo === false ? "score ≥ 64 · live trending list" : "score ≥ 64 · SIMULATED") : "score ≥ 64, not NO TRADE"}
        >
          <span className="text-[var(--accent)]">{sigData ? highConviction : "—"}</span>
        </Stat>
      </div>

      {/* main tri-panel */}
      <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr_290px] gap-3 min-h-[460px]">
        {/* conviction cards */}
        <div className="panel flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
            <span className="panel-title">Highest Conviction</span>
            {sigData && <span className="chip text-[9.5px]">{sigData.demo === false ? "LIVE" : "SIMULATED"}</span>}
            <Link href="/signals" className="link text-[10.5px]">all signals →</Link>
          </div>
          <div className="overflow-y-auto min-h-0 max-h-[560px]">
            {conviction.map((s, i) => (
              <Link key={s.id} href={`/signal?id=${s.id}`} className="block px-3 py-2.5 border-b border-[rgba(27,35,51,0.5)] hover:bg-[rgba(40,55,85,0.15)]">
                <div className="flex items-center gap-2">
                  <span className="faint num text-[10px] w-3">{i + 1}</span>
                  <TokenMark hue={s.hue} symbol={s.symbol} size={20} />
                  <span className="text-[13px] font-semibold">{s.symbol}</span>
                  <span className="chip ml-auto">{s.kind.replace(/_/g, " ")}</span>
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <Score value={s.score} width={80} />
                  <span className="num text-[10.5px] faint">conf {(s.confidence * 100).toFixed(0)}%</span>
                </div>
                <div className="text-[11px] dim mt-1.5 leading-snug line-clamp-2">▲ {s.why[0]}</div>
                <div className="text-[11px] faint mt-0.5 leading-snug line-clamp-1">▽ {s.bearCase[0]}</div>
              </Link>
            ))}
            {/* Before the first signals payload: card-shaped shimmer, so the
                column holds its width and the eventual cards land in place. */}
            {!sigData &&
              Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="px-3 py-2.5 border-b border-[rgba(27,35,51,0.5)]">
                  <div className="flex items-center gap-2">
                    <Skel w={20} h={20} round />
                    <Skel w={56} />
                    <span className="ml-auto">
                      <Skel w={64} h={14} />
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <Skel w={100} h={6} />
                    <Skel w={44} />
                  </div>
                  <div className="mt-2">
                    <Skel w={190} h={8} />
                  </div>
                </div>
              ))}
            {sigData && conviction.length === 0 && (
              <div className="px-3 py-8 text-center faint text-[11px]">
                No setup clears the conviction bar right now — NO TRADE is a valid answer.
              </div>
            )}
          </div>
        </div>

        {/* 3D center */}
        <div className="panel relative overflow-hidden min-h-[460px]">
          {net ? (
            <Network3D
              payload={net}
              settings={SCENE}
              selectedId={selected}
              onSelect={(id) => setSelected(id)}
              burstsRef={burstsRef}
              className="absolute inset-0"
              mobile={mobile}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center faint text-[11px] tracking-[0.25em]">
              SCANNING SOLANA…
            </div>
          )}
          <Link href="/network" className="absolute top-2.5 right-2.5 btn text-[10.5px]">
            full 3D network ⤢
          </Link>
          {selected && (
            <Link
              href={net?.tokens.some((t) => t.id === selected) ? `/token?m=${selected}` : `/whale?a=${selected}`}
              className="absolute bottom-2.5 right-2.5 btn btn-primary text-[10.5px]"
            >
              open {net?.tokens.find((t) => t.id === selected)?.symbol ?? "wallet"} →
            </Link>
          )}
        </div>

        {/* activity feed */}
        <div className="panel min-h-0 flex flex-col max-h-[560px]">
          <ActivityFeed limit={40} />
        </div>
      </div>

      {/* bottom row: movers + net whale flow */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="panel">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
            <span className="panel-title">Momentum Leaders 24h</span>
            <Link href="/tokens" className="link text-[10.5px]">token radar →</Link>
          </div>
          <table className="w-full text-[12px]">
            <thead className="thead">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Token</th>
                <th className="text-right px-2 font-medium">Price</th>
                <th className="text-right px-2 font-medium">24h</th>
                <th className="text-right px-2 font-medium">Mcap</th>
                {/* Ten minutes of chain, not six hours — see whaleFlowCell. */}
                <th
                  className="text-right px-2 font-medium"
                  title="Net movement by wallets that moved $20,000+ of this token, over a short chain scan — ten minutes, not six hours."
                >
                  Whale flow
                </th>
                <th className="text-right px-3 font-medium">Signal</th>
              </tr>
            </thead>
            <tbody className="num">
              {/* Live rows take ~5s to assemble on a cold load (trending +
                  rugcheck + chain flow, measured); an empty tbody for that long
                  reads as broken and lets everything below jump up when rows
                  land. Shimmer rows hold the space — bars, never numbers. */}
              {!rowData && <SkeletonRows rows={8} widths={["label", 58, 44, 48, 52, 72]} />}
              {(rowData?.rows ?? []).slice(0, 8).map((r) => (
                <tr key={r.mint} className="trow">
                  <td className="px-3 py-1.5">
                    <Link href={`/token?m=${r.mint}`} className="flex items-center gap-2 hover:text-[var(--accent)]">
                      <TokenMark hue={r.hue} symbol={r.symbol} size={18} />
                      <span className="font-[var(--font-sans)]">{r.symbol}</span>
                      <span className="faint text-[10px]">{fmtAge(r.ageHours * 3_600_000)}</span>
                    </Link>
                  </td>
                  <td className="text-right px-2">{fmtUsd(r.priceUsd)}</td>
                  <td className={`text-right px-2 ${r.h24 >= 0 ? "pos" : "neg"}`}>{fmtPct(r.h24)}</td>
                  <td className="text-right px-2 dim">{fmtUsd(r.marketCapUsd)}</td>
                  <td className={`text-right px-2 ${whaleFlowCell(r).cls}`} title={whaleFlowCell(r).title}>
                    {whaleFlowCell(r).text}
                  </td>
                  <td className="text-right px-3">
                    <Score value={r.signalScore} width={44} scored={r.scored !== false} reason={r.unscoredReason} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
            <span className="panel-title">Net Whale Flow · all tracked · 72h</span>
            {/* "All tracked" here means the simulated wallet universe: the flow
                series has no live path yet, and the chart must not borrow the
                credibility of the live panels around it (H5). */}
            {flowData?.demo !== false && <span className="chip text-[9.5px]">SIMULATED</span>}
            <Link href="/flow" className="link text-[10.5px]">money flow →</Link>
          </div>
          <div className="px-2 pb-2">
            {flowData ? <FlowChart flow={flowData.flow} height={210} /> : <div className="h-[210px] flex items-center justify-center faint text-[11px]">RECALCULATING WHALE FLOWS…</div>}
          </div>
        </div>
      </div>

      <p className="text-[10px] faint px-1 pb-2 leading-relaxed">
        {/* This line said the app "runs on a deterministic synthetic universe
            (demo mode)" and told the reader to add API keys "to prepare live
            mode". Both halves are now false — most of the terminal is real
            Solana and needs no key — and a footer insisting otherwise is the
            same drift as the opposite error, in the direction that teaches a
            reader to discount a real number. */}
        ROM Nova is an analytics and decision-support tool. Most of what you see is live Solana, read keylessly in your
        own browser; wallet reputation and a few panels are still a labelled simulation, and the data-source chip names
        which is which on every screen. Signals are ranked evidence, not predictions; nothing here is investment advice.
      </p>
    </div>
  );
}
