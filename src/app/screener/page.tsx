"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApi, fmtUsd, fmtPct, fmtNum, fmtAge } from "@/lib/client";
import { Score, RiskBadge, TokenMark, Empty, Freshness } from "@/components/ui/bits";
import type { TokenRow } from "@/lib/api/rows";

interface Filters {
  minLiq: string;
  maxMcap: string;
  maxAgeH: string;
  minScore: string;
  minHolders: string;
  maxTop10: string;
  minOrganic: string;
  smartOnly: boolean;
  excludeHighRisk: boolean;
}

const DEFAULT_FILTERS: Filters = {
  minLiq: "",
  maxMcap: "",
  maxAgeH: "",
  minScore: "",
  minHolders: "",
  maxTop10: "",
  minOrganic: "",
  smartOnly: false,
  excludeHighRisk: false,
};

const PRESETS: { name: string; f: Partial<Filters> }[] = [
  { name: "Early gems", f: { maxAgeH: "72", minLiq: "20000", minScore: "60" } },
  { name: "Smart money in", f: { smartOnly: true, excludeHighRisk: true } },
  { name: "Safe & liquid", f: { minLiq: "150000", maxTop10: "25", minOrganic: "55", excludeHighRisk: true } },
  { name: "High conviction", f: { minScore: "76" } },
];

export default function ScreenerPage() {
  const { data } = useApi<{ rows: TokenRow[]; asOf: number }>("/api/tokens?limit=300", 25_000);
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS);

  const rows = useMemo(() => {
    let rs = data?.rows ?? [];
    const n = (s: string) => (s.trim() === "" ? null : Number(s));
    const minLiq = n(f.minLiq);
    const maxMcap = n(f.maxMcap);
    const maxAge = n(f.maxAgeH);
    const minScore = n(f.minScore);
    const minHolders = n(f.minHolders);
    const maxTop10 = n(f.maxTop10);
    const minOrganic = n(f.minOrganic);
    if (minLiq !== null) rs = rs.filter((r) => r.liquidityUsd >= minLiq);
    if (maxMcap !== null) rs = rs.filter((r) => r.marketCapUsd <= maxMcap);
    if (maxAge !== null) rs = rs.filter((r) => r.ageHours <= maxAge);
    if (minScore !== null) rs = rs.filter((r) => r.signalScore >= minScore);
    if (minHolders !== null) rs = rs.filter((r) => r.holders >= minHolders);
    if (maxTop10 !== null) rs = rs.filter((r) => r.top10Pct * 100 <= maxTop10);
    if (minOrganic !== null) rs = rs.filter((r) => r.organicScore * 100 >= minOrganic);
    if (f.smartOnly) rs = rs.filter((r) => r.smFlow6hUsd > 0);
    if (f.excludeHighRisk) rs = rs.filter((r) => r.riskLevel !== "high");
    return rs.sort((a, b) => b.signalScore - a.signalScore);
  }, [data, f]);

  const exportCsv = () => {
    const cols = [
      "symbol", "name", "mint", "priceUsd", "marketCapUsd", "liquidityUsd", "volume24hUsd", "m5", "h1", "h6", "h24",
      "holders", "holderGrowthPct", "top10Pct", "organicScore", "whaleFlow6hUsd", "smFlow6hUsd", "signalScore", "signalLabel", "confidence", "riskLevel", "ageHours",
    ] as const;
    const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rom-nova-screen-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // render helper (not a component — avoids remounting inputs per keystroke)
  const field = (label: string, k: keyof Filters, placeholder: string) => (
    <label className="flex flex-col gap-1" key={k}>
      <span className="panel-title">{label}</span>
      <input
        value={String(f[k])}
        onChange={(e) => setF((prev) => ({ ...prev, [k]: e.target.value }))}
        placeholder={placeholder}
        className="input w-[110px]"
      />
    </label>
  );

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide mr-2">ADVANCED SCREENER</h1>
        {PRESETS.map((p) => (
          <button key={p.name} className="chip cursor-pointer hover:border-[var(--accent)]" onClick={() => setF({ ...DEFAULT_FILTERS, ...p.f })}>
            {p.name}
          </button>
        ))}
        <button className="chip cursor-pointer" onClick={() => setF(DEFAULT_FILTERS)}>reset</button>
        <button className="btn ml-auto" onClick={exportCsv} disabled={rows.length === 0}>Export CSV ({rows.length})</button>
        {data && <Freshness ts={data.asOf} />}
      </div>

      <div className="panel p-3 flex items-end gap-3 flex-wrap">
        {field("Min liquidity $", "minLiq", "50000")}
        {field("Max mcap $", "maxMcap", "10000000")}
        {field("Max age (h)", "maxAgeH", "72")}
        {field("Min signal", "minScore", "60")}
        {field("Min holders", "minHolders", "500")}
        {field("Max top10 %", "maxTop10", "30")}
        {field("Min organic", "minOrganic", "50")}
        <label className="flex items-center gap-2 text-[11.5px] dim cursor-pointer pb-1.5">
          <input type="checkbox" checked={f.smartOnly} onChange={() => setF((p) => ({ ...p, smartOnly: !p.smartOnly }))} className="accent-[#38e1ff]" />
          smart money in
        </label>
        <label className="flex items-center gap-2 text-[11.5px] dim cursor-pointer pb-1.5">
          <input type="checkbox" checked={f.excludeHighRisk} onChange={() => setF((p) => ({ ...p, excludeHighRisk: !p.excludeHighRisk }))} className="accent-[#38e1ff]" />
          exclude high risk
        </label>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-[12px] min-w-[1100px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-2 font-medium">#</th>
              <th className="text-left px-2 font-medium">Token</th>
              <th className="text-right px-2 font-medium">Price</th>
              <th className="text-right px-2 font-medium">Mcap</th>
              <th className="text-right px-2 font-medium">Liq</th>
              <th className="text-right px-2 font-medium">Vol 24h</th>
              <th className="text-right px-2 font-medium">1h</th>
              <th className="text-right px-2 font-medium">24h</th>
              <th className="text-right px-2 font-medium">Buys/Sells 1h</th>
              <th className="text-right px-2 font-medium">Holders</th>
              <th className="text-right px-2 font-medium">Whale 6h</th>
              <th className="text-right px-2 font-medium">Smart 6h</th>
              <th className="text-right px-2 font-medium">Signal</th>
              <th className="text-right px-2 font-medium">Conf</th>
              <th className="text-right px-3 font-medium">Risk</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((r, i) => (
              <tr key={r.mint} className="trow">
                <td className="px-3 py-[7px] faint">{i + 1}</td>
                <td className="px-2">
                  <Link href={`/token?m=${r.mint}`} className="flex items-center gap-2 hover:text-[var(--accent)]">
                    <TokenMark hue={r.hue} symbol={r.symbol} size={17} />
                    <span style={{ fontFamily: "var(--font-sans)" }}>{r.symbol}</span>
                    <span className="faint text-[10px]">{fmtAge(r.ageHours * 3_600_000)}</span>
                  </Link>
                </td>
                <td className="text-right px-2">{fmtUsd(r.priceUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(r.marketCapUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(r.liquidityUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(r.volume24hUsd)}</td>
                <td className={`text-right px-2 ${r.h1 >= 0 ? "pos" : "neg"}`}>{fmtPct(r.h1)}</td>
                <td className={`text-right px-2 ${r.h24 >= 0 ? "pos" : "neg"}`}>{fmtPct(r.h24)}</td>
                <td className="text-right px-2 dim">{r.buys1h}/{r.sells1h}</td>
                <td className="text-right px-2 dim">{fmtNum(r.holders)}</td>
                <td className={`text-right px-2 ${r.whaleFlow6hUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.whaleFlow6hUsd)}</td>
                <td className={`text-right px-2 ${r.smFlow6hUsd > 0 ? "pos" : "faint"}`}>{r.smFlow6hUsd ? fmtUsd(r.smFlow6hUsd) : "—"}</td>
                <td className="text-right px-2"><Score value={r.signalScore} width={40} /></td>
                <td className="text-right px-2 dim">{(r.confidence * 100).toFixed(0)}%</td>
                <td className="text-right px-3"><RiskBadge level={r.riskLevel} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty>{data ? "Nothing passes this screen — loosen a constraint." : "SCANNING SOLANA…"}</Empty>}
      </div>
    </div>
  );
}
