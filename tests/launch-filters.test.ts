// Two defects a blind reviewer found in the shipped launch feed, both of which
// are one condition wide and both of which contradicted something the page was
// already saying correctly one cell away.

import { describe, it, expect } from "vitest";
import { clockSkewHint } from "@/app/launches/page";
import type { LaunchFeed } from "@/lib/api/launches";

/** A feed with the lag fields under test and inert defaults elsewhere. */
function feed(over: Partial<LaunchFeed>): LaunchFeed {
  return {
    launches: [],
    polledAt: Date.now(),
    stale: false,
    lastPassOk: true,
    provenance: [],
    awaitingTriage: 0,
    lagP50Ms: null,
    lagP90Ms: null,
    lagMinMs: null,
    lagSamples: 0,
    gradLagP50Ms: null,
    gradLagP90Ms: null,
    gradLagMinMs: null,
    gradLagSamples: 0,
    ...over,
  } as LaunchFeed;
}

describe("clockSkewHint — the graduation pipeline crosses zero first", () => {
  it("warns on an impossible MINT lag, as it always did", () => {
    const h = clockSkewHint(feed({ lagMinMs: -2_400, lagSamples: 5 }));
    expect(h?.label).toBe("clock behind");
  });

  it("warns on an impossible GRADUATION lag even when mints look fine", () => {
    // The shipped bug. Graduations arrive within a few seconds, so a constant
    // clock offset is a large fraction of the figure and takes them negative
    // while mints — which lag longer — absorb the same offset and stay
    // positive. The UI printed "grad lag -0s" and raised nothing, because the
    // hint only ever read the mint minimum.
    const h = clockSkewHint(
      feed({
        lagMinMs: 6_000,
        lagSamples: 8,
        gradLagMinMs: -400,
        gradLagSamples: 4,
      }),
    );
    expect(h?.label).toBe("clock behind");
  });

  it("takes the worse impossibility, because it bounds the offset better", () => {
    const h = clockSkewHint(
      feed({ lagMinMs: -500, lagSamples: 5, gradLagMinMs: -3_100, gradLagSamples: 5 }),
    );
    expect(h?.title).toContain("3.1s BEFORE");
  });

  it("ignores a pipeline with too few samples to mean anything", () => {
    // Two graduations is not evidence of a clock offset; it is two graduations.
    expect(
      clockSkewHint(feed({ lagMinMs: 6_000, lagSamples: 8, gradLagMinMs: -400, gradLagSamples: 2 })),
    ).toBeNull();
  });

  it("stays silent when both pipelines are plausible", () => {
    expect(
      clockSkewHint(
        feed({ lagMinMs: 9_000, lagSamples: 9, gradLagMinMs: 8_000, gradLagSamples: 5 }),
      ),
    ).toBeNull();
  });

  it("returns nothing at all when no pipeline has samples", () => {
    expect(clockSkewHint(feed({}))).toBeNull();
    expect(clockSkewHint(null)).toBeNull();
  });

  it("does not read a genuinely fast graduation as a slow clock", () => {
    // The below-floor test was applied to the COMBINED minimum, but the 2.3s
    // floor was measured on the MINT source; the graduation pipeline's own
    // measured minimum is 1.0s. A fast graduation is a fast graduation, not
    // evidence about the clock.
    expect(
      clockSkewHint(
        feed({ lagMinMs: 6_000, lagSamples: 8, gradLagMinMs: 1_000, gradLagSamples: 5 }),
      ),
    ).toBeNull();
  });

  it("still flags a suspiciously fast MINT, where the floor was measured", () => {
    const h = clockSkewHint(feed({ lagMinMs: 400, lagSamples: 8 }));
    expect(h?.label).toBe("clock may be behind");
  });
});

// --------------------------------------------------------- near-graduation

/**
 * The filter predicate, mirrored from the page.
 *
 * `mergeLaunch` deliberately preserves `bondingCurvePct` through graduation, so
 * a graduated row keeps a stale curve value and used to sail past the threshold
 * — while its own Curve cell rendered "n/a — graduated, the curve is gone". The
 * filter and the column contradicted each other on the same row, and a sniper
 * asking what is about to migrate was handed tokens where migration had already
 * happened: the one set they cannot act on.
 */
const NEAR_GRADUATION = 0.8;
function matchesNearGraduation(l: { event: string; bondingCurvePct?: number }): boolean {
  if (l.event === "graduation") return false;
  return l.bondingCurvePct !== undefined && l.bondingCurvePct >= NEAR_GRADUATION;
}

describe("the near-graduation filter", () => {
  it("matches a curve token close to migrating", () => {
    expect(matchesNearGraduation({ event: "mint", bondingCurvePct: 0.92 })).toBe(true);
  });

  it("excludes a token that has ALREADY graduated, stale curve or not", () => {
    expect(matchesNearGraduation({ event: "graduation", bondingCurvePct: 0.97 })).toBe(false);
  });

  it("excludes a curve token that is not close yet", () => {
    expect(matchesNearGraduation({ event: "mint", bondingCurvePct: 0.4 })).toBe(false);
  });

  it("excludes an UNMEASURED curve rather than treating it as low", () => {
    // The same rule the min-liquidity filter follows: an absent measurement is
    // dropped, never filtered as though it were a small one.
    expect(matchesNearGraduation({ event: "mint" })).toBe(false);
  });
});
