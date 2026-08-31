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
}

const EMPTY: AlertsBlob = { rules: [], events: [], states: {}, settings: { backgroundWatch: false } };

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
    return { rules, events, states, settings };
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
  const bounded: AlertsBlob = {
    ...blob,
    rules: blob.rules.slice(0, MAX_RULES),
    events: blob.events.slice(0, MAX_EVENTS),
  };
  try {
    s.setItem(KEY, JSON.stringify(bounded));
  } catch {
    // Most likely quota. Events are the bulk; halving them keeps the rules
    // and watermarks, which are what monitoring actually needs to go on.
    try {
      s.setItem(KEY, JSON.stringify({ ...bounded, events: bounded.events.slice(0, Math.floor(bounded.events.length / 2)) }));
    } catch {
      /* storage unavailable — monitoring continues without a saved record */
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
  save({ ...blob, events: [] });
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
  save({
    ...blob,
    states: { ...blob.states, ...states },
    events: [...fired, ...blob.events].slice(0, MAX_EVENTS),
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
export const LOCK_STALE_MS = 45_000;

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
