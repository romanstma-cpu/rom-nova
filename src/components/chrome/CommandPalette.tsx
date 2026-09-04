"use client";

// Mounted only while open (the Shell conditionally renders it), so state
// resets by construction and the selection index is clamped during render
// instead of being synced by effects.
//
// The command list is the rail's own list, not a second copy: the old
// hand-written one still offered "Open Research Desk" and "Run Backtest"
// while the three pages traders actually use — Launch Feed, Whale Radar,
// Track Record — were missing from it. Two copies of a menu is how one goes
// stale.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { apiGet, shortAddr } from "@/lib/client";
import { NAV_MORE, NAV_PRIMARY, NAV_SYSTEM } from "./NavRail";
import { hunterServerSnapshot, hunterSnapshot, startHunting, stopHunting, subscribeHunter } from "@/lib/radar/hunter";
import { showIntroAgain } from "@/components/FirstRun";

interface SearchResult {
  tokens: { mint: string; symbol: string; name: string; hue: number }[];
  wallets: { address: string; entity?: string; labels: string[]; smartMoneyScore: number }[];
}

const EMPTY: SearchResult = { tokens: [], wallets: [] };

interface Item {
  key: string;
  title: string;
  sub: string;
  kind: "token" | "wallet" | "page" | "action";
  href?: string;
  run?: () => void;
}

const PAGES: Item[] = [
  ...NAV_PRIMARY.map((it) => ({ key: it.href, title: it.label, sub: it.hint, kind: "page" as const, href: it.href })),
  ...NAV_MORE.flatMap((sec) =>
    sec.items.map((it) => ({
      key: it.href,
      title: it.label,
      sub: it.sim ? `${it.hint} · simulated` : it.hint,
      kind: "page" as const,
      href: it.href,
    })),
  ),
  ...NAV_SYSTEM.map((it) => ({ key: it.href, title: it.label, sub: it.hint, kind: "page" as const, href: it.href })),
  { key: "/legal", title: "Legal", sub: "disclaimer and privacy", kind: "page", href: "/legal" },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const hunter = useSyncExternalStore(subscribeHunter, hunterSnapshot, hunterServerSnapshot);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult>(EMPTY);
  const [selRaw, setSelRaw] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Keep the selection on screen. Twelve rows overflow the 46vh list, and an
  // arrow-key selection that walks below the fold was invisible — the reader
  // pressed Enter on a row they could not see.
  useEffect(() => {
    listRef.current?.querySelector("[data-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [selRaw, results, q]);

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

  const hunting = hunter.phase === "hunting" || hunter.phase === "starting";

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const live = needle ? results : EMPTY;
    const actions: Item[] = [
      hunting
        ? { key: "act:disarm", title: "Disarm the whale radar", sub: "stop hunting; the journal keeps everything", kind: "action", run: () => stopHunting() }
        : {
            key: "act:arm",
            title: "Arm the whale radar",
            sub: "start hunting in this tab, on every page",
            kind: "action",
            href: "/radar",
            run: () => void startHunting(),
          },
      { key: "act:intro", title: "Show the introduction again", sub: "the three-step start, on the dashboard", kind: "action", href: "/", run: showIntroAgain },
    ];
    const matches = (it: Item) => !needle || it.title.toLowerCase().includes(needle) || it.sub.toLowerCase().includes(needle);
    const toks: Item[] = live.tokens.map((t) => ({
      key: t.mint,
      title: `${t.symbol} — ${t.name}`,
      sub: shortAddr(t.mint),
      href: `/token?m=${t.mint}`,
      kind: "token",
    }));
    const ws: Item[] = live.wallets.map((w) => ({
      key: w.address,
      title: w.entity ?? shortAddr(w.address),
      sub: `${w.labels.join(", ")} · SM ${w.smartMoneyScore}`,
      href: `/whale?a=${w.address}`,
      kind: "wallet",
    }));
    // With nothing typed, the list is the app: pages first, then the two
    // things the palette can DO. Typing narrows everything at once.
    const base = needle ? [...toks, ...ws, ...actions.filter(matches), ...PAGES.filter(matches)] : [...PAGES, ...actions];
    return base.slice(0, 14);
  }, [q, results, hunting]);

  const sel = Math.min(selRaw, Math.max(0, items.length - 1));

  const go = (it: Item) => {
    onClose();
    it.run?.();
    if (it.href) router.push(it.href);
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
            // Tab walks the list like ArrowDown so the palette never tabs the
            // focus out of itself onto the page underneath.
            if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
              e.preventDefault();
              setSelRaw(Math.min(items.length - 1, sel + 1));
            }
            if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
              e.preventDefault();
              setSelRaw(Math.max(0, sel - 1));
            }
            if (e.key === "Home" && !q) setSelRaw(0);
            if (e.key === "End" && !q) setSelRaw(Math.max(0, items.length - 1));
            if (e.key === "Enter" && items[sel]) go(items[sel]);
          }}
          placeholder="Search tokens and wallets, or jump to a page…"
          className="w-full bg-transparent px-4 py-3 text-[14px] outline-none border-b border-[var(--border)]"
          aria-label="Search and commands"
        />
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
          {items.map((it, i) => (
            <button
              key={it.key}
              data-selected={i === sel || undefined}
              onMouseEnter={() => setSelRaw(i)}
              onClick={() => go(it)}
              className={`w-full text-left px-4 py-2 flex items-center justify-between gap-3 text-[13px] ${
                i === sel ? "bg-[rgba(56,225,255,0.08)]" : ""
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <span
                  className={`chip ${
                    it.kind === "token" ? "chip-accent" : it.kind === "wallet" ? "chip-pos" : it.kind === "action" ? "chip-warn" : ""
                  }`}
                >
                  {it.kind}
                </span>
                <span className="truncate">{it.title}</span>
              </span>
              <span className="faint text-[11px] num truncate">{it.sub}</span>
            </button>
          ))}
          {items.length === 0 && <div className="px-4 py-6 text-center faint text-[12px]">Nothing matches.</div>}
        </div>
        <div className="flex items-center gap-3 px-4 py-1.5 border-t border-[var(--border)] text-[10px] faint">
          <span>
            <Kbd>↑↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
          <span className="ml-auto">
            <Kbd>/</Kbd> or <Kbd>⌘K</Kbd> from anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block text-[9.5px] border border-[var(--border-hi)] rounded px-1 py-px bg-[rgba(20,28,44,0.8)] num">
      {children}
    </kbd>
  );
}
