"use client";

import { useMemo, useState } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import Link from "next/link";
import { useApi, fmtUsd, fmtPct, labelClass } from "@/lib/client";
import { Score, TokenMark, Empty } from "@/components/ui/bits";
import type { Signal, StrategyProfileId } from "@/lib/types";
import type { AccuracyStats } from "@/lib/engine/signals";

type SignalWithMeta = Signal & { symbol: string; name: string; hue: number };

/** What `/api/signals` says about where the feed came from this pass. */
type SignalsMeta = {
  demo?: boolean;
  provenance?: { source: string; real: boolean; note?: string };
  live?: {
    pass: { at: number; source: string; seq: number; mints: number };
    stats: { fresh: number; updated: number; expired: number };
    cadence: { medianMs: number | null; samples: number; lastGapMs: number | null };
    corpus: number;
    note: string;
  };
};

/**
 * `/api/accuracy` refuses to grade the live feed — there is no synthetic
 * history to grade it against — so on the live path `stats` is null and
 * `measuredOn` points at the Track Record page, which grades real scores
 * against real later prices. The strip must render that pointer, not
 * reach into the null (the crash the first smoke test of this build found).
 */
type AccuracyAnswer = {
  stats: AccuracyStats | null;
  demo?: boolean;
  note?: string;
  measuredOn?: { href: string; label: string; note: string };
};

const PROFILES: { id: StrategyProfileId; label: string }[] = [
  { id: "balanced", label: "Balanced" },
  { id: "conservative", label: "Conservative" },
  { id: "aggressive", label: "Aggressive" },
  { id: "early_gem", label: "Early Gem" },
  { id: "smart_money", label: "Smart Money" },
  { id: "momentum", label: "Momentum" },
  { id: "mean_reversion", label: "Mean Reversion" },
  { id: "whale_shadow", label: "Whale Shadow" },
  { id: "high_risk", label: "High Risk" },
];

type Board = "best" | "early" | "smart" | "whale" | "warnings" | "no_trade";

export default function SignalTerminal() {
  const [profile, setProfile] = useState<StrategyProfileId>("balanced");
  const [board, setBoard] = useState<Board>("best");
  const { data, error } = useApi<{ signals: SignalWithMeta[]; asOf: number } & SignalsMeta>(`/api/signals?profile=${profile}`, 30_000);
  const { data: acc } = useApi<AccuracyAnswer>(`/api/accuracy?profile=${profile}`);

  const list = useMemo(() => {
    const all = data?.signals ?? [];
    switch (board) {
      case "best":
        return all.filter((s) => s.label !== "NO TRADE").slice(0, 30);
      case "early":
        return all.filter((s) => s.label !== "NO TRADE" && s.features.ageHours < 72).sort((a, b) => b.score - a.score);
      case "smart":
        return all.filter((s) => s.features.smartMoneyWallets > 0 && s.label !== "NO TRADE").sort((a, b) => b.features.smartMoneyNetFlowUsd - a.features.smartMoneyNetFlowUsd);
      case "whale":
        return all.filter((s) => s.label !== "NO TRADE").sort((a, b) => b.features.whaleNetFlowUsd - a.features.whaleNetFlowUsd).slice(0, 30);
      case "warnings":
        return all.filter((s) => ["whale_exit_warning", "distribution_warning", "rug_risk_escalation", "liquidity_collapse"].includes(s.kind) || s.label === "EXTREME RISK");
      case "no_trade":
        return all.filter((s) => s.label === "NO TRADE").slice(0, 40);
    }
  }, [data, board]);

  const boards: { id: Board; label: string }[] = [
    { id: "best", label: "Best setups" },
    { id: "early", label: "Early setups" },
    { id: "smart", label: "Smart money" },
    { id: "whale", label: "Whale accumulation" },
    { id: "warnings", label: "Warnings" },
    { id: "no_trade", label: "NO TRADE" },
  ];

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <PageTitle title="SIGNALS" lede="Ranked setups, with the case for and against each" />
        <select value={profile} onChange={(e) => setProfile(e.target.value as StrategyProfileId)} className="input">
          {PROFILES.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <div className="flex gap-1.5 ml-2 flex-wrap">
          {boards.map((b) => (
            <button key={b.id} onClick={() => setBoard(b.id)} className={`chip cursor-pointer ${board === b.id ? "chip-accent" : ""}`}>
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* where this pass came from — the same claim /status makes, on the page itself */}
      {data && data.demo === false && data.live && (
        <div className="panel px-4 py-2 flex items-center gap-4 text-[11.5px] flex-wrap">
          <span className="chip chip-accent">LIVE · {data.provenance?.source ?? data.live.pass.source}</span>
          <span className="dim leading-snug">{data.live.note}</span>
          <span className="num faint">
            {data.live.cadence.medianMs !== null && data.live.cadence.samples >= 2
              ? `refresh ~${Math.round(data.live.cadence.medianMs / 1000)}s measured over ${data.live.cadence.samples} gaps`
              : `pass ${data.live.pass.seq} — cadence not yet measured`}
            {" · "}
            {data.live.stats.fresh} new · {data.live.stats.updated} carried · {data.live.stats.expired} expired
          </span>
        </div>
      )}
      {data && data.demo === true && (
        <div className="panel px-4 py-2 flex items-center gap-4 text-[11.5px] flex-wrap">
          <span className="chip">SIMULATED</span>
          <span className="dim leading-snug">{data.provenance?.note ?? "the deterministic simulator — no live token source answered"}</span>
        </div>
      )}

      {/* honest accuracy strip: measured numbers, or an honest pointer — never a fabricated history */}
      {acc && !acc.stats && acc.measuredOn && (
        <div className="panel px-4 py-2 flex items-center gap-4 text-[11.5px] flex-wrap">
          <span className="panel-title">Measured performance</span>
          <span className="dim leading-snug">{acc.measuredOn.note}</span>
          <Link href={acc.measuredOn.href} className="chip cursor-pointer">{acc.measuredOn.label} →</Link>
        </div>
      )}
      {acc && acc.stats && (
        <div className="panel px-4 py-2 flex items-center gap-6 num text-[11.5px] flex-wrap">
          <span className="panel-title">Measured performance · last {acc.stats.windowDays}d · {profile}</span>
          <span><span className="dim">actionable signals</span> {acc.stats.samples}</span>
          <span><span className="dim">hit rate (&gt;5% in 24h)</span> <span className={acc.stats.hitRate >= 0.5 ? "pos" : "warn"}>{(acc.stats.hitRate * 100).toFixed(0)}%</span></span>
          <span><span className="dim">avg 24h</span> <span className={acc.stats.avgReturn24h >= 0 ? "pos" : "neg"}>{fmtPct(acc.stats.avgReturn24h)}</span></span>
          <span><span className="dim">median 24h</span> <span className={acc.stats.medianReturn24h >= 0 ? "pos" : "neg"}>{fmtPct(acc.stats.medianReturn24h)}</span></span>
          <span><span className="dim">false positives (&lt;−10%)</span> <span className="neg">{(acc.stats.falsePositiveRate * 100).toFixed(0)}%</span></span>
          <span className="faint text-[10px]">measured on synthetic data — the method is the product, not the numbers</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5">
        {list.map((s, i) => (
          <Link key={s.id} href={`/signal?id=${s.id}`} className="panel p-3 hover:border-[var(--border-hi)] block fade-up">
            <div className="flex items-center gap-2">
              <span className="faint num text-[10px]">{i + 1}</span>
              <TokenMark hue={s.hue} symbol={s.symbol} size={20} />
              <span className="font-semibold text-[13.5px]">{s.symbol}</span>
              <span className="faint text-[10.5px] truncate">{s.name}</span>
              <span className={`ml-auto chip ${labelClass(s.label)}`}>{s.label}</span>
            </div>
            <div className="flex items-center justify-between mt-2">
              <Score value={s.score} width={90} />
              <span className="chip">{s.kind.replace(/_/g, " ")}</span>
            </div>
            <div className="grid grid-cols-3 gap-1 mt-2 num text-[10.5px]">
              <span className="dim">liq {fmtUsd(s.features.liquidityUsd)}</span>
              <span className={s.features.whaleNetFlowUsd >= 0 ? "pos" : "neg"}>whale {fmtUsd(s.features.whaleNetFlowUsd)}</span>
              <span className={s.features.momentum24h >= 0 ? "pos" : "neg"}>24h {fmtPct(s.features.momentum24h)}</span>
            </div>
            <div className="text-[11px] dim mt-2 leading-snug line-clamp-2">{s.why[0]}</div>

            {/* A score is not a plan. The card showed conviction and evidence and
                stopped there — nothing about how much you could put in, or what
                would prove it wrong. Both numbers already exist on every signal;
                they were only ever rendered on the detail page. */}
            <div className="signal-plan">
              <span className="num">
                size ≤ <b>{fmtUsd(s.features.exitDepthUsd)}</b>
                <span className="faint"> to exit inside 5%</span>
              </span>
              {s.invalidation[0] && (
                <span className="signal-invalid">wrong if {s.invalidation[0]}</span>
              )}
            </div>
          </Link>
        ))}
      </div>
      {list.length === 0 && (
        <Empty>{data ? "Nothing on this board right now." : error ? "Signal engine unavailable — retrying automatically." : "SYNCING SMART MONEY…"}</Empty>
      )}
    </div>
  );
}
