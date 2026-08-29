"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DataModeChip } from "./DataModeChip";

const SECTIONS: { title: string; items: { href: string; label: string; glyph: string }[] }[] = [
  {
    title: "Monitor",
    items: [
      { href: "/", label: "Dashboard", glyph: "◈" },
      { href: "/scanner", label: "Scanner", glyph: "≋" },
      { href: "/network", label: "3D Network", glyph: "✦" },
      { href: "/flow", label: "Money Flow", glyph: "⇄" },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { href: "/signals", label: "Signals", glyph: "▲" },
      { href: "/tokens", label: "Token Radar", glyph: "◉" },
      { href: "/whales", label: "Whales", glyph: "◍" },
      { href: "/screener", label: "Screener", glyph: "☰" },
    ],
  },
  {
    title: "Desk",
    items: [
      { href: "/portfolio", label: "Paper Desk", glyph: "▤" },
      { href: "/backtest", label: "Backtest Lab", glyph: "∿" },
      { href: "/watchlists", label: "Watchlists", glyph: "☆" },
      { href: "/alerts", label: "Alerts", glyph: "◬" },
      { href: "/research", label: "Research", glyph: "✎" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/status", label: "Status", glyph: "◒" },
      { href: "/settings", label: "Settings", glyph: "⚙" },
      { href: "/legal", label: "Legal", glyph: "§" },
    ],
  },
];

export function NavRail({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  // basePath-aware: on the static build pathname includes /nova
  const here = path.replace(/^\/nova/, "") || "/";
  return (
    <nav className="w-[172px] shrink-0 h-full border-r border-[var(--border)] bg-[rgba(6,9,14,0.85)] flex flex-col gap-1 py-3 overflow-y-auto md:border-r">
      {SECTIONS.map((sec) => (
        <div key={sec.title} className="px-3 pb-2">
          <div className="panel-title px-2 pb-1.5 pt-2">{sec.title}</div>
          {sec.items.map((it) => {
            const active = it.href === "/" ? here === "/" : here.startsWith(it.href);
            return (
              <Link
                key={it.href}
                href={it.href}
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded px-2 py-[5px] text-[12.5px] transition-colors ${
                  active
                    ? "bg-[rgba(56,225,255,0.09)] text-[var(--accent)] border border-[rgba(56,225,255,0.25)]"
                    : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(40,55,85,0.25)] border border-transparent"
                }`}
              >
                <span className="w-4 text-center text-[13px] opacity-80">{it.glyph}</span>
                {it.label}
              </Link>
            );
          })}
        </div>
      ))}
      {/* Was a flat "SIMULATED DATA / deterministic universe". Half of this
          terminal is real now, and a rail that keeps insisting otherwise
          teaches a reader to ignore the labels that still matter. */}
      <div className="mt-auto px-5 pb-3 pt-4">
        <DataModeChip />
      </div>
    </nav>
  );
}
