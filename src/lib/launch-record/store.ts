// The launch record: every mint the feed saw, written down, and looked up again.
//
// The launch feed forgets a row half an hour after it stops being a launch,
// which is right for a feed and useless for a scorecard. This keeps what the
// feed saw — the mint, the verdict it gave, the deployer's history, whatever
// price and liquidity it had at first sight — and, an hour and a day later,
// asks Jupiter one batched question per hundred mints: is it still listed,
// at what price and liquidity, and did it graduate. The answers are the
// outcomes `report.ts` turns into rates.
//
// It records by listening to the feed's own merge, so it costs the feed
// nothing and misses nothing the feed showed. It resolves from the alert
// monitor's tick, which runs on every page, so a day-old launch is looked up
// whether or not the launch feed is open a day later — as long as SOME Nova
// tab is. A closed app expires the horizon rather than stretching it, exactly
// as the track record does.
//
// IndexedDB, this browser only, capped, and pruned by age. Nothing uploads.

import type { TokenLaunch } from "../types";
import {
  LAUNCH_HORIZONS,
  PRICE_AT_SEEN_MS,
  launchToleranceFor,
  type LaunchHorizonLabel,
  type LaunchRecordObs,
} from "./report";

export const LAUNCH_RECORD_CAP = 20_000;
export const LAUNCH_RECORD_MAX_AGE_MS = 14 * 86_400_000;
/** How often the resolver may run, and how many mints one run may look up. */
export const RESOLVE_EVERY_MS = 60_000;
export const RESOLVE_BATCH = 100;
/** A verdict settles when the risk read lands, or after this long without one. */
export const SETTLE_MS = 90_000;

const DB_NAME = "rom-nova-launch-record";
const DB_VERSION = 1;
const STORE = "launches";

/** What a lookup must answer per mint. Shaped like Jupiter's launch rows, supplied by the feed module. */
export interface LaunchLookupRow {
  priceUsd?: number;
  liquidityUsd?: number;
  graduatedAt?: number;
}
export type LaunchLookup = (mints: string[], now: number) => Promise<Map<string, LaunchLookupRow>>;

export interface LaunchRecordSnapshot {
  version: number;
  backend: "indexeddb" | "memory";
  loaded: boolean;
  obs: LaunchRecordObs[];
  /** Resolver bookkeeping for /status and the page. */
  lastResolveAt: number;
  lookups: number;
  lookupFailures: number;
  lastError?: string;
}

// ------------------------------------------------------------------ state

const records = new Map<string, LaunchRecordObs>();
const listeners = new Set<() => void>();
let version = 0;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let snapshotCache: LaunchRecordSnapshot | null = null;
let lookup: LaunchLookup | null = null;
let lastResolveAt = 0;
let lookups = 0;
let lookupFailures = 0;
let lastError: string | undefined;
let resolving = false;
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const hasIdb = (): boolean => typeof indexedDB !== "undefined";

function bump(): void {
  version++;
  snapshotCache = null;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* one listener must not silence the rest */
    }
  }
}

/** The feed module supplies the batched lookup; nothing here imports a provider. */
export function setLaunchLookup(fn: LaunchLookup | null): void {
  lookup = fn;
}

// -------------------------------------------------------------- persistence

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "mint" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
}

async function loadAll(): Promise<void> {
  if (!hasIdb()) {
    loaded = true;
    bump();
    return;
  }
  try {
    const db = await openDb();
    const rows = await new Promise<LaunchRecordObs[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as LaunchRecordObs[]);
      req.onerror = () => reject(req.error ?? new Error("launch record read failed"));
    });
    db.close();
    const cutoff = Date.now() - LAUNCH_RECORD_MAX_AGE_MS;
    for (const r of rows) {
      if (r.seenAt < cutoff) {
        dirty.add(r.mint); // deleted on the next flush
        continue;
      }
      if (!records.has(r.mint)) records.set(r.mint, r);
    }
    if (dirty.size > 0) scheduleFlush();
  } catch {
    /* private window or blocked storage: memory for this session */
  } finally {
    loaded = true;
    bump();
  }
}

export function launchRecordReady(): Promise<void> {
  if (!loadPromise) loadPromise = loadAll();
  return loadPromise;
}

function scheduleFlush(): void {
  if (!hasIdb() || flushTimer) return;
  // One transaction per second at most: the feed can add thirty rows a
  // minute and the resolver a hundred at once, and each is a row, not a
  // transaction.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = [...dirty];
    dirty.clear();
    void (async () => {
      try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          for (const mint of batch) {
            const rec = records.get(mint);
            if (rec) store.put(rec);
            else store.delete(mint);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("launch record write failed"));
        });
        db.close();
      } catch {
        for (const m of batch) dirty.add(m);
      }
    })();
  }, 1_000);
}

function touch(mint: string): void {
  dirty.add(mint);
  scheduleFlush();
}

// ------------------------------------------------------------- recording

function prune(now: number): void {
  const cutoff = now - LAUNCH_RECORD_MAX_AGE_MS;
  for (const [mint, r] of records) {
    if (r.seenAt < cutoff) {
      records.delete(mint);
      touch(mint);
    }
  }
  if (records.size > LAUNCH_RECORD_CAP) {
    // Oldest first, and among the oldest, the ones already resolved or
    // expired go before the ones still awaiting a horizon.
    const done = (r: LaunchRecordObs) => r.outcomes.length + r.expired.length >= LAUNCH_HORIZONS.length;
    const victims = [...records.values()]
      .sort((a, b) => Number(done(b)) - Number(done(a)) || a.seenAt - b.seenAt)
      .slice(0, records.size - LAUNCH_RECORD_CAP);
    for (const v of victims) {
      records.delete(v.mint);
      touch(v.mint);
    }
  }
}

function gradFrom(row: TokenLaunch, now: number): number | undefined {
  if (row.graduatedAt !== undefined) return row.graduatedAt;
  if (row.event === "graduation") return row.gradSeenAt ?? row.poolCreatedAt ?? now;
  return undefined;
}

/**
 * The feed's merge, observed. `added` means the row is new to the feed.
 *
 * A new row is recorded as it stands; a refreshed row settles the verdict
 * once the risk read has landed or ninety seconds have passed, takes the
 * first price it sees inside the price window, and notes a graduation the
 * moment the feed itself sees one — the free outcome, no lookup needed.
 */
export function noteLaunchMerged(row: TokenLaunch, added: boolean, now = Date.now()): void {
  let obs = records.get(row.mint);
  if (added || !obs) {
    if (obs) return;
    obs = {
      mint: row.mint,
      symbol: row.symbol,
      seenAt: row.firstSeenAt || now,
      launchpad: row.launchpad,
      event: row.event,
      source: row.source,
      verdict: row.triage.verdict,
      settled: row.triage.riskScore !== undefined,
      verdictAt: now,
      measured: row.triage.measured,
      readings: row.triage.readings,
      riskScore: row.triage.riskScore,
      devMints: row.devMints,
      devMigrations: row.devMigrations,
      priceUsd: row.priceUsd && row.priceUsd > 0 ? row.priceUsd : undefined,
      priceAt: row.priceUsd && row.priceUsd > 0 ? now : undefined,
      liquidityUsd: row.liquidityUsd,
      bondingCurvePct: row.bondingCurvePct,
      graduatedAt: gradFrom(row, now),
      outcomes: [],
      expired: [],
    };
    records.set(row.mint, obs);
    prune(now);
    touch(row.mint);
    bump();
    return;
  }

  let changed = false;
  if (!obs.settled && (row.triage.riskScore !== undefined || now - obs.seenAt >= SETTLE_MS)) {
    obs.verdict = row.triage.verdict;
    obs.settled = true;
    obs.verdictAt = now;
    obs.measured = row.triage.measured;
    obs.readings = row.triage.readings;
    obs.riskScore = row.triage.riskScore;
    changed = true;
  }
  if (obs.devMints === undefined && row.devMints !== undefined) {
    obs.devMints = row.devMints;
    obs.devMigrations = row.devMigrations;
    changed = true;
  }
  if (obs.priceUsd === undefined && row.priceUsd && row.priceUsd > 0 && now - obs.seenAt <= PRICE_AT_SEEN_MS) {
    obs.priceUsd = row.priceUsd;
    obs.priceAt = now;
    obs.liquidityUsd = row.liquidityUsd ?? obs.liquidityUsd;
    changed = true;
  }
  if (obs.graduatedAt === undefined) {
    const g = gradFrom(row, now);
    if (g !== undefined) {
      obs.graduatedAt = g;
      changed = true;
    }
  }
  if (changed) {
    touch(row.mint);
    bump();
  }
}

// -------------------------------------------------------------- resolving

/** Which (mint, horizon) pairs are inside their window right now, and which have missed it. */
export function dueNow(now = Date.now()): { due: { mint: string; horizon: LaunchHorizonLabel }[]; expired: number } {
  const due: { mint: string; horizon: LaunchHorizonLabel }[] = [];
  let expired = 0;
  for (const o of records.values()) {
    for (const h of LAUNCH_HORIZONS) {
      if (o.outcomes.some((x) => x.horizon === h.label) || o.expired.includes(h.label)) continue;
      const target = o.seenAt + h.ms;
      if (now < target) continue;
      if (now > target + launchToleranceFor(h)) {
        o.expired.push(h.label);
        expired++;
        touch(o.mint);
        continue;
      }
      due.push({ mint: o.mint, horizon: h.label });
    }
  }
  if (expired > 0) bump();
  return { due, expired };
}

/**
 * Record a lookup's answers for the pairs that were due. Exposed so the
 * resolver can be driven by a test with a fake lookup, on a fake clock.
 */
export function applyLookup(
  due: readonly { mint: string; horizon: LaunchHorizonLabel }[],
  answers: Map<string, LaunchLookupRow>,
  now = Date.now(),
): number {
  let applied = 0;
  for (const d of due) {
    const o = records.get(d.mint);
    if (!o || o.outcomes.some((x) => x.horizon === d.horizon)) continue;
    const hit = answers.get(d.mint);
    o.outcomes.push({
      horizon: d.horizon,
      at: now,
      listed: hit !== undefined,
      priceUsd: hit?.priceUsd && hit.priceUsd > 0 ? hit.priceUsd : undefined,
      liquidityUsd: hit?.liquidityUsd,
      graduatedAt: hit?.graduatedAt,
    });
    if (o.graduatedAt === undefined && hit?.graduatedAt !== undefined) o.graduatedAt = hit.graduatedAt;
    touch(d.mint);
    applied++;
  }
  if (applied > 0) bump();
  return applied;
}

/**
 * The resolver, called from the monitor's tick. Rate-gated to one run a
 * minute and one batch of a hundred mints; a busy day's backlog drains over
 * the following minutes rather than in one burst.
 */
export async function tickLaunchRecord(now = Date.now()): Promise<void> {
  await launchRecordReady();
  if (!lookup || resolving || now - lastResolveAt < RESOLVE_EVERY_MS) return;
  const { due } = dueNow(now);
  if (due.length === 0) return;
  resolving = true;
  lastResolveAt = now;
  const mints = [...new Set(due.map((d) => d.mint))].slice(0, RESOLVE_BATCH);
  const batch = due.filter((d) => mints.includes(d.mint));
  try {
    const answers = await lookup(mints, now);
    lookups++;
    applyLookup(batch, answers, Date.now());
    lastError = undefined;
  } catch (err) {
    lookupFailures++;
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    resolving = false;
    bump();
  }
}

// ---------------------------------------------------------------- snapshot

const SERVER_SNAPSHOT: LaunchRecordSnapshot = {
  version: 0,
  backend: "memory",
  loaded: false,
  obs: [],
  lastResolveAt: 0,
  lookups: 0,
  lookupFailures: 0,
};

export function launchSnapshot(): LaunchRecordSnapshot {
  if (snapshotCache) return snapshotCache;
  snapshotCache = {
    version,
    backend: hasIdb() ? "indexeddb" : "memory",
    loaded,
    obs: [...records.values()],
    lastResolveAt,
    lookups,
    lookupFailures,
    lastError,
  };
  return snapshotCache;
}

export function launchSnapshotServer(): LaunchRecordSnapshot {
  return SERVER_SNAPSHOT;
}

export function subscribeLaunchRecord(l: () => void): () => void {
  listeners.add(l);
  void launchRecordReady();
  return () => {
    listeners.delete(l);
  };
}

export function clearLaunchRecord(): void {
  for (const mint of records.keys()) touch(mint);
  records.clear();
  bump();
}

/** Test seam. */
export function resetLaunchRecord(): void {
  records.clear();
  dirty.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  snapshotCache = null;
  loaded = false;
  loadPromise = null;
  version = 0;
  lastResolveAt = 0;
  lookups = 0;
  lookupFailures = 0;
  lastError = undefined;
  resolving = false;
  lookup = null;
}
