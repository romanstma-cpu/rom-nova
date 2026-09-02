// The signal handlers, on both paths.
//
// The rules under test: live when the token list resolves and the registry
// has a pass, dated by the PASS; the simulator on `asOf` however live the
// stack is, and on a list that does not answer — labelled either way; a live
// id recomputes on the detail path and carries the registry's lifecycle; and
// /api/accuracy never hands back simulated statistics under a live page.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DemoStore } from "@/lib/demo/store";
import { extractFeatures } from "@/lib/engine/features";
import { auditFactors, scoreFeatures } from "@/lib/engine/signals";
import { __resetLiveSignals, observeLivePass } from "@/lib/live/signals";
import { lastOutcome, resetOutcomes } from "@/lib/providers/health-log";
import type { LiveFeatureResult } from "@/lib/engine/live-features";
import type { LiveTokenDetail } from "@/lib/api/detail";
import type { FeatureVector, StrategyProfileId, TokenInfo, TokenSnapshot } from "@/lib/types";

// What the live list and the detail path answer, set per test.
const stubs = vi.hoisted(() => ({
  list: null as null | { data: never[]; provenance: { source: string; real: boolean } },
  detail: null as null | ((mint: string, profile: string) => Promise<unknown>),
}));

vi.mock("@/lib/api/source", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api/source")>();
  return { ...orig, trendingRows: async () => stubs.list };
});

vi.mock("@/lib/api/detail", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api/detail")>();
  return {
    ...orig,
    liveTokenDetail: async (mint: string, profile: string) => {
      if (!stubs.detail) return null;
      return stubs.detail(mint, profile);
    },
  };
});

import { ApiError, handleAccuracy, handleSignalById, handleSignals } from "@/lib/api/handlers";

const store = new DemoStore(77);
const demoNow = store.universe.genesis;
const demoMint = store.tokenList()[0].info.mint;
const MINT_A = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk";
const T0 = 1_760_000_000_000;
const LIVE = { data: [] as never[], provenance: { source: "jupiter", real: true } };

function strong(mint: string, over: Partial<FeatureVector> = {}): FeatureVector {
  return {
    ...extractFeatures(store, demoMint, demoNow)!,
    mint,
    liquidityUsd: 5_000_000,
    liquidityChangePct: 20,
    holderGrowthPct: 25,
    momentum1h: 8,
    momentum24h: 30,
    volumeAccel: 2.6,
    organicScore: 0.97,
    socialScore: 0.8,
    top10Pct: 0.12,
    devHoldsPct: 0,
    insiderPct: 0,
    bundlerPct: 0,
    sniperPct: 0,
    devSold: false,
    buySellImbalance: 0.4,
    exitDepthUsd: 900_000,
    smartMoneyNetFlowUsd: 0,
    smartMoneyWallets: 0,
    whaleNetFlowUsd: 400_000,
    whaleBuys: 5,
    whaleSells: 0,
    flowWindowMs: 600_000,
    ageHours: 400,
    sampleSize: 120,
    worstStalenessMs: 0,
    regime: "risk_on",
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    permanentDelegate: false,
    lpLockedPct: 1,
    lpProviders: 12,
    devMints: 1,
    devMigrations: 1,
    unmeasured: ["smartMoney", "socialScore", "devSold"],
    ...over,
  };
}

const info = (mint: string, symbol: string) =>
  ({ mint, name: `${symbol} Token`, symbol, createdAt: T0 - 400 * 3_600_000, decimals: 6, hue: 200 }) as unknown as TokenInfo;

function result(mint: string, symbol: string, over: Partial<FeatureVector> = {}): LiveFeatureResult {
  return {
    features: strong(mint, over),
    info: info(mint, symbol),
    snapshot: { mint, ts: T0, priceUsd: 1 } as unknown as TokenSnapshot,
    candles: [],
    provenance: ["jupiter: token info + snapshot"],
    authorityChecked: true,
    authoritySource: "solana-rpc",
  };
}

function detailFor(mint: string, profile: string, over: Partial<FeatureVector> = {}): LiveTokenDetail {
  const now = T0 + 90_000;
  const signal = scoreFeatures(strong(mint, over), mint, now, profile as StrategyProfileId);
  return {
    mode: "live",
    info: info(mint, "AAA"),
    snapshot: { mint, ts: now, priceUsd: 1 } as unknown as TokenSnapshot,
    signal,
    audit: auditFactors(signal),
    holders: { rows: [], labelled: 0, listedPct: 0 },
    creator: { holdsUnmeasured: true },
    supply: {},
    authorityChecked: true,
    authoritySource: "solana-rpc + rugcheck",
    disagreements: [],
    provenance: ["jupiter: token info + snapshot", "rugcheck: full report"],
    source: "jupiter",
    asOf: now,
  };
}

beforeEach(() => {
  __resetLiveSignals();
  resetOutcomes();
  stubs.list = null;
  stubs.detail = null;
});

describe("handleSignals — the feed", () => {
  it("serves the live feed, dated by the pass, when the list answers", async () => {
    stubs.list = LIVE;
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const r = await handleSignals(store, "balanced");
    expect(r.demo).toBe(false);
    expect(r.provenance).toEqual({ source: "jupiter", real: true });
    expect(r.asOf).toBe(T0);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0].mint).toBe(MINT_A);
    expect(r.signals[0].symbol).toBe("AAA");
    expect("live" in r && r.live?.corpus).toBe(12);
    expect("live" in r && r.live?.note).toMatch(/not the whole chain/);
    expect("live" in r && r.live?.cadence.medianMs).toBeNull();
    expect(lastOutcome("signals")?.ok).toBe(true);
  });

  it("scores the requested profile from the same pass", async () => {
    stubs.list = LIVE;
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const r = await handleSignals(store, "momentum");
    expect(r.demo).toBe(false);
    expect(r.signals[0].profile).toBe("momentum");
    expect(r.signals[0].id).toMatch(/-momentum$/);
  });

  // A replay is not something a live source can answer, however live it is.
  it("serves the simulator on asOf, labelled, and records no failure", async () => {
    stubs.list = LIVE;
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const r = await handleSignals(store, "balanced", demoNow - 3_600_000);
    expect(r.demo).toBe(true);
    expect(r.provenance.source).toBe("demo");
    expect(r.provenance.note).toMatch(/replay of a past moment/);
    expect(r.signals.some((s) => s.mint === MINT_A)).toBe(false);
    expect(r.signals.length).toBeGreaterThan(0);
    // The pass above recorded an ok; a replay must not overwrite it with a
    // failure — nothing failed, a question was asked that live cannot answer.
    expect(lastOutcome("signals")?.ok).toBe(true);
  });

  it("falls to the simulator, labelled, when no live list answers — and says so to dataMode", async () => {
    stubs.list = null;
    const r = await handleSignals(store, "balanced");
    expect(r.demo).toBe(true);
    expect(r.provenance.source).toBe("demo");
    expect(r.provenance.note).toMatch(/live signals unavailable/);
    expect(lastOutcome("signals")?.ok).toBe(false);
  });

  it("never reads simulated data on the live path", async () => {
    stubs.list = LIVE;
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const r = await handleSignals(store, "balanced");
    const demoMints = new Set(store.tokenList().map((t) => t.info.mint));
    for (const s of r.signals) expect(demoMints.has(s.mint)).toBe(false);
  });
});

describe("handleSignalById — one signal, on the detail path", () => {
  it("rejects a malformed id", async () => {
    await expect(handleSignalById(store, "nope")).rejects.toMatchObject({ status: 400 });
  });

  it("recomputes a live id on the detail path and carries the registry's lifecycle", async () => {
    stubs.list = LIVE;
    stubs.detail = async (mint, profile) => detailFor(mint, profile);
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    observeLivePass({ at: T0 + 30_000, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const id = (await handleSignals(store, "balanced")).signals[0].id;
    const r = await handleSignalById(store, id);
    expect(r.demo).toBe(false);
    expect(r.signal.id).toBe(id);
    expect(r.signal.createdAt).toBe(T0);
    expect(r.signal.updatedAt).toBe(T0 + 90_000);
    expect(r.signal.lifecycle[0]).toMatchObject({ state: "created", ts: T0 });
    expect(r.symbol).toBe("AAA");
    expect("provenance" in r && r.provenance).toContain("rugcheck: full report");
    expect("audit" in r && r.audit?.rows.length).toBeGreaterThan(0);
    expect("live" in r && r.live?.passes).toBe(2);
    expect("live" in r && r.live?.measuredOn).toBe("/track");
    expect("live" in r && r.live?.currentId).toBeUndefined();
  });

  it("shows an expired signal's ending and points at the one that replaced it", async () => {
    stubs.list = LIVE;
    stubs.detail = async (mint, profile) => detailFor(mint, profile, { mintAuthorityRevoked: false });
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const oldId = (await handleSignals(store, "balanced")).signals[0].id;
    observeLivePass({ at: T0 + 30_000, source: "jupiter", rows: [result(MINT_A, "AAA", { mintAuthorityRevoked: false })] });
    const newId = (await handleSignals(store, "balanced")).signals[0].id;
    expect(newId).not.toBe(oldId);
    const r = await handleSignalById(store, oldId);
    expect(r.signal.id).toBe(oldId);
    expect(r.signal.lifecycle.at(-1)).toMatchObject({ state: "expired", ts: T0 + 30_000 });
    expect("live" in r && r.live?.expiredAt).toBe(T0 + 30_000);
    expect("live" in r && r.live?.currentId).toBe(newId);
    // The detail is what the mint looks like NOW, which is the veto.
    expect(r.signal.label).toBe("EXTREME RISK");
  });

  it("reports a live failure as a source problem, not as an unknown signal", async () => {
    stubs.list = LIVE;
    stubs.detail = async () => {
      throw new Error("429 rate limited");
    };
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const id = (await handleSignals(store, "balanced")).signals[0].id;
    await expect(handleSignalById(store, id)).rejects.toMatchObject({ status: 503 });
    await expect(handleSignalById(store, id)).rejects.toThrow(/429 rate limited/);
    await expect(handleSignalById(store, id)).rejects.toThrow(/not a verdict/);
  });

  it("gives the simulator its turn for a prefix this session never scored", async () => {
    stubs.list = LIVE;
    const demoId = `sig-${demoMint.slice(0, 8)}-${Math.floor(demoNow / (2 * 3_600_000))}-balanced`;
    const r = await handleSignalById(store, demoId);
    expect(r.demo).toBe(true);
    expect(r.signal.mint).toBe(demoMint);
    await expect(handleSignalById(store, "sig-zzzzzzzz-1-balanced")).rejects.toBeInstanceOf(ApiError);
    await expect(handleSignalById(store, "sig-zzzzzzzz-1-balanced")).rejects.toMatchObject({ status: 404 });
  });
});

describe("handleAccuracy — no fabricated accuracy on the live path", () => {
  it("hands back the simulator's self-grade, labelled, before any live pass", () => {
    const r = handleAccuracy(store, "balanced");
    expect(r.demo).toBe(true);
    expect(r.stats).not.toBeNull();
    expect(r.stats!.profile).toBe("balanced");
    expect("note" in r && r.note).toMatch(/synthetic/);
  });

  it("points at Track Record, with no statistics, once a live pass has landed", () => {
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const r = handleAccuracy(store, "balanced");
    expect(r.demo).toBe(false);
    expect(r.stats).toBeNull();
    expect("measuredOn" in r && r.measuredOn?.href).toBe("/track");
    expect("measuredOn" in r && r.measuredOn?.note).toMatch(/never from the simulator/);
    expect("pass" in r && r.pass).toEqual({ at: T0, source: "jupiter" });
  });

  it("still serves the simulator's numbers when a simulated page asks for them by name", () => {
    observeLivePass({ at: T0, source: "jupiter", rows: [result(MINT_A, "AAA")] });
    const r = handleAccuracy(store, "balanced", "simulated");
    expect(r.demo).toBe(true);
    expect(r.stats).not.toBeNull();
  });
});
