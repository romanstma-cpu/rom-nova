// Persistence for the track-record ledger.
//
// localStorage, deliberately. The ledger is a record of what THIS user's copy
// of the terminal saw, and it never leaves the machine — same promise as the
// rest of the static build, which runs entirely in the visitor's browser. It
// survives republishes in the web build and app restarts in the Electron shell,
// where the app:// origin gets its own persistent store.
//
// Every read and write is guarded. Storage throws outright in a handful of real
// situations — private windows with site data blocked, quota exhaustion, an
// embedded webview with third-party storage disabled — and a scanner that
// crashes because it could not write a research note is a worse product than
// one that quietly stops keeping score.

"use client";

import type { Observation } from "./engine/track-record";

const KEY = "rom-nova.track-ledger.v1";

/**
 * How long an observation stays in the ledger.
 *
 * Long enough that the 24h horizon always has room to resolve, short enough
 * that the store cannot grow without bound. Thirty days of continuous scanning
 * at one pass per thirty seconds would be far more than the cap below, so the
 * count limit is what actually binds; the age limit is what keeps a ledger from
 * a year ago being averaged in with this week.
 */
export const MAX_AGE_MS = 30 * 24 * 3_600_000;

/**
 * Hard cap on stored observations.
 *
 * At roughly 120 bytes of JSON each this is about 1.2MB, comfortably inside the
 * usual 5MB origin quota with room for the rest of the app's state.
 */
export const MAX_OBSERVATIONS = 10_000;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Parse and shape-check a stored ledger.
 *
 * Separate from `loadLedger` so a React render can derive from the raw snapshot
 * it was handed rather than reaching into storage itself — see `ledgerRaw`.
 */
export function parseLedger(raw: string | null): Observation[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Shape-check every row. A ledger corrupted by a half-written quota failure
    // would otherwise reach the statistics as NaN and produce a report that
    // looks computed.
    return parsed.filter(
      (o): o is Observation =>
        o &&
        typeof o.mint === "string" &&
        typeof o.ts === "number" &&
        Number.isFinite(o.ts) &&
        typeof o.score === "number" &&
        Number.isFinite(o.score) &&
        typeof o.priceUsd === "number" &&
        Number.isFinite(o.priceUsd),
    );
  } catch {
    return [];
  }
}

export function loadLedger(): Observation[] {
  const s = storage();
  if (!s) return [];
  try {
    return parseLedger(s.getItem(KEY));
  } catch {
    return [];
  }
}

/** Age and size limits, applied in that order so the cap keeps the NEWEST. */
export function prune(ledger: Observation[], now = Date.now()): Observation[] {
  const fresh = ledger.filter((o) => now - o.ts <= MAX_AGE_MS);
  if (fresh.length <= MAX_OBSERVATIONS) return fresh;
  return fresh.sort((a, b) => a.ts - b.ts).slice(fresh.length - MAX_OBSERVATIONS);
}

export function saveLedger(ledger: Observation[]): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(ledger));
  } catch {
    // Most likely the quota. Halving and retrying once keeps the recent history
    // rather than losing the whole ledger to one oversized write.
    try {
      s.setItem(KEY, JSON.stringify(ledger.slice(Math.floor(ledger.length / 2))));
    } catch {
      /* storage is unavailable; scanning continues without a record */
    }
  }
}

/**
 * Shortest gap between two recorded passes.
 *
 * The scanner polls every 8 seconds but its list is cached for 30, so four
 * polls out of five re-render data that was already recorded. Left unguarded
 * that writes the same snapshot four times under four different timestamps —
 * inflating the ledger, and worse, manufacturing "passes" 8 seconds apart with
 * identical prices, which the cluster bootstrap would count as independent
 * trials.
 *
 * Five minutes is chosen from the other end too. At twelve rows a pass this is
 * about 3,500 observations a day, so MAX_OBSERVATIONS holds roughly three days
 * — enough for a 24h horizon to resolve with margin. Recording every poll would
 * exhaust the cap in seven hours and prune away the 24h window before it could
 * ever close.
 */
export const MIN_PASS_INTERVAL_MS = 5 * 60_000;

/**
 * Append one scan pass.
 *
 * Rows from a single pass MUST share one timestamp — the cluster bootstrap
 * groups by it, and a per-row `Date.now()` would scatter one pass across twelve
 * singleton clusters and hand back an interval far too narrow to be true. This
 * is the same class of mistake as reading the wall clock inside a scan loop
 * instead of taking one reading for the pass.
 *
 * Returns the ledger unchanged when the pass is rejected as too soon, so a
 * caller can poll as often as it likes without thinking about any of this.
 */
export function appendPass(rows: Omit<Observation, "ts">[], ts = Date.now()): Observation[] {
  const existing = loadLedger();
  if (rows.length === 0) return existing;
  const newest = existing.reduce((m, o) => Math.max(m, o.ts), 0);
  if (newest > 0 && ts - newest < MIN_PASS_INTERVAL_MS) return existing;
  const next = prune([...existing, ...rows.map((r) => ({ ...r, ts }))], ts);
  saveLedger(next);
  bump();
  return next;
}

export function clearLedger(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
  bump();
}

// ------------------------------------------------- external-store subscription
//
// The ledger is written by the scanner and read by the track-record page, which
// may be a different route in the same tab or a different tab on the same
// origin. That is an external store, so it is exposed as one rather than being
// polled into component state — reading it in an effect and calling setState
// synchronously is the cascading-render pattern React now warns about, and it
// also loses cross-tab writes entirely.

const listeners = new Set<() => void>();
/** null means "not read yet"; the empty string means "read, and empty". */
let cachedRaw: string | null = null;

function readRaw(): string {
  const s = storage();
  if (!s) return "";
  try {
    return s.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function bump(): void {
  cachedRaw = readRaw();
  for (const l of listeners) l();
}

/**
 * The stored ledger as a RAW STRING, cached.
 *
 * A string rather than a version number, because the page must derive its
 * report from the snapshot itself. Deriving it from storage directly during
 * render is a hydration mismatch: the prerendered HTML is built with no
 * localStorage and the browser's first render has one, so the two disagree and
 * React throws #418. Routing the data through the snapshot means hydration uses
 * `ledgerRawServer` and the real value arrives on the re-render after mount,
 * which is exactly what `useSyncExternalStore` exists to arrange.
 *
 * Strings compare by value, so an unchanged ledger returns an identical
 * snapshot and no re-render is triggered. The cache spares a multi-megabyte
 * read on every render.
 */
export function ledgerRaw(): string {
  if (cachedRaw === null) cachedRaw = readRaw();
  return cachedRaw;
}

/** Server/prerender snapshot. The static export has no storage at build time. */
export function ledgerRawServer(): string {
  return "";
}

export function subscribeLedger(onChange: () => void): () => void {
  listeners.add(onChange);
  // `storage` fires only in OTHER tabs of the same origin, which is exactly the
  // case the in-process listener set cannot cover.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) bump();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
