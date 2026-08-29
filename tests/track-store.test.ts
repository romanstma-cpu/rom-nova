// The ledger's storage layer. Its failure modes are quiet ones: a scanner that
// records the same cached snapshot four times manufactures independent trials
// out of one observation, and that error flows straight into the confidence
// interval on the track-record page.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  MAX_OBSERVATIONS,
  MIN_PASS_INTERVAL_MS,
  appendPass,
  clearLedger,
  loadLedger,
  prune,
  saveLedger,
} from "@/lib/track-store";
import type { Observation } from "@/lib/engine/track-record";

// A minimal in-memory localStorage. Node's own is behind a flag and vitest runs
// without a DOM here.
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

const T0 = 1_800_000_000_000;

function row(mint: string, score = 60) {
  return { mint, symbol: mint, score, confidence: 0.7, priceUsd: 100, profile: "balanced", unmeasuredCount: 0 };
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: new MemStorage() });
  clearLedger();
});

afterEach(() => vi.unstubAllGlobals());

describe("appendPass — one pass is one trial", () => {
  it("writes every row of a pass under a single shared timestamp", () => {
    const led = appendPass([row("A"), row("B"), row("C")], T0);
    expect(led).toHaveLength(3);
    expect(new Set(led.map((o) => o.ts)).size).toBe(1);
  });

  it("rejects a second pass inside the minimum interval", () => {
    // The scanner polls every 8s against a 30s cache, so four polls in five
    // re-render already-recorded data. Recording those would fabricate passes
    // 8 seconds apart carrying identical prices, which the cluster bootstrap
    // counts as independent evidence.
    appendPass([row("A")], T0);
    const after = appendPass([row("A")], T0 + 8_000);
    expect(after).toHaveLength(1);
  });

  it("accepts the next pass once the interval has elapsed", () => {
    appendPass([row("A")], T0);
    const after = appendPass([row("A")], T0 + MIN_PASS_INTERVAL_MS);
    expect(after).toHaveLength(2);
  });

  it("ignores an empty pass rather than storing a marker for it", () => {
    appendPass([row("A")], T0);
    const after = appendPass([], T0 + MIN_PASS_INTERVAL_MS);
    expect(after).toHaveLength(1);
  });
});

describe("prune", () => {
  it("keeps the NEWEST observations when over the cap", () => {
    // Losing the recent end would leave a ledger whose horizons can never
    // resolve — every observation old, every resolving price discarded.
    const many: Observation[] = Array.from({ length: MAX_OBSERVATIONS + 500 }, (_, i) => ({
      ...row(`M${i}`),
      ts: T0 + i,
    }));
    const kept = prune(many, T0 + MAX_OBSERVATIONS + 500);
    expect(kept).toHaveLength(MAX_OBSERVATIONS);
    expect(kept[kept.length - 1].ts).toBe(T0 + MAX_OBSERVATIONS + 499);
  });

  it("drops observations past the age limit", () => {
    const old: Observation = { ...row("OLD"), ts: T0 - 40 * 24 * 3_600_000 };
    const fresh: Observation = { ...row("NEW"), ts: T0 };
    expect(prune([old, fresh], T0).map((o) => o.mint)).toEqual(["NEW"]);
  });
});

describe("loadLedger — a corrupted store must not reach the statistics", () => {
  it("returns empty for junk rather than throwing", () => {
    (window as unknown as { localStorage: MemStorage }).localStorage.setItem(
      "rom-nova.track-ledger.v1",
      "{not json",
    );
    expect(loadLedger()).toEqual([]);
  });

  it("drops rows with a non-finite price or timestamp", () => {
    // A half-written quota failure can leave NaN in the store. Reaching the
    // report, it produces intervals that look computed and mean nothing.
    saveLedger([
      { ...row("GOOD"), ts: T0 },
      { ...row("BAD"), ts: T0, priceUsd: NaN },
      { ...row("ALSOBAD"), ts: NaN },
    ] as Observation[]);
    expect(loadLedger().map((o) => o.mint)).toEqual(["GOOD"]);
  });

  it("survives storage being unavailable entirely", () => {
    // Private windows with site data blocked throw on access rather than
    // returning null, and a scanner must not crash because it could not keep a
    // record.
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(loadLedger()).toEqual([]);
    expect(() => appendPass([row("A")], T0)).not.toThrow();
  });
});
