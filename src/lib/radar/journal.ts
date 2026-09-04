// The hunter's journal: what the in-app radar has observed, kept.
//
// Same shape of promise as the wallet ledger next door: the in-memory map is
// the truth while the tab is open, IndexedDB is the copy that survives a
// reload, and a runtime without IndexedDB (tests, the server prerender)
// degrades to memory without changing the API. The hunter replays these fills
// through the scoring engine on every start, so a wallet proven on Tuesday
// is still proven when the app reopens on Thursday — the scores themselves
// are never persisted, only the evidence, which means a change to the scoring
// formula re-grades history instead of trusting stale numbers.

export interface RadarFill {
  mint: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  /** chain time, ms epoch — the TradeEvent's own clock */
  ts: number;
  sig?: string;
}

export interface RadarWalletRecord {
  address: string;
  firstSeen: number;
  /** ascending by ts, unique by sig (or by coordinates when a sig is absent) */
  fills: RadarFill[];
}

export type RadarHorizon = "m1" | "m5" | "m15" | "h1";

export interface RadarSignalRow {
  wallet_address: string;
  wallet_score: number;
  token_address: string;
  token_name: string | null;
  buy_amount_sol: number;
  timestamp: string;
  settled_sells?: number;
  // The copy-desk fields, absent on rows journaled before 1.17.0. A grade is
  // the token's price at the first trade at or after the horizon, against
  // the signal's own fill price; null until it resolves.
  signal_key?: string;
  price_at_signal?: number;
  ret_1m?: number | null;
  ret_5m?: number | null;
  ret_15m?: number | null;
  ret_1h?: number | null;
  /** best price seen inside the hour, against the fill — what a perfect exit got */
  peak_ret_1h?: number | null;
  /** at least one grade was marked to the last trade seen, not to a trade at the horizon */
  graded_stale?: boolean;
  // The signal wallet's own first sell after the signal: the exit.
  whale_exit_ret?: number | null;
  whale_exit_after_ms?: number | null;
  whale_exit_fraction?: number | null;
}

/** The column each horizon grades into. */
export const HORIZON_FIELD: Record<RadarHorizon, "ret_1m" | "ret_5m" | "ret_15m" | "ret_1h"> = {
  m1: "ret_1m",
  m5: "ret_5m",
  m15: "ret_15m",
  h1: "ret_1h",
};

/** Same key the engine stamps; computed here for rows journaled before it existed. */
export const signalKeyOf = (s: Pick<RadarSignalRow, "wallet_address" | "token_address" | "timestamp">): string =>
  `${s.wallet_address}:${s.token_address}:${s.timestamp}`;

/** Fills kept per wallet — a sniper's whole week fits; a bot's spam does not. */
export const RADAR_FILL_CAP = 400;
/** Wallets the journal keeps; past it, the longest-idle record is dropped. */
export const RADAR_WALLET_CAP = 200;
export const RADAR_SIGNAL_CAP = 300;

const DB_NAME = "rom-nova-radar";
const DB_VERSION = 1;
const WALLET_STORE = "wallets";
const LOG_STORE = "log";
const SIGNALS_KEY = "signals";

const records = new Map<string, RadarWalletRecord>();
let signals: RadarSignalRow[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

const hasIdb = (): boolean => typeof indexedDB !== "undefined";

export function radarBackendName(): "indexeddb" | "memory" {
  return hasIdb() ? "indexeddb" : "memory";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WALLET_STORE)) db.createObjectStore(WALLET_STORE, { keyPath: "address" });
      if (!db.objectStoreNames.contains(LOG_STORE)) db.createObjectStore(LOG_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("radar journal open failed"));
    req.onblocked = () => reject(new Error("radar journal open blocked"));
  });
}

async function loadAll(): Promise<void> {
  if (!hasIdb()) {
    loaded = true;
    return;
  }
  try {
    const db = await openDb();
    const [walletRows, signalDoc] = await Promise.all([
      new Promise<RadarWalletRecord[]>((resolve, reject) => {
        const req = db.transaction(WALLET_STORE, "readonly").objectStore(WALLET_STORE).getAll();
        req.onsuccess = () => resolve(req.result as RadarWalletRecord[]);
        req.onerror = () => reject(req.error ?? new Error("radar wallets read failed"));
      }),
      new Promise<{ rows?: RadarSignalRow[] } | undefined>((resolve, reject) => {
        const req = db.transaction(LOG_STORE, "readonly").objectStore(LOG_STORE).get(SIGNALS_KEY);
        req.onsuccess = () => resolve(req.result as { rows?: RadarSignalRow[] } | undefined);
        req.onerror = () => reject(req.error ?? new Error("radar signals read failed"));
      }),
    ]);
    db.close();
    for (const r of walletRows) if (!records.has(r.address)) records.set(r.address, r);
    if (signals.length === 0 && Array.isArray(signalDoc?.rows)) signals = signalDoc.rows;
  } catch {
    // A refused IndexedDB (private window, quota) degrades to memory for the
    // session; the hunter still runs, it just starts from zero next time.
  } finally {
    loaded = true;
  }
}

/** Kick the disk load once. The hunter awaits this before replaying. */
export function radarJournalReady(): Promise<void> {
  if (!loadPromise) loadPromise = loadAll();
  return loadPromise;
}

function persistWallet(address: string): void {
  if (!hasIdb()) return;
  const prior = pendingWrites.get(address);
  if (prior) clearTimeout(prior);
  // Debounced per wallet: a hot sniper fills several times a second during a
  // flip, and each write is the whole record.
  pendingWrites.set(
    address,
    setTimeout(() => {
      pendingWrites.delete(address);
      const rec = records.get(address);
      void (async () => {
        try {
          const db = await openDb();
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(WALLET_STORE, "readwrite");
            const store = tx.objectStore(WALLET_STORE);
            if (rec) store.put(rec);
            else store.delete(address);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("radar wallet write failed"));
          });
          db.close();
        } catch {
          /* memory holds it; the next fill retries */
        }
      })();
    }, 400),
  );
}

function persistSignals(): void {
  if (!hasIdb()) return;
  const prior = pendingWrites.get(SIGNALS_KEY);
  if (prior) clearTimeout(prior);
  pendingWrites.set(
    SIGNALS_KEY,
    setTimeout(() => {
      pendingWrites.delete(SIGNALS_KEY);
      const rows = signals;
      void (async () => {
        try {
          const db = await openDb();
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(LOG_STORE, "readwrite");
            tx.objectStore(LOG_STORE).put({ rows }, SIGNALS_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("radar signals write failed"));
          });
          db.close();
        } catch {
          /* next signal retries */
        }
      })();
    }, 400),
  );
}

const fillKey = (f: RadarFill): string => f.sig ?? `${f.mint}:${f.ts}:${f.sol}:${f.isBuy}`;

/**
 * Record one observed fill. Deduplicated — the same fill arriving twice
 * (a reconnect replaying a frame, two tabs hunting at once) lands once.
 * Returns whether the fill was new.
 */
export function journalFill(address: string, fill: RadarFill, firstSeen: number): boolean {
  let rec = records.get(address);
  if (!rec) {
    rec = { address, firstSeen, fills: [] };
    records.set(address, rec);
    if (records.size > RADAR_WALLET_CAP) evictIdlest();
  }
  const key = fillKey(fill);
  if (rec.fills.some((f) => fillKey(f) === key)) return false;
  rec.fills.push(fill);
  // Fills arrive nearly in order; a sort per insert on ≤400 rows is cheap and
  // keeps the replay contract (ascending) unconditional.
  rec.fills.sort((a, b) => a.ts - b.ts);
  if (rec.fills.length > RADAR_FILL_CAP) rec.fills.splice(0, rec.fills.length - RADAR_FILL_CAP);
  persistWallet(address);
  return true;
}

function evictIdlest(): void {
  let idlest: string | null = null;
  let idlestAt = Infinity;
  for (const [addr, rec] of records) {
    const last = rec.fills[rec.fills.length - 1]?.ts ?? rec.firstSeen;
    if (last < idlestAt) {
      idlest = addr;
      idlestAt = last;
    }
  }
  if (idlest !== null) {
    records.delete(idlest);
    persistWallet(idlest); // record gone → the debounced write deletes it
  }
}

export function journalSignal(row: RadarSignalRow): void {
  signals = [row, ...signals].slice(0, RADAR_SIGNAL_CAP);
  persistSignals();
}

/**
 * Fold a grade or an exit into a journaled signal. Returns the patched row,
 * or null when the signal is not in the journal any more (the cap dropped
 * it, or it belonged to a session whose journal was forgotten).
 */
export function journalSignalPatch(key: string, patch: Partial<RadarSignalRow>): RadarSignalRow | null {
  const i = signals.findIndex((s) => (s.signal_key ?? signalKeyOf(s)) === key);
  if (i < 0) return null;
  const next = { ...signals[i], ...patch };
  signals = signals.map((s, j) => (j === i ? next : s));
  persistSignals();
  return next;
}

/** Everything persisted, for the hunter's replay-on-start. */
export function journalWallets(): ReadonlyMap<string, RadarWalletRecord> {
  return records;
}

export function journalSignals(): readonly RadarSignalRow[] {
  return signals;
}

export function journalCounts(): { wallets: number; fills: number; signals: number; loaded: boolean } {
  let fills = 0;
  for (const r of records.values()) fills += r.fills.length;
  return { wallets: records.size, fills, signals: signals.length, loaded };
}

/** Forget one wallet — mirrors the engine evicting it from tracking. */
export function journalDropWallet(address: string): void {
  if (records.delete(address)) persistWallet(address);
}

/**
 * Forget everything the radar has recorded — memory now, disk right behind
 * it. Returns whether the disk copy went too: if IndexedDB refused, the
 * old records come back on the next load, and the caller should say so
 * rather than report a clean slate.
 */
export async function clearRadarJournal(): Promise<boolean> {
  for (const t of pendingWrites.values()) clearTimeout(t);
  pendingWrites.clear();
  records.clear();
  signals = [];
  if (!hasIdb()) return true;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([WALLET_STORE, LOG_STORE], "readwrite");
      tx.objectStore(WALLET_STORE).clear();
      tx.objectStore(LOG_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("radar journal clear failed"));
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Test seam. */
export function resetRadarJournal(): void {
  records.clear();
  signals = [];
  for (const t of pendingWrites.values()) clearTimeout(t);
  pendingWrites.clear();
  loaded = false;
  loadPromise = null;
}
