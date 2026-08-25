"use client";

import { useState } from "react";
import Link from "next/link";
import { useEventStream, fmtUsd, type StreamEvent } from "@/lib/client";

const LOUD_KINDS = new Set(["whale_buy", "whale_sell", "smart_money_buy", "smart_money_sell", "cluster_detected", "signal_created"]);
const MIN_USD = 40_000;

export function EventToasts() {
  const [toasts, setToasts] = useState<StreamEvent[]>([]);

  useEventStream((e) => {
    const loud = LOUD_KINDS.has(e.kind) && ((e.amountUsd ?? 0) >= MIN_USD || e.kind === "signal_created" || e.kind === "cluster_detected");
    if (!loud) return;
    setToasts((ts) => [...ts.slice(-2), e]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== e.id)), 7000);
  });

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 w-[320px] pointer-events-none">
      {toasts.map((t) => (
        <Link
          key={t.id}
          href={t.mint ? `/token?m=${t.mint}` : "/scanner"}
          className="toast panel p-3 pointer-events-auto block hover:border-[var(--accent)]"
        >
          <div className="flex items-center justify-between">
            <span
              className={`text-[10px] tracking-[0.14em] font-semibold ${
                t.kind.includes("sell") ? "neg" : t.kind === "signal_created" ? "text-[var(--accent)]" : "pos"
              }`}
            >
              {t.headline}
            </span>
            {t.amountUsd ? <span className="num text-[12px]">{fmtUsd(t.amountUsd)}</span> : null}
          </div>
          <div className="text-[12px] dim mt-1 leading-snug">{t.detail}</div>
          {t.confidence !== undefined && (
            <div className="text-[10px] faint mt-1 num">confidence {(t.confidence * 100).toFixed(0)}%</div>
          )}
        </Link>
      ))}
    </div>
  );
}
