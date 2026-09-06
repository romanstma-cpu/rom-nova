"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";
import { EventToasts } from "./EventToasts";
import { AlertMonitor } from "./AlertMonitor";
import { RadarArm } from "./RadarArm";
import { dataMode } from "@/lib/providers/registry";
import { APP_VERSION, RELEASES_URL } from "@/lib/version";
import { desktopServerSnapshot, desktopSnapshot, installDesktopUpdate, subscribeDesktop } from "@/lib/desktop";

/**
 * What going offline actually stops, computed from the same resolution the
 * data-mode chip reads.
 *
 * The banner used to say "the live SOL reference is paused. The analytics
 * universe keeps running locally" — the stale blanket claim from when the
 * SOL price was the one live number. Offline also stops the token list, the
 * scanner, the launch feed, wallet reads, rug checks, flow and both sockets:
 * everything /status calls live. Listed from `dataMode()` so this sentence
 * cannot drift away from the providers a second time.
 */
export function offlineMessage(mode: { live: string[]; bounded: string[] }): string {
  const paused = [...mode.live, ...mode.bounded.map((b) => b.split(" — ")[0])];
  if (paused.length === 0) return "You appear to be offline. Nothing here was live, so nothing has changed: the whole terminal is the deterministic simulator.";
  return (
    `You appear to be offline — every live source is paused: ${paused.join(", ")}. ` +
    "The live sockets are down and will reconnect on their own. Anything labelled SIMULATED keeps running locally; " +
    "anything labelled with a vendor's name is frozen at its last reading and its age keeps counting."
  );
}

const DEFAULT_OFFLINE_TEXT = "You appear to be offline.";

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}
const readOffline = () => !navigator.onLine;
const readOfflineServer = () => false;

// The provider set is configuration and does not change for the life of the
// tab, so the sentence is computed once and never re-subscribed.
let offlineTextCached: string | null = null;
function readOfflineText(): string {
  if (offlineTextCached === null) {
    try {
      offlineTextCached = offlineMessage(dataMode());
    } catch {
      offlineTextCached = DEFAULT_OFFLINE_TEXT;
    }
  }
  return offlineTextCached;
}
const readOfflineTextServer = () => DEFAULT_OFFLINE_TEXT;
const subscribeNever = () => () => {};

export function Shell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // The drawer is the only navigation on a phone. Focus moves into it on
  // open (the close button takes it) and back to whatever opened it on
  // close, so a keyboard or screen-reader user is never left on <body>.
  const navOpener = useRef<HTMLElement | null>(null);
  const navDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!navOpen) return;
    const dialog = navDialog.current;
    dialog?.showModal();
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setNavOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      dialog?.close();
    };
  }, [navOpen]);
  const openNav = () => {
    navOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNavOpen(true);
  };
  useEffect(() => {
    if (navOpen || !navOpener.current) return;
    navOpener.current.focus();
    navOpener.current = null;
  }, [navOpen]);
  // Both browser facts through the external-store seam: the prerendered
  // shell says "online" with the default sentence, and the first client
  // paint reads the real answer without a setState-in-effect round trip.
  const offline = useSyncExternalStore(subscribeOnline, readOffline, readOfflineServer);
  const offlineText = useSyncExternalStore(subscribeNever, readOfflineText, readOfflineTextServer);
  // The desktop shell's update state, for the one banner worth interrupting
  // with: a downloaded update, which installs on the next start whether or
  // not the reader restarts now. In a browser this snapshot never changes.
  const desk = useSyncExternalStore(subscribeDesktop, desktopSnapshot, desktopServerSnapshot);
  const [updateLaterFor, setUpdateLaterFor] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const updateVersion = desk.update.version ?? "?";
  const updateReady = desk.update.state === "ready" && updateLaterFor !== updateVersion;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Do not open a second modal behind the native navigation dialog.
      if (navOpen) return;
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
  }, [navOpen]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar onOpenPalette={() => setPaletteOpen(true)} onOpenNav={openNav} />
      {offline && (
        <div className="shrink-0 bg-[rgba(255,180,84,0.12)] border-b border-[rgba(255,180,84,0.3)] text-[var(--warn)] text-[11.5px] text-center py-1">
          {offlineText}
        </div>
      )}
      {updateReady && (
        <div className="shrink-0 bg-[rgba(56,225,255,0.08)] border-b border-[rgba(56,225,255,0.3)] text-[11.5px] px-4 py-1 flex items-center justify-center gap-3 flex-wrap">
          <span>
            <span className="text-[var(--accent)] font-semibold">ROM Nova {updateVersion}</span> is downloaded — it installs the
            next time the app starts.
          </span>
          <button
            type="button"
            className="btn btn-primary text-[10.5px] py-0.5"
            onClick={() => void installDesktopUpdate().then((r) => setInstallError(r.ok ? null : r.error))}
          >
            Restart now
          </button>
          <button type="button" className="btn text-[10.5px] py-0.5" onClick={() => setUpdateLaterFor(updateVersion)}>
            Later
          </button>
          {installError && <span className="warn">{installError}</span>}
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
        <dialog ref={navDialog} aria-label="Navigation" className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 p-0 bg-transparent text-[var(--text)] backdrop:bg-transparent" onCancel={() => setNavOpen(false)} onClick={() => setNavOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
          <div className="absolute left-0 top-0 bottom-0 fade-up" onClick={(e) => e.stopPropagation()}>
            <div className="h-full flex flex-col bg-[#080b12] border-r border-[var(--border)]">
              <div className="flex items-center justify-between px-4 h-[46px] border-b border-[var(--border)]">
                <span className="text-[13px] font-semibold tracking-[0.2em]">
                  ROM<span className="text-[var(--accent)]">NOVA</span>
                </span>
                <button type="button" className="btn text-[11px]" onClick={() => setNavOpen(false)} aria-label="Close navigation" autoFocus>
                  ✕
                </button>
              </div>
              <NavRail onNavigate={() => setNavOpen(false)} />
            </div>
          </div>
        </dialog>
      )}

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <EventToasts />
      {/* The live alert monitor rides the shell so rules keep evaluating on
          whichever page is open — its own coverage story lives on /alerts. */}
      <AlertMonitor />
      {/* Resumes the whale hunter when it was left armed, so it keeps
          hunting on whichever page is open. */}
      <RadarArm />

      <footer className="shrink-0 border-t border-[var(--border)] bg-[rgba(6,9,14,0.9)] px-4 py-1.5 flex items-center gap-3 text-[10px] faint">
        <span className="truncate">
          Analytics and decision support, not investment advice. Live and simulated data are labelled on every screen.
        </span>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener"
          className="num shrink-0 ml-auto hover:text-[var(--text)]"
          title="this build — release notes on GitHub"
        >
          v{APP_VERSION}
        </a>
        <Link href="/legal" className="link shrink-0">
          Disclaimer &amp; privacy
        </Link>
        <a href="https://romapps.xyz" className="link shrink-0" target="_blank" rel="noopener">
          ROM Apps
        </a>
      </footer>
    </div>
  );
}
