"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { DataModeChip } from "./DataModeChip";

export type NavItem = { href: string; label: string; glyph: string; hint: string; sim?: boolean };

// Two tiers, not four sections. Nineteen links under four headings was a
// directory, and a trader opening the app during a session needs seven of
// them: what is launching, what is moving, what the engine rates, who to
// follow, who the radar found on its own, what to be woken for, and home.
// Everything else is one click further and labelled for what it is — the
// simulated desk sits under SIMULATED, so the rail itself says which pages
// are the deterministic universe.
//
// The label here IS the page title. The rail once said "Wallets" and the
// page said WHALE INTELLIGENCE; a reader learns fast that such a rail cannot
// be trusted to say where a click lands. `hint` is the one-line purpose the
// command palette and the tooltip show.
export const NAV_PRIMARY: NavItem[] = [
  { href: "/", label: "Dashboard", glyph: "◈", hint: "the whole terminal at a glance" },
  // Above the scanner on purpose. The scanner ranks what is already moving;
  // this is the only page in the app whose data is worthless a minute after
  // it arrives, so it goes where the eye lands first.
  { href: "/launches", label: "Launch Feed", glyph: "⌁", hint: "new mints and pools, triaged as they land" },
  { href: "/scanner", label: "Scanner", glyph: "≋", hint: "what is moving now, ranked by evidence" },
  { href: "/signals", label: "Signals", glyph: "▲", hint: "ranked setups with the case for and against" },
  { href: "/whales", label: "Wallets", glyph: "◍", hint: "who is moving size, and any wallet's real record" },
  // The seventh link, earned: "who to follow" answered by the app itself.
  // Armed, it discovers and scores whale wallets autonomously — the one
  // page here that acts instead of ranking.
  { href: "/radar", label: "Whale Radar", glyph: "◎", hint: "finds and scores whale wallets on its own" },
  { href: "/alerts", label: "Alerts", glyph: "◬", hint: "rules this browser evaluates while open" },
];

export const NAV_MORE: { title: string; items: NavItem[] }[] = [
  {
    title: "More live",
    items: [
      // Was "Token Radar" — two radars in one rail, and only one of them hunts.
      { href: "/tokens", label: "Tokens", glyph: "◉", hint: "the trending list with scores, risk and whale flow" },
      { href: "/screener", label: "Screener", glyph: "☰", hint: "filter the token universe and export it" },
      { href: "/watchlists", label: "Watchlists", glyph: "☆", hint: "your lists, kept in this browser" },
      // The page that grades the rest. "Is the score any good" is an
      // intelligence question, not a diagnostic one.
      { href: "/track", label: "Track Record", glyph: "⌗", hint: "how past calls held up" },
    ],
  },
  {
    title: "Simulated",
    items: [
      { href: "/network", label: "3D Network", glyph: "✦", hint: "the simulated universe as a galaxy", sim: true },
      { href: "/flow", label: "Money Flow", glyph: "⇄", hint: "where the simulated wallets' money went", sim: true },
      { href: "/portfolio", label: "Paper Desk", glyph: "▤", hint: "practice trades on simulated fills", sim: true },
      { href: "/backtest", label: "Backtest Lab", glyph: "∿", hint: "replay the engine over history", sim: true },
      { href: "/research", label: "Research", glyph: "✎", hint: "ask a question, get the evidence", sim: true },
    ],
  },
];

// Always visible at the foot of the rail — a settings page hidden behind a
// "more" toggle is a settings page nobody finds.
export const NAV_SYSTEM: NavItem[] = [
  { href: "/status", label: "Status", glyph: "◒", hint: "every source, socket and store this tab uses" },
  // The one page that knows who you are — for the hosted radar, and only
  // for it. Pinned beside Settings so the sign-in is never a hunt.
  { href: "/account", label: "Account", glyph: "◐", hint: "sign in for the hosted radar; your plan" },
  { href: "/settings", label: "Settings", glyph: "⚙", hint: "your keys, this browser's memory, data providers" },
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
  const inMore = NAV_MORE.some((sec) => sec.items.some((it) => here.startsWith(it.href)));
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
        className={`flex items-center gap-2.5 rounded-md px-2 py-[5px] text-[12.5px] transition-[color,background-color,box-shadow,transform] duration-150 ${
          active
            ? "bg-[rgba(56,225,255,0.09)] text-[var(--accent)] border border-[rgba(56,225,255,0.25)] shadow-[inset_2px_0_0_0_var(--accent),0_0_18px_-8px_rgba(56,225,255,0.55)]"
            : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(40,55,85,0.25)] hover:translate-x-[1px] border border-transparent"
        }`}
        title={it.sim ? `${it.hint} — SIMULATED, and labelled so on the page` : it.hint}
        aria-current={active ? "page" : undefined}
      >
        <span className="w-4 text-center text-[13px] opacity-80">{it.glyph}</span>
        {it.label}
      </Link>
    );
  };

  return (
    <nav className="w-[172px] shrink-0 h-full border-r border-[var(--border)] bg-[rgba(6,9,14,0.85)] flex flex-col gap-1 py-3 overflow-y-auto md:border-r">
      <div className="px-3 pb-2">{NAV_PRIMARY.map(link)}</div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={toggleMore}
          className="panel-title px-2 pb-1.5 pt-2 w-full text-left cursor-pointer hover:text-[var(--text)]"
          aria-expanded={showMore}
        >
          {showMore ? "▾ fewer tools" : "▸ more tools"}
        </button>
        {showMore &&
          NAV_MORE.map((sec) => (
            <div key={sec.title} className="pb-1">
              <div className="panel-title px-2 pb-1 pt-1.5 text-[9.5px]">{sec.title}</div>
              {sec.items.map(link)}
            </div>
          ))}
      </div>
      {/* Status and Settings, pinned. The data chip lives in the header from
          `sm` up, so the rail only repeats it on phones, where the header
          has no room for it. */}
      <div className="mt-auto px-3 pt-3 border-t border-[rgba(27,35,51,0.6)] flex flex-col gap-1">
        {NAV_SYSTEM.map(link)}
        <div className="sm:hidden px-2 pt-2 pb-1">
          <DataModeChip />
        </div>
      </div>
    </nav>
  );
}
