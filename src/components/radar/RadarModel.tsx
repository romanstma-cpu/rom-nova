"use client";

// The graded model on the Track Record page: two cards, the same shape.
//
// The left one is trained here, now, over this browser's journal — the
// signals the in-app radar fired and graded on this device. The right one
// is the connected worker's, trained on its own history and, unlike this
// browser's, carrying a forward record: guesses it stamped on signals as
// they fired, judged by the grades that landed after. A model that only
// scores well on the past it was shown is a fitted curve; the forward line
// is the only part that can earn trust, and the page says which is which.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { hunterServerSnapshot, hunterSnapshot, subscribeHunter } from "@/lib/radar/hunter";
import { journalSignals, radarJournalReady, type RadarSignalRow } from "@/lib/radar/journal";
import { FEATURE_NOTES, HIT_RET, MIN_USABLE, normModelSummary, trainCard, type ModelCard, type ModelSummary, type ModelVerdict } from "@/lib/radar/model";
import { holdRadar, radarServerSnapshot, radarSnapshot, subscribeRadar } from "@/lib/radar/client";

const pct = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");

function VerdictChip({ verdict }: { verdict: ModelVerdict | "untrained" }) {
  const cls = verdict === "edge" ? "chip-pos" : verdict === "no edge" ? "chip-warn" : "";
  return <span className={`chip text-[9.5px] ${cls}`}>{verdict.toUpperCase()}</span>;
}

/** The held-out fold, in one line a reader can check. */
function FoldLine({ n, baseline, topPrecision, topK, se, lift }: { n: number; baseline: number; topPrecision: number; topK: number; se: number; lift: number | null }) {
  return (
    <div className="text-[11.5px] leading-relaxed">
      Newest <span className="num">{n}</span> signals it never saw: every signal hit <span className="num">{pct(baseline)}</span>; its top quarter (
      <span className="num">{topK}</span>) hit <span className={`num ${topPrecision > baseline + 2 * se ? "pos" : ""}`}>{pct(topPrecision)}</span>{" "}
      <span className="faint">±{pct(se)}</span>
      {lift !== null && (
        <>
          {" "}
          · lift <span className="num">{lift.toFixed(2)}×</span>
        </>
      )}
    </div>
  );
}

function LocalCard({ card, rows }: { card: ModelCard | null; rows: number }) {
  if (!card) return <div className="text-[11px] faint">reading the journal…</div>;
  const weights = card.weights
    ? Object.entries(card.weights)
        .filter(([f]) => f !== "hourSin" && f !== "hourCos")
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    : [];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">This browser&apos;s journal</span>
        <VerdictChip verdict={card.verdict} />
        <span className="num text-[10.5px] dim">
          {card.usable} usable of {rows} · {card.excluded.ungraded} ungraded · {card.excluded.stale} stale · {card.excluded.unpriced} unpriced
        </span>
      </div>
      <div className="text-[11.5px] dim leading-relaxed">{card.note}.</div>
      {card.test && <FoldLine n={card.test.n} baseline={card.test.baseline} topPrecision={card.test.top.precision} topK={card.test.top.k} se={card.test.top.se} lift={card.test.top.lift} />}
      {card.test && (
        <div className="text-[10.5px] faint num">
          Brier {card.test.brier.toFixed(3)} vs {card.test.brier_baseline.toFixed(3)} for the base rate · trained on {card.split?.train_n}, judged on {card.split?.test_n}
        </div>
      )}
      {weights.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-0.5 text-[10.5px] mt-1">
          {weights.map(([f, w]) => (
            <div key={f} className="flex items-baseline gap-1.5 min-w-0" title={FEATURE_NOTES[f as keyof typeof FEATURE_NOTES] ?? f}>
              <span className={`num w-[44px] text-right shrink-0 ${w > 0.05 ? "pos" : w < -0.05 ? "neg" : "faint"}`}>
                {w > 0 ? "+" : ""}
                {w.toFixed(2)}
              </span>
              <span className="dim truncate">{FEATURE_NOTES[f as keyof typeof FEATURE_NOTES] ?? f}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkerCard({ summary, connected }: { summary: ModelSummary | null; connected: boolean }) {
  if (!connected) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="panel-title">A worker&apos;s model</span>
          <span className="chip text-[9.5px]">not connected</span>
        </div>
        <div className="text-[11.5px] dim leading-relaxed">
          A Radar worker trains the same model on its own 24/7 history and stamps each new signal with its guess as it fires, so the grades that land later judge the guess with no hindsight. Connect one on the{" "}
          <Link href="/radar" className="link">
            radar page
          </Link>{" "}
          (ROM&apos;s hosted one, via{" "}
          <Link href="/account" className="link">
            Account
          </Link>
          ) and its card and forward record appear here.
        </div>
      </div>
    );
  }
  if (!summary) return <div className="text-[11px] faint">waiting for the worker&apos;s status…</div>;
  const f = summary.forward;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">The connected worker</span>
        <VerdictChip verdict={summary.verdict} />
        <span className="num text-[10.5px] dim">
          {summary.usable} usable graded signals{summary.trained_at ? ` · trained ${new Date(summary.trained_at).toLocaleTimeString()}` : ""}
        </span>
      </div>
      {summary.note && <div className="text-[11.5px] dim leading-relaxed">{summary.note}.</div>}
      {summary.test && <FoldLine n={summary.test.n} baseline={summary.test.baseline} topPrecision={summary.test.top_precision} topK={summary.test.top_k} se={summary.test.se} lift={summary.test.lift} />}
      <div className="text-[11.5px] leading-relaxed border-t border-[rgba(27,35,51,0.5)] pt-1.5 mt-0.5">
        <span className="panel-title mr-2">Forward record</span>
        {f && f.n > 0 ? (
          <>
            <span className="num">{f.n}</span> signals carried a guess when they fired and have since been graded: every one hit{" "}
            <span className="num">{pct(f.baseline)}</span>; the ones it would have acted on (p ≥ 50%, <span className="num">{f.acted}</span>) hit{" "}
            <span className={`num ${f.acted_precision !== null && f.acted_precision > f.baseline ? "pos" : ""}`}>{pct(f.acted_precision)}</span>; its top quarter hit{" "}
            <span className="num">{pct(f.top_precision)}</span> · <VerdictChip verdict={f.verdict} />
          </>
        ) : (
          <span className="faint">none yet — it starts the moment the worker has a fitted card and a new signal fires, and needs {MIN_USABLE} graded guesses to say anything.</span>
        )}
      </div>
    </div>
  );
}

export function RadarModel() {
  const hunter = useSyncExternalStore(subscribeHunter, hunterSnapshot, hunterServerSnapshot);
  const worker = useSyncExternalStore(subscribeRadar, radarSnapshot, radarServerSnapshot);
  const [rows, setRows] = useState<RadarSignalRow[] | null>(null);
  useEffect(() => holdRadar(), []);
  const stamp = `${hunter.counts.signals}:${hunter.counts.graded}:${hunter.phase}`;
  useEffect(() => {
    let dead = false;
    void radarJournalReady().then(() => {
      if (!dead) setRows([...journalSignals()]);
    });
    return () => {
      dead = true;
    };
  }, [stamp]);

  // Training a few hundred rows is a blink; a few thousand is still under a second.
  const card = useMemo(() => (rows ? trainCard(rows) : null), [rows]);
  const summary = normModelSummary(worker.health?.model);
  const connected = worker.phase === "connected";

  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">Whale Radar · the graded model</span>
        <span className="text-[10.5px] dim">a claim about which signals pay, held to the signals&apos; own standard</span>
      </div>
      <p className="text-[12px] leading-[1.55]">
        A logistic regression over the radar&apos;s graded record: what was known about a signal the moment it fired (the
        wallet&apos;s score and the sells behind it, the size, how far up the curve, minutes since launch, the hour, how busy
        the wallet and the mint were) against whether its five-minute grade cleared +{Math.round(HIT_RET * 100)}%. Trained
        on the older part of the record and judged only on the newer part it never saw, in time order. Its verdict is one
        of three words, and <b>edge</b> needs its top quarter to beat following every signal by two standard errors. It
        needs {MIN_USABLE} usable graded signals before it says anything at all. Nothing here is a trade instruction; a
        probability on a signal is a guess, and only the forward record can earn it trust.
      </p>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <LocalCard card={card} rows={rows?.length ?? 0} />
        <WorkerCard summary={summary} connected={connected} />
      </div>
    </div>
  );
}
