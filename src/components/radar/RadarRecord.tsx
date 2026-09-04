"use client";

// The radar's signal record, on the Track Record page: what following the
// radar has paid, by horizon, by wallet, by day, gross and net of the
// reader's own round-trip cost. Read from this browser's journal — every
// signal the in-app radar ever fired here, up to the journal's cap — and
// refreshed whenever the hunter grades or fires another.

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { hunterServerSnapshot, hunterSnapshot, subscribeHunter } from "@/lib/radar/hunter";
import { copyPlanServerSnapshot, copyPlanSnapshot, subscribeFollows } from "@/lib/radar/follows";
import { journalSignals, radarJournalReady, type RadarSignalRow } from "@/lib/radar/journal";
import { EXIT_BEFORE_YOU_MS, HIT_RET, MIN_WALLET_GRADES, signalRecord } from "@/lib/radar/record";

const shortAddr = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);
const fmtRet = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(r > -0.1 && r < 0.1 ? 1 : 0)}%`;
const retCls = (r: number) => (r >= HIT_RET ? "pos" : r <= -HIT_RET ? "neg" : "dim");
const fmtHold = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export function RadarRecord() {
  const hunter = useSyncExternalStore(subscribeHunter, hunterSnapshot, hunterServerSnapshot);
  const plan = useSyncExternalStore(subscribeFollows, copyPlanSnapshot, copyPlanServerSnapshot);
  const [rows, setRows] = useState<RadarSignalRow[] | null>(null);
  // The journal is the source, re-read when the hunter changes anything
  // about signals — a new one, a grade, an exit.
  const stamp = `${hunter.counts.signals}:${hunter.counts.graded}:${hunter.counts.exits}:${hunter.phase}`;
  useEffect(() => {
    let dead = false;
    void radarJournalReady().then(() => {
      if (!dead) setRows([...journalSignals()]);
    });
    return () => {
      dead = true;
    };
  }, [stamp]);

  const record = signalRecord(rows ?? [], plan.costPct);

  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">Whale Radar · signal record</span>
        <span className="num text-[10.5px] dim">
          {record.signals} signal{record.signals === 1 ? "" : "s"} from {record.wallets} wallet{record.wallets === 1 ? "" : "s"} in this browser&apos;s journal
          {record.staleAny > 0 && ` · ${record.staleAny} with a stale grade`}
          {record.lookupAny > 0 && ` · ${record.lookupAny} graded off the curve`}
        </span>
        <Link href="/radar" className="link text-[10.5px] ml-auto">
          the radar →
        </Link>
      </div>
      <p className="text-[12px] leading-[1.55]">
        Every signal the radar fires here is graded by the stream that produced it: the token&apos;s price at the
        first trade one, five, fifteen and sixty minutes later, against the signal&apos;s own fill price. Nothing is
        fitted after the fact. <b>Net</b> subtracts the {plan.costPct}% round trip set on your copy plan; a{" "}
        <b>hit</b> is a grade at or above +{Math.round(HIT_RET * 100)}%, the bar a bonding-curve round trip needs to
        be green.
      </p>

      {rows === null ? (
        <div className="text-[11px] faint">reading the journal…</div>
      ) : record.signals === 0 ? (
        <div className="text-[11px] faint">
          No signals in this browser yet. Arm the radar; the first signals need a wallet that has proved itself on
          settled sells, and each one is graded within the hour.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-3">
          <div>
            <table className="w-full text-[11.5px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Horizon</th>
                  <th className="text-right px-2 font-medium">Graded</th>
                  <th className="text-right px-2 font-medium">Median</th>
                  <th className="text-right px-2 font-medium" title={`net of ${plan.costPct}%`}>
                    Net
                  </th>
                  <th className="text-right px-2 font-medium" title={`share of grades at or above +${Math.round(HIT_RET * 100)}%`}>
                    Hit
                  </th>
                  <th className="text-right px-2 font-medium" title="grades marked to the last price seen because nothing traded at the horizon">
                    Stale
                  </th>
                </tr>
              </thead>
              <tbody className="num">
                {record.horizons.map((h) => (
                  <tr key={h.horizon} className="trow">
                    <td className="px-2 py-1.5">{h.label}</td>
                    <td className="text-right px-2 dim">{h.graded}</td>
                    <td className={`text-right px-2 ${h.medianGross === null ? "faint" : retCls(h.medianGross)}`}>{h.medianGross === null ? "—" : fmtRet(h.medianGross)}</td>
                    <td className={`text-right px-2 ${h.medianNet === null ? "faint" : retCls(h.medianNet)}`}>{h.medianNet === null ? "—" : fmtRet(h.medianNet)}</td>
                    <td className="text-right px-2">{pct(h.hitRate)}</td>
                    <td className="text-right px-2 faint">{h.stale || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="num text-[10.5px] dim px-2 pt-2 leading-relaxed">
              Best price inside the hour, median: {record.peakMedian === null ? "—" : fmtRet(record.peakMedian)} — what a
              perfect exit got, which nobody gets. The signal wallet sold on {record.exits.n} of these
              {record.exits.n > 0 && (
                <>
                  , median {fmtRet(record.exits.medianRet ?? 0)} after {record.exits.medianAfterMs === null ? "—" : fmtHold(record.exits.medianAfterMs)}
                  {record.exits.beforeYou > 0 && (
                    <>
                      ; <span className="warn">{record.exits.beforeYou}</span> inside {Math.round(EXIT_BEFORE_YOU_MS / 1000)}s, before a person could have bought
                    </>
                  )}
                </>
              )}
              .
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <table className="w-full text-[11.5px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium" title={`wallets with at least ${MIN_WALLET_GRADES} graded signals, best five-minute median first`}>
                    Wallet
                  </th>
                  <th className="text-right px-2 font-medium">Signals</th>
                  <th className="text-right px-2 font-medium">+5m median</th>
                  <th className="text-right px-2 font-medium">Hit</th>
                  <th className="text-right px-2 font-medium" title="how long after its signal the wallet usually sells">
                    Sells after
                  </th>
                </tr>
              </thead>
              <tbody className="num">
                {record.byWallet.slice(0, 8).map((w) => (
                  <tr key={w.wallet} className="trow">
                    <td className="px-2 py-1.5">
                      <Link href={`/whale?a=${w.wallet}`} className="link">
                        {shortAddr(w.wallet)}
                      </Link>
                    </td>
                    <td className="text-right px-2 dim">
                      {w.signals}
                      <span className="faint"> ·{w.graded}</span>
                    </td>
                    <td className={`text-right px-2 ${w.median5m === null ? "faint" : retCls(w.median5m)}`}>{w.median5m === null ? "—" : fmtRet(w.median5m)}</td>
                    <td className="text-right px-2">{pct(w.hit5m)}</td>
                    <td className="text-right px-2 dim">{w.medianExitAfterMs === null ? "—" : fmtHold(w.medianExitAfterMs)}</td>
                  </tr>
                ))}
                {record.byWallet.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-3 faint text-[11px]">
                      No wallet has {MIN_WALLET_GRADES} graded signals yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {record.byDay.length > 1 && (
              <div className="num text-[10.5px] dim px-2 leading-relaxed">
                By day:{" "}
                {record.byDay.slice(0, 7).map((d) => (
                  <span key={d.day} className="mr-3" title={`${d.signals} signals, ${d.graded} graded at +5m`}>
                    {d.day.slice(5)}{" "}
                    <span className={d.median5m === null ? "faint" : retCls(d.median5m)}>{d.median5m === null ? "—" : fmtRet(d.median5m)}</span>
                    <span className="faint"> {pct(d.hit5m)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
