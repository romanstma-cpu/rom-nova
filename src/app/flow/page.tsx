"use client";

import { useState } from "react";
import { useApi, fmtUsd } from "@/lib/client";
import { FlowChart } from "@/components/charts/FlowChart";
import { Empty, Stat } from "@/components/ui/bits";
import type { FlowPoint } from "@/lib/api/rows";

const WINDOWS = [
  { label: "24h", hours: 24 },
  { label: "72h", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "14d", hours: 336 },
];

export default function FlowPage() {
  const [hours, setHours] = useState(72);
  const { data } = useApi<{ flow: FlowPoint[] }>(`/api/flow?hours=${hours}`, 30_000);
  const flow = data?.flow ?? [];
  const totBuy = flow.reduce((s, p) => s + p.whaleBuyUsd, 0);
  const totSell = flow.reduce((s, p) => s + p.whaleSellUsd, 0);
  const smNet = flow.reduce((s, p) => s + p.smNetUsd, 0);

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h1 className="text-[15px] font-semibold tracking-wide mr-2">MONEY FLOW · ALL TRACKED WALLETS</h1>
        {WINDOWS.map((w) => (
          <button key={w.hours} onClick={() => setHours(w.hours)} className={`chip cursor-pointer ${hours === w.hours ? "chip-accent" : ""}`}>
            {w.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Gross whale buying"><span className="pos">{fmtUsd(totBuy)}</span></Stat>
        <Stat label="Gross whale selling"><span className="neg">{fmtUsd(totSell)}</span></Stat>
        <Stat label="Net whale flow"><span className={totBuy - totSell >= 0 ? "pos" : "neg"}>{fmtUsd(totBuy - totSell)}</span></Stat>
        <Stat label="Smart money net"><span className={smNet >= 0 ? "pos" : "neg"}>{fmtUsd(smNet)}</span></Stat>
      </div>

      <div className="panel">
        <div className="panel-title px-3 pt-2.5">Hourly whale buys (green) / sells (red) · smart-money net line (cyan)</div>
        <div className="px-2 pb-2">
          {flow.length ? <FlowChart flow={flow} height={420} /> : <Empty>RECALCULATING WHALE FLOWS…</Empty>}
        </div>
      </div>
    </div>
  );
}
