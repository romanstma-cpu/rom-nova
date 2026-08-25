"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi, fmtUsd, fmtPct, fmtAgo, shortAddr } from "@/lib/client";
import { Score, Stat, Empty } from "@/components/ui/bits";
import type { WalletInfo, WalletPerformance, WalletTrade, WalletCluster } from "@/lib/types";

interface WalletDetail {
  info: WalletInfo;
  perf: WalletPerformance;
  positions: {
    mint: string;
    symbol: string;
    tokens: number;
    costBasisUsd: number;
    valueUsd: number;
    pnlUsd: number;
    pnlPct: number;
    openedAt: number;
  }[];
  roundTrips: { mint: string; symbol: string; entryTs: number; exitTs: number; costUsd: number; pnlUsd: number; holdHours: number }[];
  trades: (WalletTrade & { symbol: string })[];
  cluster: WalletCluster | null;
}

export default function WalletPage() {
  return (
    <Suspense fallback={<Empty>PROFILING WALLET…</Empty>}>
      <WalletInner />
    </Suspense>
  );
}

function WalletInner() {
  const address = useSearchParams().get("a") ?? "";
  const { data, error } = useApi<WalletDetail>(address ? `/api/wallets/${address}` : null, 20_000);

  if (!address || error)
    return <Empty>Wallet not tracked. <Link href="/whales" className="link">Back to whale intelligence.</Link></Empty>;
  if (!data) return <Empty>PROFILING WALLET…</Empty>;

  const { info, perf } = data;
  const sm = info.smartMoney;

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="panel px-4 py-3 flex items-center gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[16px] font-semibold">{info.knownEntity ?? shortAddr(info.address)}</span>
            {info.labels.map((l) => (
              <span key={l} className={`chip ${l === "smart_trader" ? "chip-accent" : ""}`}>{l.replace("_", " ")}</span>
            ))}
            {data.cluster && (
              <span className="chip chip-warn" title={data.cluster.evidence.join(" · ")}>
                COORDINATED: {data.cluster.name}
              </span>
            )}
          </div>
          <button className="num text-[10.5px] faint hover:text-[var(--accent)] mt-1" onClick={() => navigator.clipboard?.writeText(info.address)}>
            {info.address} ⧉
          </button>
          <div className="text-[10.5px] faint num mt-0.5">
            first seen {fmtAgo(info.firstSeen)} · last active {fmtAgo(info.lastActive)} · funding: {info.fundingSource ?? "unknown"} · {info.solBalance.toFixed(0)} SOL
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="panel-title">Smart money score (measured)</div>
          <div className="flex items-center gap-2 justify-end mt-1">
            <span className="num text-[22px]" style={{ color: sm.total >= 65 ? "var(--pos)" : "var(--text-dim)" }}>{sm.total}</span>
            <span className="faint text-[11px]">/100</span>
          </div>
        </div>
      </div>

      {/* score breakdown + perf */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        {(
          [
            ["Performance", sm.performance],
            ["Timing", sm.timing],
            ["Consistency", sm.consistency],
            ["Risk Mgmt", sm.riskManagement],
            ["Diversification", sm.diversification],
            ["Data Confidence", sm.dataConfidence],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="panel px-3 py-2">
            <div className="panel-title">{label}</div>
            <div className="mt-1"><Score value={v} width={70} /></div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <Stat label="Realized PnL"><span className={perf.realizedPnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(perf.realizedPnlUsd)}</span></Stat>
        <Stat label="Unrealized"><span className={perf.unrealizedPnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(perf.unrealizedPnlUsd)}</span></Stat>
        <Stat label="ROI"><span className={perf.roiPct >= 0 ? "pos" : "neg"}>{perf.roiPct.toFixed(0)}%</span></Stat>
        <Stat label="Win rate">{(perf.winRate * 100).toFixed(0)}%</Stat>
        <Stat label="Profit factor">{perf.profitFactor >= 99 ? "∞" : perf.profitFactor.toFixed(2)}</Stat>
        <Stat label="Max drawdown"><span className="neg">{perf.maxDrawdownPct.toFixed(0)}%</span></Stat>
        <Stat label="Median hold">{perf.medianHoldHours.toFixed(0)}h</Stat>
        <Stat label="Round trips">{perf.trades}</Stat>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* open positions */}
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Open positions</div>
          <table className="w-full text-[12px]">
            <thead className="thead">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Token</th>
                <th className="text-right px-2 font-medium">Value</th>
                <th className="text-right px-2 font-medium">Cost</th>
                <th className="text-right px-2 font-medium">PnL</th>
                <th className="text-right px-3 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody className="num">
              {data.positions.sort((a, b) => b.valueUsd - a.valueUsd).map((p) => (
                <tr key={p.mint} className="trow">
                  <td className="px-3 py-1.5">
                    <Link href={`/token?m=${p.mint}`} className="hover:text-[var(--accent)]" style={{ fontFamily: "var(--font-sans)" }}>{p.symbol}</Link>
                  </td>
                  <td className="text-right px-2">{fmtUsd(p.valueUsd)}</td>
                  <td className="text-right px-2 dim">{fmtUsd(p.costBasisUsd)}</td>
                  <td className={`text-right px-2 ${p.pnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(p.pnlUsd)} ({fmtPct(p.pnlPct, 0)})</td>
                  <td className="text-right px-3 faint">{fmtAgo(p.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.positions.length === 0 && <Empty>Flat — no open positions.</Empty>}
        </div>

        {/* closed round trips */}
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Closed round trips</div>
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <tbody className="num">
                {data.roundTrips.map((r, i) => (
                  <tr key={i} className="trow">
                    <td className="px-3 py-1.5">
                      <Link href={`/token?m=${r.mint}`} className="hover:text-[var(--accent)]" style={{ fontFamily: "var(--font-sans)" }}>{r.symbol}</Link>
                    </td>
                    <td className="text-right px-2 dim">{fmtUsd(r.costUsd)} in</td>
                    <td className={`text-right px-2 ${r.pnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.pnlUsd)}</td>
                    <td className="text-right px-2 dim">{r.holdHours.toFixed(0)}h held</td>
                    <td className="text-right px-3 faint">{fmtAgo(r.exitTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.roundTrips.length === 0 && <Empty>No completed trades yet.</Empty>}
          </div>
        </div>
      </div>

      {/* behavior + trade log */}
      <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr] gap-3">
        <div className="panel p-3.5">
          <div className="panel-title mb-2">Behavioral profile</div>
          {(
            [
              ["Early-entry tendency", info.behavior.earlyBird],
              ["Momentum chasing", info.behavior.momentumBias],
              ["Small-cap preference", info.behavior.smallCapPreference],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="mb-2">
              <div className="flex justify-between text-[11.5px]"><span className="dim">{label}</span><span className="num">{(v * 100).toFixed(0)}%</span></div>
              <div className="scorebar mt-1"><div style={{ width: `${v * 100}%`, background: "var(--accent-2)" }} /></div>
            </div>
          ))}
          <div className="text-[11.5px] dim space-y-1 mt-3 num">
            <div className="flex justify-between"><span className="faint">typical entry mcap</span><span>{fmtUsd(info.behavior.typicalEntryMcap)}</span></div>
            <div className="flex justify-between"><span className="faint">typical exit multiple</span><span>{info.behavior.typicalExitMultiple.toFixed(1)}×</span></div>
            <div className="flex justify-between"><span className="faint">preferred DEX</span><span>{info.behavior.preferredDex}</span></div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Trade log</div>
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <tbody className="num">
                {data.trades.map((t) => (
                  <tr key={t.id} className="trow">
                    <td className="px-3 py-1 faint">{new Date(t.ts).toLocaleString()}</td>
                    <td className={`px-2 ${t.side === "buy" ? "pos" : "neg"}`}>{t.side.toUpperCase()}</td>
                    <td className="px-2">
                      <Link href={`/token?m=${t.mint}`} className="hover:text-[var(--accent)]">{t.symbol}</Link>
                    </td>
                    <td className="px-2">{fmtUsd(t.amountUsd)}</td>
                    <td className="px-2 faint">{t.dex}</td>
                    <td className="px-2 faint">{t.classification}</td>
                    <td className="px-2 faint text-right" title={t.signature}>{t.signature.slice(0, 8)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
