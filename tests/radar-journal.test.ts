// The hunter's journal: dedupe, caps, eviction, and the replay contract —
// evidence in IndexedDB (memory here; node has no IDB, which is the same
// fallback a blocked browser gets), scores always recomputed from it.

import { beforeEach, describe, expect, it } from "vitest";
import { applyFill, newWallet, scoreOf } from "../src/lib/radar/engine/score.js";
import { hunterConfig, HUNTER_DEFAULTS } from "../src/lib/radar/hunter";
import {
  journalCounts,
  journalDropWallet,
  journalFill,
  journalSignal,
  journalSignals,
  journalWallets,
  RADAR_FILL_CAP,
  RADAR_SIGNAL_CAP,
  RADAR_WALLET_CAP,
  radarBackendName,
  resetRadarJournal,
  type RadarFill,
} from "../src/lib/radar/journal";

const T0 = 1_788_000_000_000;
const fill = (over: Partial<RadarFill> = {}): RadarFill => ({
  mint: "MINT1",
  isBuy: true,
  sol: 5,
  tokens: 1000,
  ts: T0,
  sig: "sig-a",
  ...over,
});

beforeEach(() => {
  resetRadarJournal();
});

describe("journalFill", () => {
  it("records a fill and reports it new exactly once", () => {
    expect(journalFill("W1", fill(), T0)).toBe(true);
    expect(journalFill("W1", fill(), T0)).toBe(false);
    expect(journalCounts().fills).toBe(1);
  });

  it("dedupes by coordinates when a signature is absent", () => {
    expect(journalFill("W1", fill({ sig: undefined }), T0)).toBe(true);
    expect(journalFill("W1", fill({ sig: undefined }), T0)).toBe(false);
    expect(journalFill("W1", fill({ sig: undefined, sol: 6 }), T0)).toBe(true);
  });

  it("keeps fills ascending by chain time regardless of arrival order", () => {
    journalFill("W1", fill({ sig: "b", ts: T0 + 2000 }), T0);
    journalFill("W1", fill({ sig: "a", ts: T0 + 1000 }), T0);
    const rec = journalWallets().get("W1")!;
    expect(rec.fills.map((f) => f.sig)).toEqual(["a", "b"]);
  });

  it("caps fills per wallet, oldest out", () => {
    for (let i = 0; i < RADAR_FILL_CAP + 5; i++) journalFill("W1", fill({ sig: `s${i}`, ts: T0 + i }), T0);
    const rec = journalWallets().get("W1")!;
    expect(rec.fills).toHaveLength(RADAR_FILL_CAP);
    expect(rec.fills[0].sig).toBe("s5");
  });

  it("evicts the longest-idle wallet past the wallet cap", () => {
    for (let i = 0; i < RADAR_WALLET_CAP + 1; i++) {
      journalFill(`W${i}`, fill({ sig: `s${i}`, ts: T0 + i * 1000 }), T0);
    }
    expect(journalCounts().wallets).toBe(RADAR_WALLET_CAP);
    expect(journalWallets().has("W0")).toBe(false);
    expect(journalWallets().has(`W${RADAR_WALLET_CAP}`)).toBe(true);
  });

  it("drops a wallet on request", () => {
    journalFill("W1", fill(), T0);
    journalDropWallet("W1");
    expect(journalWallets().has("W1")).toBe(false);
  });
});

describe("journalSignal", () => {
  const row = (i: number) => ({
    wallet_address: "W1",
    wallet_score: 71,
    token_address: `M${i}`,
    token_name: null,
    buy_amount_sol: 2,
    timestamp: new Date(T0 + i).toISOString(),
  });

  it("keeps newest first under the cap", () => {
    for (let i = 0; i < RADAR_SIGNAL_CAP + 10; i++) journalSignal(row(i));
    const rows = journalSignals();
    expect(rows).toHaveLength(RADAR_SIGNAL_CAP);
    expect(rows[0].token_address).toBe(`M${RADAR_SIGNAL_CAP + 9}`);
  });
});

describe("replay contract", () => {
  it("recomputes the same score from journaled evidence that direct application produced", () => {
    const live = newWallet(T0);
    for (let i = 0; i < 6; i++) {
      const buy = { mint: `P${i}`, isBuy: true, sol: 10, tokens: 1000, ts: T0 + i * 10 };
      const sell = { mint: `P${i}`, isBuy: false, sol: 25, tokens: 1000, ts: T0 + i * 10 + 5 };
      applyFill(live, buy);
      applyFill(live, sell);
      journalFill("W1", { ...buy, sig: `b${i}` }, T0);
      journalFill("W1", { ...sell, sig: `s${i}` }, T0);
    }
    const rec = journalWallets().get("W1")!;
    const replayed = newWallet(rec.firstSeen);
    for (const f of rec.fills) applyFill(replayed, { mint: f.mint, isBuy: f.isBuy, sol: f.sol, tokens: f.tokens, ts: f.ts });
    expect(scoreOf(replayed)).toBe(scoreOf(live));
    expect(replayed.settledSells).toBe(live.settledSells);
    expect(replayed.realizedSol).toBeCloseTo(live.realizedSol, 9);
  });
});

describe("environment", () => {
  it("degrades to the memory backend where IndexedDB is absent", () => {
    expect(radarBackendName()).toBe("memory");
  });

  it("hunterConfig answers defaults where localStorage is absent", () => {
    const cfg = hunterConfig();
    expect(cfg.on).toBe(false);
    expect(cfg.thresholdSol).toBe(HUNTER_DEFAULTS.whaleThresholdSol);
  });
});
