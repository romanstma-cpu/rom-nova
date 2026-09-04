"use client";

import { useState } from "react";
import Link from "next/link";
import { useEventStream, fmtUsd, type StreamEvent } from "@/lib/client";

const LOUD_KINDS = new Set([
  "whale_buy",
  "whale_sell",
  "smart_money_buy",
  "smart_money_sell",
  "cluster_detected",
  "signal_created",
  // Socket-derived, and always real: a watched wallet transacting is exactly
  // what the reader armed a rule to hear about. Launch pushes and curve
  // changes are NOT here — thirty to sixty a minute belong in the feed, not
  // floating over every page.
  "wallet_activity",
  // The radar's proven-wallet buys — the one event arming the hunter exists
  // to surface. Its discoveries (radar_whale) stay feed-only for the same
  // reason launches do.
  "radar_signal",
  // The signal wallet selling. A copier who hears the buy and not the sell
  // is holding a bag by design; this is the other half of the same alert.
  "radar_exit",
  // A dormant wallet waking up big, or a chart being painted with wash
  // trades — the two behaviour reads worth interrupting for.
  "radar_behaviour",
]);
const MIN_USD = 40_000;

/**
 * The one label both event surfaces share, read from the one field.
 *
 * `real === true` came from a socket or the live signal path and is credited
 * to its source; anything else is the deterministic simulator. The toasts and
 * the activity feed used to render the SAME payload as SIMULATED on one and
 * an unlabelled "streaming" on the other — one stream wearing two labels.
 */
export function eventBadge(e: Pick<StreamEvent, "real" | "source">): { label: string; cls: string; title: string } {
  if (e.real === true) {
    return {
      label: `LIVE · ${(e.source ?? "live").toUpperCase()}`,
      cls: "chip chip-accent",
      title:
        `Produced by ${e.source ?? "a live source"} from real Solana data. The time shown is when THIS tab received it, ` +
        "on this machine's clock, uncorrected.",
    };
  }
  return {
    label: "SIMULATED",
    cls: "chip",
    title: "This event comes from the deterministic demo universe, not from Solana. The wallets and tokens in it do not exist.",
  };
}

export function EventToasts() {
  const [toasts, setToasts] = useState<StreamEvent[]>([]);

  useEventStream((e) => {
    const loud =
      LOUD_KINDS.has(e.kind) &&
      ((e.amountUsd ?? 0) >= MIN_USD ||
        e.kind === "signal_created" ||
        e.kind === "cluster_detected" ||
        e.kind === "wallet_activity" ||
        e.kind === "radar_signal" ||
        e.kind === "radar_exit" ||
        e.kind === "radar_behaviour");
    if (!loud) return;
    setToasts((ts) => [...ts.slice(-2), e]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== e.id)), 7000);
  });

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 w-[320px] pointer-events-none">
      {toasts.map((t) => {
        const badge = eventBadge(t);
        return (
          <Link
            key={t.id}
            href={t.mint ? `/token?m=${t.mint}` : t.wallet ? `/whale?a=${t.wallet}` : "/scanner"}
            className="toast panel p-3 pointer-events-auto block hover:border-[var(--accent)]"
          >
            {/* The badge is CONDITIONAL now, not deleted. Until the live bus
                existed every event in this stream was synthetic in both build
                modes and the badge was hardcoded; a socket-derived event
                carries `real: true` and is credited to the socket that
                produced it, and everything else is still the simulator. */}
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[10px] tracking-[0.14em] font-semibold truncate ${
                  t.kind.includes("sell") || t.kind === "radar_exit" ? "warn" : t.kind === "signal_created" ? "text-[var(--accent)]" : "pos"
                }`}
              >
                {t.headline}
              </span>
              <span className={`${badge.cls} text-[9px] tracking-[0.1em] shrink-0`} title={badge.title}>
                {badge.label}
              </span>
            </div>
            {t.amountUsd ? <div className="num text-[12px] mt-0.5 dim">{fmtUsd(t.amountUsd)}</div> : null}
            <div className="text-[12px] dim mt-1 leading-snug">{t.detail}</div>
            {t.confidence !== undefined && (
              <div className="text-[10px] faint mt-1 num">confidence {(t.confidence * 100).toFixed(0)}%</div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
