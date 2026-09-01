"use client";

// Persistence for live alert rules, fired events, and per-rule evaluation
// state.
//
// localStorage, same promise as the track ledger: this is a record of what
// THIS visitor's copy of the terminal watched and it never leaves the
// machine. Every read and write is guarded — storage throws in private
// windows with site data blocked and on quota exhaustion, and an alert system
// that crashes because it could not save a watermark is worse than one that
// keeps monitoring without a record.
//
// Evaluation STATE persists alongside the rules on purpose: `lastEvaluatedAt`
// surviving a reload is what lets the page say "last evaluated two hours ago,
// before this session" instead of forgetting the gap ever happened. The gap
// is the honest part.

import type { LiveAlertEvent, LiveAlertRule, RuleEvalState } from "./rules";

const KEY = "rom-nova.live-alerts.v1";

export const MAX_RULES = 60;
export const MAX_EVENTS = 200;

export interface AlertSettings {
  /**
   * Keep evaluating while the tab is hidden. Off by default: the rest of the
   * app deliberately stops polling in background tabs, and turning that back
   * on is a choice the user makes knowingly — the toggle's label says what it
   * costs and that the browser throttles it to roughly a pass a minute.
   */
  backgroundWatch: boolean;
}

export interface AlertsBlob {
  rules: LiveAlertRule[];
  events: LiveAlertEvent[];
  states: Record<string, RuleEvalState>;
  settings: AlertSettings;
  /**
   * How many events have been evicted, per rule id.
   *
   * The inbox calls itself "the record" in two places, and a record that
   * quietly deletes its own contents is worse than one that admits a limit.
   * The first review watched an externally-verified SOL price-crossing alert
   * disappear inside ten minutes, evicted by launch spam, while the page went
   * on calling itself the record — so eviction now leaves a countable scar the
   * UI is obliged to print.
   */
  dropped: Record<string, number>;
  /**
   * Dedupe keys shed under storage pressure, cumulative.
   *
   * Not cosmetic: a shed key is an already-alerted row that CAN alert again,
   * so this is the one number that tells a reader a duplicate they are looking
   * at was permitted rather than a bug. Zero and absent mean the same thing.
   */
  keysShed?: number;
}

const EMPTY: AlertsBlob = { rules: [], events: [], states: {}, settings: { backgroundWatch: false }, dropped: {} };

/**
 * Dedupe keys kept per rule when storage forces a shed.
 *
 * Enough to cover a few passes of the launch feed, so the rows most likely to
 * still be listed keep their keys; far below SEEN_CAP, because the point is to
 * free space.
 */
const KEY_FLOOR = 100;

/**
 * Trim the inbox to MAX_EVENTS by taking from whichever rule is hogging it.
 *
 * Oldest-first across the whole inbox — the obvious policy, and the one that
 * shipped — makes every rule's history hostage to the noisiest rule on the
 * page. A launch rule on a busy afternoon emits an event every few seconds and
 * will churn 200 slots in about four minutes, so a price-crossing alert that
 * fires once a day is guaranteed to be gone before its owner looks at it. The
 * rules are not interchangeable and their events are not fungible.
 *
 * So the victim is chosen by CENSUS, not by age: the rule with the most events
 * in the inbox loses its oldest one, repeatedly, until the inbox fits. A rule
 * holding a single precious alert can only be evicted once every other rule
 * has been cut down to that same depth, which is the fairest reading of "the
 * record" that a bounded store allows.
 */
export function boundEvents(
  events: LiveAlertEvent[],
  dropped: Record<string, number>,
  cap = MAX_EVENTS,
): { events: LiveAlertEvent[]; dropped: Record<string, number> } {
  if (events.length <= cap) return { events, dropped };
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.ruleId, (counts.get(e.ruleId) ?? 0) + 1);
  const nextDropped = { ...dropped };
  const doomed = new Set<LiveAlertEvent>();

  while (events.length - doomed.size > cap) {
    let fattestRule = "";
    let fattestCount = -1;
    for (const [ruleId, n] of counts) {
      if (n > fattestCount) {
        fattestCount = n;
        fattestRule = ruleId;
      }
    }
    // Newest first in this array, so the last surviving entry for that rule is
    // its oldest — the one a reader is least likely to be waiting on.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.ruleId === fattestRule && !doomed.has(e)) {
        doomed.add(e);
        break;
      }
    }
    counts.set(fattestRule, fattestCount - 1);
    nextDropped[fattestRule] = (nextDropped[fattestRule] ?? 0) + 1;
  }

  return { events: events.filter((e) => !doomed.has(e)), dropped: nextDropped };
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Parse and shape-check a stored blob. Exported so the page can derive its
 * view from the raw snapshot `useSyncExternalStore` hands it — reading
 * storage during render is the hydration mismatch track-store already
 * documents.
 */
export function parseAlerts(raw: string | null): AlertsBlob {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.filter(
          (r: LiveAlertRule) =>
            r &&
            typeof r.id === "string" &&
            typeof r.name === "string" &&
            r.condition &&
            typeof r.condition.kind === "string" &&
            typeof r.enabled === "boolean" &&
            typeof r.createdAt === "number",
        )
      : [];
    const events = Array.isArray(parsed.events)
      ? parsed.events.filter(
          (e: LiveAlertEvent) =>
            e &&
            typeof e.id === "string" &&
            typeof e.ruleId === "string" &&
            typeof e.firedAt === "number" &&
            Number.isFinite(e.firedAt) &&
            typeof e.measurement === "string",
        )
      : [];
    const states =
      parsed.states && typeof parsed.states === "object" ? (parsed.states as Record<string, RuleEvalState>) : {};
    const settings: AlertSettings = {
      backgroundWatch: parsed.settings?.backgroundWatch === true,
    };
    const dropped: Record<string, number> = {};
    if (parsed.dropped && typeof parsed.dropped === "object") {
      for (const [k, v] of Object.entries(parsed.dropped)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) dropped[k] = v;
      }
    }
    const keysShed =
      typeof parsed.keysShed === "number" && Number.isFinite(parsed.keysShed) && parsed.keysShed > 0
        ? parsed.keysShed
        : undefined;
    return { rules, events, states, settings, dropped, keysShed };
  } catch {
    return EMPTY;
  }
}

export function loadAlerts(): AlertsBlob {
  const s = storage();
  if (!s) return EMPTY;
  try {
    return parseAlerts(s.getItem(KEY));
  } catch {
    return EMPTY;
  }
}

function save(blob: AlertsBlob): void {
  const s = storage();
  if (!s) return;
  // Quota-aware rather than oldest-first, and the count of what was taken
  // travels with it so the inbox can print its own scar.
  const trimmed = boundEvents(blob.events, blob.dropped ?? {});
  const bounded: AlertsBlob = {
    ...blob,
    rules: blob.rules.slice(0, MAX_RULES),
    events: trimmed.events,
    dropped: trimmed.dropped,
  };
  try {
    s.setItem(KEY, JSON.stringify(bounded));
  } catch {
    // Most likely the storage quota rather than our own cap. Halving the
    // events keeps the rules and watermarks, which are what monitoring
    // actually needs to go on. Counted like any other eviction — a write that
    // fails silently is the same lie as a cap that hides.
    const half = Math.floor(bounded.events.length / 2);
    const cut = bounded.events.slice(0, half);
    const dropped = { ...bounded.dropped };
    for (const e of bounded.events.slice(half)) dropped[e.ruleId] = (dropped[e.ruleId] ?? 0) + 1;
    try {
      s.setItem(KEY, JSON.stringify({ ...bounded, events: cut, dropped }));
    } catch {
      // Events were never the bulk: dedupe keys are, at ~53 bytes each and up
      // to a thousand per launch rule — megabytes against the events' hundred
      // kilobytes. So the last resort sheds THOSE, keeping each rule's newest
      // keys (the rows still in the feed, which are the ones that would
      // re-fire). Giving up here instead would persist nothing at all, and a
      // dedupe set that stops persisting is the duplicate storm returning.
      //
      // Counted and said out loud, like the events beside it: shedding keys
      // means some already-alerted row can alert again, which is a promise
      // being broken quietly unless the page can see that it happened.
      const states: typeof bounded.states = {};
      let shed = 0;
      for (const [id, st] of Object.entries(bounded.states)) {
        if (st.seenKeys && st.seenKeys.length > KEY_FLOOR) {
          shed += st.seenKeys.length - KEY_FLOOR;
          states[id] = { ...st, seenKeys: st.seenKeys.slice(-KEY_FLOOR) };
        } else {
          states[id] = st;
        }
      }
      try {
        s.setItem(
          KEY,
          JSON.stringify({ ...bounded, events: cut, dropped, states, keysShed: (bounded.keysShed ?? 0) + shed }),
        );
      } catch {
        /* storage unavailable — monitoring continues without a saved record */
      }
    }
  }
  bump();
}

// --------------------------------------------------------------- mutations
//
// Every mutation is load → change → save, because the monitor and the page
// write concurrently within one tab (the leader lease in the monitor keeps
// OTHER tabs from writing evaluation state at the same time).

let seq = 0;
export function nextAlertId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addRule(rule: LiveAlertRule): void {
  const blob = loadAlerts();
  save({ ...blob, rules: [rule, ...blob.rules] });
}

export function patchRule(id: string, patch: Partial<Pick<LiveAlertRule, "enabled" | "notify" | "name">>): void {
  const blob = loadAlerts();
  save({ ...blob, rules: blob.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
}

export function deleteRule(id: string): void {
  const blob = loadAlerts();
  const states = { ...blob.states };
  delete states[id];
  save({ ...blob, rules: blob.rules.filter((r) => r.id !== id), states });
}

export function markAllRead(): void {
  const blob = loadAlerts();
  save({ ...blob, events: blob.events.map((e) => (e.read ? e : { ...e, read: true })) });
}

export function clearEvents(): void {
  const blob = loadAlerts();
  // The drop counters go with them. They exist to explain a hole in the
  // record, and a record the reader deliberately emptied has no hole to
  // explain — leaving them would report the user's own click as data loss.
  save({ ...blob, events: [], dropped: {} });
}

export function setBackgroundWatch(on: boolean): void {
  const blob = loadAlerts();
  save({ ...blob, settings: { ...blob.settings, backgroundWatch: on } });
}

/**
 * One evaluation pass's output, applied atomically: updated per-rule states
 * plus any events that fired. Newest events first, same convention as the
 * demo store.
 */
export function applyEvaluation(states: Record<string, RuleEvalState>, fired: LiveAlertEvent[]): void {
  const blob = loadAlerts();
  // No slice here: `save` bounds the inbox by rule census so one noisy rule
  // cannot evict another's history. Truncating to the cap first would throw
  // away the very events that policy exists to protect.
  save({
    ...blob,
    states: { ...blob.states, ...states },
    events: [...fired, ...blob.events],
  });
}

// ------------------------------------------------- external-store snapshot
//
// Written by the monitor (every pass) and read by the page, the top-bar
// badge, and possibly another tab. Same pattern as track-store: the snapshot
// is the raw string, cached, so an unchanged blob triggers no re-render and
// hydration starts from the server's empty value.

const listeners = new Set<() => void>();
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

export function alertsRaw(): string {
  if (cachedRaw === null) cachedRaw = readRaw();
  return cachedRaw;
}

/** Server/prerender snapshot — the static export has no storage at build time. */
export function alertsRawServer(): string {
  return "";
}

export function subscribeAlerts(onChange: () => void): () => void {
  listeners.add(onChange);
  // `storage` fires only in OTHER tabs of this origin — exactly what the
  // in-process listener set cannot see.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) bump();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

// ------------------------------------------------------ monitor telemetry
//
// Session-only, deliberately NOT persisted: "the launches feed answered 4s
// ago" is a claim about THIS tab's session, and resurrecting it after a
// reload would assert coverage that did not happen. The per-rule
// `lastEvaluatedAt` in the persisted blob is what carries history across
// reloads.

export interface SourcePassInfo {
  key: string;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  /** The payload's own claim about its data time. */
  dataAsOf?: number;
  ok: boolean;
  note?: string;
}

export interface CoverageGap {
  from: number;
  to?: number;
  reason: string;
}

export interface MonitorStatus {
  /** True once a monitor loop is mounted in this tab. */
  running: boolean;
  /** False when another Nova tab holds the evaluation lease. */
  leader: boolean;
  visible: boolean;
  backgroundWatch: boolean;
  /**
   * This tab is hidden with background watch off, so it evaluates nothing.
   *
   * Its own field because the status line must branch on it FIRST. Reading
   * "not the leader" as the headline let a tab that had just released the
   * lease (or was still holding a stale one from before a reload) announce
   * "another tab is monitoring" when the truth was simply that this tab had
   * stopped — a coverage claim about a tab that may not exist.
   */
  paused: boolean;
  startedAt?: number;
  lastTickAt?: number;
  sources: Record<string, SourcePassInfo>;
  /** Windows this session knowingly did not evaluate, newest last. */
  gaps: CoverageGap[];
  notifDelivered: number;
  notifFailed: number;
}

const MAX_GAPS = 20;

let status: MonitorStatus = {
  running: false,
  leader: false,
  visible: true,
  backgroundWatch: false,
  paused: false,
  sources: {},
  gaps: [],
  notifDelivered: 0,
  notifFailed: 0,
};

const statusListeners = new Set<() => void>();

export function monitorStatus(): MonitorStatus {
  return status;
}

export function updateMonitorStatus(patch: Partial<MonitorStatus>): void {
  status = { ...status, ...patch };
  for (const l of statusListeners) l();
}

export function noteSourcePass(info: SourcePassInfo): void {
  status = { ...status, sources: { ...status.sources, [info.key]: info } };
  for (const l of statusListeners) l();
}

/** Start a coverage gap, once — repeated calls while it is open are no-ops. */
export function openGap(from: number, reason: string): void {
  const last = status.gaps[status.gaps.length - 1];
  if (last && last.to === undefined && last.reason === reason) return;
  status = { ...status, gaps: [...status.gaps, { from, reason }].slice(-MAX_GAPS) };
  for (const l of statusListeners) l();
}

/** Close the open gap, if there is one. Safe to call every tick. */
export function closeGap(to: number): void {
  const gaps = [...status.gaps];
  const last = gaps[gaps.length - 1];
  if (!last || last.to !== undefined) return;
  gaps[gaps.length - 1] = { ...last, to };
  status = { ...status, gaps };
  for (const l of statusListeners) l();
}

export function noteNotification(delivered: boolean): void {
  status = delivered
    ? { ...status, notifDelivered: status.notifDelivered + 1 }
    : { ...status, notifFailed: status.notifFailed + 1 };
  for (const l of statusListeners) l();
}

export function subscribeMonitor(onChange: () => void): () => void {
  statusListeners.add(onChange);
  return () => {
    statusListeners.delete(onChange);
  };
}

/** Stable server snapshot so useSyncExternalStore hydrates cleanly. */
const SERVER_STATUS: MonitorStatus = status;
export function monitorStatusServer(): MonitorStatus {
  return SERVER_STATUS;
}

// -------------------------------------------------------------- leadership
//
// Two Nova tabs share one localStorage. Without a lease, both monitors would
// evaluate every rule, double the provider traffic, and interleave writes to
// the same watermarks — the second tab's arming pass could swallow fills the
// first was about to fire on. One tab holds a heartbeat lease; the others
// idle and say so.

const LOCK_KEY = "rom-nova.live-alerts.lock";
/**
 * How long an unrenewed lease stays believed.
 *
 * The holder renews on every tick, so 2.5 ticks of silence means the holder is
 * gone — crashed, navigated, or reloaded. It was 45 seconds, chosen when
 * nothing depended on the number; the cost of that generosity is a window in
 * which a tab reports that "another tab is monitoring" when the other tab is
 * its own pre-reload ghost. `pagehide` closes that window in a real browser by
 * handing the lease back on unload, but unload events are not guaranteed to
 * run, so the timeout is the backstop that must not be loose.
 */
export const LOCK_STALE_MS = 25_000;

/** Age of the current lease in ms, or null when nobody holds one. */
export function leaseAgeMs(now = Date.now()): number | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(LOCK_KEY);
    if (!raw) return null;
    const lock = JSON.parse(raw) as { ts: number };
    return typeof lock.ts === "number" ? now - lock.ts : null;
  } catch {
    return null;
  }
}

/**
 * Whether this tab intends to evaluate, decided BEFORE the lease is touched.
 *
 * Extracted from the monitor's tick because the bug it fixes was one of
 * ORDER, not of arithmetic, and order is invisible to a test that only pokes
 * the lock primitives. The shipped tick renewed the lease at the top of every
 * pass and only then asked whether it was paused, so a hidden tab with
 * background watch off held the lock while evaluating nothing — and a visible
 * tab in the same browser sat idle for minutes announcing that another tab
 * was monitoring on its behalf.
 *
 * `holdLease` is therefore exactly `!paused`: a tab that is not watching must
 * not hold the right to watch.
 */
export function watchDecision(
  visible: boolean,
  backgroundWatch: boolean,
): { paused: boolean; holdLease: boolean } {
  const paused = !visible && !backgroundWatch;
  return { paused, holdLease: !paused };
}

export function acquireLease(tabId: string, now = Date.now()): boolean {
  const s = storage();
  if (!s) return true; // no storage, no second tab to race
  try {
    const raw = s.getItem(LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw) as { id: string; ts: number };
      if (lock.id !== tabId && now - lock.ts < LOCK_STALE_MS) return false;
    }
    s.setItem(LOCK_KEY, JSON.stringify({ id: tabId, ts: now }));
    return true;
  } catch {
    return true;
  }
}

export function releaseLease(tabId: string): void {
  const s = storage();
  if (!s) return;
  try {
    const raw = s.getItem(LOCK_KEY);
    if (raw && (JSON.parse(raw) as { id: string }).id === tabId) s.removeItem(LOCK_KEY);
  } catch {
    /* nothing to release */
  }
}
