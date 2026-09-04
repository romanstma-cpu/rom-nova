"use client";

// The explanatory paragraph, folded.
//
// Every dense page here earned its paragraph honestly: each sentence was
// written because a blind review found a reader could misread the table
// above it without that sentence. The paragraphs are correct and they are
// also the reason the app reads as a wall of text — a trader who has read
// the launch-feed explainer once does not need it above the feed every day.
//
// So the paragraph stays and the DEFAULT changes: one line, and a "how to
// read this" that opens the rest. What a reader opens stays open on that
// page for them, in this browser, because re-folding it on every visit would
// be its own kind of nagging.
//
// The folded line is a hand-written `summary` when the page gives one. The
// earlier fold clipped the paragraph's first line mid-sentence ("…gets
// tracked; every…"), which read as a rendering bug rather than a fold.

import { useSyncExternalStore } from "react";

const KEY = "whalenova_hints_v1";
const listeners = new Set<() => void>();
let cached: string | null = null;

function read(): string {
  if (cached !== null) return cached;
  try {
    cached = typeof localStorage === "undefined" ? "" : (localStorage.getItem(KEY) ?? "");
  } catch {
    cached = "";
  }
  return cached;
}

function write(next: string): void {
  cached = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private window or quota — the toggle still works for this page load */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const serverSnapshot = () => "";

/** The set of hint ids the reader has opened. A raw string, so the snapshot is stable. */
function openSet(raw: string): Set<string> {
  return new Set(raw.split("|").filter(Boolean));
}

/** Fold every explainer back to its one line — the settings page's reset. */
export function foldAllHints(): void {
  write("");
}

/** How many explainers are open, from a snapshot (the settings row). */
export function openHintCount(raw: string): number {
  return openSet(raw).size;
}

// The store's seam, for a page that shows the state without owning a hint.
export const subscribeHints = subscribe;
export const hintsSnapshot = read;
export const hintsServerSnapshot = serverSnapshot;

export function Hint({
  id,
  summary,
  className = "",
  children,
}: {
  id: string;
  summary?: string;
  className?: string;
  children: React.ReactNode;
}) {
  // The snapshot is the raw stored string — reading localStorage inside the
  // render would desync the prerendered HTML from the browser's first paint
  // (the hydration gotcha this codebase already met once).
  const raw = useSyncExternalStore(subscribe, read, serverSnapshot);
  const open = openSet(raw).has(id);
  const toggle = () => {
    const set = openSet(read());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    write([...set].join("|"));
  };
  return (
    <div className={`hint ${className}`}>
      {open ? <div>{children}</div> : summary ? <div>{summary}</div> : <div className="line-clamp-1">{children}</div>}
      <button
        type="button"
        onClick={toggle}
        className="text-[10.5px] text-[var(--accent)] hover:underline mt-0.5 cursor-pointer"
        aria-expanded={open}
      >
        {open ? "less ▴" : "how to read this ▾"}
      </button>
    </div>
  );
}
