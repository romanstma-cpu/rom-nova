"use client";

// Whale activity feed: seeds from /api/events, then prepends stream arrivals.
//
// Every row wears the badge its `real` field earns — the same badge the
// toasts wear, from the same function — and the panel header says which
// halves are present. This panel used to render the simulator's events under
// "Whale Activity · ● streaming" with no marker, directly above a table of
// real Solana tokens, while the toasts stamped the identical payload
// SIMULATED. One stream, two labels; now one.

import { useState } from "react";
import Link from "next/link";
import { useApi, useEventStream, fmtUsd, fmtAgo, type StreamEvent } from "@/lib/client";
import { eventBadge } from "@/components/chrome/EventToasts";

const KIND_STYLE: Record<string, { tag: string; cls: string }> = {
  whale_buy: { tag: "WHALE BUY", cls: "pos" },
  whale_sell: { tag: "WHALE SELL", cls: "neg" },
  smart_money_buy: { tag: "SMART MONEY BUY", cls: "pos" },
  smart_money_sell: { tag: "SMART MONEY SELL", cls: "neg" },
  new_position: { tag: "NEW POSITION", cls: "text-[var(--accent)]" },
  position_exit: { tag: "POSITION EXIT", cls: "neg" },
  cluster_detected: { tag: "CLUSTER", cls: "warn" },
  liquidity_add: { tag: "LIQUIDITY +", cls: "pos" },
  liquidity_remove: { tag: "LIQUIDITY −", cls: "neg" },
  risk_event: { tag: "RISK", cls: "warn" },
  signal_created: { tag: "SIGNAL", cls: "text-[var(--accent)]" },
  signal_invalidated: { tag: "INVALIDATED", cls: "neg" },
  new_token: { tag: "NEW TOKEN", cls: "dim" },
  // Socket-derived. Each says what was measured (a frame arrived) and no more.
  launch_seen: { tag: "LAUNCH PUSHED", cls: "text-[var(--accent)]" },
  wallet_activity: { tag: "WALLET ACTIVITY", cls: "pos" },
  mint_activity: { tag: "MINT ACTIVITY", cls: "dim" },
  curve_change: { tag: "CURVE CHANGE", cls: "warn" },
};

export function ActivityFeed({ limit = 40, mint }: { limit?: number; mint?: string }) {
  const { data } = useApi<{ events: StreamEvent[] }>(`/api/events?limit=${limit}`);
  const [live, setLive] = useState<StreamEvent[]>([]);
  const connected = useEventStream((e) => {
    if (mint && e.mint !== mint) return;
    setLive((xs) => [e, ...xs].slice(0, limit));
  });

  const seeded = (data?.events ?? []).filter((e) => !mint || e.mint === mint);
  const seen = new Set(live.map((e) => e.id));
  const events = [...live, ...seeded.filter((e) => !seen.has(e.id))].slice(0, limit);
  const realCount = events.filter((e) => e.real === true).length;
  const mix =
    events.length === 0
      ? null
      : realCount === 0
        ? { label: "SIMULATED", cls: "chip", title: "Every row below is the deterministic demo universe. No socket has published a real event into this feed yet." }
        : realCount === events.length
          ? { label: "LIVE", cls: "chip chip-accent", title: "Every row below came from a real source; each names it." }
          : {
              label: `MIXED · ${realCount} live`,
              cls: "chip chip-warn",
              title: `${realCount} of ${events.length} rows came from a real source and are badged LIVE with the socket's name; the rest are the simulator, badged SIMULATED.`,
            };

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <span className="panel-title flex items-center gap-2">
          Whale Activity
          {mix && (
            <span className={`${mix.cls} text-[9px] tracking-[0.1em]`} title={mix.title}>
              {mix.label}
            </span>
          )}
        </span>
        {/* "streaming" describes the SUBSCRIPTION, not the data: in the
            static build it is an in-process bus that is always up. Whether
            any real source is publishing into it is what the badge above
            says, so the dot no longer implies liveness the rows do not have. */}
        <span
          className="flex items-center gap-1.5 text-[10px] faint"
          title={connected ? "Subscribed to the event bus. Whether the rows are real is per row, and in the badge beside the title." : "Not subscribed — reconnecting."}
        >
          <span className={connected ? "live-dot" : "w-1.5 h-1.5 rounded-full bg-[var(--neg)]"} />
          {connected ? "subscribed" : "reconnecting"}
        </span>
      </div>
      <div className="overflow-y-auto min-h-0 flex-1">
        {events.map((e) => {
          const style = KIND_STYLE[e.kind] ?? { tag: e.kind.toUpperCase(), cls: "dim" };
          const badge = eventBadge(e);
          return (
            <Link
              key={e.id}
              href={e.mint ? `/token?m=${e.mint}` : e.wallet ? `/whale?a=${e.wallet}` : "#"}
              className="block px-3 py-2 border-b border-[rgba(27,35,51,0.5)] hover:bg-[rgba(40,55,85,0.15)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] tracking-[0.1em] font-semibold ${style.cls}`}>{style.tag}</span>
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className={`${badge.cls} text-[8.5px] tracking-[0.08em]`} title={badge.title}>
                    {badge.label}
                  </span>
                  <span className="num text-[10px] faint" title={e.real ? "receipt time on this machine's clock" : "simulator clock"}>
                    {fmtAgo(e.ts)}
                  </span>
                </span>
              </div>
              <div className="text-[11.5px] dim leading-snug mt-0.5">{e.detail}</div>
              {e.amountUsd ? (
                <div className="num text-[11px] mt-0.5">
                  {fmtUsd(e.amountUsd)}
                  {e.symbol && <span className="faint"> · {e.symbol}</span>}
                </div>
              ) : null}
            </Link>
          );
        })}
        {events.length === 0 && <div className="px-3 py-6 text-center faint text-[11px]">Waiting for events…</div>}
      </div>
    </div>
  );
}
