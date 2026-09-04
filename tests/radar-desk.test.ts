// The copy desk's stores and the journal's grade patches. localStorage is
// shimmed with a Map so the follows store persists the way a browser would.

import { beforeEach, describe, expect, it } from "vitest";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});

const T0 = 1_788_000_000_000;

describe("follows store", () => {
  beforeEach(() => {
    store.clear();
  });

  it("records a follow, marks it, closes it, and keeps the record honest", async () => {
    const f = await import("../src/lib/radar/follows");
    expect(f.followsSnapshot()).toEqual([]);
    const added = f.addFollow({ signalKey: "k1", mint: "MINT", name: "Next", wallet: "W", entryPriceSol: 0.01, sizeSol: 0.2 });
    expect(added).not.toBeNull();
    expect(f.followsSnapshot()).toHaveLength(1);
    expect(f.openFollowMints()).toEqual(["MINT"]);
    // A live mark against the entry.
    expect(f.followReturn(added!, 0.012)).toBeCloseTo(0.2, 6);
    expect(f.followReturn(added!, null)).toBeNull();
    // Closing takes the reader's own exit price, never the mark.
    f.closeFollow(added!.id, 0.015);
    const closed = f.followsSnapshot()[0];
    expect(closed.closedAt).not.toBeNull();
    expect(f.followReturn(closed, 0.001)).toBeCloseTo(0.5, 6);
    expect(f.openFollowMints()).toEqual([]);
    const rec = f.copyRecord(f.followsSnapshot());
    expect(rec.closed).toBe(1);
    expect(rec.median).toBeCloseTo(0.5, 6);
    expect(rec.hitRate).toBe(1);
    expect(rec.pnlSol).toBeCloseTo(0.1, 6);
  });

  it("refuses a follow without a price, and survives a garbage store", async () => {
    const f = await import("../src/lib/radar/follows");
    expect(f.addFollow({ signalKey: null, mint: "M", name: null, wallet: null, entryPriceSol: 0, sizeSol: 1 })).toBeNull();
    store.set("whalenova_follows_v1", "{not json");
    expect(f.followsSnapshot()).toEqual([]);
    store.set("whalenova_follows_v1", JSON.stringify([{ id: "x", mint: "M", entryPriceSol: 0 }, { id: "y", mint: "M", entryPriceSol: 2 }]));
    expect(f.followsSnapshot().map((r) => r.id)).toEqual(["y"]);
  });

  it("the plan sizes a signal from bankroll and risk, with defaults that survive nonsense", async () => {
    const f = await import("../src/lib/radar/follows");
    expect(f.copyPlanSnapshot()).toEqual(f.DEFAULT_PLAN);
    f.setCopyPlan({ bankrollSol: 20, riskPct: 1 });
    expect(f.suggestedSizeSol(f.copyPlanSnapshot())).toBe(0.2);
    store.set("whalenova_copyplan_v1", JSON.stringify({ bankrollSol: -3, riskPct: 42 }));
    expect(f.copyPlanSnapshot()).toEqual(f.DEFAULT_PLAN);
  });

  it("the record ignores open follows and counts hits at +10%", async () => {
    const f = await import("../src/lib/radar/follows");
    const rows = [
      { id: "a", signalKey: null, mint: "M", name: null, wallet: null, entryPriceSol: 1, entryAt: T0, sizeSol: 1, exitPriceSol: 1.5, closedAt: T0 + 1 },
      { id: "b", signalKey: null, mint: "M", name: null, wallet: null, entryPriceSol: 1, entryAt: T0, sizeSol: 1, exitPriceSol: 0.8, closedAt: T0 + 1 },
      { id: "c", signalKey: null, mint: "M", name: null, wallet: null, entryPriceSol: 1, entryAt: T0, sizeSol: 1, exitPriceSol: null, closedAt: null },
    ];
    const rec = f.copyRecord(rows);
    expect(rec.closed).toBe(2);
    expect(rec.median).toBeCloseTo(0.15, 6);
    expect(rec.hitRate).toBe(0.5);
    expect(rec.pnlSol).toBeCloseTo(0.3, 6);
  });
});

describe("journal grade patches", () => {
  it("folds a grade and an exit into the signal by key, and returns null for a stranger", async () => {
    const j = await import("../src/lib/radar/journal");
    j.resetRadarJournal();
    const row = {
      wallet_address: "W",
      wallet_score: 80,
      token_address: "M",
      token_name: null,
      buy_amount_sol: 2,
      timestamp: new Date(T0).toISOString(),
      price_at_signal: 0.01,
    };
    j.journalSignal({ ...row, signal_key: j.signalKeyOf(row) });
    const patched = j.journalSignalPatch(j.signalKeyOf(row), { ret_5m: 0.4, peak_ret_1h: 0.9 });
    expect(patched?.ret_5m).toBe(0.4);
    expect(j.journalSignals()[0].peak_ret_1h).toBe(0.9);
    j.journalSignalPatch(j.signalKeyOf(row), { whale_exit_ret: 0.3, whale_exit_after_ms: 90_000, whale_exit_fraction: 1 });
    expect(j.journalSignals()[0]).toMatchObject({ ret_5m: 0.4, whale_exit_ret: 0.3, whale_exit_fraction: 1 });
    expect(j.journalSignalPatch("nobody:M:never", { ret_1m: 0 })).toBeNull();
    // A row journaled before keys existed is still found by its coordinates.
    j.journalSignal({ ...row, timestamp: new Date(T0 + 1).toISOString() });
    expect(j.journalSignalPatch(`W:M:${new Date(T0 + 1).toISOString()}`, { ret_1m: 0.1 })?.ret_1m).toBe(0.1);
  });
});
