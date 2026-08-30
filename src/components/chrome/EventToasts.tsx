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
          {/* EVERY event in this stream is synthetic, in both build modes: the
              static build subscribes to `ensureSimulator()` and the server
              route reads the same store. Unlabelled, these floated over the
              launch feed and over real wallet pages asserting things like
              "SMART MONEY SELL $436.1K — bLtU…VFsc sold $436K of BALL,
              confidence 76%" — a dollar figure and a confidence percentage for
              a wallet that does not exist, sitting on top of live Solana data.
              Three surfaces then disagreed about one capability: /status said
              smart-money scoring was SIMULATED, the wallet page said NOT
              COMPUTED, and this asserted a number.
              If a real event source is ever wired in, this badge has to become
              conditional rather than being deleted. */}
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-[10px] tracking-[0.14em] font-semibold truncate ${
                t.kind.includes("sell") ? "neg" : t.kind === "signal_created" ? "text-[var(--accent)]" : "pos"
              }`}
            >
              {t.headline}
            </span>
            <span
              className="chip text-[9px] tracking-[0.1em] shrink-0"
              title="This event comes from the deterministic demo universe, not from Solana. The wallets and tokens in it do not exist."
            >
              SIMULATED
            </span>
          </div>
          {t.amountUsd ? (
            <div className="num text-[12px] mt-0.5 dim">{fmtUsd(t.amountUsd)}</div>
          ) : null}
          <div className="text-[12px] dim mt-1 leading-snug">{t.detail}</div>
          {t.confidence !== undefined && (
            <div className="text-[10px] faint mt-1 num">confidence {(t.confidence * 100).toFixed(0)}%</div>
          )}
        </Link>
      ))}
    </div>
  );
}
