"use client";

// The wallet page, which now has two completely different jobs.
//
// It was written for the synthetic universe, where every address is known and
// complete: a smart-money score, a behavioural profile, a funding source, a
// cluster. Paste a real Solana address into that page and it answered "wallet
// not tracked" — honest, and the whole problem. This is a Solana intelligence
// terminal that could not tell you anything about a Solana wallet.
//
// So the page routes. An address the simulator knows renders the synthetic view
// under a SIMULATED banner; anything else is read off the chain. The demo
// lookup goes first because it answers from memory, and because the two address
// spaces are shaped identically — the generator emits 44-character base58 too —
// so there is no way to tell them apart by looking at one.

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet, useApi, fmtUsd, fmtPct, fmtAgo, shortAddr } from "@/lib/client";
import { Score, Stat, Empty } from "@/components/ui/bits";
import { RealWalletProfile } from "@/components/wallet/RealWalletProfile";
import type { WalletInfo, WalletPerformance, WalletProfile, WalletTrade, WalletCluster } from "@/lib/types";

interface WalletDetail {
  info: WalletInfo;
  perf: WalletPerformance;
  positions: {
    mint: string;
    symbol: string;
    tokens: number;
    costBasisUsd: number;
    valueUsd: number;
    pnlUsd: number;
    pnlPct: number;
    openedAt: number;
  }[];
  roundTrips: { mint: string; symbol: string; entryTs: number; exitTs: number; costUsd: number; pnlUsd: number; holdHours: number }[];
  trades: (WalletTrade & { symbol: string })[];
  cluster: WalletCluster | null;
}

export default function WalletPage() {
  return (
    <Suspense fallback={<Empty>PROFILING WALLET…</Empty>}>
      <WalletRouter />
    </Suspense>
  );
}

/** Solana addresses are base58 and 32 bytes. Anything else is a typo. */
const PLAUSIBLE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Rendered with `key={current}` by every caller, so navigating to a new address
 * remounts it and the box picks the new value up from its initial state. An
 * effect syncing prop into state would do the same thing one render later and
 * cascade, which is the pattern React now flags outright.
 */
function AddressBar({ current }: { current: string }) {
  const router = useRouter();
  const [value, setValue] = useState(current);
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
        placeholder="paste a wallet address…"
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className={`chip ${ok ? "chip-accent" : ""} cursor-pointer`} disabled={!ok}>
        {ok ? "PROFILE" : "not a Solana address"}
      </button>
    </form>
  );
}

type Resolution =
  | { state: "loading" }
  | { state: "demo"; data: WalletDetail }
  | { state: "real"; profile: WalletProfile }
  | { state: "none"; reason: string };

function WalletRouter() {
  const address = useSearchParams().get("a") ?? "";
  // Tagged with the address it describes, so "still loading" is derived from a
  // mismatch rather than from a setState fired synchronously inside the effect.
  // Every write below happens after an await, in a promise continuation.
  const [answered, setAnswered] = useState<{ address: string; res: Resolution } | null>(null);

  useEffect(() => {
    if (!address) return;
    let dead = false;
    void (async () => {
      // Simulator first. It answers from memory, and a hit means the address
      // belongs to the demo universe rather than to Solana.
      try {
        const demo = await apiGet<WalletDetail>(`/api/wallets/${address}`);
        if (!dead) setAnswered({ address, res: { state: "demo", data: demo } });
        return;
      } catch {
        // Not a synthetic wallet. Read the chain.
      }
      try {
        const real = await apiGet<{ profile: WalletProfile }>(`/api/wallets/${address}/profile`);
        if (!dead) setAnswered({ address, res: { state: "real", profile: real.profile } });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!dead) setAnswered({ address, res: { state: "none", reason } });
      }
    })();
    return () => {
      dead = true;
    };
  }, [address]);

  const res: Resolution = !address
    ? { state: "none", reason: "Paste a Solana wallet address to profile it." }
    : answered?.address === address
      ? answered.res
      : { state: "loading" };

  const frame = (body: React.ReactNode) => (
    <div className="p-3 flex flex-col gap-3">
      <AddressBar key={address} current={address} />
      {body}
    </div>
  );

  if (res.state === "loading") {
    return frame(<Empty>READING THE CHAIN… signatures, then transactions, then balances.</Empty>);
  }
  if (res.state === "none") {
    return frame(
      <Empty>
        {res.reason}{" "}
        <Link href="/whales" className="link">
          Back to whale intelligence.
        </Link>
      </Empty>,
    );
  }
  if (res.state === "real") return frame(<RealWalletProfile p={res.profile} />);
  return <DemoWallet address={address} initial={res.data} />;
}

function DemoWallet({ address, initial }: { address: string; initial: WalletDetail }) {
  // Starts from the copy the router already fetched, so the synthetic view does
  // not flash empty on the way in, and keeps polling from there.
  const { data } = useApi<WalletDetail>(`/api/wallets/${address}`, 20_000);
  const detail = data ?? initial;
  const { info, perf } = detail;
  const sm = info.smartMoney;

  return (
    <div className="p-3 flex flex-col gap-3">
      <AddressBar key={address} current={address} />
      <div className="panel px-4 py-2 text-[11.5px]">
        <span className="chip chip-warn mr-2">SIMULATED WALLET</span>
        This address belongs to the deterministic demo universe — its trades, score and behavioural profile
        were generated, not observed. Paste a real Solana address above to read one off the chain.
      </div>
      <div className="panel px-4 py-3 flex items-center gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[16px] font-semibold">{info.knownEntity ?? shortAddr(info.address)}</span>
            {info.labels.map((l) => (
              <span key={l} className={`chip ${l === "smart_trader" ? "chip-accent" : ""}`}>{l.replace("_", " ")}</span>
            ))}
            {detail.cluster && (
              <span className="chip chip-warn" title={detail.cluster.evidence.join(" · ")}>
                COORDINATED: {detail.cluster.name}
              </span>
            )}
          </div>
          <button className="num text-[10.5px] faint hover:text-[var(--accent)] mt-1" onClick={() => navigator.clipboard?.writeText(info.address)}>
            {info.address} ⧉
          </button>
          <div className="text-[10.5px] faint num mt-0.5">
            first seen {fmtAgo(info.firstSeen)} · last active {fmtAgo(info.lastActive)} · funding: {info.fundingSource ?? "unknown"} · {info.solBalance.toFixed(0)} SOL
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="panel-title">Smart money score (measured)</div>
          <div className="flex items-center gap-2 justify-end mt-1">
            <span className="num text-[22px]" style={{ color: sm.total >= 65 ? "var(--pos)" : "var(--text-dim)" }}>{sm.total}</span>
            <span className="faint text-[11px]">/100</span>
          </div>
        </div>
      </div>

      {/* score breakdown + perf */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        {(
          [
            ["Performance", sm.performance],
            ["Timing", sm.timing],
            ["Consistency", sm.consistency],
            ["Risk Mgmt", sm.riskManagement],
            ["Diversification", sm.diversification],
            ["Data Confidence", sm.dataConfidence],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="panel px-3 py-2">
            <div className="panel-title">{label}</div>
            <div className="mt-1"><Score value={v} width={70} /></div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <Stat label="Realized PnL"><span className={perf.realizedPnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(perf.realizedPnlUsd)}</span></Stat>
        <Stat label="Unrealized"><span className={perf.unrealizedPnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(perf.unrealizedPnlUsd)}</span></Stat>
        <Stat label="ROI"><span className={perf.roiPct >= 0 ? "pos" : "neg"}>{perf.roiPct.toFixed(0)}%</span></Stat>
        <Stat label="Win rate">{(perf.winRate * 100).toFixed(0)}%</Stat>
        <Stat label="Profit factor">{perf.profitFactor >= 99 ? "∞" : perf.profitFactor.toFixed(2)}</Stat>
        <Stat label="Max drawdown"><span className="neg">{perf.maxDrawdownPct.toFixed(0)}%</span></Stat>
        <Stat label="Median hold">{perf.medianHoldHours.toFixed(0)}h</Stat>
        <Stat label="Round trips">{perf.trades}</Stat>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* open positions */}
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Open positions</div>
          <table className="w-full text-[12px]">
            <thead className="thead">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Token</th>
                <th className="text-right px-2 font-medium">Value</th>
                <th className="text-right px-2 font-medium">Cost</th>
                <th className="text-right px-2 font-medium">PnL</th>
                <th className="text-right px-3 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody className="num">
              {detail.positions.sort((a, b) => b.valueUsd - a.valueUsd).map((p) => (
                <tr key={p.mint} className="trow">
                  <td className="px-3 py-1.5">
                    <Link href={`/token?m=${p.mint}`} className="hover:text-[var(--accent)]" style={{ fontFamily: "var(--font-sans)" }}>{p.symbol}</Link>
                  </td>
                  <td className="text-right px-2">{fmtUsd(p.valueUsd)}</td>
                  <td className="text-right px-2 dim">{fmtUsd(p.costBasisUsd)}</td>
                  <td className={`text-right px-2 ${p.pnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(p.pnlUsd)} ({fmtPct(p.pnlPct, 0)})</td>
                  <td className="text-right px-3 faint">{fmtAgo(p.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.positions.length === 0 && <Empty>Flat — no open positions.</Empty>}
        </div>

        {/* closed round trips */}
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Closed round trips</div>
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <tbody className="num">
                {detail.roundTrips.map((r, i) => (
                  <tr key={i} className="trow">
                    <td className="px-3 py-1.5">
                      <Link href={`/token?m=${r.mint}`} className="hover:text-[var(--accent)]" style={{ fontFamily: "var(--font-sans)" }}>{r.symbol}</Link>
                    </td>
                    <td className="text-right px-2 dim">{fmtUsd(r.costUsd)} in</td>
                    <td className={`text-right px-2 ${r.pnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.pnlUsd)}</td>
                    <td className="text-right px-2 dim">{r.holdHours.toFixed(0)}h held</td>
                    <td className="text-right px-3 faint">{fmtAgo(r.exitTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.roundTrips.length === 0 && <Empty>No completed trades yet.</Empty>}
          </div>
        </div>
      </div>

      {/* behavior + trade log */}
      <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr] gap-3">
        <div className="panel p-3.5">
          <div className="panel-title mb-2">Behavioral profile</div>
          {(
            [
              ["Early-entry tendency", info.behavior.earlyBird],
              ["Momentum chasing", info.behavior.momentumBias],
              ["Small-cap preference", info.behavior.smallCapPreference],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="mb-2">
              <div className="flex justify-between text-[11.5px]"><span className="dim">{label}</span><span className="num">{(v * 100).toFixed(0)}%</span></div>
              <div className="scorebar mt-1"><div style={{ width: `${v * 100}%`, background: "var(--accent-2)" }} /></div>
            </div>
          ))}
          <div className="text-[11.5px] dim space-y-1 mt-3 num">
            <div className="flex justify-between"><span className="faint">typical entry mcap</span><span>{fmtUsd(info.behavior.typicalEntryMcap)}</span></div>
            <div className="flex justify-between"><span className="faint">typical exit multiple</span><span>{info.behavior.typicalExitMultiple.toFixed(1)}×</span></div>
            <div className="flex justify-between"><span className="faint">preferred DEX</span><span>{info.behavior.preferredDex}</span></div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Trade log</div>
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <tbody className="num">
                {detail.trades.map((t) => (
                  <tr key={t.id} className="trow">
                    <td className="px-3 py-1 faint">{new Date(t.ts).toLocaleString()}</td>
                    <td className={`px-2 ${t.side === "buy" ? "pos" : "neg"}`}>{t.side.toUpperCase()}</td>
                    <td className="px-2">
                      <Link href={`/token?m=${t.mint}`} className="hover:text-[var(--accent)]">{t.symbol}</Link>
                    </td>
                    <td className="px-2">{fmtUsd(t.amountUsd)}</td>
                    <td className="px-2 faint">{t.dex}</td>
                    <td className="px-2 faint">{t.classification}</td>
                    <td className="px-2 faint text-right" title={t.signature}>{t.signature.slice(0, 8)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
