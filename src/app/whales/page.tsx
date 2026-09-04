"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import Link from "next/link";
import { ledgerSnapshot, ledgerSnapshotServer, setRecording, subscribeLedger, WALLET_CAP } from "@/lib/ledger/store";
import { MIN_OBSERVED_DAYS, MIN_ROUND_TRIPS } from "@/lib/ledger/reputation";
import { useRouter } from "next/navigation";
import { useApi, fmtUsd, fmtAgo } from "@/lib/client";
import { Score, Empty } from "@/components/ui/bits";
import { shortAddr } from "@/lib/client";
import { SMART_MONEY_THRESHOLD } from "@/lib/engine/thresholds";
import type { WalletRow } from "@/lib/api/rows";

type Filter = "all" | "smart" | "whales" | "snipers" | "suspect";

/** Solana addresses are base58 and 32 bytes. */
const PLAUSIBLE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The way into the real half of this page.
 *
 * The table below is the demo universe and always has been — "Meridian Desk"
 * and the rest are generated. Rather than dress it up, the entry point to real
 * data sits above it, and the table carries a banner saying what it is.
 */
function TrackAny() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const ok = PLAUSIBLE.test(value.trim());
  return (
    <form
      className="panel px-3 py-2.5 flex items-center gap-2 flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) router.push(`/whale?a=${value.trim()}`);
      }}
    >
      <span className="panel-title shrink-0">TRACK ANY SOLANA WALLET</span>
      <input
        className="flex-1 min-w-[280px] num text-[12px] px-2 py-1.5 rounded bg-transparent border"
        style={{ borderColor: "var(--border)" }}
        placeholder="paste a wallet address — real positions, real fills, real PnL over the last ~48h"
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className={`chip ${ok ? "chip-accent" : ""} cursor-pointer`} disabled={!ok}>
        {ok ? "PROFILE" : "paste an address"}
      </button>
    </form>
  );
}

interface Mover {
  owner: string;
  netUsd: number;
  grossUsd: number;
  tokens: string[];
}

/**
 * Ranked discovery, from data that exists.
 *
 * A PnL leaderboard is not feasible keylessly and this is not one: profiling
 * one wallet costs ~400 RPC requests against a 2,400/minute budget, so ranking
 * any meaningful universe by realized PnL would take days. Ranking by MEASURED
 * FLOW costs nothing extra — the scanner already streams per-token wallet
 * deltas from SQD and caches them — and answers the question a trader actually
 * opens a whale page for: who is moving size right now.
 *
 * It is emphatically not a skill ranking, and the caption says so. The old
 * caption on the simulated table below claimed its scores were "measured from
 * each wallet's trade history", which was true of the generator and false on
 * the screen.
 */
function LiveMovers() {
  const { data, loading } = useApi<{ movers: Mover[]; real: boolean; note: string; source?: string }>(
    "/api/wallets/movers",
    30_000,
  );
  const movers = data?.movers ?? [];
  // The ledger, so each mover can say whether it is being recorded and what
  // the record says so far — and so one press can record the whole list.
  const ledger = useSyncExternalStore(subscribeLedger, ledgerSnapshot, ledgerSnapshotServer);
  const byAddress = new Map(ledger.wallets.map((w) => [w.address, w]));
  const recordingCount = ledger.wallets.filter((w) => w.recording).length;
  const notYet = movers.filter((m) => !byAddress.get(m.owner)?.recording);
  const room = Math.max(0, WALLET_CAP - recordingCount);
  const [lastPress, setLastPress] = useState<string | null>(null);
  const recordAll = () => {
    let on = 0;
    let refused = 0;
    for (const m of notYet) {
      if (setRecording(m.owner, true)) on++;
      else refused++;
    }
    setLastPress(
      refused > 0
        ? `recorded ${on}, ${refused} refused — at the cap of ${WALLET_CAP}; forget a wallet to make room`
        : `recorded ${on} — the monitor reads each on its cadence; first grades need ${MIN_ROUND_TRIPS} closed round trips over ${MIN_OBSERVED_DAYS} observed days`,
    );
  };
  return (
    <div className="panel">
      <div className="panel-title px-3 pt-2.5 pb-1 flex items-baseline gap-2 flex-wrap">
        <span>Moving right now</span>
        {data?.real && <span className="chip chip-accent">REAL · {data.source?.toUpperCase() ?? "SQD"}</span>}
        <span className="faint normal-case">{data?.note}</span>
        {/* Size moved is where to START recording, not a verdict: these are the
            wallets the ledger can turn into reputations fastest, because they
            trade. One press instead of twenty page visits. */}
        {movers.length > 0 && (
          <button
            className={`chip cursor-pointer ml-auto normal-case ${notYet.length > 0 ? "chip-accent" : ""}`}
            disabled={notYet.length === 0 || room === 0}
            onClick={recordAll}
            title={
              room === 0
                ? `the ledger is at its cap of ${WALLET_CAP} recording wallets`
                : `mark every wallet below RECORD: the alert monitor re-reads each on its cadence and the ledger keeps the fills until there is enough history to grade`
            }
          >
            {notYet.length === 0 ? "all recording" : `record all ${notYet.length}${notYet.length > room ? ` (room for ${room})` : ""}`}
          </button>
        )}
      </div>
      {lastPress && <div className="px-3 pb-1 text-[10.5px] dim">{lastPress}</div>}
      <div className="max-h-[320px] overflow-y-auto">
        <table className="w-full text-[12px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Wallet</th>
              <th className="text-right px-2 font-medium">Net moved</th>
              <th className="text-right px-2 font-medium">Gross moved</th>
              <th className="text-left px-3 font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody className="num">
            {movers.map((m) => {
              const rec = byAddress.get(m.owner);
              const rep = rec?.reputation;
              return (
              <tr key={m.owner} className="trow">
                <td className="px-3 py-1.5">
                  <Link href={`/whale?a=${m.owner}`} className="hover:text-[var(--accent)]">
                    {shortAddr(m.owner)}
                  </Link>
                  {rec?.recording && (
                    <span
                      className={`chip ml-2 text-[9.5px] ${rep?.smart ? "chip-accent" : ""}`}
                      title={
                        rep?.verdict === "measured"
                          ? `grade ${rep.grade} · ${rep.score}/100 over ${rep.roundTrips} round trips`
                          : `recording · ${rec.fills} fills · ${rep?.needs.join(", ") ?? "reading"}`
                      }
                    >
                      {rep?.verdict === "measured" ? `${rep.grade}${rep.smart ? " · SMART" : ""}` : "● REC"}
                    </span>
                  )}
                </td>
                <td className={`text-right px-2 ${m.netUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(m.netUsd)}</td>
                <td className="text-right px-2 dim">{fmtUsd(m.grossUsd)}</td>
                <td className="px-3 faint" style={{ fontFamily: "var(--font-sans)" }}>
                  {m.tokens.slice(0, 4).join(", ")}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {movers.length === 0 && (
          <Empty>{loading ? "READING FLOW…" : "No wallet movement measured in the current window."}</Empty>
        )}
      </div>
    </div>
  );
}

export default function WhalesPage() {
  const { data, loading, error } = useApi<{ rows: WalletRow[] }>("/api/wallets", 30_000);
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    switch (filter) {
      case "smart":
        return all.filter((r) => r.smartMoneyScore >= SMART_MONEY_THRESHOLD);
      case "whales":
        return all.filter((r) => r.labels.includes("whale") || r.labels.includes("fund"));
      case "snipers":
        return all.filter((r) => r.labels.includes("sniper") || r.labels.includes("bundler"));
      case "suspect":
        return all.filter((r) => r.labels.includes("insider") || r.labels.includes("bot"));
      default:
        return all;
    }
  }, [data, filter]);

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All tracked" },
    { id: "smart", label: "Smart money" },
    { id: "whales", label: "Whales & funds" },
    { id: "snipers", label: "Snipers & bundlers" },
    { id: "suspect", label: "Insiders & bots" },
  ];

  return (
    <div className="p-3 flex flex-col gap-3">
      <TrackAny />
      <LiveMovers />
      <div className="panel px-4 py-2 text-[11.5px]">
        <span className="chip chip-warn mr-2">SIMULATED LIST</span>
        The roster below is the deterministic demo universe — generated wallets, generated trades, generated
        scores. A ranked leaderboard of real wallets by PnL is not reachable keylessly: profiling one wallet
        costs around 400 RPC requests against a 2,400-per-minute budget, so ranking a meaningful universe would
        take days. The real, measured alternative is above.
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <PageTitle title="WALLETS" lede="Who is moving size right now, and the real record of any wallet you paste" />
        {filters.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={`chip cursor-pointer ${filter === f.id ? "chip-accent" : ""}`}>
            {f.label}
          </button>
        ))}
        {/* This read "smart-money scores are MEASURED from each wallet's trade
            history — not asserted", which was a claim about the generator
            standing directly above generated rows. */}
        <span className="faint text-[10.5px] ml-auto">
          every row below is synthetic — scores are derived from simulated trades, not from Solana
        </span>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-[12px] min-w-[980px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Wallet</th>
              <th className="text-left px-2 font-medium">Labels</th>
              <th className="text-right px-2 font-medium">Smart Money</th>
              <th className="text-right px-2 font-medium">Realized PnL</th>
              <th className="text-right px-2 font-medium">Unrealized</th>
              <th className="text-right px-2 font-medium">ROI</th>
              <th className="text-right px-2 font-medium">Win rate</th>
              <th className="text-right px-2 font-medium">PF</th>
              <th className="text-right px-2 font-medium">Trades</th>
              <th className="text-right px-2 font-medium">Med. hold</th>
              <th className="text-right px-2 font-medium">Open</th>
              <th className="text-right px-3 font-medium">Last active</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((r) => (
              <tr key={r.address} className="trow">
                <td className="px-3 py-2">
                  <Link href={`/whale?a=${r.address}`} className="hover:text-[var(--accent)]">
                    {r.knownEntity ? (
                      <span style={{ fontFamily: "var(--font-sans)" }}>{r.knownEntity}</span>
                    ) : (
                      shortAddr(r.address)
                    )}
                  </Link>
                </td>
                <td className="px-2">
                  <span className="flex gap-1 flex-wrap">
                    {r.labels.slice(0, 3).map((l) => (
                      <span key={l} className={`chip ${l === "smart_trader" ? "chip-accent" : l === "insider" || l === "bot" ? "chip-warn" : ""}`}>
                        {l.replace("_", " ")}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="text-right px-2"><Score value={r.smartMoneyScore} width={46} /></td>
                <td className={`text-right px-2 ${r.realizedPnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.realizedPnlUsd)}</td>
                <td className={`text-right px-2 ${r.unrealizedPnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.unrealizedPnlUsd)}</td>
                <td className={`text-right px-2 ${r.roiPct >= 0 ? "pos" : "neg"}`}>{r.roiPct.toFixed(0)}%</td>
                <td className="text-right px-2 dim">{(r.winRate * 100).toFixed(0)}%</td>
                <td className="text-right px-2 dim">{r.profitFactor >= 99 ? "∞" : r.profitFactor.toFixed(2)}</td>
                <td className="text-right px-2 dim">{r.trades}</td>
                <td className="text-right px-2 dim">{r.medianHoldHours.toFixed(0)}h</td>
                <td className="text-right px-2 dim">{r.openPositions}</td>
                <td className="text-right px-3 faint">{fmtAgo(r.lastActive)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <Empty>{loading ? "PROFILING WALLETS…" : error ? "Wallet data unavailable — retrying automatically." : "No wallets match."}</Empty>
        )}
      </div>
    </div>
  );
}
