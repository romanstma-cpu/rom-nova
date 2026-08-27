"use client";

import { useState } from "react";
import Link from "next/link";
import { apiPost, fmtUsd, fmtPct, fmtAgo } from "@/lib/client";
import { Empty, Stat } from "@/components/ui/bits";
import { LineChart } from "@/components/charts/LineChart";
import type { BacktestResult, StrategyProfileId } from "@/lib/types";

const NUM_FIELDS = [
  ["days", "History days", 10],
  ["minScore", "Min signal score", 70],
  ["minLiquidityUsd", "Min liquidity $", 50000],
  ["maxMarketCapUsd", "Max mcap $", 50000000],
  ["holdHours", "Max hold (h)", 24],
  ["stopLossPct", "Stop loss %", 20],
  ["takeProfitPct", "Take profit %", 40],
  ["positionUsd", "Position $", 500],
  ["maxConcurrent", "Max concurrent", 5],
  ["slippagePct", "Slippage %", 1.5],
  ["feePct", "Fees %", 0.6],
  ["entryDelayMin", "Entry delay (min)", 10],
] as const;

const PROFILES: StrategyProfileId[] = [
  "balanced", "conservative", "aggressive", "early_gem", "smart_money", "momentum", "mean_reversion", "whale_shadow", "high_risk",
];

export default function BacktestPage() {
  const [profile, setProfile] = useState<StrategyProfileId>("balanced");
  const [fields, setFields] = useState<Record<string, number>>(Object.fromEntries(NUM_FIELDS.map(([k, , d]) => [k, d])));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await apiPost<{ result: BacktestResult; error?: string }>("/api/backtests", {
        profile,
        ...fields,
        minConfidence: 0.45,
      });
      if (!res.ok) throw new Error(res.body.error ?? `error ${res.status}`);
      setResult(res.body.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide">BACKTESTING LAB</h1>
        <span className="faint text-[10.5px] max-w-[92ch]">
          signals are recomputed at each historical step from data available at that moment — the
          integrity check fails the run if any entry saw the future. the market itself is generated
          by this program, so a return here measures the engine against a world it made up
        </span>
      </div>

      <div className="panel p-3 flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="panel-title">Strategy</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value as StrategyProfileId)} className="input">
            {PROFILES.map((p) => <option key={p} value={p}>{p.replace("_", " ")}</option>)}
          </select>
        </label>
        {NUM_FIELDS.map(([k, label]) => (
          <label key={k} className="flex flex-col gap-1">
            <span className="panel-title">{label}</span>
            <input
              type="number"
              value={fields[k]}
              onChange={(e) => setFields((f) => ({ ...f, [k]: Number(e.target.value) }))}
              className="input w-[104px]"
            />
          </label>
        ))}
        <button className="btn btn-primary h-[30px]" onClick={run} disabled={running}>
          {running ? "SIMULATING…" : "▶ Run backtest"}
        </button>
      </div>

      {error && <div className="panel px-4 py-2.5 text-[12px] neg">{error}</div>}

      {result && (
        <>
          <div className={`panel px-4 py-2 text-[11.5px] flex items-center gap-3 ${result.integrity.lookaheadChecksPassed ? "" : "border-[var(--neg)]"}`}>
            <span className={`chip ${result.integrity.lookaheadChecksPassed ? "chip-pos" : "chip-neg"}`}>
              {result.integrity.lookaheadChecksPassed ? "ANTI-LOOKAHEAD VERIFIED" : "LOOKAHEAD DETECTED — RESULTS INVALID"}
            </span>
            <span className="dim">{result.integrity.notes.join(" · ")}</span>
            <span className="faint ml-auto num">ran {fmtAgo(result.ranAt)}</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
            <Stat label="Start → End">{fmtUsd(result.startingUsd)} → {fmtUsd(result.endingUsd)}</Stat>
            <Stat label="Total return"><span className={result.totalReturnPct >= 0 ? "pos" : "neg"}>{fmtPct(result.totalReturnPct)}</span></Stat>
            <Stat label="Trades">{result.trades.length}</Stat>
            <Stat label="Win rate">{(result.winRate * 100).toFixed(0)}%</Stat>
            <Stat label="Profit factor">{result.profitFactor >= 99 ? "∞" : result.profitFactor.toFixed(2)}</Stat>
            <Stat label="Max drawdown"><span className="neg">{result.maxDrawdownPct.toFixed(1)}%</span></Stat>
            <Stat label="Sharpe-like">{result.sharpeLike.toFixed(2)}</Stat>
            <Stat label="Avg trade">
              <span className={result.trades.length && result.totalReturnPct >= 0 ? "pos" : "neg"}>
                {result.trades.length ? fmtUsd(result.trades.reduce((s, t) => s + t.pnlUsd, 0) / result.trades.length) : "—"}
              </span>
            </Stat>
          </div>

          {result.attribution.length > 0 && (
            <div className="panel">
              <div className="panel-title px-3 pt-2.5 pb-1">Where the return came from</div>
              <p className="px-3 pb-2 text-[11.5px] dim max-w-[86ch] leading-relaxed">
                Every token here was generated from an archetype chosen before the run — moonshot,
                rug, chopper — and the holder, flow and concentration features the signal engine
                reads were generated from that same archetype. So a good number above is the engine
                recovering a label this program assigned, not evidence that the strategy works on a
                real market. The spread of mean scores across these rows is the honest measure of
                what the engine did.
              </p>
              <table className="w-full text-[11.5px]">
                <thead className="thead">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Archetype</th>
                    <th className="text-right px-2 font-medium">Offered</th>
                    <th className="text-right px-2 font-medium">Mean score</th>
                    <th className="text-right px-2 font-medium">Bought</th>
                    <th className="text-right px-2 font-medium">Won</th>
                    <th className="text-right px-3 font-medium">PnL $</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {result.attribution.map((a) => (
                    <tr key={a.archetype} className="trow">
                      <td className="px-3 py-1" style={{ fontFamily: "var(--font-sans)" }}>
                        {a.archetype}
                      </td>
                      <td className="text-right px-2 faint">{a.candidates.toLocaleString()}</td>
                      <td className="text-right px-2 dim">{a.meanScore.toFixed(1)}</td>
                      <td className="text-right px-2">{a.trades}</td>
                      <td className="text-right px-2 dim">{a.trades > 0 ? a.wins : "—"}</td>
                      <td className={`text-right px-3 ${a.pnlUsd >= 0 ? "pos" : "neg"}`}>
                        {a.trades > 0 ? fmtUsd(a.pnlUsd) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="panel">
            <div className="panel-title px-3 pt-2.5">Equity curve</div>
            <div className="px-2 pb-2">
              <LineChart points={result.equityCurve.map((p) => ({ ts: p.ts, value: p.equity }))} height={240} color="#2ee6a8" />
            </div>
          </div>

          <div className="panel">
            <div className="panel-title px-3 pt-2.5 pb-1">Trades (last {result.trades.length})</div>
            <div className="max-h-[360px] overflow-y-auto">
              <table className="w-full text-[11.5px]">
                <thead className="thead sticky top-0 bg-[var(--panel-solid)]">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Token</th>
                    <th className="text-right px-2 font-medium">Score</th>
                    <th className="text-right px-2 font-medium">Entry</th>
                    <th className="text-right px-2 font-medium">Exit</th>
                    <th className="text-right px-2 font-medium">Reason</th>
                    <th className="text-right px-2 font-medium">PnL $</th>
                    <th className="text-right px-3 font-medium">PnL %</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {[...result.trades].reverse().map((t, i) => (
                    <tr key={i} className="trow">
                      <td className="px-3 py-1">
                        <Link href={`/token?m=${t.mint}`} className="hover:text-[var(--accent)]" style={{ fontFamily: "var(--font-sans)" }}>{t.symbol}</Link>
                      </td>
                      <td className="text-right px-2 dim">{t.signalScore}</td>
                      <td className="text-right px-2 faint">{new Date(t.entryTs).toLocaleString()}</td>
                      <td className="text-right px-2 faint">{new Date(t.exitTs).toLocaleString()}</td>
                      <td className="text-right px-2 dim">{t.exitReason}</td>
                      <td className={`text-right px-2 ${t.pnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(t.pnlUsd)}</td>
                      <td className={`text-right px-3 ${t.pnlPct >= 0 ? "pos" : "neg"}`}>{fmtPct(t.pnlPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {!result && !running && <Empty>Configure a strategy and run it against the synthetic history. Costs, slippage and entry delay are applied; the engine can only see data that existed at each step.</Empty>}
    </div>
  );
}
