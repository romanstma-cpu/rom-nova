"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi, fmtUsd, fmtPct } from "@/lib/client";
import { AlertBadge } from "./AlertBadge";
import { DataModeChip } from "./DataModeChip";
import type { SolReference } from "@/lib/providers/reference";

// The header carries ONE number: the cross-checked SOL price, marked LIVE.
// It used to also print the meme index, the smart-money flow and the regime
// chip — three simulator numbers, unlabelled, beside a price marked LIVE. The
// dashboard shows those in a tile that says SIMULATED; a header cannot fit the
// label, so it does not show the numbers.
//
// The slot went the same way and for a worse reason: it was never read off the
// chain. `market.slot` is arithmetic — 285,000,000 plus elapsed milliseconds
// over 400 plus a hash of the minute (src/lib/demo/store.ts) — and it sat
// under a pulsing live dot with the tooltip "latest Solana slot this tab has
// seen". A number that moves like a measurement, next to one that is one. No
// keyless source here reports the head slot without a subscription nobody
// asked for, so the header shows no slot at all rather than a plausible one.
export function TopBar({ onOpenPalette, onOpenNav }: { onOpenPalette: () => void; onOpenNav: () => void }) {
  const { data } = useApi<{ reference: SolReference | null }>("/api/market", 8000);
  const ref = data?.reference;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Keep aging the last reading even when requests fail or hang.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ageSeconds = ref && Number.isFinite(ref.fetchedAt)
    ? Math.max(0, Math.floor((now - ref.fetchedAt) / 1000))
    : null;
  // The provider caches for 60 seconds; allow one refresh and its timeout.
  const stale = ageSeconds === null || ageSeconds >= 90;
  const ageLabel = ageSeconds === null ? "age unknown" : `${ageSeconds}s old`;

  return (
    <header className="topbar h-[46px] shrink-0 border-b border-[var(--border)] bg-[rgba(6,9,14,0.9)] flex items-center gap-4 px-4">
      <button className="nav-toggle md:hidden btn px-2 text-[14px]" onClick={onOpenNav} aria-label="Open navigation">
        ☰
      </button>
      <Link href="/" className="flex items-baseline gap-2 mr-2 select-none">
        <span className="text-[15px] font-semibold tracking-[0.22em] text-[var(--text)]">
          ROM<span className="wordmark-nova">NOVA</span>
        </span>
        <span className="brand-descriptor hidden xl:inline text-[9px] tracking-[0.2em] faint">ON-CHAIN INTELLIGENCE</span>
      </Link>

      <div className="hidden md:flex items-center gap-4 num text-[11.5px]">
        {ref ? (
          <span
            title={`${stale ? "stale" : "live"} reference · ${ageLabel} · ${ref.sources.map((s) => `${s.name} $${s.priceUsd.toFixed(2)}`).join(" · ")} · max deviation ${(ref.maxDeviation * 100).toFixed(2)}%`}
          >
            <span className="dim">SOL</span> {fmtUsd(ref.priceUsd)}{" "}
            {ref.change24hPct !== null && (
              <span className={ref.change24hPct >= 0 ? "pos" : "neg"}>{fmtPct(ref.change24hPct)}</span>
            )}
            <span className={`text-[8.5px] align-super ml-0.5 ${stale ? "warn" : "text-[var(--accent)]"}`} title={`Last successful price reading: ${ageLabel}`}>
              {stale ? `STALE · ${ageLabel}` : "LIVE"}
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
          className="command-trigger btn text-[11px]"
          title="Search and commands — press / or ⌘K anywhere"
          aria-label="Search and commands"
        >
          <span aria-hidden="true" className="sm:hidden">⌕</span>
          <span className="dim hidden sm:inline">Search the terminal</span>
          <kbd className="hidden sm:inline-block text-[10px] border border-[var(--border-hi)] rounded px-1 py-px bg-[rgba(20,28,44,0.8)]">/</kbd>
        </button>
      </div>
    </header>
  );
}
