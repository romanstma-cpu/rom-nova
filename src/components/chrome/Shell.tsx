"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";
import { EventToasts } from "./EventToasts";

export function Shell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      // "/" opens search the way every reference terminal does — but never
      // while the reader is typing in a field, where "/" is just a slash.
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        const typing =
          t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (!typing) {
          e.preventDefault();
          setPaletteOpen(true);
        }
      }
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar onOpenPalette={() => setPaletteOpen(true)} onOpenNav={() => setNavOpen(true)} />
      {offline && (
        <div className="shrink-0 bg-[rgba(255,180,84,0.12)] border-b border-[rgba(255,180,84,0.3)] text-[var(--warn)] text-[11.5px] text-center py-1">
          You appear to be offline — the live SOL reference is paused. The analytics universe keeps running locally.
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        <div className="hidden md:block">
          <NavRail />
        </div>
        <main className="flex-1 min-w-0 overflow-y-auto grid-bg">{children}</main>
      </div>

      {/* mobile drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setNavOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
          <div className="absolute left-0 top-0 bottom-0 fade-up" onClick={(e) => e.stopPropagation()}>
            <div className="h-full flex flex-col bg-[#080b12] border-r border-[var(--border)]">
              <div className="flex items-center justify-between px-4 h-[46px] border-b border-[var(--border)]">
                <span className="text-[13px] font-semibold tracking-[0.2em]">
                  ROM<span className="text-[var(--accent)]">NOVA</span>
                </span>
                <button className="btn text-[11px]" onClick={() => setNavOpen(false)}>
                  ✕
                </button>
              </div>
              <NavRail onNavigate={() => setNavOpen(false)} />
            </div>
          </div>
        </div>
      )}

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <EventToasts />

      <footer className="shrink-0 border-t border-[var(--border)] bg-[rgba(6,9,14,0.9)] px-4 py-1.5 flex items-center gap-3 text-[10px] faint">
        <span className="truncate">
          Analytics &amp; decision support on a mix of live Solana data and clearly-labeled simulation — see the data-source
        chip for which is which — not investment advice, not a prediction engine.
        </span>
        <Link href="/legal" className="link shrink-0 ml-auto">
          Disclaimer &amp; privacy
        </Link>
        <a href="https://romapps.xyz" className="link shrink-0" target="_blank" rel="noopener">
          ROM Apps
        </a>
      </footer>
    </div>
  );
}
