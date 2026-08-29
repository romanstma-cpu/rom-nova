"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApi, fmtUsd, fmtPct, fmtNum, fmtAge } from "@/lib/client";
import { Score, RiskBadge, TokenMark, Freshness, Empty } from "@/components/ui/bits";
import type { TokenRow } from "@/lib/api/rows";

type Quick = "all" | "fresh" | "smart" | "conviction" | "risky";

const QUICKS: { id: Quick; label: string }[] = [
  { id: "all", label: "All" },
  { id: "fresh", label: "Fresh < 48h" },
  { id: "smart", label: "Smart money in" },
  { id: "conviction", label: "Score ≥ 70" },
  { id: "risky", label: "High risk" },
];

export default function TokenRadar() {
  const { data, loading, error } = useApi<{ rows: TokenRow[]; asOf: number }>("/api/tokens?limit=300", 20_000);
  const [quick, setQuick] = useState<Quick>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: keyof TokenRow; dir: 1 | -1 }>({ key: "signalScore", dir: -1 });

  const rows = useMemo(() => {
    let rs = data?.rows ?? [];
    if (quick === "fresh") rs = rs.filter((r) => r.ageHours < 48);
    if (quick === "smart") rs = rs.filter((r) => r.smFlow6hUsd > 0);
    if (quick === "conviction") rs = rs.filter((r) => r.signalScore >= 70);
    if (quick === "risky") rs = rs.filter((r) => r.riskLevel === "high");
    if (q.trim()) {
      const needle = q.toLowerCase();
      rs = rs.filter((r) => r.symbol.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle));
    }
    return [...rs].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      return typeof av === "number" && typeof bv === "number" ? (av - bv) * sort.dir : 0;
    });
  }, [data, quick, q, sort]);

  // render helper (not a component — keeps the sortable header terse)
  const th = (k: keyof TokenRow, label: string, right = true) => (
    <th
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : -1 }))}
      className={`${right ? "text-right" : "text-left"} px-2 py-2 font-medium cursor-pointer hover:text-[var(--text)] select-none whitespace-nowrap`}
    >
      {label}
      {sort.key === k ? (sort.dir === -1 ? " ▾" : " ▴") : ""}
    </th>
  );

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide mr-2">MEME COIN RADAR</h1>
        {QUICKS.map((f) => (
          <button key={f.id} onClick={() => setQuick(f.id)} className={`chip cursor-pointer ${quick === f.id ? "chip-accent" : ""}`}>
            {f.label}
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…" className="input ml-auto w-[160px]" />
        {data && <Freshness ts={data.asOf} />}
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-[12px] min-w-[1080px]">
          <thead className="thead">
            <tr>
              {th("symbol", "Token", false)}
              {th("priceUsd", "Price")}
              {th("m5", "5m")}
              {th("h1", "1h")}
              {th("h24", "24h")}
              {th("marketCapUsd", "Mcap")}
              {th("liquidityUsd", "Liq")}
              {th("volume24hUsd", "Vol 24h")}
              {th("volumeAccel", "Vol accel")}
              {th("holders", "Holders")}
              {th("holderGrowthPct", "Δ24h")}
              {th("whaleFlow6hUsd", "Whale 6h")}
              {th("smFlow6hUsd", "Smart 6h")}
              {th("top10Pct", "Top10")}
              {th("organicScore", "Organic")}
              {th("signalScore", "Signal")}
              <th className="px-2 font-medium text-right">Risk</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((r) => (
              <tr key={r.mint} className="trow">
                <td className="px-2 py-[7px]">
                  <Link href={`/token?m=${r.mint}`} className="flex items-center gap-2 hover:text-[var(--accent)]">
                    <TokenMark hue={r.hue} symbol={r.symbol} size={18} />
                    <span style={{ fontFamily: "var(--font-sans)" }}>{r.symbol}</span>
                    {r.verified && <span className="text-[var(--accent)] text-[9px]" title="verified">✓</span>}
                    <span className="faint text-[10px]">{fmtAge(r.ageHours * 3_600_000)}</span>
                  </Link>
                </td>
                <td className="text-right px-2">{fmtUsd(r.priceUsd)}</td>
                <Cell v={r.m5} />
                <Cell v={r.h1} />
                <Cell v={r.h24} />
                <td className="text-right px-2 dim">{fmtUsd(r.marketCapUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(r.liquidityUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(r.volume24hUsd)}</td>
                <td className={`text-right px-2 ${r.volumeAccel > 1.6 ? "warn" : "dim"}`}>{r.volumeAccel.toFixed(1)}×</td>
                <td className="text-right px-2 dim">{fmtNum(r.holders)}</td>
                <Cell v={r.holderGrowthPct} />
                <td className={`text-right px-2 ${r.whaleFlow6hUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.whaleFlow6hUsd)}</td>
                <td className={`text-right px-2 ${r.smFlow6hUsd > 0 ? "pos" : r.smFlow6hUsd < 0 ? "neg" : "faint"}`}>
                  {r.smFlow6hUsd !== 0 ? fmtUsd(r.smFlow6hUsd) : "—"}
                </td>
                <td className={`text-right px-2 ${r.top10Pct > 0.35 ? "neg" : "dim"}`}>{(r.top10Pct * 100).toFixed(0)}%</td>
                <td className={`text-right px-2 ${r.organicScore < 0.4 ? "warn" : "dim"}`}>{(r.organicScore * 100).toFixed(0)}</td>
                <td className="text-right px-2">
                  <Score value={r.signalScore} width={40} scored={r.scored !== false} reason={r.unscoredReason} />
                </td>
                <td className="text-right px-2">
                  <RiskBadge level={r.riskLevel} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <Empty>
            {loading ? "ANALYZING TOKENS…" : error ? "Token data is unavailable right now — retrying automatically." : "No token matches these filters."}
          </Empty>
        )}
      </div>
    </div>
  );
}

function Cell({ v }: { v: number }) {
  return <td className={`text-right px-2 ${v > 0.05 ? "pos" : v < -0.05 ? "neg" : "faint"}`}>{fmtPct(v)}</td>;
}
