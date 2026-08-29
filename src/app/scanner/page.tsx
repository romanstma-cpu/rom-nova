"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, useEventStream, fmtUsd, fmtPct, fmtAge, type StreamEvent } from "@/lib/client";
import { Score, TokenMark, Empty } from "@/components/ui/bits";
import type { TokenRow } from "@/lib/api/rows";

// Full-screen live discovery scanner: rank-ordered rows that re-sort as new
// data lands, with per-row flash on movement and a pinned set that ignores
// re-ranking.

export default function ScannerPage() {
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [minLiq, setMinLiq] = useState("0");
  const [rows, setRows] = useState<TokenRow[]>([]);
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
        setFlash(flashes);
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

      <div className="panel overflow-auto flex-1 min-h-0">
        <table className="w-full text-[12px] min-w-[900px]">
          <thead className="thead sticky top-0 bg-[var(--panel-solid)] z-10">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-8">Pin</th>
              <th className="text-left px-2 font-medium w-10">#</th>
              <th className="text-left px-2 font-medium">Token</th>
              <th className="text-right px-2 font-medium">Price</th>
              <th className="text-right px-2 font-medium">1h</th>
              <th className="text-right px-2 font-medium">24h</th>
              <th className="text-right px-2 font-medium">Vol accel</th>
              <th className="text-right px-2 font-medium">Whale 6h</th>
              <th className="text-right px-2 font-medium">Liq</th>
              <th className="text-right px-3 font-medium">Signal</th>
            </tr>
          </thead>
          <tbody className="num">
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
                  <td className={`text-right px-2 ${r.h1 >= 0 ? "pos" : "neg"}`}>{fmtPct(r.h1)}</td>
                  <td className={`text-right px-2 ${r.h24 >= 0 ? "pos" : "neg"}`}>{fmtPct(r.h24)}</td>
                  <td className={`text-right px-2 ${r.volumeAccel > 1.6 ? "warn" : "dim"}`}>{r.volumeAccel.toFixed(1)}×</td>
                  <td className={`text-right px-2 ${r.whaleFlow6hUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(r.whaleFlow6hUsd)}</td>
                  <td className="text-right px-2 dim">{fmtUsd(r.liquidityUsd)}</td>
                  <td className="text-right px-3"><Score value={r.signalScore} width={46} scored={r.scored !== false} reason={r.unscoredReason} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {ordered.length === 0 && <Empty>SCANNING SOLANA…</Empty>}
      </div>
    </div>
  );
}
