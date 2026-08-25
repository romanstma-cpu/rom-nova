"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApi, fmtUsd, fmtAgo } from "@/lib/client";
import { Score, Empty } from "@/components/ui/bits";
import { shortAddr } from "@/lib/client";
import type { WalletRow } from "@/lib/api/rows";

type Filter = "all" | "smart" | "whales" | "snipers" | "suspect";

export default function WhalesPage() {
  const { data, loading, error } = useApi<{ rows: WalletRow[] }>("/api/wallets", 30_000);
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    switch (filter) {
      case "smart":
        return all.filter((r) => r.smartMoneyScore >= 65);
      case "whales":
        return all.filter((r) => r.labels.includes("whale") || r.labels.includes("fund"));
      case "snipers":
        return all.filter((r) => r.labels.includes("sniper") || r.labels.includes("bundler"));
      case "suspect":
        return all.filter((r) => r.labels.includes("insider") || r.labels.includes("bot"));
      default:
        return all;
    }
  }, [data, filter]);

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All tracked" },
    { id: "smart", label: "Smart money" },
    { id: "whales", label: "Whales & funds" },
    { id: "snipers", label: "Snipers & bundlers" },
    { id: "suspect", label: "Insiders & bots" },
  ];

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide mr-2">WHALE INTELLIGENCE</h1>
        {filters.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={`chip cursor-pointer ${filter === f.id ? "chip-accent" : ""}`}>
            {f.label}
          </button>
        ))}
        <span className="faint text-[10.5px] ml-auto">smart-money scores are measured from each wallet&apos;s trade history — not asserted</span>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-[12px] min-w-[980px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Wallet</th>
              <th className="text-left px-2 font-medium">Labels</th>
              <th className="text-right px-2 font-medium">Smart Money</th>
              <th className="text-right px-2 font-medium">Realized PnL</th>
              <th className="text-right px-2 font-medium">Unrealized</th>
              <th className="text-right px-2 font-medium">ROI</th>
              <th className="text-right px-2 font-medium">Win rate</th>
              <th className="text-right px-2 font-medium">PF</th>
              <th className="text-right px-2 font-medium">Trades</th>
              <th className="text-right px-2 font-medium">Med. hold</th>
              <th className="text-right px-2 font-medium">Open</th>
              <th className="text-right px-3 font-medium">Last active</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((r) => (
              <tr key={r.address} className="trow">
                <td className="px-3 py-2">
                  <Link href={`/whale?a=${r.address}`} className="hover:text-[var(--accent)]">
                    {r.knownEntity ? (
                      <span style={{ fontFamily: "var(--font-sans)" }}>{r.knownEntity}</span>
                    ) : (
                      shortAddr(r.address)
                    )}
                  </Link>
                </td>
                <td className="px-2">
                  <span className="flex gap-1 flex-wrap">
                    {r.labels.slice(0, 3).map((l) => (
                      <span key={l} className={`chip ${l === "smart_trader" ? "chip-accent" : l === "insider" || l === "bot" ? "chip-warn" : ""}`}>
                        {l.replace("_", " ")}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="text-right px-2"><Score value={r.smartMoneyScore} width={46} /></td>
                <td className={`text-right px-2 ${r.realizedPnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.realizedPnlUsd)}</td>
                <td className={`text-right px-2 ${r.unrealizedPnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.unrealizedPnlUsd)}</td>
                <td className={`text-right px-2 ${r.roiPct >= 0 ? "pos" : "neg"}`}>{r.roiPct.toFixed(0)}%</td>
                <td className="text-right px-2 dim">{(r.winRate * 100).toFixed(0)}%</td>
                <td className="text-right px-2 dim">{r.profitFactor >= 99 ? "∞" : r.profitFactor.toFixed(2)}</td>
                <td className="text-right px-2 dim">{r.trades}</td>
                <td className="text-right px-2 dim">{r.medianHoldHours.toFixed(0)}h</td>
                <td className="text-right px-2 dim">{r.openPositions}</td>
                <td className="text-right px-3 faint">{fmtAgo(r.lastActive)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <Empty>{loading ? "PROFILING WALLETS…" : error ? "Wallet data unavailable — retrying automatically." : "No wallets match."}</Empty>
        )}
      </div>
    </div>
  );
}
