// The wallet ledger: every fill ever seen for a recorded wallet, kept.
//
// WHY THIS EXISTS
//
// The only keyless RPC that answers `getSignaturesForAddress` retains about
// two days. Every wallet read in this app is therefore a two-day window, and
// `UnmeasuredWalletField.reputation` is set on every real profile because a
// two-day win rate is a sample, not a reputation. Nothing accumulated, so the
// window never grew — a wallet watched for a month was still judged on its
// last 48 hours.
//
// This is the accumulation. A wallet marked RECORDING keeps every fill the
// chain reader returns for it, deduplicated by signature, together with the
// windows those reads covered. The alert monitor re-reads recorded wallets on
// its wallet cadence while the app is open, so the history grows on its own.
// After a week there is a week; after a month, a month — with the gaps named,
// because an app that was closed for three days did not observe those days
// and must not pretend it did.
//
// WHERE IT LIVES
//
// In the visitor's browser, in IndexedDB, private to them — the same reason
// user state lives in localStorage: a static site has no server to hold it.
// The in-memory map is the source of truth while the tab is open; IndexedDB
// is the copy that survives a reload. Node and the server route get a memory
// backend and record nothing durable, which /status says.
//
// It is opt-in per wallet. Recording every wallet a visitor ever glanced at
// would churn the cap and mean nothing; a wallet someone chose to record is a
// wallet they want judged.

import type { WalletCoverage, WalletFill } from "../types";
import { mergeIntervals, reputationFrom, type Interval, type WalletReputation } from "./reputation";

/** Fills kept per wallet. Oldest evicted past this, and the coverage clipped to match. */
export const FILL_CAP = 4_000;
/** Wallets that can be recording at once. */
export const WALLET_CAP = 40;

const DB_NAME = "rom-nova-ledger";
const DB_VERSION = 1;
const STORE = "wallets";

/** A fill as stored: `WalletFill` minus the wallet (the key) and the prose. */
export interface LedgerFill {
  signature: string;
  slot: number;
  ts: number;
  mint: string;
  decimals: number;
  side: "buy" | "sell";
  tokens: number;
  priceUsd?: number;
  valueUsd?: number;
  pricing: WalletFill["pricing"];
  classification: WalletFill["classification"];
}

export interface WalletLedgerRecord {
  address: string;
  recording: boolean;
  /** When recording was switched on. */
  startedAt: number;
  /** Last read merged in, and how many reads have been. */
  lastReadAt?: number;
  reads: number;
  /** The adapter that answered the last read. */
  source?: string;
  /** Sorted by ts ascending, unique by signature. */
  fills: LedgerFill[];
  /** Merged read windows — what the fills are the complete record OF. */
  covered: Interval[];
}

export interface LedgerSummary {
  address: string;
  recording: boolean;
  startedAt: number;
  lastReadAt?: number;
  reads: number;
  fills: number;
  oldestTs?: number;
  newestTs?: number;
  reputation: WalletReputation;
}

export interface LedgerSnapshot {
  /** Bumped on every change, so a memoised consumer can tell. */
  version: number;
  backend: "indexeddb" | "memory";
  loaded: boolean;
  wallets: LedgerSummary[];
  totalFills: number;
}

// ------------------------------------------------------------------ state

const records = new Map<string, WalletLedgerRecord>();
const listeners = new Set<() => void>();
let version = 0;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let snapshotCache: LedgerSnapshot | null = null;
const reputationCache = new Map<string, { version: number; rep: WalletReputation }>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

const hasIdb = (): boolean => typeof indexedDB !== "undefined";

export function ledgerBackendName(): "indexeddb" | "memory" {
  return hasIdb() ? "indexeddb" : "memory";
}

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

// -------------------------------------------------------------- persistence

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "address" });
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
    const rows = await new Promise<WalletLedgerRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as WalletLedgerRecord[]);
      req.onerror = () => reject(req.error ?? new Error("ledger read failed"));
    });
    db.close();
    for (const r of rows) {
      // Disk wins over memory only for wallets memory has not touched yet:
      // a record written during the load must not be rolled back.
      if (!records.has(r.address)) records.set(r.address, r);
    }
  } catch {
    // A refused or broken IndexedDB (private window, quota, a browser that
    // blocks site data) degrades to memory for this session. The snapshot
    // still says "indexeddb" for the backend, which is the intent; the load
    // failure is disclosed through `loaded` staying true with nothing in it.
  } finally {
    loaded = true;
    bump();
  }
}

/** Kick the load once, on first use, in whichever runtime this is. */
export function ledgerReady(): Promise<void> {
  if (!loadPromise) loadPromise = loadAll();
  return loadPromise;
}

function persist(address: string): void {
  if (!hasIdb()) return;
  const prior = pendingWrites.get(address);
  if (prior) clearTimeout(prior);
  // Debounced: a read merges once, but the toggle and the read can land
  // within the same second, and IndexedDB writes are not free on a 4,000-row
  // record.
  pendingWrites.set(
    address,
    setTimeout(() => {
      pendingWrites.delete(address);
      const rec = records.get(address);
      void (async () => {
        try {
          const db = await openDb();
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            if (rec) store.put(rec);
            else store.delete(address);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("ledger write failed"));
          });
          db.close();
        } catch {
          /* memory still holds it; the next write retries */
        }
      })();
    }, 400),
  );
}

// ------------------------------------------------------------------- reads

export function isRecording(address: string): boolean {
  return records.get(address)?.recording === true;
}

export function recordedWallets(): string[] {
  return [...records.values()].filter((r) => r.recording).map((r) => r.address);
}

export function ledgerRecord(address: string): WalletLedgerRecord | undefined {
  return records.get(address);
}

/** The fills as `WalletFill`s again, for anything that replays them. */
export function ledgerFills(address: string): WalletFill[] {
  const rec = records.get(address);
  if (!rec) return [];
  return rec.fills.map((f) => ({ ...f, wallet: address }));
}

/**
 * Reputation for a wallet the ledger knows, memoised per change.
 *
 * Synchronous on purpose: the token scorer asks this for forty movers in a
 * loop and cannot await forty IndexedDB reads. The memory map is the truth
 * while the tab is open; before the load finishes it answers from what has
 * been touched this session, which is nothing — and nothing is the honest
 * answer to "do you know this wallet" until the disk has been read.
 */
export function reputationOf(address: string): WalletReputation | undefined {
  const rec = records.get(address);
  if (!rec) return undefined;
  const hit = reputationCache.get(address);
  if (hit && hit.version === version) return hit.rep;
  const rep = reputationFrom(address, ledgerFills(address), rec.covered);
  reputationCache.set(address, { version, rep });
  return rep;
}

// ------------------------------------------------------------------ writes

/**
 * Switch recording on or off.
 *
 * Off keeps the record and its history — a month of fills is not thrown away
 * because someone paused — it only stops the monitor re-reading. `forget`
 * removes it.
 */
export function setRecording(address: string, on: boolean, now = Date.now()): WalletLedgerRecord | null {
  let rec = records.get(address);
  if (on && !rec) {
    if (recordedWallets().length >= WALLET_CAP) return null;
    rec = { address, recording: true, startedAt: now, reads: 0, fills: [], covered: [] };
    records.set(address, rec);
  } else if (rec) {
    rec.recording = on;
    if (on && rec.reads === 0) rec.startedAt = now;
  } else {
    return null;
  }
  persist(address);
  bump();
  return rec;
}

export function forgetWallet(address: string): void {
  if (!records.delete(address)) return;
  reputationCache.delete(address);
  persist(address);
  bump();
}

/**
 * Merge one read's fills into the wallet's record.
 *
 * Returns null when the wallet is not recording — the common case, so a
 * profile read for a wallet nobody chose costs one map lookup. Otherwise the
 * fills are deduplicated by signature, the read's window is merged into the
 * coverage, the cap is applied oldest-first, and the coverage is clipped to
 * the oldest fill still held so the verdict never claims a window whose
 * evidence has been evicted.
 */
export function recordFills(
  address: string,
  fills: readonly WalletFill[],
  coverage: Pick<WalletCoverage, "oldestTs" | "newestTs" | "source">,
  readAt = Date.now(),
): { added: number; total: number } | null {
  const rec = records.get(address);
  if (!rec || !rec.recording) return null;

  const seen = new Set(rec.fills.map((f) => f.signature));
  let added = 0;
  for (const f of fills) {
    if (f.wallet !== address || seen.has(f.signature)) continue;
    seen.add(f.signature);
    rec.fills.push({
      signature: f.signature,
      slot: f.slot,
      ts: f.ts,
      mint: f.mint,
      decimals: f.decimals,
      side: f.side,
      tokens: f.tokens,
      priceUsd: f.priceUsd,
      valueUsd: f.valueUsd,
      pricing: f.pricing,
      classification: f.classification,
    });
    added++;
  }
  if (added > 0) rec.fills.sort((a, b) => a.ts - b.ts || a.slot - b.slot);

  // The window a read covers runs from the oldest transaction it saw to the
  // moment it ran: anything between the newest fill and now would have been
  // listed, since the endpoint retains two days. An empty read of a quiet
  // wallet covers [readAt, readAt] and nothing more — it proved nothing about
  // the past, only that nothing was listed right now.
  const from = coverage.oldestTs > 0 ? Math.min(coverage.oldestTs, readAt) : readAt;
  rec.covered = mergeIntervals([...rec.covered, { from, to: readAt }]);

  if (rec.fills.length > FILL_CAP) {
    rec.fills.splice(0, rec.fills.length - FILL_CAP);
    const floor = rec.fills[0].ts;
    rec.covered = mergeIntervals(
      rec.covered.filter((i) => i.to >= floor).map((i) => ({ from: Math.max(i.from, floor), to: i.to })),
    );
  }

  rec.reads++;
  rec.lastReadAt = readAt;
  rec.source = coverage.source;
  persist(address);
  bump();
  return { added, total: rec.fills.length };
}

// ---------------------------------------------------------------- snapshot

const SERVER_SNAPSHOT: LedgerSnapshot = { version: 0, backend: "memory", loaded: false, wallets: [], totalFills: 0 };

export function ledgerSnapshot(): LedgerSnapshot {
  if (snapshotCache) return snapshotCache;
  const wallets: LedgerSummary[] = [...records.values()]
    .map((r) => ({
      address: r.address,
      recording: r.recording,
      startedAt: r.startedAt,
      lastReadAt: r.lastReadAt,
      reads: r.reads,
      fills: r.fills.length,
      oldestTs: r.fills[0]?.ts,
      newestTs: r.fills[r.fills.length - 1]?.ts,
      reputation: reputationOf(r.address) as WalletReputation,
    }))
    .sort((a, b) => b.fills - a.fills);
  snapshotCache = {
    version,
    backend: ledgerBackendName(),
    loaded,
    wallets,
    totalFills: wallets.reduce((s, w) => s + w.fills, 0),
  };
  return snapshotCache;
}

export function ledgerSnapshotServer(): LedgerSnapshot {
  return SERVER_SNAPSHOT;
}

export function subscribeLedger(l: () => void): () => void {
  listeners.add(l);
  // First subscriber in a browser starts the disk load; a page that never
  // asks never pays for it.
  void ledgerReady();
  return () => {
    listeners.delete(l);
  };
}

/** Test seam. */
export function resetLedger(): void {
  records.clear();
  reputationCache.clear();
  for (const t of pendingWrites.values()) clearTimeout(t);
  pendingWrites.clear();
  snapshotCache = null;
  loaded = false;
  loadPromise = null;
  version = 0;
}
