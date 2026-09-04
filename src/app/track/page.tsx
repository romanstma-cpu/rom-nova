"use client";

// The page that grades the rest of the terminal.
//
// Every other screen here asks "what is happening". This one asks whether the
// number those screens sort by has ever been worth anything — and it is built
// so that the answer is allowed to be no. The verdict string, the interval
// widths and the "not enough data" state all come from the same computation, so
// the headline cannot be encouraging while the table underneath is empty.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import { Hint } from "@/components/ui/Hint";
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
import { RadarRecord } from "@/components/radar/RadarRecord";
import { clearLaunchRecord, launchSnapshot, launchSnapshotServer, subscribeLaunchRecord } from "@/lib/launch-record/store";
import { ALIVE_LIQUIDITY_USD, LAUNCH_MIN_RESOLVED, launchReport, type LaunchBucketStat } from "@/lib/launch-record/report";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function ago(ts: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

const rate = (num: number, den: number) => (den > 0 ? `${Math.round((100 * num) / den)}%` : "—");

/**
 * One bucket table: verdicts, deployer history, or launchpad.
 *
 * A row prints its rates only past the floor; below it the row says how many
 * of thirty it has, in the cell where the rate would go, so "no number" and
 * "zero" can never be confused.
 */
function BucketTable({ title, rows }: { title: string; rows: LaunchBucketStat[] }) {
  return (
    <div className="panel overflow-auto">
      <div className="panel-title px-3 pt-2.5 pb-1">{title}</div>
      <table className="w-full text-[12px] min-w-[720px]">
        <thead className="thead">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Bucket</th>
            <th className="text-right px-2 font-medium">seen</th>
            <th className="text-right px-2 font-medium" title="looked up 24h after first sight, inside the window">resolved 24h</th>
            <th className="text-right px-2 font-medium" title="graduated into a real pool within 24h of first sight, by the feed's own sighting or the lookup">graduated</th>
            <th className="text-right px-2 font-medium" title={`still listed with $${ALIVE_LIQUIDITY_USD.toLocaleString()}+ liquidity at 24h`}>alive 24h</th>
            <th className="text-right px-2 font-medium" title="rows that had a price within two minutes of first sight AND at the horizon — most launchpad mints have neither">priced</th>
            <th className="text-right px-2 font-medium">median 1h</th>
            <th className="text-right px-2 font-medium">median 24h</th>
            <th className="text-right px-3 font-medium">above water 24h</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((b) => (
            <tr key={b.bucket} className="trow">
              <td className="px-3 py-[6px]" style={{ fontFamily: "var(--font-sans)" }}>{b.bucket}</td>
              <td className="text-right px-2 dim">{b.n.toLocaleString()}</td>
              <td className="text-right px-2 dim">{b.resolved24h.toLocaleString()}</td>
              {b.enough24h ? (
                <>
                  <td className="text-right px-2">{rate(b.graduated24h, b.resolved24h)}</td>
                  <td className="text-right px-2">{rate(b.alive24h, b.resolved24h)}</td>
                  <td className="text-right px-2 dim">{b.priced24h}</td>
                  <td className={`text-right px-2 ${(b.medianReturn1h ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {b.medianReturn1h === undefined ? <span className="faint">—</span> : pct(b.medianReturn1h)}
                  </td>
                  <td className={`text-right px-2 ${(b.medianReturn24h ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {b.medianReturn24h === undefined ? <span className="faint">—</span> : pct(b.medianReturn24h)}
                  </td>
                  <td className="text-right px-3 dim">{b.aboveWater24h === undefined ? "—" : `${(b.aboveWater24h * 100).toFixed(0)}%`}</td>
                </>
              ) : (
                <>
                  <td className="text-right px-2 faint" colSpan={6} title={`a rate prints at ${LAUNCH_MIN_RESOLVED} resolved launches in this bucket`}>
                    {b.resolved24h} of {LAUNCH_MIN_RESOLVED} resolved — no rate yet
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The launch feed's own scorecard: what its verdicts turned out to be worth.
 * Same discipline as the score's track record above it — forward only,
 * refused below a floor, and the comparison is between buckets over the same
 * period, never against a market that lifts every curve.
 */
function LaunchRecord({ tick }: { tick: number }) {
  const snap = useSyncExternalStore(subscribeLaunchRecord, launchSnapshot, launchSnapshotServer);
  const report = useMemo(
    () => launchReport(snap.obs),
    // `tick` is a deliberate input: elapsed time expires horizons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, tick],
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap pt-2">
        <h2 className="text-[14px] font-semibold tracking-wide">LAUNCH RECORD</h2>
        <span className="text-[10.5px] dim num ml-2">
          {report.total.toLocaleString()} launches seen · {report.settled.toLocaleString()} verdicts settled ·{" "}
          {report.pending.toLocaleString()} awaiting a horizon · {report.expired.toLocaleString()} expired unresolved
          {snap.lookups > 0 && ` · ${snap.lookups} lookups${snap.lookupFailures ? `, ${snap.lookupFailures} failed` : ""}`}
          {snap.lastError && <span className="neg"> · last error: {snap.lastError}</span>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn text-[11px]" onClick={() => clearLaunchRecord()}>
            clear launch record
          </button>
        </div>
      </div>
      <div className="panel p-3">
        <div className="panel-title pb-1.5">VERDICT</div>
        <p className="text-[13px] leading-[1.6]">{report.verdict}</p>
        <div className="text-[10.5px] dim num pt-2 flex gap-4 flex-wrap">
          <span>first launch {ago(report.firstTs)}</span>
          <span>last {ago(report.lastTs)}</span>
          <span>stored in this browser only ({snap.backend})</span>
        </div>
      </div>
      {report.total > 0 && (
        <>
          <BucketTable title="By verdict the feed gave" rows={report.byVerdict} />
          <BucketTable title="By deployer history" rows={report.byDeployer} />
          <BucketTable title="By launchpad" rows={report.byLaunchpad} />
        </>
      )}
    </div>
  );
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
        <PageTitle title="TRACK RECORD" lede="How past calls held up, graded against what happened next" />
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

      {/* The radar grades its own signals; that record comes first because it
          is the one a copier acts on. */}
      <RadarRecord />

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

      <LaunchRecord tick={tick} />

      <Hint id="track" className="px-1 pb-2">
        ✳ marks a band whose lift interval excludes zero. That is a measured separation over{" "}
        <i>this sample and this period</i>, not a guarantee and not evidence it will hold. Horizons are{" "}
        {HORIZONS.map((h) => h.label).join(", ")}; an observation resolves only against a price taken
        inside its window, and expires unresolved if the terminal was closed when that window passed.
        Nothing on this page is advice, and no arrangement of these numbers makes a memecoin a good
        idea.
      </Hint>
    </div>
  );
}
