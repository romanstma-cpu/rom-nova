"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { DataModeChip } from "./DataModeChip";

type NavItem = { href: string; label: string; glyph: string; sim?: boolean };

// Two tiers, not four sections. Nineteen links under four headings was a
// directory, and a trader opening the app during a session needs six of them:
// what is launching, what is moving, what the engine rates, who to follow,
// what to be woken for, and home. Everything else is one click further and
// labelled for what it is — the simulated desk sits under SIMULATED, so the
// rail itself says which pages are the deterministic universe.
const PRIMARY: NavItem[] = [
  { href: "/", label: "Dashboard", glyph: "◈" },
  // Above the scanner on purpose. The scanner ranks what is already moving;
  // this is the only page in the app whose data is worthless a minute after
  // it arrives, so it goes where the eye lands first.
  { href: "/launches", label: "Launch Feed", glyph: "⌁" },
  { href: "/scanner", label: "Scanner", glyph: "≋" },
  { href: "/signals", label: "Signals", glyph: "▲" },
  { href: "/whales", label: "Wallets", glyph: "◍" },
  { href: "/alerts", label: "Alerts", glyph: "◬" },
];

const MORE: { title: string; items: NavItem[] }[] = [
  {
    title: "More live",
    items: [
      // Live only when the visitor connects their own Radar worker — the
      // page says so itself; an unconnected radar shows setup, not data.
      { href: "/radar", label: "Whale Radar", glyph: "◎" },
      { href: "/tokens", label: "Token Radar", glyph: "◉" },
      { href: "/screener", label: "Screener", glyph: "☰" },
      { href: "/watchlists", label: "Watchlists", glyph: "☆" },
      // The page that grades the rest. "Is the score any good" is an
      // intelligence question, not a diagnostic one.
      { href: "/track", label: "Track Record", glyph: "⌗" },
    ],
  },
  {
    title: "Simulated",
    items: [
      { href: "/network", label: "3D Network", glyph: "✦", sim: true },
      { href: "/flow", label: "Money Flow", glyph: "⇄", sim: true },
      { href: "/portfolio", label: "Paper Desk", glyph: "▤", sim: true },
      { href: "/backtest", label: "Backtest Lab", glyph: "∿", sim: true },
      { href: "/research", label: "Research", glyph: "✎", sim: true },
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

const MORE_KEY = "whalenova_nav_more_v1";

// The remembered "more" flag, through the external-store seam rather than a
// setState in an effect: the snapshot is the stored string itself, so the
// prerendered rail and the browser's first paint agree (the hydration
// mismatch this codebase already paid for once).
const moreListeners = new Set<() => void>();
let moreCached: string | null = null;
function readMore(): string {
  if (moreCached !== null) return moreCached;
  try {
    moreCached = typeof localStorage === "undefined" ? "" : (localStorage.getItem(MORE_KEY) ?? "");
  } catch {
    moreCached = "";
  }
  return moreCached;
}
function writeMore(v: string): void {
  moreCached = v;
  try {
    localStorage.setItem(MORE_KEY, v);
  } catch {
    /* no storage — still toggles for this page load */
  }
  for (const l of moreListeners) l();
}
function subscribeMore(l: () => void): () => void {
  moreListeners.add(l);
  return () => {
    moreListeners.delete(l);
  };
}
const moreServer = () => "";

export function NavRail({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  // basePath-aware: on the static build pathname includes /nova
  const here = path.replace(/^\/nova/, "") || "/";
  const inMore = MORE.some((sec) => sec.items.some((it) => here.startsWith(it.href)));
  // Opens itself when the current page lives inside it, so a deep link never
  // lands on a rail that hides where you are. Otherwise remembered.
  const more = useSyncExternalStore(subscribeMore, readMore, moreServer) === "1";
  const showMore = more || inMore;
  const toggleMore = () => writeMore(showMore ? "0" : "1");

  const link = (it: NavItem) => {
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
        title={it.sim ? "deterministic simulation — labelled SIMULATED on the page" : undefined}
      >
        <span className="w-4 text-center text-[13px] opacity-80">{it.glyph}</span>
        {it.label}
      </Link>
    );
  };

  return (
    <nav className="w-[172px] shrink-0 h-full border-r border-[var(--border)] bg-[rgba(6,9,14,0.85)] flex flex-col gap-1 py-3 overflow-y-auto md:border-r">
      <div className="px-3 pb-2">{PRIMARY.map(link)}</div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={toggleMore}
          className="panel-title px-2 pb-1.5 pt-2 w-full text-left cursor-pointer hover:text-[var(--text)]"
          aria-expanded={showMore}
        >
          {showMore ? "▾ less" : "▸ more"}
        </button>
        {showMore &&
          MORE.map((sec) => (
            <div key={sec.title} className="pb-1">
              <div className="panel-title px-2 pb-1 pt-1.5 text-[9.5px]">{sec.title}</div>
              {sec.items.map(link)}
            </div>
          ))}
      </div>
      {/* Was a flat "SIMULATED DATA / deterministic universe". Half of this
          terminal is real now, and a rail that keeps insisting otherwise
          teaches a reader to ignore the labels that still matter. */}
      <div className="mt-auto px-5 pb-3 pt-4">
        <DataModeChip />
      </div>
    </nav>
  );
}
