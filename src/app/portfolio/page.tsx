"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useApi, apiPost, fmtUsd, fmtPct, fmtAgo } from "@/lib/client";
import { Empty, Stat } from "@/components/ui/bits";
import type { PortfolioView } from "@/lib/engine/paper";

export default function PortfolioPage() {
  const { data, reload } = useApi<{ portfolios: PortfolioView[] }>("/api/paper", 10_000);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const pf = data?.portfolios[0];

  const sell = async (mint: string, usd: number) => {
    if (!pf || pending.current) return;
    pending.current = true;
    setBusy(mint);
    setMsg("Submitting simulated exit…");
    try {
      const res = await apiPost<{ error?: string; fill?: { usd: number } }>("/api/paper/orders", { portfolioId: pf.id, mint, side: "sell", usd });
      setMsg(!res.ok || res.body.error ? `Exit rejected: ${res.body.error ?? `request failed (${res.status})`}` : "Simulated exit processed. Review the updated position and fill below.");
      reload();
    } catch {
      setMsg("Could not confirm the exit. Refresh and check the order history before retrying.");
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  if (!pf) return <Empty>{msg ?? "LOADING PAPER DESK…"}</Empty>;

  const fees = pf.fills.reduce((sum, f) => sum + f.feeUsd, 0);
  const exposure = pf.positionViews.reduce((sum, p) => sum + p.valueUsd, 0);
  const largest = Math.max(0, ...pf.positionViews.map(p => p.valueUsd));
  const exportRecord = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), mode: "SIMULATED", valuation: "Mark-to-market; open positions exclude future exit costs", portfolio: pf }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "nova-paper-record.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="evidence-page flex flex-col gap-5">
      <section className="evidence-card">
        <div className="evidence-heading"><div><p className="eyebrow">PRACTICE / REVIEW / REFINE</p><h1>Your trading rehearsal.</h1><p>Review exposure, execution costs, and every simulated fill.</p></div><span className="chip chip-warn">Simulated capital</span></div>
        <div className="evidence-stats">
          <div><span>Capital deployed</span><strong>{pf.equityUsd > 0 ? `${(exposure / pf.equityUsd * 100).toFixed(1)}%` : "—"}</strong></div>
          <div><span>Largest position / equity</span><strong>{pf.equityUsd > 0 ? `${(largest / pf.equityUsd * 100).toFixed(1)}%` : "—"}</strong></div>
          <div><span>Fees paid · included in P&amp;L</span><strong>{fmtUsd(fees)}</strong></div>
          <div><span>Open positions</span><strong>{pf.positionViews.length}</strong></div>
        </div>
        <div className="evidence-note"><b>Practice results are not a live track record.</b><p>Prices and fills on this desk are simulated. Equity marks open positions at the current simulated price; future exit fees and slippage are not deducted. Stops can exit in pieces when pool depth limits a sale.</p></div>
        <div className="evidence-actions"><Link href="/tokens" className="btn btn-primary">Find a token →</Link><Link href="/track" className="btn">Review signal evidence ↗</Link><button className="btn" onClick={exportRecord}>Export paper record ↓</button></div>
      </section>
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-semibold">Paper desk · {pf.name}</h2>
        <span className="chip chip-warn">SIMULATED — no real funds on this desk</span>
        <span role="status" className="text-[12px] dim">{msg}</span>
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
        <div className="overflow-x-auto">
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
                    <button className="btn btn-danger text-[10.5px]" disabled={busy !== null} onClick={() => sell(p.mint, p.valueUsd)}>{busy === p.mint ? "Exiting…" : "Close position"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pf.positionViews.length === 0 && <Empty>Flat. Open a token page and use Paper buy — fills apply slippage, fees and pool-impact limits.</Empty>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Fills</div>
          <div className="max-h-[300px] overflow-y-auto">
            <div className="overflow-x-auto">
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
            </div>
            {pf.fills.length === 0 && <Empty>No fills yet.</Empty>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Orders (incl. rejections)</div>
          <div className="max-h-[300px] overflow-y-auto">
            <div className="overflow-x-auto">
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
            </div>
            {pf.orders.length === 0 && <Empty>No orders yet.</Empty>}
          </div>
        </div>
      </div>
    </div>
  );
}
