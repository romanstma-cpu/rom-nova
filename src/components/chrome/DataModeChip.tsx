"use client";

// The chip that says what this terminal is showing you.
//
// It used to be a hardcoded SIMULATED DATA label whose tooltip read "every
// token, wallet and trade in this terminal is a deterministic simulation; the
// SOL reference price is the one live number". True when written, and false
// three times over once the token list became DEX Screener, the mint and freeze
// authorities came from the chain, and whale flow came from SQD.
//
// A blanket claim is wrong in whichever direction it points. Told the whole
// screen is simulated, a reader discounts a real number; shown one real panel,
// they extend that trust to a synthetic one beside it. So this renders from the
// same provider resolution the data itself uses, and the tooltip lists both
// halves by name.
//
// One component for the nav and the top bar, because two copies of a claim
// about honesty is how one of them ends up stale — which is exactly what
// happened to the sentence it replaces.

import Link from "next/link";
import { useApi } from "@/lib/client";

interface DataMode {
  overall: "live" | "mixed" | "demo";
  live: string[];
  simulated: string[];
  /**
   * Real, and narrower than the word LIVE implies.
   *
   * Added when wallet history became real, because "live" would have been the
   * more damaging half-truth: it is live for about forty-eight hours and blind
   * before that, and a reader who sees LIVE next to a PnL figure reads it as
   * the wallet's record rather than as two days of it.
   */
  bounded?: string[];
}

const LABEL: Record<DataMode["overall"], string> = {
  live: "LIVE DATA",
  mixed: "MIXED DATA",
  demo: "SIMULATED DATA",
};

// Amber for anything not fully real. Mixed is the state most in need of a
// second look, so it does not get the calmer colour.
const CLASS: Record<DataMode["overall"], string> = {
  live: "chip-accent",
  mixed: "chip-warn",
  demo: "chip-warn",
};

function tooltip(m: DataMode | null): string {
  if (!m) return "checking which data sources are live…";
  const real = m.live.length ? `Live: ${m.live.join(", ")}.` : "Nothing is live.";
  const bounded = m.bounded?.length ? ` Real but bounded: ${m.bounded.join("; ")}.` : "";
  const sim = m.simulated.length ? ` Simulated: ${m.simulated.join(", ")}.` : "";
  return `${real}${bounded}${sim} Click for details.`;
}

export function DataModeChip({ className = "" }: { className?: string }) {
  const { data } = useApi<{ dataMode?: DataMode }>("/api/status");
  const mode = data?.dataMode ?? null;
  // Until the answer arrives, claim the more cautious thing rather than the
  // more flattering one.
  const overall = mode?.overall ?? "demo";

  return (
    <Link
      href="/status"
      className={`chip ${CLASS[overall]} ${className}`}
      title={tooltip(mode)}
    >
      {LABEL[overall]}
    </Link>
  );
}
