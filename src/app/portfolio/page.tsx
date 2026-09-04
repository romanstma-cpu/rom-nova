"use client";

import { useState } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import Link from "next/link";
import { useApi, apiPost, fmtUsd, fmtPct, fmtAgo } from "@/lib/client";
import { Empty, Stat } from "@/components/ui/bits";
import type { PortfolioView } from "@/lib/engine/paper";

export default function PortfolioPage() {
  const { data, reload } = useApi<{ portfolios: PortfolioView[] }>("/api/paper", 10_000);
  const [msg, setMsg] = useState<string | null>(null);
  const pf = data?.portfolios[0];

  const sell = async (mint: string, usd: number) => {
    if (!pf) return;
    setMsg("…");
    const res = await apiPost<{ error?: string }>("/api/paper/orders", { portfolioId: pf.id, mint, side: "sell", usd });
    setMsg(res.body.error ? `rejected: ${res.body.error}` : "sold");
    reload();
  };

  if (!pf) return <Empty>{msg ?? "LOADING PAPER DESK…"}</Empty>;

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <PageTitle title={`PAPER DESK · ${pf.name}`} lede="Practice trades on simulated fills" />
        <span className="chip chip-warn">SIMULATED — no real funds exist anywhere in this app</span>
        {msg && <span className="text-[11px] dim num">{msg}</span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat label="Equity">{fmtUsd(pf.equityUsd)}</Stat>
        <Stat label="Cash">{fmtUsd(pf.cashUsd)}</Stat>
        <Stat label="Total return"><span className={pf.totalReturnPct >= 0 ? "pos" : "neg"}>{fmtPct(pf.totalReturnPct)}</span></Stat>
        <Stat label="Realized PnL"><span className={pf.realizedPnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(pf.realizedPnlUsd)}</span></Stat>
        <Stat label="Unrealized"><span className={pf.unrealizedPnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(pf.unrealizedPnlUsd)}</span></Stat>
      </div>

      <div className="panel">
        <div className="panel-title px-3 pt-2.5 pb-1">Open positions · buy from any token page</div>
        <table className="w-full text-[12px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Token</th>
              <th className="text-right px-2 font-medium">Value</th>
              <th className="text-right px-2 font-medium">Cost</th>
              <th className="text-right px-2 font-medium">PnL</th>
              <th className="text-right px-2 font-medium">Stop / Target</th>
              <th className="text-right px-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="num">
            {pf.positionViews.map((p) => (
              <tr key={p.mint} className="trow">
                <td className="px-3 py-1.5">
                  <Link href={`/token?m=${p.mint}`} className="hover:text-[var(--accent)]" style={{ fontFamily: "var(--font-sans)" }}>{p.symbol}</Link>
                </td>
                <td className="text-right px-2">{fmtUsd(p.valueUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(p.costBasisUsd)}</td>
                <td className={`text-right px-2 ${p.pnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(p.pnlUsd)} ({fmtPct(p.pnlPct, 0)})</td>
                <td className="text-right px-2 faint">
                  {p.stopLossPct ? `-${p.stopLossPct}%` : "—"} / {p.takeProfitPct ? `+${p.takeProfitPct}%` : "—"}
                </td>
                <td className="text-right px-3">
                  <button className="btn btn-danger text-[10.5px]" onClick={() => sell(p.mint, p.valueUsd)}>close</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pf.positionViews.length === 0 && <Empty>Flat. Open a token page and use Paper buy — fills apply slippage, fees and pool-impact limits.</Empty>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Fills</div>
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <tbody className="num">
                {[...pf.fills].reverse().map((f) => (
                  <tr key={f.orderId} className="trow">
                    <td className="px-3 py-1 faint">{fmtAgo(f.ts)}</td>
                    <td className="px-2">{fmtUsd(f.usd)}</td>
                    <td className="px-2 dim">@ {fmtUsd(f.priceUsd)}</td>
                    <td className="px-2 faint">slip {f.slippagePct.toFixed(2)}%</td>
                    <td className="px-2 faint">impact {f.priceImpactPct.toFixed(2)}%</td>
                    <td className="px-2 faint text-right">fee {fmtUsd(f.feeUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pf.fills.length === 0 && <Empty>No fills yet.</Empty>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Orders (incl. rejections)</div>
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <tbody className="num">
                {[...pf.orders].reverse().map((o) => (
                  <tr key={o.id} className="trow">
                    <td className="px-3 py-1 faint">{fmtAgo(o.ts)}</td>
                    <td className={`px-2 ${o.side === "buy" ? "pos" : "neg"}`}>{o.side.toUpperCase()}</td>
                    <td className="px-2">{fmtUsd(o.requestedUsd)}</td>
                    <td className={`px-2 ${o.status === "rejected" ? "neg" : "dim"}`}>{o.status}</td>
                    <td className="px-2 faint">{o.rejectReason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pf.orders.length === 0 && <Empty>No orders yet.</Empty>}
          </div>
        </div>
      </div>
    </div>
  );
}
