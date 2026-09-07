"use client";

// The first thing a new visitor sees, and only the first time.
//
// Nova is the front door of romapps.xyz — someone arrives here having
// clicked "Launch it live" with no context at all, and lands on a dashboard
// of unexplained numbers. Without this the honest outcome was: look at it
// for thirty seconds, understand nothing in particular, leave.
//
// This is deliberately not a tour. Three links, one line each, then it is
// gone for good — unless the reader asks for it back from Settings. The
// three are the loop the app is actually for now that most of it is live:
// watch launches land, let the radar hunt for the wallets worth following,
// then find out whether any of the calls were right.

import { useSyncExternalStore } from "react";
import Link from "next/link";

const KEY = "romnova_seen_intro_v1";

/**
 * localStorage is state that lives outside React, which is precisely what
 * useSyncExternalStore is for. Reading it in an effect and calling setState
 * works but trips react-hooks/set-state-in-effect, and for good reason: it
 * renders once with the wrong answer and then corrects itself.
 *
 * The server snapshot says "already seen", so the prerendered HTML contains
 * nothing and a returning visitor never sees this flash into existence.
 */
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function hasSeen(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    // Storage blocked (private window, site data off). Treat it as seen —
    // showing this on every single visit is a worse first impression than
    // never showing it at all.
    return true;
  }
}

/** Nothing is prerendered, so the static HTML is identical for everyone. */
const seenOnServer = () => true;

function notify(): void {
  for (const l of listeners) l();
}

/** Bring the introduction back on the dashboard — the settings page's reset. */
export function showIntroAgain(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored, nothing to remove */
  }
  notify();
}

// The store's seam, for the settings page: same subscribe, same snapshots,
// so it never reads storage during render.
export const subscribeIntro = subscribe;
export const introSeenSnapshot = hasSeen;
export const introSeenServer = seenOnServer;

export function FirstRun() {
  const seen = useSyncExternalStore(subscribe, hasSeen, seenOnServer);

  if (seen) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Nothing to persist to; the component still hides for this render pass.
    }
    notify();
  };

  const steps: { href: string; title: string; body: string }[] = [
    {
      href: "/launches",
      title: "Watch launches land",
      body: "New pools, early activity, and the checks behind each launch.",
    },
    {
      href: "/radar",
      title: "Arm the whale radar",
      body: "Discover active wallets and inspect their measured track records.",
    },
    {
      href: "/track",
      title: "Check whether it was right",
      body: "See how past signals held up against what happened next.",
    },
  ];

  return (
    <section className="getting-started" aria-labelledby="firstrun-h">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 id="firstrun-h" className="text-[13px] font-semibold tracking-wide">
            Your first session
          </h2>
          <p className="text-[12px] dim mt-1 max-w-[68ch]">
            Start with a launch, a wallet, or the record. Live and simulated data are labelled throughout.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-[11px] dim hover:text-[var(--text)] shrink-0 px-2 py-1"
          aria-label="Dismiss this introduction"
        >
          Dismiss ✕
        </button>
      </div>

      <ol className="grid gap-2 sm:grid-cols-3 mt-3">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Link
              href={s.href}
              onClick={dismiss}
              className="intro-step block h-full transition-colors"
            >
              <span className="text-[10px] faint">{String(i + 1).padStart(2, "0")}</span>
              <span className="block text-[12.5px] font-semibold mt-0.5">{s.title}</span>
              <span className="block text-[11.5px] dim mt-1 leading-relaxed">{s.body}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
