"use client";

// The desktop shell, as the page sees it.
//
// Under the app:// scheme the shell answers a same-origin GET with its
// version and the updater's state (desktop/bridge.js); in a browser tab
// there is no shell, and the snapshot says so. Read through
// useSyncExternalStore like every other browser-only fact in this codebase,
// so the prerendered HTML and the first paint agree ("not the desktop"), and
// polled only while something is subscribed. In a browser nothing is ever
// fetched.

export type DesktopUpdateState =
  | "unavailable"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "none"
  | "error";

export interface DesktopUpdate {
  state: DesktopUpdateState;
  version: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
}

export interface DesktopSnapshot {
  /** True only under the app:// scheme — the installed shell. */
  desktop: boolean;
  /** Whether the shell has answered: null before the first poll, false when it could not. */
  reachable: boolean | null;
  version: string | null;
  platform: string | null;
  electron: string | null;
  update: DesktopUpdate;
}

const BRIDGE_PATH = "/nova/__desktop";
const CHECK_PATH = "/nova/__desktop/check";
const INSTALL_PATH = "/nova/__desktop/install";
const POLL_MS = 60_000;
/** After asking for a check, the answer arrives as events; look again on this schedule. */
const AFTER_CHECK_MS = [1500, 5000, 15_000];

const NO_UPDATE: DesktopUpdate = { state: "unavailable", version: null, percent: null, error: null, checkedAt: null };
const NOT_DESKTOP: DesktopSnapshot = {
  desktop: false,
  reachable: null,
  version: null,
  platform: null,
  electron: null,
  update: NO_UPDATE,
};

/** Test seams: the protocol to pretend and the fetch to use. Null means the real ones. */
export const desktopSeams: { protocol: string | null; fetch: typeof fetch | null } = { protocol: null, fetch: null };

export function isDesktop(): boolean {
  const protocol = desktopSeams.protocol ?? (typeof location === "undefined" ? "" : location.protocol);
  return protocol === "app:";
}

let snapshot: DesktopSnapshot = NOT_DESKTOP;
let started = false;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

const STATES: DesktopUpdateState[] = ["unavailable", "idle", "checking", "available", "downloading", "ready", "none", "error"];

function normUpdate(raw: unknown): DesktopUpdate {
  const r = (raw ?? {}) as Record<string, unknown>;
  const state = STATES.includes(r.state as DesktopUpdateState) ? (r.state as DesktopUpdateState) : "unavailable";
  return {
    state,
    version: typeof r.version === "string" ? r.version : null,
    percent: typeof r.percent === "number" && Number.isFinite(r.percent) ? r.percent : null,
    error: typeof r.error === "string" ? r.error : null,
    checkedAt: typeof r.checkedAt === "number" ? r.checkedAt : null,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Ask the shell now. A no-op in a browser. */
export async function refreshDesktop(): Promise<void> {
  if (!isDesktop()) return;
  const f = desktopSeams.fetch ?? fetch;
  try {
    const res = await f(BRIDGE_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    snapshot = {
      desktop: true,
      reachable: true,
      version: str(j.version),
      platform: str(j.platform),
      electron: str(j.electron),
      update: normUpdate(j.update),
    };
  } catch {
    // An older shell without the bridge (1.25.0 and before) answers 404
    // here: the page is the desktop, and that is all it can know.
    snapshot = { ...snapshot, desktop: true, reachable: false };
  }
  emit();
}

function startPolling(): void {
  if (timer !== undefined || !isDesktop()) return;
  timer = setInterval(() => void refreshDesktop(), POLL_MS);
}

function stopPolling(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

export function subscribeDesktop(l: () => void): () => void {
  listeners.add(l);
  if (!started) {
    started = true;
    if (isDesktop()) {
      snapshot = { ...NOT_DESKTOP, desktop: true };
      void refreshDesktop();
    }
  }
  startPolling();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) stopPolling();
  };
}

export const desktopSnapshot = (): DesktopSnapshot => snapshot;
export const desktopServerSnapshot = (): DesktopSnapshot => NOT_DESKTOP;

async function post(path: string): Promise<{ ok: boolean; error: string | null }> {
  if (!isDesktop()) return { ok: false, error: "not the desktop app" };
  const f = desktopSeams.fetch ?? fetch;
  try {
    const res = await f(path, { method: "POST" });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true, error: null } : { ok: false, error: j.error ?? `bridge ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask the shell to look at the release feed now, then read the answer as it lands. */
export async function checkDesktopUpdate(): Promise<{ ok: boolean; error: string | null }> {
  const out = await post(CHECK_PATH);
  if (out.ok) for (const ms of AFTER_CHECK_MS) setTimeout(() => void refreshDesktop(), ms);
  return out;
}

/** Restart into a downloaded update. The shell answers, then quits; a failure comes back as words. */
export async function installDesktopUpdate(): Promise<{ ok: boolean; error: string | null }> {
  return post(INSTALL_PATH);
}

/** One line for the update, for the Settings page and the banner. */
export function describeUpdate(u: DesktopUpdate, reachable: boolean | null): string {
  if (reachable === false) return "this shell predates the update bridge — updates still install on the next launch";
  switch (u.state) {
    case "unavailable":
      return "no update feed in this build — updates come with the installed app";
    case "idle":
      return "not checked yet";
    case "checking":
      return "checking the release feed…";
    case "available":
      return `${u.version ?? "a newer version"} found — downloading`;
    case "downloading":
      return `downloading ${u.version ?? "the update"}${u.percent !== null ? ` · ${u.percent}%` : ""}`;
    case "ready":
      return `${u.version ?? "an update"} is downloaded — restart to install it`;
    case "none":
      return "up to date";
    case "error":
      return `could not reach the release feed${u.error ? ` — ${u.error}` : ""}`;
  }
}

/** For tests: back to the first render. */
export function resetDesktopStore(): void {
  stopPolling();
  listeners.clear();
  snapshot = NOT_DESKTOP;
  started = false;
}
