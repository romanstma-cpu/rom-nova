"use client";

import Link from "next/link";
import { useApi, fmtUsd, fmtPct, fmtNum } from "@/lib/client";
import { AlertBadge } from "./AlertBadge";
import { DataModeChip } from "./DataModeChip";
import type { MarketState } from "@/lib/types";

interface SolReference {
  priceUsd: number;
  change24hPct: number | null;
  sources: { name: string; priceUsd: number }[];
  maxDeviation: number;
}

// The header carries only what is real on every screen: the slot and the
// cross-checked SOL price. It used to also print the meme index, the
// smart-money flow and the regime chip — three simulator numbers, unlabelled,
// beside a price marked LIVE. The dashboard shows them in a tile that says
// SIMULATED; a header cannot fit the label, so it does not show the numbers.
export function TopBar({ onOpenPalette, onOpenNav }: { onOpenPalette: () => void; onOpenNav: () => void }) {
  const { data } = useApi<{ market: MarketState; reference: SolReference | null }>("/api/market", 8000);
  const m = data?.market;
  const ref = data?.reference;

  return (
    <header className="topbar h-[46px] shrink-0 border-b border-[var(--border)] bg-[rgba(6,9,14,0.9)] flex items-center gap-4 px-4">
      <button className="md:hidden btn px-2 text-[14px]" onClick={onOpenNav} aria-label="Open navigation">
        ☰
      </button>
      <Link href="/" className="flex items-baseline gap-2 mr-2 select-none">
        <span className="text-[15px] font-semibold tracking-[0.22em] text-[var(--text)]">
          ROM<span className="wordmark-nova">NOVA</span>
        </span>
        <span className="hidden lg:inline text-[9px] tracking-[0.28em] faint">SOLANA ON-CHAIN INTELLIGENCE</span>
      </Link>

      <div className="hidden md:flex items-center gap-4 num text-[11.5px]">
        <span className="flex items-center gap-1.5" title="latest Solana slot this tab has seen">
          <span className="live-dot" />
          <span className="dim">slot</span> {m ? fmtNum(m.slot) : "—"}
        </span>
        {ref ? (
          <span
            title={`live reference · ${ref.sources.map((s) => `${s.name} $${s.priceUsd.toFixed(2)}`).join(" · ")} · max deviation ${(ref.maxDeviation * 100).toFixed(2)}%`}
          >
            <span className="dim">SOL</span> {fmtUsd(ref.priceUsd)}{" "}
            {ref.change24hPct !== null && (
              <span className={ref.change24hPct >= 0 ? "pos" : "neg"}>{fmtPct(ref.change24hPct)}</span>
            )}
            <span className="text-[8.5px] align-super text-[var(--accent)] ml-0.5" title="real price, cross-checked across public APIs">
              LIVE
            </span>
          </span>
        ) : (
          <span title="waiting for the live reference price">
            <span className="dim">SOL</span> —
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <AlertBadge />
        <DataModeChip className="hidden sm:inline-flex" />
        {/* On a 390px screen the full label and its shortcut ran off the right
            edge — the header read "search / c" with the rest clipped, and a
            keyboard hint is meaningless on a phone anyway. Below sm it is the
            glyph alone; the accessible name stays either way. */}
        <button
          onClick={onOpenPalette}
          className="btn text-[11px]"
          title="Search and commands — press / or ⌘K anywhere"
          aria-label="Search and commands"
        >
          <span aria-hidden="true" className="sm:hidden">⌕</span>
          <span className="dim hidden sm:inline">search / go to</span>
          <kbd className="hidden sm:inline-block text-[10px] border border-[var(--border-hi)] rounded px-1 py-px bg-[rgba(20,28,44,0.8)]">⌘K</kbd>
        </button>
      </div>
    </header>
  );
}
