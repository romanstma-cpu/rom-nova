// The graded model: features from earlier signals only, the exclusions by
// reason, a time-ordered split, a planted relationship found, noise not
// mistaken for an edge, a probability from a card, the forward record, and
// the worker's desk that stamps the guess on a signal as it fires.

import { describe, expect, it } from "vitest";
import {
  ACT_P,
  contextsOf,
  featuresOf,
  FEATURES,
  forwardRecord,
  judge,
  MIN_USABLE,
  predictP,
  samplesOf,
  trainModel,
  verdictOf,
} from "../src/lib/radar/engine/model.js";
import { ModelDesk } from "../worker/src/model.js";
import { fakeDb } from "./helpers/worker-config";

const T0 = 1_788_000_000_000;
const MIN = 60_000;

/** A deterministic generator, so a "no edge" verdict on noise is not a coin flip per run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  wallet_address: string;
  wallet_score: number;
  token_address: string;
  buy_amount_sol: number;
  timestamp: string;
  price_at_signal?: number;
  settled_sells?: number;
  launch_age_ms?: number | null;
  ret_5m?: number | null;
  graded_stale?: boolean;
  signal_key?: string;
  model_p?: number | null;
}

function row(i: number, over: Partial<Row> = {}): Row {
  return {
    wallet_address: `W${i % 7}`,
    wallet_score: 70 + (i % 30),
    token_address: `M${i}`,
    buy_amount_sol: 1 + (i % 5),
    timestamp: new Date(T0 + i * 3 * MIN).toISOString(),
    price_at_signal: 1e-7 * (1 + (i % 9)),
    settled_sells: 3 + (i % 6),
    launch_age_ms: (i % 4) * 5 * MIN,
    signal_key: `k${i}`,
    ...over,
  };
}

/** Rows whose hit chance rises with the wallet's score — a relationship the model should find. */
function planted(n: number, seed = 7): Row[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const score = 60 + Math.floor(r() * 40);
    const pHit = 1 / (1 + Math.exp(-(score - 80) / 4)); // 60 → ~1%, 80 → 50%, 100 → ~99%
    const hit = r() < pHit;
    return row(i, { wallet_score: score, ret_5m: hit ? 0.1 + r() * 0.5 : -0.3 + r() * 0.35 });
  });
}

/** Rows where nothing predicts anything: a coin weighted 30% hit. */
function noise(n: number, seed = 11): Row[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => row(i, { wallet_score: 60 + Math.floor(r() * 40), ret_5m: r() < 0.3 ? 0.2 : -0.1 }));
}

describe("features and samples", () => {
  it("hands each signal the context of the ones before it, never after", () => {
    const rows = [
      row(0, { wallet_address: "A", token_address: "X", timestamp: new Date(T0).toISOString() }),
      row(1, { wallet_address: "A", token_address: "X", timestamp: new Date(T0 + 10 * MIN).toISOString() }),
      row(2, { wallet_address: "B", token_address: "X", timestamp: new Date(T0 + 20 * MIN).toISOString() }),
      row(3, { wallet_address: "A", token_address: "Y", timestamp: new Date(T0 + 2 * 60 * MIN).toISOString() }),
    ];
    const ctx = contextsOf([rows[3], rows[1], rows[0], rows[2]]).map((c) => c.ctx); // any input order
    expect(ctx[0]).toEqual({ walletHour: 0, mintDay: 0, sinceLastMin: 1440 });
    expect(ctx[1]).toEqual({ walletHour: 1, mintDay: 1, sinceLastMin: 10 });
    expect(ctx[2]).toEqual({ walletHour: 0, mintDay: 2, sinceLastMin: 1440 });
    expect(ctx[3]).toMatchObject({ walletHour: 0, mintDay: 0, sinceLastMin: 110 });
  });

  it("builds a vector per feature, marks an unseen launch age and an unpriced fill", () => {
    const x = featuresOf(row(1, { launch_age_ms: null, price_at_signal: 1e-7 }), { walletHour: 2, mintDay: 1, sinceLastMin: 30 });
    expect(x).toHaveLength(FEATURES.length);
    expect(x[FEATURES.indexOf("ageKnown")]).toBe(0);
    expect(Number.isNaN(x[FEATURES.indexOf("age")])).toBe(true);
    expect(x[FEATURES.indexOf("price")]).toBeCloseTo(-7, 6);
    expect(x[FEATURES.indexOf("walletHour")]).toBe(2);
    expect(Number.isNaN(featuresOf(row(1, { price_at_signal: 0 }), { walletHour: 0, mintDay: 0, sinceLastMin: 0 })[FEATURES.indexOf("price")])).toBe(true);
  });

  it("keeps only graded, fresh, priced signals and counts the rest by reason", () => {
    const rows = [
      row(0, { ret_5m: 0.2 }),
      row(1, { ret_5m: null }),
      row(2, { ret_5m: 0.3, graded_stale: true }),
      row(3, { ret_5m: -0.1, price_at_signal: 0 }),
      row(4, { ret_5m: 0.05 }),
    ];
    const { samples, excluded } = samplesOf(rows);
    expect(samples.map((s) => s.y)).toEqual([1, 0]);
    expect(excluded).toEqual({ ungraded: 1, stale: 1, unpriced: 1 });
  });
});

describe("trainModel", () => {
  it("says insufficient below the floor, with the count", () => {
    const card = trainModel(planted(50), { now: T0 });
    expect(card.verdict).toBe("insufficient");
    expect(card.usable).toBe(50);
    expect(card.note).toContain(`needs ${MIN_USABLE}`);
    expect(card.weights).toBeNull();
    expect(predictP(card, row(1), { walletHour: 0, mintDay: 0, sinceLastMin: 0 })).toBeNull();
  });

  it("finds a planted relationship on the fold it never saw and weights the right feature", () => {
    const card = trainModel(planted(600), { now: T0 });
    expect(card.verdict).toBe("edge");
    expect(card.split?.train_n).toBe(420);
    expect(card.split?.test_n).toBe(180);
    expect(Date.parse(card.split!.train_to)).toBeLessThan(Date.parse(card.split!.test_from));
    expect(card.test!.top.precision).toBeGreaterThan(card.test!.baseline + 2 * card.test!.top.se);
    expect(card.test!.brier).toBeLessThan(card.test!.brier_baseline);
    expect(card.weights!.score).toBeGreaterThan(0.5);
    const p = predictP(card, row(1, { wallet_score: 98 }), { walletHour: 0, mintDay: 0, sinceLastMin: 60 });
    const q = predictP(card, row(2, { wallet_score: 62 }), { walletHour: 0, mintDay: 0, sinceLastMin: 60 });
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(q!);
    expect(p!).toBeGreaterThan(0.6);
    expect(q!).toBeLessThan(0.3);
  });

  it("does not call an edge on noise", () => {
    for (const seed of [11, 23, 47]) {
      const card = trainModel(noise(600, seed), { now: T0 });
      expect(card.verdict).not.toBe("edge");
      expect(card.usable).toBe(600);
    }
  });

  it("judges a fold with a base rate, a top quarter with its standard error, Brier and what it would act on", () => {
    const j = judge([
      { p: 0.9, y: 1 },
      { p: 0.8, y: 1 },
      { p: 0.6, y: 0 },
      { p: 0.4, y: 0 },
      { p: 0.3, y: 1 },
      { p: 0.2, y: 0 },
      { p: 0.1, y: 0 },
      { p: 0.05, y: 0 },
    ])!;
    expect(j).toMatchObject({ n: 8, hits: 3, baseline: 0.375, top: { k: 2, hits: 2, precision: 1 }, acted: { n: 3, hits: 2 } });
    expect(j.acted.precision).toBeCloseTo(2 / 3, 4);
    expect(j.brier).toBeLessThan(j.brier_baseline);
    expect(verdictOf(j)).toBe("insufficient"); // k=2 picks is far below the floor
    expect(judge([])).toBeNull();
  });
});

describe("the forward record", () => {
  it("judges only signals that carried a guess when they fired and were graded fresh", () => {
    const rows = [
      row(0, { model_p: 0.8, ret_5m: 0.2 }),
      row(1, { model_p: 0.7, ret_5m: -0.1 }),
      row(2, { model_p: 0.2, ret_5m: 0.3 }),
      row(3, { model_p: 0.1, ret_5m: -0.2 }),
      row(4, { model_p: null, ret_5m: 0.5 }), // no guess: not the model's to claim
      row(5, { model_p: 0.9, ret_5m: null }), // not graded yet
      row(6, { model_p: 0.9, ret_5m: 0.5, graded_stale: true }),
    ];
    const f = forwardRecord(rows)!;
    expect(f.n).toBe(4);
    expect(f.hits).toBe(2);
    expect(f.acted.n).toBe(2);
    expect(f.acted.precision).toBe(0.5);
    expect(f.verdict).toBe("insufficient");
    expect(f.from).toBe(rows[0].timestamp);
    expect(f.to).toBe(rows[3].timestamp);
    expect(forwardRecord([row(0)])).toBeNull();
  });
});

describe("ModelDesk", () => {
  it("trains on the database, stamps a guess on a new signal, seeds the live context, and summarises", async () => {
    const db = fakeDb([], { signals: planted(600) as unknown as Record<string, unknown>[] });
    const desk = new ModelDesk(db, { now: () => T0 + 600 * 3 * MIN });
    expect(desk.summary()).toMatchObject({ verdict: "untrained", usable: 0, forward: null });
    expect(desk.annotate(row(700))).toEqual({}); // no card yet: no guess, nothing claimed
    await desk.refresh();
    expect(desk.summary()).toMatchObject({ verdict: "edge", usable: 600, refreshes: 1 });
    expect(desk.summary().test?.n).toBe(180);
    const stamped = desk.annotate(row(701, { wallet_score: 97 }));
    expect(stamped).toMatchObject({ model_version: "lr-1" });
    expect((stamped as { model_p: number }).model_p).toBeGreaterThan(0.5);
    expect(desk.counts.annotated).toBe(1);
    // The next signal from the same wallet in the same hour sees it in its context.
    const ctx = desk.contextFor(row(702, { wallet_address: row(701).wallet_address, timestamp: new Date(T0 + 702 * 3 * MIN + MIN).toISOString() }));
    expect(ctx.walletHour).toBeGreaterThanOrEqual(1);
    expect(ctx.sinceLastMin).toBeLessThan(60);
    const full = desk.full();
    expect(full.card.verdict).toBe("edge");
    expect(full.refreshed_at).not.toBeNull();
  });

  it("survives a database it cannot read, and says so", async () => {
    const db = fakeDb();
    db.gradedSignals = async () => {
      throw new Error("connection reset");
    };
    const desk = new ModelDesk(db, { now: () => T0 });
    await desk.refresh();
    expect(desk.summary().lastError).toContain("connection reset");
    expect(desk.annotate(row(1))).toEqual({});
  });

  it("ACT_P is the line the forward record acts on", () => {
    expect(ACT_P).toBe(0.5);
  });
});
