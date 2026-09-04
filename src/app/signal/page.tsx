"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi, fmtUsd, fmtPct, fmtAgo, labelClass } from "@/lib/client";
import { Score, Empty } from "@/components/ui/bits";
import { flowWindowLabel } from "@/lib/engine/flow-window";
import type { Signal } from "@/lib/types";

export default function SignalPage() {
  return (
    <Suspense fallback={<Empty>RECONSTRUCTING SIGNAL…</Empty>}>
      <SignalInner />
    </Suspense>
  );
}

function SignalInner() {
  const id = useSearchParams().get("id") ?? "";
  const { data, error } = useApi<{ signal: Signal; symbol: string; name: string }>(id ? `/api/signals/${id}` : null);

  if (!id || error)
    return <Empty>Signal not found or expired. <Link href="/signals" className="link">Back to the terminal.</Link></Empty>;
  if (!data) return <Empty>RECONSTRUCTING SIGNAL…</Empty>;

  const s = data.signal;
  const positives = s.factors.filter((f) => f.weight > 0).sort((a, b) => b.contribution - a.contribution);
  const risks = s.factors.filter((f) => f.weight < 0).sort((a, b) => a.contribution - b.contribution);

  return (
    <div className="p-3 flex flex-col gap-3 max-w-[1100px]">
      <div className="panel px-4 py-3 flex items-center gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Link href={`/token?m=${s.mint}`} className="text-[17px] font-semibold hover:text-[var(--accent)]">{data.symbol}</Link>
            <span className="dim">{data.name}</span>
            <span className={`chip ${labelClass(s.label)}`}>{s.label}</span>
            <span className="chip">{s.kind.replace(/_/g, " ")}</span>
          </div>
          <div className="num text-[10.5px] faint mt-1">
            {s.id} · engine v{s.engineVersion} · profile {s.profile} · created {fmtAgo(s.createdAt)} · features as of {new Date(s.features.asOf).toLocaleString()}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-6">
          <div className="text-right">
            <div className="panel-title">Signal score</div>
            <Score value={s.score} width={110} />
          </div>
          <div className="text-right">
            <div className="panel-title">Confidence</div>
            <span className="num text-[16px]">{(s.confidence * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>

      {s.outcome && s.outcome.return24h !== null && (
        <div className="panel px-4 py-2.5 flex items-center gap-6 num text-[12px] flex-wrap">
          <span className="panel-title">Measured outcome (this signal is old enough to grade)</span>
          <span><span className="dim">1h</span> <b className={(s.outcome.return1h ?? 0) >= 0 ? "pos" : "neg"}>{fmtPct(s.outcome.return1h ?? 0)}</b></span>
          <span><span className="dim">24h</span> <b className={(s.outcome.return24h ?? 0) >= 0 ? "pos" : "neg"}>{fmtPct(s.outcome.return24h ?? 0)}</b></span>
          <span><span className="dim">max favorable</span> <b className="pos">{fmtPct(s.outcome.maxFavorable ?? 0)}</b></span>
          <span><span className="dim">max adverse</span> <b className="neg">{fmtPct(s.outcome.maxAdverse ?? 0)}</b></span>
          {s.outcome.hit !== null && <span className={`chip ${s.outcome.hit ? "chip-pos" : "chip-neg"}`}>{s.outcome.hit ? "HIT" : "MISS"}</span>}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="panel p-3.5">
          <div className="panel-title mb-2">Factor contributions · positive stack</div>
          {positives.map((f) => (
            <div key={f.key} className="mb-2.5">
              <div className="flex items-center justify-between text-[12px]">
                <span>{f.name}</span>
                <span className="num dim">w {f.weight.toFixed(1)} · +{f.contribution.toFixed(1)} pts</span>
              </div>
              <div className="scorebar mt-1"><div style={{ transform: `scaleX(${f.normalized})`, background: "var(--accent)" }} /></div>
              <div className="text-[11px] faint mt-0.5">{f.explanation}</div>
            </div>
          ))}
          <div className="panel-title mt-4 mb-2">Risk penalties</div>
          {risks.map((f) => (
            <div key={f.key} className="mb-2.5">
              <div className="flex items-center justify-between text-[12px]">
                <span>{f.name}</span>
                <span className="num neg">{f.contribution.toFixed(1)} pts</span>
              </div>
              <div className="scorebar mt-1"><div style={{ transform: `scaleX(${f.raw})`, background: "var(--neg)" }} /></div>
              <div className="text-[11px] faint mt-0.5">{f.explanation}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="panel p-3.5">
            <div className="text-[10.5px] pos font-semibold tracking-[0.14em] mb-1.5">WHY THIS IS INTERESTING</div>
            {s.why.map((w, i) => (
              <div key={i} className="text-[12px] dim leading-relaxed mb-1">· {w}</div>
            ))}
          </div>
          <div className="panel p-3.5">
            <div className="text-[10.5px] neg font-semibold tracking-[0.14em] mb-1.5">BEAR CASE — WHAT COULD MAKE THIS FAIL</div>
            {s.bearCase.map((w, i) => (
              <div key={i} className="text-[12px] dim leading-relaxed mb-1">· {w}</div>
            ))}
          </div>
          <div className="panel p-3.5">
            <div className="text-[10.5px] warn font-semibold tracking-[0.14em] mb-1.5">INVALIDATION CONDITIONS</div>
            {s.invalidation.map((w, i) => (
              <div key={i} className="text-[12px] dim leading-relaxed mb-1">· {w}</div>
            ))}
          </div>
          <div className="panel p-3.5">
            <div className="panel-title mb-2">Lifecycle</div>
            {s.lifecycle.map((l, i) => (
              <div key={i} className="flex justify-between text-[11.5px] num mb-0.5">
                <span className="dim uppercase tracking-wide">{l.state}</span>
                <span className="faint">{l.note ?? fmtAgo(l.ts)}</span>
              </div>
            ))}
          </div>
          <div className="panel p-3.5">
            <div className="panel-title mb-2">Feature snapshot (reproducibility)</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 num text-[10.5px] dim">
              {/* The window comes off the vector. This was captioned "6h" for
                  every signal while the invalidation list above it said "a
                  ten-minute chain scan, not a 6h window" — one engine, two
                  stated windows, on one screen. */}
              <KV k={`smart $ net · ${flowWindowLabel(s.features.flowWindowMs)}`} v={fmtUsd(s.features.smartMoneyNetFlowUsd)} />
              <KV k={`whale net · ${flowWindowLabel(s.features.flowWindowMs)}`} v={fmtUsd(s.features.whaleNetFlowUsd)} />
              <KV k="momentum 1h/24h" v={`${fmtPct(s.features.momentum1h)} / ${fmtPct(s.features.momentum24h)}`} />
              <KV k="volume accel" v={`${s.features.volumeAccel.toFixed(2)}×`} />
              <KV k="liquidity" v={fmtUsd(s.features.liquidityUsd)} />
              <KV k="holders Δ24h" v={fmtPct(s.features.holderGrowthPct)} />
              <KV k="top10" v={`${(s.features.top10Pct * 100).toFixed(0)}%`} />
              <KV k="organic" v={(s.features.organicScore * 100).toFixed(0)} />
              <KV k="age" v={`${s.features.ageHours.toFixed(0)}h`} />
              <KV k="regime" v={s.features.regime} />
              <KV k="sample size" v={String(s.features.sampleSize)} />
              <KV k="staleness" v={`${Math.round(s.features.worstStalenessMs / 60000)}m`} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="faint">{k}</span>
      <span>{v}</span>
    </div>
  );
}
