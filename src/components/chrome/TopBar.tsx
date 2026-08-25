"use client";

import Link from "next/link";
import { useApi, fmtUsd, fmtPct, fmtNum } from "@/lib/client";
import type { MarketState } from "@/lib/types";

const REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  risk_on: { text: "RISK ON", cls: "chip-pos" },
  neutral: { text: "NEUTRAL", cls: "chip" },
  risk_off: { text: "RISK OFF", cls: "chip-neg" },
  meme_mania: { text: "MEME MANIA", cls: "chip-accent" },
  low_liquidity: { text: "LOW LIQ", cls: "chip-warn" },
  high_volatility: { text: "HIGH VOL", cls: "chip-warn" },
  rotation: { text: "ROTATION", cls: "chip" },
  distribution: { text: "DISTRIBUTION", cls: "chip-neg" },
};

interface SolReference {
  priceUsd: number;
  change24hPct: number | null;
  sources: { name: string; priceUsd: number }[];
  maxDeviation: number;
}

export function TopBar({ onOpenPalette, onOpenNav }: { onOpenPalette: () => void; onOpenNav: () => void }) {
  const { data } = useApi<{ market: MarketState; reference: SolReference | null }>("/api/market", 8000);
  const m = data?.market;
  const ref = data?.reference;
  const regime = m ? REGIME_LABEL[m.regime] : undefined;

  return (
    <header className="h-[46px] shrink-0 border-b border-[var(--border)] bg-[rgba(6,9,14,0.9)] flex items-center gap-4 px-4">
      <button className="md:hidden btn px-2 text-[14px]" onClick={onOpenNav} aria-label="Open navigation">
        ☰
      </button>
      <Link href="/" className="flex items-baseline gap-2 mr-2 select-none">
        <span className="text-[15px] font-semibold tracking-[0.22em] text-[var(--text)]">
          ROM<span className="text-[var(--accent)]">NOVA</span>
        </span>
        <span className="hidden lg:inline text-[9px] tracking-[0.28em] faint">SOLANA ON-CHAIN INTELLIGENCE</span>
      </Link>

      <div className="hidden md:flex items-center gap-4 num text-[11.5px]">
        <span className="flex items-center gap-1.5">
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
        <span>
          <span className="dim">meme idx</span> {m ? m.memeMomentumIndex : "—"}
        </span>
        <span>
          <span className="dim">SM flow 24h</span>{" "}
          <span className={m && m.netSmartMoneyFlowUsd >= 0 ? "pos" : "neg"}>{m ? fmtUsd(m.netSmartMoneyFlowUsd) : "—"}</span>
        </span>
        {regime && <span className={regime.cls}>{regime.text}</span>}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <Link
          href="/legal"
          className="chip chip-warn hidden sm:inline-flex"
          title="Every token, wallet and trade in this terminal is a deterministic simulation. The SOL reference price is the one live number. Click for details."
        >
          SIMULATED DATA
        </Link>
        <button onClick={onOpenPalette} className="btn text-[11px]" title="Command palette">
          <span className="dim">search / commands</span>
          <kbd className="text-[10px] border border-[var(--border-hi)] rounded px-1 py-px bg-[rgba(20,28,44,0.8)]">⌘K</kbd>
        </button>
      </div>
    </header>
  );
}
