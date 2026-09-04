"use client";

import { useMemo, useState } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import Link from "next/link";
import { useApi, fmtUsd, fmtPct, fmtNum, fmtAge, whaleFlowCell, absent } from "@/lib/client";
import { Score, RiskBadge, SkeletonRows, TokenMark, Freshness, Empty } from "@/components/ui/bits";
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
    <div className="p-3 flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <PageTitle title="TOKENS" lede="The trending list with scores, risk and whale flow" />
        {QUICKS.map((f) => (
          <button key={f.id} onClick={() => setQuick(f.id)} className={`chip cursor-pointer ${quick === f.id ? "chip-accent" : ""}`}>
            {f.label}
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…" className="input ml-auto w-[160px]" />
        {data && <Freshness ts={data.asOf} />}
      </div>

      {/* The scanner's scroll pattern: the PANEL scrolls, so three hundred
          rows keep their column names on screen. Sorting by a header you can
          no longer read is a guess. */}
      <div className="panel overflow-auto flex-1 min-h-0">
        <table className="w-full text-[12px] min-w-[1080px]">
          <thead className="thead sticky top-0 bg-[var(--panel-solid)] z-10">
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
              {th("whaleFlowUsd", "Whale flow")}
              {th("smFlow6hUsd", "Smart 6h")}
              {th("top10Pct", "Top10")}
              {th("organicScore", "Organic")}
              {th("signalScore", "Signal")}
              <th className="px-2 font-medium text-right">Risk</th>
            </tr>
          </thead>
          <tbody className="num">
            {/* First payload in flight: rows of shimmer at real row height, so
                the table is furniture immediately and nothing reflows. */}
            {loading && (
              <SkeletonRows
                rows={12}
                widths={["label", 56, 36, 36, 38, 48, 46, 48, 32, 40, 36, 52, 48, 34, 30, 68, 40]}
              />
            )}
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
                {/* Every column below can be UNMEASURED on a live row, and each
                    used to print its placeholder zero: "+0.0%" for a tape nobody
                    fetched, "0%" for a top-10 share no free RPC will serve. The
                    scanner dashes these; this page contradicted it. */}
                <Cell v={r.m5} absent={absent(r, "momentum")} why="no interval price change published for this row; candles are not fetched for the list" />
                <Cell v={r.h1} absent={absent(r, "momentum")} why="no interval price change published for this row; candles are not fetched for the list" />
                <Cell v={r.h24} absent={absent(r, "momentum")} why="no interval price change published for this row; candles are not fetched for the list" />
                <td className="text-right px-2 dim">{fmtUsd(r.marketCapUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(r.liquidityUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(r.volume24hUsd)}</td>
                <Dash absent={absent(r, "volumeAccel")} cls={r.volumeAccel > 1.6 ? "warn" : "dim"} why="volume acceleration needs interval volumes this row's source did not publish">
                  {r.volumeAccel.toFixed(1)}×
                </Dash>
                <Dash absent={absent(r, "holders")} cls="dim" why="holder count not published by this row's source">
                  {fmtNum(r.holders)}
                </Dash>
                <Cell v={r.holderGrowthPct} absent={absent(r, "holderGrowth")} why="holder growth needs a prior holder count nobody published" />
                <td className={`text-right px-2 ${whaleFlowCell(r).cls}`} title={whaleFlowCell(r).title}>
                  {whaleFlowCell(r).text}
                </td>
                <Dash absent={absent(r, "smartMoney")} cls={r.smFlow6hUsd > 0 ? "pos" : r.smFlow6hUsd < 0 ? "neg" : "faint"} why="smart-money flow needs wallet reputation no keyless source carries">
                  {r.smFlow6hUsd !== 0 ? fmtUsd(r.smFlow6hUsd) : "—"}
                </Dash>
                <Dash absent={absent(r, "top10Pct")} cls={r.top10Pct > 0.35 ? "neg" : "dim"} why="top-10 share needs getTokenLargestAccounts, which free RPC endpoints refuse">
                  {(r.top10Pct * 100).toFixed(0)}%
                </Dash>
                <Dash absent={absent(r, "organicScore")} cls={r.organicScore < 0.4 ? "warn" : "dim"} why="organic score not published for this row">
                  {(r.organicScore * 100).toFixed(0)}
                </Dash>
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
        {/* The loading case is the skeleton above; this strip only ever
            describes a real empty result. */}
        {rows.length === 0 && !loading && (
          <Empty>
            {error ? "Token data is unavailable right now — retrying automatically." : "No token matches these filters."}
          </Empty>
        )}
      </div>
    </div>
  );
}

/** A percentage cell that dashes, and says why, when its input was never measured. */
function Cell({ v, absent, why }: { v: number; absent: boolean; why: string }) {
  if (absent) {
    return (
      <td className="text-right px-2 faint" title={why}>
        —
      </td>
    );
  }
  return <td className={`text-right px-2 ${v > 0.05 ? "pos" : v < -0.05 ? "neg" : "faint"}`}>{fmtPct(v)}</td>;
}

/** Any other numeric cell, same rule. */
function Dash({ absent, cls, why, children }: { absent: boolean; cls: string; why: string; children: React.ReactNode }) {
  if (absent) {
    return (
      <td className="text-right px-2 faint" title={why}>
        —
      </td>
    );
  }
  return <td className={`text-right px-2 ${cls}`}>{children}</td>;
}
