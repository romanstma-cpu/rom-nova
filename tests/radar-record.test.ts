// The radar's own track record over journaled signals, and the cost the
// desk nets everything against.

import { describe, expect, it } from "vitest";
import { EXIT_BEFORE_YOU_MS, HIT_RET, netOf, signalRecord } from "../src/lib/radar/record";
import type { RadarSignalRow } from "../src/lib/radar/journal";

const T0 = 1_788_000_000_000;
const row = (over: Partial<RadarSignalRow> & { wallet_address: string; at?: number }): RadarSignalRow => ({
  wallet_score: 80,
  token_address: "M",
  token_name: null,
  buy_amount_sol: 1,
  timestamp: new Date(over.at ?? T0).toISOString(),
  price_at_signal: 0.01,
  ...over,
});

describe("signalRecord", () => {
  it("is empty and honest with nothing graded", () => {
    const r = signalRecord([], 2.5);
    expect(r.signals).toBe(0);
    expect(r.horizons.every((h) => h.graded === 0 && h.medianGross === null && h.hitRate === null)).toBe(true);
    expect(r.exits).toEqual({ n: 0, medianRet: null, medianAfterMs: null, beforeYou: 0 });
    expect(r.byWallet).toEqual([]);
  });

  it("medians each horizon, nets the cost, counts hits at the fee bar, and flags stale grades", () => {
    const rows = [
      row({ wallet_address: "A", ret_1m: 0.05, ret_5m: 0.5, ret_15m: 0.2, ret_1h: -0.3, peak_ret_1h: 1.2 }),
      row({ wallet_address: "A", ret_1m: 0.02, ret_5m: 0.12, ret_15m: null, ret_1h: null, peak_ret_1h: 0.3, at: T0 + 1000 }),
      row({ wallet_address: "B", ret_1m: -0.1, ret_5m: -0.4, ret_15m: -0.5, ret_1h: -0.6, graded_stale: true, graded_lookup: true, at: T0 + 2000 }),
      row({ wallet_address: "C", at: T0 + 3000 }), // ungraded
    ];
    const r = signalRecord(rows, 2.5);
    expect(r.signals).toBe(4);
    expect(r.wallets).toBe(3);
    const m5 = r.horizons.find((h) => h.horizon === "m5")!;
    expect(m5.graded).toBe(3);
    expect(m5.medianGross).toBeCloseTo(0.12, 9);
    expect(m5.medianNet).toBeCloseTo(0.095, 9);
    expect(m5.hitRate).toBeCloseTo(2 / 3, 9);
    expect(m5.stale).toBe(1);
    const m15 = r.horizons.find((h) => h.horizon === "m15")!;
    expect(m15.graded).toBe(2);
    expect(m15.medianGross).toBeCloseTo(-0.15, 9);
    expect(r.peakMedian).toBeCloseTo(0.75, 9);
    expect(r.staleAny).toBe(1);
    expect(r.lookupAny).toBe(1);
    expect(netOf(0.1, 2.5)).toBeCloseTo(0.075, 9);
    expect(HIT_RET).toBe(0.1);
  });

  it("ranks wallets by their five-minute median once they have two grades, and reads exits", () => {
    const rows = [
      row({ wallet_address: "A", ret_5m: 0.5, whale_exit_ret: 0.4, whale_exit_after_ms: 30_000 }),
      row({ wallet_address: "A", ret_5m: 0.3, whale_exit_ret: 0.1, whale_exit_after_ms: 300_000, at: T0 + 1 }),
      row({ wallet_address: "B", ret_5m: 0.9, at: T0 + 2 }), // one grade: not ranked
      row({ wallet_address: "C", ret_5m: -0.2, at: T0 + 3 }),
      row({ wallet_address: "C", ret_5m: -0.1, whale_exit_ret: -0.05, whale_exit_after_ms: 10_000, at: T0 + 4 }),
    ];
    const r = signalRecord(rows, 2.5);
    expect(r.byWallet.map((w) => w.wallet)).toEqual(["A", "C"]);
    expect(r.byWallet[0]).toMatchObject({ signals: 2, graded: 2, median5m: 0.4, hit5m: 1, exits: 2, medianExitAfterMs: 165_000 });
    expect(r.exits.n).toBe(3);
    expect(r.exits.medianRet).toBeCloseTo(0.1, 9);
    expect(r.exits.beforeYou).toBe(2);
    expect(EXIT_BEFORE_YOU_MS).toBe(60_000);
  });

  it("buckets by day, newest first, capped at fourteen", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ wallet_address: "A", ret_5m: i % 2 ? 0.2 : -0.2, at: T0 + i * 86_400_000 }));
    const r = signalRecord(rows, 0);
    expect(r.byDay).toHaveLength(14);
    expect(r.byDay[0].day > r.byDay[1].day).toBe(true);
    expect(r.byDay[0].graded).toBe(1);
  });
});
