"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Hint } from "@/components/ui/Hint";
import Link from "next/link";
import { apiGet, useEventStream, fmtUsd, fmtPct, fmtAge, whaleFlowCell, absent, type StreamEvent } from "@/lib/client";
import { Score, SkeletonRows, TokenMark, Empty } from "@/components/ui/bits";
import { appendPass } from "@/lib/track-store";
import type { TokenRow } from "@/lib/api/rows";

// Full-screen live discovery scanner: rank-ordered rows that re-sort as new
// data lands, with per-row flash on movement and a pinned set that ignores
// re-ranking.
//
// The rows are real Solana tokens now, and that changed what the columns mean.
// A live row is scored on liquidity, trade imbalance, age, chain-read
// authorities and wallet flow — but NOT on price history, because candles cost
// four seconds each and a list cannot afford twelve of them. Those columns are
// unmeasured rather than zero, and rendering a placeholder 0 as "+0.0%" would
// tell a reader the tape was flat when nobody looked.

// `absent` moved to lib/client so the pages that lacked it stop printing
// placeholder zeros; this page keeps calling the shared one.

/** A numeric cell that shows a dash, and why, when its input was not measured. */
function Cell({
  show,
  cls,
  why,
  children,
}: {
  show: boolean;
  cls: string;
  why: string;
  children: React.ReactNode;
}) {
  if (!show) {
    return (
      <td className="text-right px-2 faint" title={why}>
        —
      </td>
    );
  }
  return <td className={`text-right px-2 ${cls}`}>{children}</td>;
}

/**
 * The third-party risk grade, phrased as somebody else's opinion.
 *
 * Rendered in its own column rather than folded into the signal score on
 * purpose. The signal is Nova weighing evidence it can inspect; this is a
 * vendor's judgement, and a reader who cannot tell them apart has been given
 * one number where there are two claims.
 */
function RiskCell({ row }: { row: TokenRow }) {
  if (row.riskScore === undefined) {
    return (
      <td className="text-right px-2 faint" title="no risk provider graded this mint">
        —
      </td>
    );
  }
  // Higher is riskier. Colour is the inverse of every other column here, which
  // is exactly why it carries a label rather than standing on hue alone.
  const cls = row.riskScore >= 40 ? "neg" : row.riskScore >= 15 ? "warn" : "pos";
  const flags = row.riskFlags ?? [];
  const lp =
    row.lpLockedPct === undefined
      ? "LP lock not reported"
      : `LP ${(row.lpLockedPct * 100).toFixed(1)}% locked`;
  return (
    <td
      className={`text-right px-2 ${cls}`}
      title={
        `${row.riskSource ?? "risk"} rates this ${row.riskScore}/100 — higher is riskier.\n${lp}` +
        (flags.length ? `\n\nCritical: ${flags.join("; ")}` : "\nNo critical findings.")
      }
    >
      {row.riskScore}
      {flags.length > 0 ? <span className="neg"> ⚑</span> : ""}
    </td>
  );
}

/**
 * Where it launched and who launched it.
 *
 * A deployer's mint count is the most useful single fact about a memecoin and
 * nothing else on this row carries it. Today's trending list routinely holds a
 * wallet on its first token beside one on its 873rd, and no price column
 * distinguishes them.
 */
function OriginCell({ row }: { row: TokenRow }) {
  const bits: string[] = [];
  if (row.launchpad) bits.push(row.launchpad);
  if (row.devMints !== undefined) {
    bits.push(row.devMints === 1 ? "1st mint" : `${row.devMints} mints`);
  }
  if (bits.length === 0) {
    return (
      <td className="px-2 faint text-[10px]" title="source did not name a launchpad or creator history">
        —
      </td>
    );
  }
  // A serial deployer is worth flagging; a first-timer is not automatically
  // safe, and the tooltip says so rather than letting the absence of a warning
  // read as reassurance.
  const serial = (row.devMints ?? 0) >= 10;
  return (
    <td
      className={`px-2 text-[10px] ${serial ? "warn" : "faint"}`}
      title={
        (row.launchpad ? `Launched on ${row.launchpad}. ` : "") +
        (row.devMints === undefined
          ? "Creator history unknown."
          : `This creator has issued ${row.devMints} mint${row.devMints === 1 ? "" : "s"}` +
            (row.devMigrations !== undefined ? `, ${row.devMigrations} of which reached a pool` : "") +
            ". A serial deployer is a warning; a first-time one is not a guarantee.")
      }
    >
      {bits.join(" · ")}
    </td>
  );
}

export default function ScannerPage() {
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [minLiq, setMinLiq] = useState("0");
  const [rows, setRows] = useState<TokenRow[]>([]);
  // Distinguishes "first payload still in flight" (skeleton) from "loaded and
  // genuinely empty" (message). Rows alone cannot tell the two apart.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const prevRank = useRef<Map<string, number>>(new Map());
  const [flash, setFlash] = useState<Map<string, 1 | -1>>(new Map());
  const [eventsPerMin, setEventsPerMin] = useState(0);
  const eventTimes = useRef<number[]>([]);

  useEventStream((e: StreamEvent) => {
    eventTimes.current.push(e.ts);
    eventTimes.current = eventTimes.current.filter((t) => t > Date.now() - 60_000);
    setEventsPerMin(eventTimes.current.length);
  }, !paused);

  // own polling loop: rank-diff against the previous poll happens after the
  // fetch resolves, so re-sorts flash exactly once per data arrival
  useEffect(() => {
    if (paused) return;
    let dead = false;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const body = await apiGet<{ rows: TokenRow[] }>("/api/tokens?limit=300");
        if (dead || frozen) return;
        const liq = Number(minLiq) || 0;
        const next = body.rows.filter((r) => r.liquidityUsd >= liq);
        const flashes = new Map<string, 1 | -1>();
        next.forEach((r, i) => {
          const prev = prevRank.current.get(r.mint);
          if (prev !== undefined && prev !== i) flashes.set(r.mint, prev > i ? 1 : -1);
        });
        prevRank.current = new Map(next.map((r, i) => [r.mint, i]));
        setRows(next);
        setLoadedOnce(true);
        setFlash(flashes);

        // Keep score of the scoring. Every pass that reaches here is a set of
        // real tokens with real prices, and until now that record was thrown
        // away the instant the next poll replaced it — which is why nothing in
        // this app could say whether a 70 had ever outperformed a 40.
        //
        // Three filters, each guarding a way the ledger could be quietly
        // poisoned: simulator rows would contribute synthetic outcomes,
        // unscored rows have no score to grade, and a zero price makes the
        // forward return meaningless.
        //
        // ONE timestamp for the whole pass, not one per row. The interval
        // machinery groups by it, and a per-row clock reading would scatter a
        // single pass across twelve singleton clusters and hand back a
        // confidence nobody earned.
        const recordable = next.filter((r) => r.source !== "demo" && r.scored && r.priceUsd > 0);
        if (recordable.length > 0) {
          appendPass(
            recordable.map((r) => ({
              mint: r.mint,
              symbol: r.symbol,
              score: r.signalScore,
              confidence: r.confidence,
              priceUsd: r.priceUsd,
              profile: "balanced",
              unmeasuredCount: (r.unmeasured ?? []).length,
            })),
            // The time the PRICE was observed, not the time this render ran.
            // A forward return is measured from when the number was true.
            recordable[0].dataTs || Date.now(),
          );
        }
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          if (!dead) setFlash(new Map());
        }, 900);
      } catch {
        /* transient — next poll retries */
      }
    };
    load();
    const timer = setInterval(load, 8000);
    return () => {
      dead = true;
      clearInterval(timer);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [paused, frozen, minLiq]);

  const ordered = useMemo(() => {
    const pin = rows.filter((r) => pinned.has(r.mint));
    const rest = rows.filter((r) => !pinned.has(r.mint));
    return [...pin, ...rest];
  }, [rows, pinned]);

  return (
    <div className="p-3 flex flex-col gap-2 h-full min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide">LIVE DISCOVERY SCANNER</h1>
        <span className="flex items-center gap-1.5 text-[10.5px] dim num ml-2">
          <span className="live-dot" /> {eventsPerMin} events/min
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-[11px] dim flex items-center gap-1.5">
            min liq $
            <input value={minLiq} onChange={(e) => setMinLiq(e.target.value)} className="input w-[90px]" />
          </label>
          <button className={`btn text-[11px] ${frozen ? "btn-primary" : ""}`} onClick={() => setFrozen((x) => !x)}>
            {frozen ? "ranking frozen" : "freeze ranking"}
          </button>
          <button className={`btn text-[11px] ${paused ? "btn-danger" : ""}`} onClick={() => setPaused((x) => !x)}>
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
        </div>
      </div>

      {/* What this list is, and — more importantly — what it is not. A ranked
          screen invites the reading "these are the good ones", and nothing here
          predicts a return. */}
      {/* This paragraph used to claim the score weighed "chain-read mint &
          freeze authority". It did not — those flags were never fields on the
          feature vector, so the scorer could not read them even in principle.
          They are now, along with the LP lock and the permanent delegate, and
          a token whose authorities are LIVE cannot carry a positive label. */}
      <Hint id="scanner" className="px-1 pb-1">
        Ranked by the signal score, which weighs liquidity, buy/sell imbalance, momentum, holder
        concentration and growth, organic activity, token age, observed wallet flow, and the
        security facts: mint and freeze authority, any permanent delegate, and how much of the
        liquidity pool is locked. <b>A live mint or freeze authority vetoes the verdict outright</b>{" "}
        — no amount of momentum outranks a supply that can be inflated at will.{" "}
        <b>A high score is not a prediction of profit</b> — it means more of
        the evidence this terminal can see points the same way, and{" "}
        <Link href="/track" className="text-[var(--accent)] hover:underline">
          Track Record
        </Link>{" "}
        keeps the running tally of whether that has meant anything. Dashes are inputs nobody measured,
        not zeros: hover one to see why. Confidence falls with every input that is missing, so a 60 at
        low confidence is a thinner claim than a 45 at high. <b>Risk</b> is a third-party grade where
        higher is worse — the inverse of Signal, and somebody else&rsquo;s opinion rather than
        Nova&rsquo;s.
      </Hint>

      <div className="panel overflow-auto flex-1 min-h-0">
        <table className="w-full text-[12px] min-w-[1000px]">
          <thead className="thead sticky top-0 bg-[var(--panel-solid)] z-10">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-8">Pin</th>
              <th className="text-left px-2 font-medium w-10">#</th>
              <th className="text-left px-2 font-medium">Token</th>
              <th className="text-right px-2 font-medium">Price</th>
              <th className="text-right px-2 font-medium">1h</th>
              <th className="text-right px-2 font-medium">24h</th>
              <th className="text-right px-2 font-medium">Vol accel</th>
              {/* NOT "Whale 6h". The window is a ten-minute chain scan, stated
                  per row in the cell's tooltip because a truncated read covers
                  less than it asked for. */}
              <th
                className="text-right px-2 font-medium"
                title="Net movement by wallets that moved $20,000+ of this token, over a short chain scan — ten minutes, not six hours. Hover a cell for the window it actually covered."
              >
                Whale flow
              </th>
              <th className="text-left px-2 font-medium">Buyers</th>
              <th className="text-left px-2 font-medium">Origin</th>
              <th className="text-right px-2 font-medium">Liq</th>
              <th className="text-right px-2 font-medium" title="Third-party risk grade. Higher is riskier — the inverse of the Signal column.">
                Risk
              </th>
              <th className="text-right px-3 font-medium">Signal</th>
            </tr>
          </thead>
          <tbody className="num">
            {/* Cold load takes ~5s of provider work before the first ranked
                pass; shimmer rows at real height instead of a bare panel. */}
            {!loadedOnce && (
              <SkeletonRows
                rows={12}
                widths={[16, 14, "label", 56, 36, 38, 32, 52, 44, 52, 46, 26, 68]}
              />
            )}
            {ordered.map((r, i) => {
              const fl = flash.get(r.mint);
              return (
                <tr
                  key={r.mint}
                  className="trow"
                  style={fl ? { background: fl === 1 ? "rgba(46,230,168,0.10)" : "rgba(255,77,109,0.09)" } : undefined}
                >
                  <td className="px-3 py-[6px]">
                    <button
                      className={`text-[13px] ${pinned.has(r.mint) ? "text-[var(--accent)]" : "faint hover:text-[var(--text)]"}`}
                      onClick={() =>
                        setPinned((p) => {
                          const n = new Set(p);
                          if (n.has(r.mint)) n.delete(r.mint);
                          else n.add(r.mint);
                          return n;
                        })
                      }
                    >
                      {pinned.has(r.mint) ? "★" : "☆"}
                    </button>
                  </td>
                  <td className="px-2 faint">
                    {i + 1}
                    {fl === 1 ? <span className="pos"> ▲</span> : fl === -1 ? <span className="neg"> ▼</span> : ""}
                  </td>
                  <td className="px-2">
                    <Link href={`/token?m=${r.mint}`} className="flex items-center gap-2 hover:text-[var(--accent)]">
                      <TokenMark hue={r.hue} symbol={r.symbol} size={17} />
                      <span style={{ fontFamily: "var(--font-sans)" }}>{r.symbol}</span>
                      <span className="faint text-[10px]">{fmtAge(r.ageHours * 3_600_000)}</span>
                    </Link>
                  </td>
                  <td className="text-right px-2">{fmtUsd(r.priceUsd)}</td>
                  {/* An unmeasured column must not render its placeholder zero.
                      "+0.0%" reads as a flat tape; the truth is that nobody
                      fetched the candles, and a dash says that. */}
                  <Cell show={!absent(r, "momentum")} cls={r.h1 >= 0 ? "pos" : "neg"} why="this row's source published no interval price change, and candles are not fetched for the list">
                    {fmtPct(r.h1)}
                  </Cell>
                  <Cell show={!absent(r, "momentum")} cls={r.h24 >= 0 ? "pos" : "neg"} why="this row's source published no interval price change, and candles are not fetched for the list">
                    {fmtPct(r.h24)}
                  </Cell>
                  <Cell show={!absent(r, "volumeAccel")} cls={r.volumeAccel > 1.6 ? "warn" : "dim"} why="this row's source published no interval price change, and candles are not fetched for the list">
                    {r.volumeAccel.toFixed(1)}×
                  </Cell>
                  {/* The dash's reason comes from the shared helper now. This
                      cell used to say "no wallet-flow source configured" for
                      every dash, while the source was configured, live, and
                      answering for other rows in the same batch. */}
                  <Cell show={!absent(r, "whaleFlow")} cls={whaleFlowCell(r).cls} why={whaleFlowCell(r).title}>
                    <span title={whaleFlowCell(r).title}>{whaleFlowCell(r).text}</span>
                  </Cell>
                  <td className="px-2 text-[10px]">
                    {r.topWallets && r.topWallets.length > 0 ? (
                      <span
                        className="faint"
                        title={r.topWallets
                          .map((w) => `${w.owner}  ${w.usd >= 0 ? "+" : ""}${fmtUsd(w.usd)}`)
                          .join("\n")}
                      >
                        {/* Linked now that a real address leads somewhere. These
                            are addresses SQD watched move a moment ago, and
                            until wallet reads were real, clicking one would have
                            reached the simulator and found nothing. */}
                        <Link
                          href={`/whale?a=${r.topWallets[0].owner}`}
                          className={`hover:underline ${r.topWallets[0].usd >= 0 ? "pos" : "neg"}`}
                        >
                          {r.topWallets[0].owner.slice(0, 4)}…{r.topWallets[0].owner.slice(-3)}
                        </Link>{" "}
                        {r.topWallets.length > 1 && `+${r.topWallets.length - 1}`}
                      </span>
                    ) : (
                      <span className="faint" title="no wallet movement observed in the window">
                        —
                      </span>
                    )}
                  </td>
                  <OriginCell row={r} />
                  <td className="text-right px-2 dim">{fmtUsd(r.liquidityUsd)}</td>
                  <RiskCell row={r} />
                  <td className="text-right px-3"><Score value={r.signalScore} width={46} scored={r.scored !== false} reason={r.unscoredReason} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loadedOnce && ordered.length === 0 && <Empty>No token clears the liquidity floor right now.</Empty>}
      </div>
    </div>
  );
}
