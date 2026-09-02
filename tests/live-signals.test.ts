// The live signals feed, from the scored list to the bus.
//
// Everything `/signals` shows on the live path descends from `observeLivePass`
// and nothing here touches the simulator. These pin the four properties the
// contract names: id stability across passes, the lifecycle (new / updated /
// expired), one `signal_created` per mint per 45 minutes when a positive band
// is FIRST reached, and a cadence figure that refuses to be a number until it
// has two passes to measure.

import { describe, it, expect, beforeEach } from "vitest";
import { DemoStore } from "@/lib/demo/store";
import { extractFeatures } from "@/lib/engine/features";
import { subscribeLiveEvents, type LiveEvent } from "@/lib/live/bus";
import {
  __resetLiveSignals,
  achievedCadence,
  lastLivePass,
  liveSignalsFor,
  liveTrackFor,
  observeLivePass,
  recentLiveSignalEvents,
  resolveLiveMint,
  SIGNAL_EVENT_DEDUPE_MS,
} from "@/lib/live/signals";
import { lastOutcome, resetOutcomes } from "@/lib/providers/health-log";
import { POSITIVE_LABELS } from "@/lib/engine/signals";
import type { LiveFeatureResult } from "@/lib/engine/live-features";
import type { FeatureVector, TokenInfo, TokenSnapshot } from "@/lib/types";

const store = new DemoStore(77);
const demoNow = store.universe.genesis;
const demoMint = store.tokenList()[0].info.mint;

// Real-shaped mints, none of which the simulator has heard of.
const MINT_A = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk";
const MINT_B = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
const T0 = 1_760_000_000_000;
const MIN = 60_000;

/** A strong live vector — a vector the scorer calls POSITIVE when it is safe. */
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
    flowWindowMs: 10 * MIN,
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

function result(mint: string, symbol: string, over: Partial<FeatureVector> = {}): LiveFeatureResult {
  const features = strong(mint, over);
  const info = {
    mint,
    name: `${symbol} Token`,
    symbol,
    createdAt: T0 - 400 * 3_600_000,
    decimals: 6,
    narrative: "Meme",
    verified: false,
    mintAuthorityRevoked: features.mintAuthorityRevoked,
    freezeAuthorityRevoked: features.freezeAuthorityRevoked,
    permanentDelegate: false,
    devWallet: "",
    hue: 120,
  } as unknown as TokenInfo;
  const snapshot = { mint, ts: T0, priceUsd: 1 } as unknown as TokenSnapshot;
  return {
    features,
    info,
    snapshot,
    candles: [],
    provenance: ["jupiter: token info + snapshot", "solana-rpc: mint revoked, freeze revoked"],
    authorityChecked: true,
    authoritySource: "solana-rpc",
    risk: { source: "rugcheck" } as LiveFeatureResult["risk"],
  };
}

const pass = (at: number, rows: LiveFeatureResult[]) => observeLivePass({ at, source: "jupiter", rows });

beforeEach(() => {
  __resetLiveSignals();
  resetOutcomes();
});

describe("nothing before the first pass", () => {
  it("answers null rather than an empty feed", () => {
    expect(liveSignalsFor("balanced")).toBeNull();
    expect(lastLivePass()).toBeNull();
    expect(achievedCadence()).toEqual({ medianMs: null, samples: 0, lastGapMs: null });
  });
});

describe("materialising a signal from a scored row", () => {
  it("builds one Signal per row in the demo id scheme, and the row gets the same id", () => {
    const ids = pass(T0, [result(MINT_A, "AAA")]);
    const feed = liveSignalsFor("balanced")!;
    expect(feed.signals).toHaveLength(1);
    const s = feed.signals[0];
    // The demo handler's regex, verbatim. The number is the creation second.
    expect(s.id).toMatch(/^sig-([A-Za-z0-9]{8})-(\d+)-([a-z_]+)$/);
    expect(s.id).toBe(`sig-${MINT_A.slice(0, 8)}-${Math.floor(T0 / 1000)}-balanced`);
    expect(ids.get(MINT_A)).toBe(s.id);
    expect(s.symbol).toBe("AAA");
    expect(s.source).toBe("jupiter");
    expect(s.provenance).toContain("jupiter: token info + snapshot");
    expect(POSITIVE_LABELS).toContain(s.label);
  });

  it("keeps the id stable across passes while the label holds, and dates it honestly", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    const first = liveSignalsFor("balanced")!.signals[0];
    pass(T0 + 30_000, [result(MINT_A, "AAA")]);
    const second = liveSignalsFor("balanced")!.signals[0];
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(T0);
    expect(second.updatedAt).toBe(T0 + 30_000);
    expect(second.live.passes).toBe(2);
    expect(second.lifecycle[0]).toMatchObject({ state: "created", ts: T0 });
    // Score unchanged and over 64: confirmed, as `signalsAt` would note it.
    expect(second.lifecycle.at(-1)).toMatchObject({ state: "confirmed", ts: T0 + 30_000 });
  });

  // Two hours later the demo scheme would mint a new bucket; the live id must
  // not, or every link on the page goes stale on the hour.
  it("does not roll the id when the bucket clock rolls", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    const first = liveSignalsFor("balanced")!.signals[0];
    pass(T0 + 3 * 3_600_000, [result(MINT_A, "AAA")]);
    expect(liveSignalsFor("balanced")!.signals[0].id).toBe(first.id);
  });

  // Two vectors probed to land in ONE band nineteen points apart: a flat tape
  // (81, STRONG POSITIVE) and a two-hour-old token whose low confidence keeps
  // a 100 out of EXTREME POSITIVE. The precondition is asserted so a retune
  // that splits the pair fails loudly instead of skipping the check.
  const flat = { whaleNetFlowUsd: 40_000, volumeAccel: 1, holderGrowthPct: 0, liquidityChangePct: 0, buySellImbalance: 0 };
  const young = { ageHours: 2 };

  it("notes a strengthened signal with the move it made", () => {
    pass(T0, [result(MINT_A, "AAA", flat)]);
    const s1 = liveSignalsFor("balanced")!.signals[0];
    pass(T0 + 30_000, [result(MINT_A, "AAA", young)]);
    const s2 = liveSignalsFor("balanced")!.signals[0];
    expect(s2.label).toBe(s1.label);
    expect(s2.score - s1.score).toBeGreaterThanOrEqual(6);
    expect(s2.id).toBe(s1.id);
    expect(s2.lifecycle.at(-1)).toMatchObject({ state: "strengthened", ts: T0 + 30_000, note: `${s1.score} → ${s2.score}` });
  });

  it("notes a weakened signal without ending it", () => {
    pass(T0, [result(MINT_A, "AAA", young)]);
    const s1 = liveSignalsFor("balanced")!.signals[0];
    pass(T0 + 30_000, [result(MINT_A, "AAA", flat)]);
    const s2 = liveSignalsFor("balanced")!.signals[0];
    expect(s2.label).toBe(s1.label);
    expect(s1.score - s2.score).toBeGreaterThanOrEqual(6);
    expect(s2.id).toBe(s1.id);
    expect(s2.lifecycle.at(-1)).toMatchObject({ state: "weakened", note: `${s1.score} → ${s2.score}` });
    expect(liveSignalsFor("balanced")!.stats).toEqual({ fresh: 0, updated: 1, expired: 0 });
  });

  it("reports the pass it came from, not the moment it was asked", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    const feed = liveSignalsFor("balanced")!;
    expect(feed.pass).toMatchObject({ at: T0, source: "jupiter", seq: 1, mints: 1 });
    expect(lastLivePass()).toMatchObject({ at: T0, source: "jupiter" });
  });
});

describe("lifecycle across passes", () => {
  it("counts fresh, updated and expired against the previous pass", () => {
    pass(T0, [result(MINT_A, "AAA"), result(MINT_B, "BBB")]);
    expect(liveSignalsFor("balanced")!.stats).toEqual({ fresh: 2, updated: 0, expired: 0 });
    pass(T0 + 30_000, [result(MINT_A, "AAA")]);
    expect(liveSignalsFor("balanced")!.stats).toEqual({ fresh: 0, updated: 1, expired: 1 });
  });

  it("starts a new signal when the label changes and retires the old one with the reason", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    const before = liveSignalsFor("balanced")!.signals[0];
    // A live mint authority vetoes the label whatever the tape did.
    pass(T0 + 30_000, [result(MINT_A, "AAA", { mintAuthorityRevoked: false })]);
    const feed = liveSignalsFor("balanced")!;
    const after = feed.signals[0];
    expect(after.label).toBe("EXTREME RISK");
    // Thirty seconds apart, inside one two-hour bucket: the ids must differ.
    expect(after.id).not.toBe(before.id);
    expect(after.createdAt).toBe(T0 + 30_000);
    expect(after.lifecycle[0].note).toBe(`moved ${before.label} → EXTREME RISK`);
    expect(feed.stats).toEqual({ fresh: 1, updated: 0, expired: 1 });
    const old = liveTrackFor(MINT_A, "balanced", before.id)!;
    expect(old.id).toBe(before.id);
    expect(old.expiredAt).toBe(T0 + 30_000);
    expect(old.lifecycle.at(-1)).toMatchObject({ state: "expired", note: `label ${before.label} → EXTREME RISK` });
  });

  it("expires a mint that leaves the list without calling it invalidated", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    const id = liveSignalsFor("balanced")!.signals[0].id;
    pass(T0 + 30_000, [result(MINT_B, "BBB")]);
    expect(liveSignalsFor("balanced")!.signals.map((s) => s.mint)).toEqual([MINT_B]);
    const gone = liveTrackFor(MINT_A, "balanced", id)!;
    expect(gone.expiredAt).toBe(T0 + 30_000);
    expect(gone.lifecycle.at(-1)!.note).toMatch(/left the trending list/);
    expect(gone.lifecycle.at(-1)!.note).toMatch(/not invalidated/);
  });

  it("still resolves the prefix of a mint that has left the list", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    pass(T0 + 30_000, []);
    expect(resolveLiveMint(MINT_A.slice(0, 8))).toBe(MINT_A);
    expect(resolveLiveMint("zzzzzzzz")).toBeNull();
  });
});

describe("every profile from the same measured vector", () => {
  it("scores a profile on request and dates its history from that pass", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    pass(T0 + 30_000, [result(MINT_A, "AAA")]);
    const mom = liveSignalsFor("momentum")!;
    expect(mom.signals[0].profile).toBe("momentum");
    expect(mom.signals[0].id).toMatch(/-momentum$/);
    // Nobody asked for momentum until now, so its history starts now.
    expect(mom.signals[0].createdAt).toBe(T0 + 30_000);
    expect(mom.stats).toEqual({ fresh: 1, updated: 0, expired: 0 });
    // And advances with later passes once asked for.
    pass(T0 + 60_000, [result(MINT_A, "AAA")]);
    expect(liveSignalsFor("momentum")!.signals[0].live.passes).toBe(2);
  });
});

describe("signal_created on the live bus", () => {
  const collect = (): LiveEvent[] => {
    const seen: LiveEvent[] = [];
    subscribeLiveEvents((e) => seen.push(e));
    return seen;
  };

  it("emits once, real and sourced, when a mint first reaches a positive band", () => {
    const seen = collect();
    pass(T0, [result(MINT_A, "AAA")]);
    pass(T0 + 30_000, [result(MINT_A, "AAA")]);
    const sigs = seen.filter((e) => e.kind === "signal_created");
    expect(sigs).toHaveLength(1);
    const e = sigs[0];
    const s = liveSignalsFor("balanced")!.signals[0];
    expect(POSITIVE_LABELS).toContain(s.label);
    expect(e.real).toBe(true);
    expect(e.source).toBe("signals-live");
    expect(e.mint).toBe(MINT_A);
    expect(e.symbol).toBe("AAA");
    expect(e.ts).toBe(T0);
    expect(e.confidence).toBe(s.confidence);
    expect(e.headline).toBe(`LIVE SIGNAL ${s.score}/100 · ${s.label}`);
    // The measured basis: which sources answered, what stood down, the window.
    expect(e.detail).toMatch(/measured on jupiter \+ solana-rpc \+ rugcheck/);
    expect(e.detail).toMatch(/3 inputs unmeasured \(smartMoney, socialScore, devSold\)/);
    expect(e.detail).toMatch(/flow window 10 min/);
    expect(e.detail).toContain(`first seen on the list at ${s.label}`);
    expect(recentLiveSignalEvents()).toHaveLength(1);
  });

  it("stays silent for labels that are not an invitation", () => {
    const seen = collect();
    pass(T0, [
      result(MINT_A, "AAA", { mintAuthorityRevoked: false }),
      result(MINT_B, "BBB", { liquidityUsd: 10_000, exitDepthUsd: 1_800 }),
    ]);
    const labels = liveSignalsFor("balanced")!.signals.map((s) => s.label);
    expect(labels).not.toContain("POSITIVE");
    expect(labels).not.toContain("STRONG POSITIVE");
    expect(seen.filter((e) => e.kind === "signal_created")).toHaveLength(0);
  });

  it("says when a mint climbed into the band rather than arriving in it", () => {
    const seen = collect();
    pass(T0, [result(MINT_A, "AAA", { mintAuthorityRevoked: false })]);
    pass(T0 + 30_000, [result(MINT_A, "AAA")]);
    const e = seen.find((x) => x.kind === "signal_created")!;
    expect(e.detail).toMatch(/moved EXTREME RISK → (EXTREME |STRONG )?POSITIVE/);
  });

  it("dedupes per mint for 45 minutes, then speaks again", () => {
    const seen = collect();
    const veto = { mintAuthorityRevoked: false };
    pass(T0, [result(MINT_A, "AAA")]); // emits
    pass(T0 + 5 * MIN, [result(MINT_A, "AAA", veto)]); // retires
    pass(T0 + 10 * MIN, [result(MINT_A, "AAA")]); // new track, inside the window: silent
    expect(seen.filter((e) => e.kind === "signal_created")).toHaveLength(1);
    pass(T0 + 20 * MIN, [result(MINT_A, "AAA", veto)]);
    pass(T0 + SIGNAL_EVENT_DEDUPE_MS + MIN, [result(MINT_A, "AAA")]); // outside: speaks
    expect(seen.filter((e) => e.kind === "signal_created")).toHaveLength(2);
    expect(SIGNAL_EVENT_DEDUPE_MS).toBe(45 * MIN);
  });

  it("dedupes per mint, not per pass", () => {
    const seen = collect();
    pass(T0, [result(MINT_A, "AAA"), result(MINT_B, "BBB")]);
    expect(seen.filter((e) => e.kind === "signal_created").map((e) => e.mint).sort()).toEqual([MINT_A, MINT_B].sort());
  });
});

describe("what the pass records for the rest of the app", () => {
  it("measures the achieved cadence from the passes that landed", () => {
    pass(T0, [result(MINT_A, "AAA")]);
    expect(achievedCadence()).toEqual({ medianMs: null, samples: 0, lastGapMs: null });
    pass(T0 + 30_000, [result(MINT_A, "AAA")]);
    expect(achievedCadence()).toEqual({ medianMs: 30_000, samples: 1, lastGapMs: 30_000 });
    pass(T0 + 60_000, [result(MINT_A, "AAA")]);
    pass(T0 + 100_000, [result(MINT_A, "AAA")]);
    expect(achievedCadence()).toEqual({ medianMs: 30_000, samples: 3, lastGapMs: 40_000 });
    expect(liveSignalsFor("balanced")!.cadence.medianMs).toBe(30_000);
  });

  it("records a live outcome for the signals capability", () => {
    expect(lastOutcome("signals")).toBeNull();
    pass(T0, [result(MINT_A, "AAA")]);
    expect(lastOutcome("signals")?.ok).toBe(true);
  });

  it("orders the feed by score, highest first", () => {
    pass(T0, [result(MINT_B, "BBB", { whaleNetFlowUsd: 20_000, volumeAccel: 1 }), result(MINT_A, "AAA")]);
    const scores = liveSignalsFor("balanced")!.signals.map((s) => s.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
