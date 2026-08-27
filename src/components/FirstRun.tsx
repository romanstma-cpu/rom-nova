"use client";

// The first thing a new visitor sees, and only the first time.
//
// Nova is now the front door of romapps.xyz — someone arrives here having
// clicked "Launch it live" with no context at all, and lands on a dashboard of
// unexplained numbers. There was no onboarding of any kind, so the honest
// outcome was: look at it for thirty seconds, understand nothing in
// particular, leave.
//
// This is deliberately not a tour. Three links, one line each, then it is gone
// for good. They are the actual loop the app already supports and never
// pointed at: see the market, read why a call was made, then find out whether
// those calls were right — which is the only reason to come back.

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

export function FirstRun() {
  const seen = useSyncExternalStore(subscribe, hasSeen, seenOnServer);

  if (seen) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Nothing to persist to; the component still hides for this render pass.
    }
    for (const l of listeners) l();
  };

  const steps: { href: string; title: string; body: string }[] = [
    {
      href: "/network",
      title: "See the market move",
      body: "Every token as a sphere, lit by how strong its signal is, with whale money arcing between them.",
    },
    {
      href: "/signals",
      title: "Read why, not just what",
      body: "Each call shows the evidence that produced it and the risks weighed against it — including the ones it refuses to trade.",
    },
    {
      href: "/signals",
      title: "Check whether it was right",
      body: "Past calls are scored against what actually happened next. The engine grades itself, and shows you the marks.",
    },
  ];

  return (
    <section className="panel p-4 border border-[var(--accent)]/30" aria-labelledby="firstrun-h">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 id="firstrun-h" className="text-[13px] font-semibold tracking-wide">
            New here? This is a scoring engine you can argue with.
          </h2>
          <p className="text-[12px] dim mt-1 max-w-[68ch]">
            Everything below runs on a deterministic simulated market, labelled as such on every
            screen — nothing here is a live feed, a recommendation, or a prediction. What is real is
            the reasoning: how the signals are built, what they refuse, and how often they turn out
            to be right.
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
              className="block h-full rounded-md border border-[var(--border)] p-3 hover:border-[var(--accent)] transition-colors"
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
