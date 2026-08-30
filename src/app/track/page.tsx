"use client";

// The page that grades the rest of the terminal.
//
// Every other screen here asks "what is happening". This one asks whether the
// number those screens sort by has ever been worth anything — and it is built
// so that the answer is allowed to be no. The verdict string, the interval
// widths and the "not enough data" state all come from the same computation, so
// the headline cannot be encouraging while the table underneath is empty.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { HORIZONS, MIN_PASSES, trackReport, type TrackReport } from "@/lib/engine/track-record";
import {
  clearLedger,
  ledgerRaw,
  ledgerRawServer,
  MAX_AGE_MS,
  parseLedger,
  subscribeLedger,
} from "@/lib/track-store";
import { Empty } from "@/components/ui/bits";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function ago(ts: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export default function TrackPage() {
  // The ledger is an external store — written by the scanner, possibly in
  // another tab. Subscribing to it beats polling it into state: no cascading
  // renders, and a write from another tab lands here immediately.
  // The report derives from the SNAPSHOT, never from storage read during
  // render — that difference is what keeps the prerendered HTML and the first
  // browser render in agreement.
  const raw = useSyncExternalStore(subscribeLedger, ledgerRaw, ledgerRawServer);
  // Horizons resolve with the passage of time, not only with new writes, so a
  // slow tick re-runs the report even when nothing has been recorded.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const ledger = useMemo(() => parseLedger(raw), [raw]);
  const report: TrackReport = useMemo(
    () => trackReport(ledger),
    // `tick` is a deliberate input: elapsed time resolves horizons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger, tick],
  );

  const enough = useMemo(
    () => Math.max(0, ...report.horizons.map((h) => h.passes)) >= MIN_PASSES,
    [report],
  );

  return (
    <div className="p-3 flex flex-col gap-3 h-full min-h-0 overflow-auto">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide">TRACK RECORD</h1>
        <span className="text-[10.5px] dim num ml-2">
          {report.observations.toLocaleString()} observations · {report.passes.toLocaleString()} passes ·{" "}
          {report.mints.toLocaleString()} tokens
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn text-[11px]" onClick={() => clearLedger()}>
            clear ledger
          </button>
        </div>
      </div>

      {/* The claim, stated before any table so a reader meets the caveat first. */}
      <div className="panel p-3 flex flex-col gap-2">
        <div className="panel-title">WHAT THIS MEASURES</div>
        <p className="text-[12px] leading-[1.55]">
          Every scan pass writes down what it saw and what it cost. Later passes supply the price that
          resolves it, so this is a <b>forward test</b> — nothing here is fitted after the fact, and no
          observation is scored against a price that existed when it was made.
        </p>
        <p className="text-[12px] leading-[1.55]">
          The column that matters is <b>lift</b>: a score band&rsquo;s return minus the average of{" "}
          <i>everything this scanner listed</i> over the same window. In a rising market every band goes
          up, and reporting that as skill would be crediting the market to the model. Intervals resample{" "}
          <b>whole scan passes</b>, never individual rows — twelve tokens seen in one pass share a market
          and a direction, and treating them as twelve independent trials narrows the interval by an
          amount nobody earned.
        </p>
        <p className="text-[12px] leading-[1.55] dim">
          The ledger lives in this browser only. Nothing is uploaded. Observations older than{" "}
          {Math.round(MAX_AGE_MS / 86_400_000)} days are dropped.
        </p>
      </div>

      <div
        className={`panel p-3 border ${
          enough ? "border-[rgba(56,225,255,0.25)]" : "border-[var(--border)]"
        }`}
      >
        <div className="panel-title pb-1.5">VERDICT</div>
        <p className="text-[13px] leading-[1.6]">{report.verdict}</p>
        <div className="text-[10.5px] dim num pt-2 flex gap-4 flex-wrap">
          <span>first observation {ago(report.firstTs)}</span>
          <span>last {ago(report.lastTs)}</span>
          <span>{report.pending.toLocaleString()} awaiting their horizon</span>
          <span title="The window closed before another price arrived — usually the app was not running.">
            {report.expired.toLocaleString()} expired unresolved
          </span>
        </div>
      </div>

      {report.observations === 0 ? (
        <Empty>OPEN THE SCANNER TO START RECORDING</Empty>
      ) : (
        report.horizons.map((h) => (
          <div key={h.horizon} className="panel overflow-auto">
            <div className="flex items-baseline gap-3 px-3 pt-2.5 pb-1 flex-wrap">
              <div className="panel-title">{h.horizon.toUpperCase()} FORWARD</div>
              <span className="text-[10.5px] dim num">
                {h.n.toLocaleString()} resolved over {h.passes.toLocaleString()} passes
              </span>
              {/* Dashes at n=0, exactly as every band below already does. The
                  bands were guarded and this line was not, so all three horizon
                  panels announced "baseline +0.00%" with nothing resolved — a
                  mean over an empty set rendered as a flat market. */}
              <span className="text-[10.5px] num ml-auto">
                baseline (all listed tokens){" "}
                {h.n === 0 ? (
                  <b className="faint" title="nothing has resolved at this horizon yet">
                    —
                  </b>
                ) : (
                  <b className={h.baselineMeanPct >= 0 ? "pos" : "neg"}>{pct(h.baselineMeanPct)}</b>
                )}
              </span>
            </div>
            <table className="w-full text-[12px] min-w-[720px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Score band</th>
                  <th className="text-right px-2 font-medium">n</th>
                  <th className="text-right px-2 font-medium">passes</th>
                  <th className="text-right px-2 font-medium">mean</th>
                  <th className="text-right px-2 font-medium">median</th>
                  <th className="text-right px-2 font-medium">above water</th>
                  <th className="text-right px-2 font-medium">lift vs baseline</th>
                  <th className="text-right px-3 font-medium">95% interval on lift</th>
                </tr>
              </thead>
              <tbody className="num">
                {h.bands.map((b) => {
                  const separates = b.liftCI !== null && (b.liftCI[0] > 0 || b.liftCI[1] < 0);
                  return (
                    <tr key={b.bucket} className="trow">
                      <td className="px-3 py-[6px]" style={{ fontFamily: "var(--font-sans)" }}>
                        {b.bucket}
                      </td>
                      <td className="text-right px-2 dim">{b.n.toLocaleString()}</td>
                      <td className="text-right px-2 dim">{b.passes.toLocaleString()}</td>
                      {b.n === 0 ? (
                        <>
                          <td className="text-right px-2 faint" title="nothing scored into this band yet">—</td>
                          <td className="text-right px-2 faint">—</td>
                          <td className="text-right px-2 faint">—</td>
                          <td className="text-right px-2 faint">—</td>
                          <td className="text-right px-3 faint">—</td>
                        </>
                      ) : (
                        <>
                          <td className={`text-right px-2 ${b.meanReturnPct >= 0 ? "pos" : "neg"}`}>
                            {pct(b.meanReturnPct)}
                          </td>
                          <td className={`text-right px-2 ${b.medianReturnPct >= 0 ? "pos" : "neg"}`}>
                            {pct(b.medianReturnPct)}
                          </td>
                          <td className="text-right px-2 dim">{(b.hitRate * 100).toFixed(0)}%</td>
                          <td
                            className={`text-right px-2 ${separates ? (b.liftPct >= 0 ? "pos" : "neg") : "dim"}`}
                            title={
                              separates
                                ? "This band's interval excludes zero."
                                : "Not distinguishable from the baseline once passes are resampled."
                            }
                          >
                            {pct(b.liftPct)}
                            {separates ? " ✳" : ""}
                          </td>
                          {/* An interval below the group minimum is not a wide
                              interval, it is a meaningless one, so it is refused
                              rather than drawn narrow and wrong. */}
                          <td className="text-right px-3 dim">
                            {b.liftCI ? (
                              `${pct(b.liftCI[0])} … ${pct(b.liftCI[1])}`
                            ) : (
                              <span className="faint" title={`needs at least 8 resolved passes in this band`}>
                                too few passes
                              </span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))
      )}

      <div className="hint px-1 pb-2">
        ✳ marks a band whose lift interval excludes zero. That is a measured separation over{" "}
        <i>this sample and this period</i>, not a guarantee and not evidence it will hold. Horizons are{" "}
        {HORIZONS.map((h) => h.label).join(", ")}; an observation resolves only against a price taken
        inside its window, and expires unresolved if the terminal was closed when that window passed.
        Nothing on this page is advice, and no arrangement of these numbers makes a memecoin a good
        idea.
      </div>
    </div>
  );
}
