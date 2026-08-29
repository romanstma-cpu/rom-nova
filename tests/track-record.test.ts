// The forward test has one job that matters more than the arithmetic: refusing
// to report an edge that is not there. Every failure mode below produces a
// confident, wrong, encouraging number — which is precisely what a token
// scanner's "track record" page is usually made of.

import { describe, it, expect } from "vitest";
import {
  BUCKETS,
  HORIZONS,
  MIN_PASSES,
  bucketOf,
  clusterBootstrapCI,
  mean,
  median,
  resolveOutcomes,
  seededRandom,
  toleranceFor,
  trackReport,
  type Observation,
} from "@/lib/engine/track-record";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

function obs(mint: string, ts: number, score: number, priceUsd: number): Observation {
  return { mint, symbol: mint, ts, score, confidence: 0.7, priceUsd, profile: "balanced", unmeasuredCount: 0 };
}

describe("resolveOutcomes — matching a score to what happened next", () => {
  it("resolves against the first price at or after the horizon", () => {
    const ledger = [obs("A", T0, 70, 100), obs("A", T0 + HOUR, 70, 110)];
    const r = resolveOutcomes(ledger, [HORIZONS[0]], T0 + 3 * HOUR);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].returnPct).toBeCloseTo(10, 6);
  });

  it("does not resolve a horizon that has not elapsed", () => {
    const ledger = [obs("A", T0, 70, 100), obs("A", T0 + 10 * 60_000, 70, 110)];
    const r = resolveOutcomes(ledger, [HORIZONS[0]], T0 + 20 * 60_000);
    expect(r.resolved).toHaveLength(0);
    // Both rows are pending: every observation awaits its OWN horizon, so a
    // later price is simultaneously the resolver for an earlier row and an
    // unresolved row in its own right.
    expect(r.pending).toBe(2);
  });

  it("EXPIRES rather than mislabels when the app was not running", () => {
    // The important one. A laptop shut for three days means the next sighting
    // of a mint is not its "1h return" — and quietly using it would fill the
    // ledger with horizons that all silently lengthen, which in a bull week
    // manufactures an edge out of nothing but downtime.
    const ledger = [obs("A", T0, 70, 100), obs("A", T0 + 72 * HOUR, 70, 300)];
    const r = resolveOutcomes(ledger, [HORIZONS[0]], T0 + 100 * HOUR);
    expect(r.resolved).toHaveLength(0);
    // The 300% move is not credited to anything. Both rows expire unresolved.
    expect(r.expired).toBe(2);
  });

  it("keeps the tolerance window generous enough for a polling scanner", () => {
    // A 1h horizon tolerates up to another hour; a 30-minute floor stops very
    // short horizons from being impossible to hit.
    expect(toleranceFor({ label: "1h", ms: HOUR })).toBe(HOUR);
    expect(toleranceFor({ label: "5m", ms: 5 * 60_000 })).toBe(30 * 60_000);
  });

  it("never resolves one mint against another's price", () => {
    const ledger = [obs("A", T0, 70, 100), obs("B", T0 + HOUR, 70, 9999)];
    const r = resolveOutcomes(ledger, [HORIZONS[0]], T0 + 3 * HOUR);
    expect(r.resolved).toHaveLength(0);
  });

  it("skips observations with no usable price", () => {
    const ledger = [obs("A", T0, 70, 0), obs("A", T0 + HOUR, 70, 110)];
    const r = resolveOutcomes(ledger, [HORIZONS[0]], T0 + 3 * HOUR);
    expect(r.resolved).toHaveLength(0);
  });
});

describe("clusterBootstrapCI — passes are the trial, not rows", () => {
  it("refuses an interval below the minimum group count", () => {
    // Four passes cannot produce a meaningful percentile interval, and printing
    // one invites exactly the over-reading this module exists to prevent.
    const groups = [[1, 2], [3, 4], [5, 6], [7, 8]];
    expect(clusterBootstrapCI(groups, mean)).toBeNull();
  });

  it("returns a reproducible interval for the same seed", () => {
    const groups = Array.from({ length: 20 }, (_, i) => [i - 10, i - 9, i - 8]);
    const a = clusterBootstrapCI(groups, mean, { seed: 7 });
    const b = clusterBootstrapCI(groups, mean, { seed: 7 });
    expect(a).toEqual(b);
  });

  it("is WIDER than a row-wise interval on correlated data", () => {
    // The whole reason this function exists. Twelve tokens in one pass move
    // together; treating them as twelve independent trials narrows the interval
    // by an unearned root-N and turns market beta into apparent skill.
    //
    // Each pass here is internally identical — perfect correlation — so a
    // row-wise resample sees 240 samples where there are really only 20.
    const passes = Array.from({ length: 20 }, (_, i) => Array(12).fill(i - 10));
    const clustered = clusterBootstrapCI(passes, mean, { seed: 42 })!;
    const rowwise = clusterBootstrapCI(
      passes.flat().map((v) => [v]),
      mean,
      { seed: 42 },
    )!;
    const width = (ci: [number, number]) => ci[1] - ci[0];
    expect(width(clustered)).toBeGreaterThan(width(rowwise));
  });

  it("brackets the true mean of uncorrelated groups", () => {
    const groups = Array.from({ length: 40 }, (_, i) => [10 + ((i % 5) - 2)]);
    const ci = clusterBootstrapCI(groups, mean, { seed: 3 })!;
    expect(ci[0]).toBeLessThanOrEqual(10);
    expect(ci[1]).toBeGreaterThanOrEqual(10);
  });
});

describe("seededRandom", () => {
  it("is deterministic and stays in [0,1)", () => {
    const a = seededRandom(99);
    const b = seededRandom(99);
    for (let i = 0; i < 200; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("buckets", () => {
  it("covers the whole 0-100 range with no gap and no overlap", () => {
    for (let s = 0; s <= 100; s++) expect(bucketOf(s), `score ${s}`).toBeDefined();
    for (let s = 0; s <= 100; s++) {
      expect(BUCKETS.filter((b) => s >= b.min && s < b.max)).toHaveLength(1);
    }
  });
});

describe("trackReport — refusing to conclude", () => {
  it("says so plainly when nothing has been recorded", () => {
    const r = trackReport([]);
    expect(r.observations).toBe(0);
    expect(r.verdict).toContain("Nothing recorded yet");
  });

  it("withholds a verdict below the pass threshold", () => {
    // Ten passes of a rocketing token. Every band is up, the hit rate is 100%,
    // and the report must still decline to call it anything.
    const ledger: Observation[] = [];
    for (let i = 0; i < 10; i++) {
      ledger.push(obs("A", T0 + i * HOUR, 80, 100 * 1.1 ** i));
    }
    const r = trackReport(ledger, [HORIZONS[0]], T0 + 40 * HOUR);
    expect(r.verdict).toContain(`of ${MIN_PASSES} scan passes`);
    expect(r.horizons[0].anyBandSeparates).toBe(false);
  });

  it("reports no edge when every band tracks the market", () => {
    // Thirty passes, four tokens each, all moving together regardless of score.
    // A row-wise interval would find "significance" here; a clustered one must
    // not, because there is nothing to find.
    const ledger: Observation[] = [];
    const scores = [20, 45, 60, 85];
    for (let i = 0; i < 30; i++) {
      const drift = 1 + (i % 7) * 0.01;
      for (const s of scores) ledger.push(obs(`T${s}`, T0 + i * HOUR, s, 100 * drift));
    }
    const r = trackReport(ledger, [HORIZONS[0]], T0 + 60 * HOUR);
    expect(r.passes).toBe(30);
    expect(r.horizons[0].anyBandSeparates).toBe(false);
    expect(r.verdict).toContain("no score band beats the average");
  });

  it("measures lift against the scanner's own list, not against zero", () => {
    // A rising market that lifts every token identically, regardless of score.
    // The raw return of the top band is large and positive; its LIFT over the
    // baseline is nil. Crediting that raw number to the model is the single
    // most common way a track-record page lies.
    //
    // One price per mint per timestamp, deliberately: two prices on one
    // timestamp makes the resolver's tie-break decide the answer, which is a
    // property of the fixture rather than of the code under test.
    const ledger: Observation[] = [];
    for (let i = 0; i < 30; i++) {
      for (const s of [20, 85]) ledger.push(obs(`T${s}`, T0 + i * HOUR, s, 100 * (i + 1)));
    }
    const r = trackReport(ledger, [HORIZONS[0]], T0 + 60 * HOUR);
    const h = r.horizons[0];
    // The market genuinely rose over every window.
    expect(h.baselineMeanPct).toBeGreaterThan(3);
    // And no band beat it, because the score had nothing to do with the move.
    for (const b of h.bands.filter((x) => x.n > 0)) {
      expect(Math.abs(b.liftPct)).toBeLessThan(0.001);
    }
    expect(h.anyBandSeparates).toBe(false);
  });

  it("counts one pass per timestamp, however many rows it carried", () => {
    const ledger: Observation[] = [];
    for (const s of [20, 45, 60, 85]) ledger.push(obs(`T${s}`, T0, s, 100));
    const r = trackReport(ledger, [HORIZONS[0]], T0 + HOUR);
    expect(r.observations).toBe(4);
    expect(r.passes).toBe(1);
  });
});

describe("mean and median", () => {
  it("return 0 for an empty sample rather than NaN", () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
  });

  it("median does not mutate its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("median averages the middle pair on an even sample", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
