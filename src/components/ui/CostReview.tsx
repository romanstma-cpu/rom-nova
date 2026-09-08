"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { costReview } from "@/lib/engine/cost-review";
import { BUCKETS, HORIZONS, MIN_PASSES, type Observation } from "@/lib/engine/track-record";

const percent = (n: number | null) => n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

export function CostReview({ ledger, tick }: { ledger: readonly Observation[]; tick: number }) {
  const [horizon, setHorizon] = useState("24h");
  const [band, setBand] = useState("70+");
  const [cost, setCost] = useState("2");
  const costPct = Number(cost);
  const valid = cost.trim() !== "" && Number.isFinite(costPct) && costPct >= 0 && costPct < 100;
  const report = useMemo(() => {
    void tick;
    return valid ? costReview(ledger, horizon, band, costPct) : null;
  }, [ledger, horizon, band, costPct, valid, tick]);
  return <section className="evidence-card" aria-labelledby="cost-review-title">
    <div className="evidence-heading"><div><p className="eyebrow">PERFORMANCE / COST SENSITIVITY</p><h2 id="cost-review-title">Does the move survive the costs?</h2><p>Inspect observed price moves after an assumed round-trip cost.</p></div><span className="chip chip-warn">Research · not realized P&amp;L</span></div>
    <div className="evidence-controls">
      <label>Holding window<select className="input" value={horizon} onChange={e => setHorizon(e.target.value)}>{HORIZONS.map(h => <option key={h.label}>{h.label}</option>)}</select></label>
      <label>Score band<select className="input" value={band} onChange={e => setBand(e.target.value)}>{BUCKETS.map(b => <option key={b.label}>{b.label}</option>)}</select></label>
      <label>Round-trip cost (%)<input className="input" type="number" min="0" max="99.99" step="0.1" value={cost} onChange={e => setCost(e.target.value)} aria-invalid={!valid} aria-describedby="cost-method" /></label>
    </div>
    {!valid && <p role="alert" className="neg">Enter a cost from 0 to less than 100%.</p>}
    <div className="evidence-stats">
      <div><span>Gross mean move</span><strong>{percent(report?.grossMeanPct ?? null)}</strong></div>
      <div><span>After assumed costs</span><strong className={report?.netMeanPct != null && report.netMeanPct < 0 ? "neg" : ""}>{percent(report?.netMeanPct ?? null)}</strong></div>
      <div><span>Median after costs</span><strong>{percent(report?.netMedianPct ?? null)}</strong></div>
      <div><span>Observations / passes</span><strong>{report ? `${report.count} / ${report.passes}` : "—"}</strong></div>
    </div>
    <div className="evidence-note"><b>{!report?.count ? "No resolved observations for this selection." : !report.enough ? `Limited sample: ${report.passes} of ${MIN_PASSES} resolved passes.` : "Sample available for review; profitability is not established."}</b><p id="cost-method">Only observations with all scoring inputs measured are included. The default 2% is an editable assumption, not a measured fee. Each price return is multiplied by (1 − cost/100). Actual fees, slippage, failed exits and market impact can differ. Overlapping observations are not independent trades or a portfolio return.</p></div>
    <div className="evidence-actions"><Link href="/scanner" className="btn btn-primary">Collect observations →</Link><Link href="/portfolio" className="btn">Open paper desk ↗</Link></div>
  </section>;
}
