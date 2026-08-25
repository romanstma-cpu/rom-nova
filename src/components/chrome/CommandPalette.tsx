"use client";

// Mounted only while open (the Shell conditionally renders it), so state
// resets by construction and the selection index is clamped during render
// instead of being synced by effects.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, shortAddr } from "@/lib/client";

interface SearchResult {
  tokens: { mint: string; symbol: string; name: string; hue: number }[];
  wallets: { address: string; entity?: string; labels: string[]; smartMoneyScore: number }[];
}

const EMPTY: SearchResult = { tokens: [], wallets: [] };

const COMMANDS: { label: string; href: string; hint: string }[] = [
  { label: "Open Dashboard", href: "/", hint: "overview" },
  { label: "Open 3D Network", href: "/network", hint: "visualizer" },
  { label: "Open Live Scanner", href: "/scanner", hint: "live feed" },
  { label: "Open Signal Terminal", href: "/signals", hint: "ranked setups" },
  { label: "Open Screener", href: "/screener", hint: "filters + export" },
  { label: "Run Backtest", href: "/backtest", hint: "historical simulation" },
  { label: "Open Paper Desk", href: "/portfolio", hint: "simulated trading" },
  { label: "Create Alert", href: "/alerts", hint: "rules" },
  { label: "Open Research Desk", href: "/research", hint: "ask questions" },
  { label: "Provider Status", href: "/status", hint: "health" },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult>(EMPTY);
  const [selRaw, setSelRaw] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!q.trim()) return;
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const res = await apiGet<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`);
        if (!dead) setResults(res);
      } catch {
        /* search is best-effort */
      }
    }, 120);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [q]);

  const items = useMemo(() => {
    const live = q.trim() ? results : EMPTY;
    const cmds = COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase())).map((c) => ({
      key: c.href,
      title: c.label,
      sub: c.hint,
      href: c.href,
      kind: "cmd" as const,
    }));
    const toks = live.tokens.map((t) => ({
      key: t.mint,
      title: `${t.symbol} — ${t.name}`,
      sub: shortAddr(t.mint),
      href: `/token?m=${t.mint}`,
      kind: "token" as const,
    }));
    const ws = live.wallets.map((w) => ({
      key: w.address,
      title: w.entity ?? shortAddr(w.address),
      sub: `${w.labels.join(", ")} · SM ${w.smartMoneyScore}`,
      href: `/whale?a=${w.address}`,
      kind: "wallet" as const,
    }));
    return [...toks, ...ws, ...cmds].slice(0, 12);
  }, [q, results]);

  const sel = Math.min(selRaw, Math.max(0, items.length - 1));

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-start justify-center pt-[12vh]" onClick={onClose}>
      <div className="panel w-[560px] max-w-[92vw] overflow-hidden fade-up" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSelRaw(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") setSelRaw(Math.min(items.length - 1, sel + 1));
            if (e.key === "ArrowUp") setSelRaw(Math.max(0, sel - 1));
            if (e.key === "Enter" && items[sel]) go(items[sel].href);
          }}
          placeholder="Search tokens, wallets, or type a command…"
          className="w-full bg-transparent px-4 py-3 text-[14px] outline-none border-b border-[var(--border)]"
        />
        <div className="max-h-[46vh] overflow-y-auto py-1">
          {items.map((it, i) => (
            <button
              key={it.key}
              onMouseEnter={() => setSelRaw(i)}
              onClick={() => go(it.href)}
              className={`w-full text-left px-4 py-2 flex items-center justify-between gap-3 text-[13px] ${
                i === sel ? "bg-[rgba(56,225,255,0.08)]" : ""
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <span className={`chip ${it.kind === "token" ? "chip-accent" : it.kind === "wallet" ? "chip-pos" : ""}`}>
                  {it.kind}
                </span>
                <span className="truncate">{it.title}</span>
              </span>
              <span className="faint text-[11px] num truncate">{it.sub}</span>
            </button>
          ))}
          {items.length === 0 && <div className="px-4 py-6 text-center faint text-[12px]">Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
}
