"use client";

// Whale activity feed: seeds from /api/events, then prepends SSE arrivals.

import { useState } from "react";
import Link from "next/link";
import { useApi, useEventStream, fmtUsd, fmtAgo, type StreamEvent } from "@/lib/client";

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

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <span className="panel-title">Whale Activity</span>
        <span className="flex items-center gap-1.5 text-[10px] faint">
          <span className={connected ? "live-dot" : "w-1.5 h-1.5 rounded-full bg-[var(--neg)]"} />
          {connected ? "streaming" : "reconnecting"}
        </span>
      </div>
      <div className="overflow-y-auto min-h-0 flex-1">
        {events.map((e) => {
          const style = KIND_STYLE[e.kind] ?? { tag: e.kind.toUpperCase(), cls: "dim" };
          return (
            <Link
              key={e.id}
              href={e.mint ? `/token?m=${e.mint}` : e.wallet ? `/whale?a=${e.wallet}` : "#"}
              className="block px-3 py-2 border-b border-[rgba(27,35,51,0.5)] hover:bg-[rgba(40,55,85,0.15)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] tracking-[0.1em] font-semibold ${style.cls}`}>{style.tag}</span>
                <span className="num text-[10px] faint shrink-0">{fmtAgo(e.ts)}</span>
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
