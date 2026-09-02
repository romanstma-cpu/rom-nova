// The launch feed's two jobs are to see a launch and to remember when it saw
// it. The first is the adapter's; the second is the merge's, and it is the one
// that is easy to break invisibly — a first-seen timestamp that refreshes on
// every poll reports a latency of zero while the feed runs minutes behind.
//
// FIXTURES ARE REAL PAYLOADS. Both rows below were captured from
// lite-api.jup.ag/tokens/v2/recent, including the empty name and symbol on the
// freshest one, which is not a mistake in the fixture.

import { describe, it, expect } from "vitest";
import { toLaunch, gemsToLaunch } from "@/lib/providers/jupiter";
import { mergeLaunch } from "@/lib/api/launches";
import { clockSkewHint } from "@/app/launches/page";
import type { LaunchObservation, TokenLaunch } from "@/lib/types";
import type { TokenRisk } from "@/lib/providers/types";

/** A mint one second old: no price, no liquidity, no metadata yet. */
const UNPRICED = {
  id: "3q7Jficn2KAzhCL1LN3uapPoxsfCSmiBBHfd42MZ1acr",
  name: "",
  symbol: "",
  decimals: 6,
  dev: "AfkXsvWsvouFhgaAvNWDCJCp1Ytt7yty7mwXEbDNiVpZ",
  holderCount: 3,
  stats5m: { buyVolume: 0.0105, numBuys: 1, numTraders: 1, numNetBuyers: 1 },
  firstPool: { id: "5SvEJiMeQQfHDCryqm5MNEDsT8udJBoG85YY3SmHxCyc", createdAt: "2026-08-29T19:35:14Z" },
  audit: { isSus: true, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devMints: 1 },
  organicScore: 0,
  organicScoreLabel: "low",
  tags: ["unknown", "token-2022"],
  createdAt: "2026-08-29T19:35:14Z",
};

/** Four seconds old, from a deployer on their 3,911th mint. */
const SERIAL = {
  id: "CHARLESTONxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump",
  name: "Charleston",
  symbol: "CHARLESTON",
  decimals: 6,
  dev: "devWallet2222222222222222222222222222222222",
  launchpad: "pump.fun",
  holderCount: 36,
  usdPrice: 0.0000031,
  liquidity: 7725.72,
  audit: {
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    devBalancePercentage: 19.12,
    devMigrations: 159,
    devMints: 3911,
  },
  stats5m: { numBuys: 12, numSells: 4, numTraders: 9 },
  firstPool: { createdAt: "2026-08-29T19:35:11Z" },
  createdAt: "2026-08-29T19:35:11Z",
};

const SEEN = Date.parse("2026-08-29T19:35:16Z");

describe("toLaunch keeps what a snapshot throws away", () => {
  it("separates the pool's creation time from when we saw it", () => {
    const l = toLaunch(SERIAL, SEEN);
    expect(l.poolCreatedAt).toBe(Date.parse("2026-08-29T19:35:11Z"));
    expect(l.firstSeenAt).toBe(SEEN);
    // 5 seconds of feed lag, which is the entire point of carrying both.
    expect(l.firstSeenAt - l.poolCreatedAt).toBe(5_000);
  });

  it("distinguishes an audited mint from an unaudited one", () => {
    // Both come out `mintAuthorityRevoked: false` when the audit is missing, so
    // without this flag "authority is LIVE" and "nobody looked" are the same
    // row, and triage cannot phrase either honestly.
    expect(toLaunch(SERIAL, SEEN).authorityKnown).toBe(true);
    const noAudit = toLaunch({ ...SERIAL, audit: undefined }, SEEN);
    expect(noAudit.authorityKnown).toBe(false);
    expect(noAudit.mintAuthorityRevoked).toBe(false);
  });

  it("leaves an unpriced mint undefined rather than zero", () => {
    // Two of thirty rows arrive before Jupiter has priced them, and they are the
    // freshest launches on the page. A zero would sort them to the bottom of a
    // liquidity filter and read as "no liquidity" instead of "not yet priced".
    const l = toLaunch(UNPRICED, SEEN);
    expect(l.priceUsd).toBeUndefined();
    expect(l.liquidityUsd).toBeUndefined();
    expect(l.holders).toBe(3);
  });

  it("does not invent a ticker for a mint with no metadata", () => {
    const l = toLaunch(UNPRICED, SEEN);
    expect(l.symbol).toBe("");
    expect(l.name).toBe("");
  });

  it("carries the listing source's own suspicion bit", () => {
    expect(toLaunch(UNPRICED, SEEN).sus).toBe(true);
    // Absent means nothing was flagged, not "checked and clean".
    expect(toLaunch(SERIAL, SEEN).sus).toBeUndefined();
  });

  it("carries creator history and converts shares to fractions", () => {
    const l = toLaunch(SERIAL, SEEN);
    expect(l.devMints).toBe(3911);
    expect(l.devMigrations).toBe(159);
    expect(l.devHoldsPct).toBeCloseTo(0.1912, 4);
  });

  it("calls a graduated mint a graduation", () => {
    const l = toLaunch({ ...SERIAL, graduatedAt: "2026-08-29T19:40:00Z" }, SEEN);
    expect(l.event).toBe("graduation");
    expect(l.graduatedAt).toBe(Date.parse("2026-08-29T19:40:00Z"));
  });

  it("gives a mint the same colour the rest of the app gives it", () => {
    // classify.ts already warns about this: a token that is one colour on the
    // scanner and another here is a bug nobody would think to look for.
    const l = toLaunch(SERIAL, SEEN);
    expect(l.hue).toBe(Math.abs([...SERIAL.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 360);
  });
});

describe("merging a re-sighting", () => {
  const rows = () => new Map<string, TokenLaunch>();
  const first = toLaunch(UNPRICED, SEEN);

  it("adds an unseen mint and reports it as new", () => {
    const m = rows();
    expect(mergeLaunch(m, first).added).toBe(true);
    expect(mergeLaunch(m, first).added).toBe(false);
    expect(m.size).toBe(1);
  });

  it("never moves firstSeenAt", () => {
    // The failure this prevents: refresh the row on every poll and its measured
    // age resets to zero every five seconds, so the feed reports a latency of
    // nothing while running minutes behind.
    const m = rows();
    mergeLaunch(m, first);
    mergeLaunch(m, { ...first, firstSeenAt: SEEN + 60_000 });
    expect(m.get(first.mint)!.firstSeenAt).toBe(SEEN);
  });

  it("does refresh the market numbers, because the first sighting had none", () => {
    const m = rows();
    mergeLaunch(m, first);
    mergeLaunch(m, { ...first, firstSeenAt: SEEN + 5_000, priceUsd: 0.000004, liquidityUsd: 3_100 });
    const row = m.get(first.mint)!;
    expect(row.priceUsd).toBe(0.000004);
    expect(row.liquidityUsd).toBe(3_100);
    expect(row.firstSeenAt).toBe(SEEN);
  });

  it("keeps the earlier creation claim when two sources disagree", () => {
    const m = rows();
    mergeLaunch(m, first);
    mergeLaunch(m, { ...first, poolCreatedAt: first.poolCreatedAt + 30_000 });
    expect(m.get(first.mint)!.poolCreatedAt).toBe(first.poolCreatedAt);
  });

  it("promotes a pool to a graduation and never back", () => {
    const m = rows();
    mergeLaunch(m, first);
    mergeLaunch(m, { ...first, event: "graduation", venue: "pumpswap" });
    expect(m.get(first.mint)!.event).toBe("graduation");
    mergeLaunch(m, { ...first, event: "pool" });
    expect(m.get(first.mint)!.event).toBe("graduation");
  });

  it("stamps the graduation's own sighting time at promotion", () => {
    // A watched curve mint keeps its original firstSeenAt when it graduates,
    // while poolCreatedAt is re-dated to the graduation. Measuring the lag as
    // firstSeenAt - poolCreatedAt on such a row produced a NEGATIVE number the
    // size of the curve's lifetime — observed live at -90.2s and -158.8s — and
    // the clock-skew check then reported an impossible clock with a fabricated
    // magnitude. On an accurate machine, one promoted graduation would have
    // fired "clock behind" spuriously.
    const m = rows();
    mergeLaunch(m, first, undefined, SEEN);
    const gradAt = first.poolCreatedAt + 120_000; // curve completes 2 min later
    const noticedAt = gradAt + 3_000; // and the feed sees it 3s after that
    mergeLaunch(
      m,
      { ...first, event: "graduation", venue: "pumpswap", poolCreatedAt: gradAt },
      undefined,
      noticedAt,
    );
    const row = m.get(first.mint)!;
    expect(row.event).toBe("graduation");
    expect(row.poolCreatedAt).toBe(gradAt);
    // The poisoned sample this replaces: firstSeenAt predates the graduation.
    expect(row.firstSeenAt - row.poolCreatedAt!).toBeLessThan(0);
    // The honest one: when did the feed notice the graduation.
    expect(row.gradSeenAt).toBe(noticedAt);
    expect((row.gradSeenAt ?? row.firstSeenAt) - row.poolCreatedAt!).toBe(3_000);
    // And it is stamped ONCE — a later re-sighting must not move it.
    mergeLaunch(m, { ...first, event: "graduation", poolCreatedAt: gradAt }, undefined, noticedAt + 60_000);
    expect(m.get(first.mint)!.gradSeenAt).toBe(noticedAt);
  });

  it("leaves gradSeenAt absent when the row was a graduation at first sight", () => {
    // There firstSeenAt already IS the graduation sighting, and the lag
    // fallback reads it.
    const m = rows();
    mergeLaunch(m, { ...first, event: "graduation" }, undefined, SEEN);
    expect(m.get(first.mint)!.gradSeenAt).toBeUndefined();
  });

  it("does not lose a finding when the row is re-triaged on refreshed numbers", () => {
    // Triage is a pure function of (observation, risk), and the row is
    // re-triaged on every poll because its price changes. Re-triaging without
    // the grade that produced the verdict would quietly revert a flagged rugger
    // to "nothing found yet" — the worst possible direction for a finding to
    // move, and silent.
    const rugger: TokenRisk = {
      mint: first.mint,
      source: "rugcheck",
      score: 65,
      risks: [{ name: "Creator history of rugged tokens", level: "danger", detail: "history of rugging" }],
      detailed: false,
    };
    const m = rows();
    mergeLaunch(m, first, rugger);
    expect(m.get(first.mint)!.triage.verdict).toBe("avoid");
    mergeLaunch(m, { ...first, priceUsd: 0.00001 }, rugger, SEEN + 5_000);
    expect(m.get(first.mint)!.triage.verdict).toBe("avoid");
  });

  it("times triage from first sight, not from the poll that graded it", () => {
    const m = rows();
    mergeLaunch(m, first);
    expect(m.get(first.mint)!.triage.completedInMs).toBeUndefined();
    const graded: TokenRisk = { mint: first.mint, source: "rugcheck", score: 1, risks: [], detailed: false };
    mergeLaunch(m, first, graded, SEEN + 430);
    expect(m.get(first.mint)!.triage.completedInMs).toBe(430);
  });
});

// The graduation path, which is where the feed used to lose by two orders of
// magnitude. Both fixtures are real `datapi.jup.ag/v1/pools/gems` rows.
//
// TURINF is the case that makes the dating rule matter and it is not a corner:
// its curve opened at 04:05:51 and it graduated at 04:30:29, twenty-four and a
// half minutes later. Date the row by the curve and this graduation reports a
// lag of 1,478 seconds into a statistic that is supposed to read in seconds.
const GRADUATED = {
  id: "J8HKHySYextrShvb9EHGa7uoGMi1PpbRy2PQ9tx7Hazt",
  dex: "swap.pump.fun",
  type: "pumpfun-amm",
  createdAt: "2026-08-30T04:30:29Z",
  liquidity: 2.798684095372946,
  baseAsset: {
    id: "3EVtYFKBaD8cDkex9FUvE4ds3f5vzjxqsGKaW9oepump",
    name: "just one dollar ✌️🤙🙏",
    symbol: "TURINF",
    decimals: 6,
    dev: "A1UdA6yuAGm3SSFUNmew3pMDKzV2vK3wr5bsTdJmvQWc",
    launchpad: "pump.fun",
    firstPool: { createdAt: "2026-08-30T04:05:51Z" },
    graduatedPool: "J8HKHySYextrShvb9EHGa7uoGMi1PpbRy2PQ9tx7Hazt",
    graduatedAt: "2026-08-30T04:30:29Z",
    holderCount: 16,
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 78.27630366269356,
      devBalancePercentage: 19.23483440819695,
      devMigrations: 1,
      devMints: 4,
    },
    createdAt: "2026-08-30T04:05:51Z",
    mcap: 6.1432909941701705,
    usdPrice: 6.143290994170171e-9,
    liquidity: 2.798684095372946,
  },
};

/** Still on its curve, 77.7% of the way to graduating. */
const CLIMBING = {
  id: "HeAB8u6ay7T3Ty4KfQFeK4jmfN6VTjYWkR51DBuZpump",
  dex: "pump.fun",
  type: "pumpfun",
  createdAt: "2026-08-30T04:31:15Z",
  liquidity: 3168.6671821449745,
  bondingCurve: 0.7772862379701206,
  baseAsset: {
    id: "HeAB8u6ay7T3Ty4KfQFeK4jmfN6VTjYWkR51DBuZpump",
    name: "NIGGAS IN",
    symbol: "PARIS",
    decimals: 6,
    dev: "9vDqT3tfVGe8KGMXhNgNgkf5ciaxbM7hKvjvqT6hinqK",
    launchpad: "pump.fun",
    firstPool: { createdAt: "2026-08-30T04:31:15Z" },
    holderCount: 3,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devMints: 255, devMigrations: 6 },
    createdAt: "2026-08-30T04:31:15Z",
    mcap: 2652.667535683357,
    liquidity: 3168.6671821449745,
  },
};

const GRAD_SEEN = Date.parse("2026-08-30T04:30:32Z");

describe("graduation latency: dating the row by the right event", () => {
  it("dates a graduation by the graduation, not by when its curve opened", () => {
    // The whole graduation-latency measurement rests on this one line. The
    // token payload's own creation time is 24m38s earlier; using it would make
    // a 3-second feed report a 1,478-second one.
    const l = gemsToLaunch(GRADUATED, GRAD_SEEN)!;
    expect(l.poolCreatedAt).toBe(Date.parse("2026-08-30T04:30:29Z"));
    expect(l.firstSeenAt - l.poolCreatedAt).toBe(3_000);
    expect(l.event).toBe("graduation");
  });

  it("keeps the curve's own creation time available as the graduation stamp", () => {
    const l = gemsToLaunch(GRADUATED, GRAD_SEEN)!;
    expect(l.graduatedAt).toBe(Date.parse("2026-08-30T04:30:29Z"));
    expect(l.venue).toBe("swap.pump.fun");
    expect(l.launchpad).toBe("pump.fun");
  });

  it("reads the audit through the same path as every other launch", () => {
    // Not a second hand-rolled copy of the authority logic. A duplicate is how
    // a mint nobody examined eventually gets graded as safely renounced.
    const l = gemsToLaunch(GRADUATED, GRAD_SEEN)!;
    expect(l.authorityKnown).toBe(true);
    expect(l.mintAuthorityRevoked).toBe(true);
    expect(l.devMints).toBe(4);
    expect(l.top10Pct).toBeCloseTo(0.7828, 4);
  });

  it("reads the curve as a percentage and stores it as a fraction", () => {
    // The source publishes 0..100. This fixture's raw 0.7772862 means 0.78% of
    // the curve, NOT 78% — a mint seconds old has barely started. Reading it as
    // a fraction would overstate every curve on the page by 100x, and it would
    // look entirely plausible doing it.
    //
    // Settled by measuring all three buckets: aboutToGraduate runs 65.76-91.49,
    // recent runs 0.00-47.39 with a median of 1.07, graduated has no field.
    expect(gemsToLaunch(CLIMBING, GRAD_SEEN)!.bondingCurvePct).toBeCloseTo(0.007772862, 9);
  });

  it("leaves the curve undefined on a graduated pool rather than zeroing it", () => {
    // A graduated pool has no curve left. Undefined, never 0 — a zero would
    // render as "nobody is buying this" on a token that just completed.
    expect(gemsToLaunch(GRADUATED, GRAD_SEEN)!.bondingCurvePct).toBeUndefined();
  });

  it("returns null rather than a row for a pool with no base asset", () => {
    expect(gemsToLaunch({ id: "x", createdAt: "2026-08-30T04:30:29Z" }, GRAD_SEEN)).toBeNull();
  });

  it("falls back to the pool's own creation time when there is no graduation stamp", () => {
    const noStamp = { ...GRADUATED, baseAsset: { ...GRADUATED.baseAsset, graduatedAt: undefined } };
    expect(gemsToLaunch(noStamp, GRAD_SEEN)!.poolCreatedAt).toBe(Date.parse("2026-08-30T04:30:29Z"));
  });
});

describe("a mint that graduates while the feed is already watching it", () => {
  // TURINF as the primary listing would have delivered it when its curve
  // opened — the same mint, 24m38s before it graduated. The two sightings must
  // be in that order or the test proves nothing: `Math.min` of a curve that
  // came LATER than the graduation would pick the graduation by accident and
  // pass against the very code this is here to catch.
  const MINT = "3EVtYFKBaD8cDkex9FUvE4ds3f5vzjxqsGKaW9oepump";
  const curve = gemsToLaunch(
    {
      ...CLIMBING,
      id: MINT,
      createdAt: "2026-08-30T04:05:51Z",
      baseAsset: {
        ...CLIMBING.baseAsset,
        id: MINT,
        firstPool: { createdAt: "2026-08-30T04:05:51Z" },
        createdAt: "2026-08-30T04:05:51Z",
      },
    },
    Date.parse("2026-08-30T04:05:54Z"),
  )!;
  const graduation = gemsToLaunch(GRADUATED, GRAD_SEEN)!;

  it("re-dates the row to the graduation instead of keeping the curve time", () => {
    // The regression the old `Math.min` produced: a mint already in the feed
    // from the primary listing graduates, the row is promoted to GRAD, and its
    // date stays at the curve — so it lands in the graduation statistic with an
    // age of however long the curve took.
    const m = new Map<string, TokenLaunch>();
    mergeLaunch(m, curve);
    mergeLaunch(m, graduation);
    const row = m.get(curve.mint)!;
    expect(row.event).toBe("graduation");
    expect(row.poolCreatedAt).toBe(Date.parse("2026-08-30T04:30:29Z"));
    // Still stamped when the CURVE was first seen — that is never re-dated,
    // and it is what makes the lag arithmetic a measurement.
    expect(row.firstSeenAt).toBe(Date.parse("2026-08-30T04:05:54Z"));
    // The number this whole path exists to keep honest: 3 seconds, not 1,478.
    expect(row.poolCreatedAt! - Date.parse("2026-08-30T04:05:51Z")).toBe(1_478_000);
  });

  it("never lets a later plain sighting drag a graduation back to its curve", () => {
    // The mirror failure, and the quieter one: the row is already a graduation
    // and the primary listing mentions the mint again with its curve time.
    const m = new Map<string, TokenLaunch>();
    mergeLaunch(m, graduation);
    mergeLaunch(m, curve);
    const row = m.get(curve.mint)!;
    expect(row.event).toBe("graduation");
    expect(row.poolCreatedAt).toBe(Date.parse("2026-08-30T04:30:29Z"));
  });

  it("does not erase the graduation stamp with a payload that lacks one", () => {
    // `{...existing, ...obs}` overwrites with undefined wherever the newer
    // payload simply has no such field, and the primary listing has neither of
    // these. An un-dated graduation is a graduation the feed cannot measure.
    const m = new Map<string, TokenLaunch>();
    mergeLaunch(m, graduation);
    mergeLaunch(m, curve);
    expect(m.get(curve.mint)!.graduatedAt).toBe(Date.parse("2026-08-30T04:30:29Z"));
  });

  it("keeps the last known curve figure rather than blinking it out", () => {
    const m = new Map<string, TokenLaunch>();
    mergeLaunch(m, curve);
    mergeLaunch(m, { ...curve, bondingCurvePct: undefined, priceUsd: 0.0000031 });
    expect(m.get(curve.mint)!.bondingCurvePct).toBeCloseTo(0.007772862, 9);
  });

  it("still takes the earlier claim when two sources describe the same pool", () => {
    // The `min` rule is still right where it was always right: two sources
    // dating one event, neither of them a promotion.
    const m = new Map<string, TokenLaunch>();
    mergeLaunch(m, curve);
    mergeLaunch(m, { ...curve, poolCreatedAt: curve.poolCreatedAt + 30_000 });
    expect(m.get(curve.mint)!.poolCreatedAt).toBe(curve.poolCreatedAt);
  });
});

// The direction of the clock-skew flag, which the first attempt got backwards.
// A live run caught it: the machine was bracketed at 2.85s BEHIND real time off
// the HTTP Date header, and the page rendered "clock ahead".
describe("clock-skew disclosure points at the flattering direction", () => {
  const feed = (lagMinMs: number | null, lagSamples = 10) =>
    ({ lagMinMs, lagSamples }) as unknown as Parameters<typeof clockSkewHint>[0];

  it("reads an impossible negative lag as a clock running BEHIND, not ahead", () => {
    // measured = true_lag + skew, skew positive when the local clock is ahead.
    // A clock running ahead can only ever INFLATE a lag, so it cannot produce a
    // negative one. Seeing a pool before the source says it existed means our
    // "now" reads earlier than theirs.
    const hint = clockSkewHint(feed(-800))!;
    expect(hint.label).toBe("clock behind");
    expect(hint.title).toContain("faster than it is");
    expect(hint.label).not.toContain("ahead");
  });

  it("treats a lag under the source's measured floor as weaker evidence of the same thing", () => {
    const hint = clockSkewHint(feed(1_200))!;
    expect(hint.label).toBe("clock may be behind");
    expect(hint.title).toContain("evidence, not proof");
  });

  it("says nothing when the fastest row clears the source's own floor", () => {
    expect(clockSkewHint(feed(4_000))).toBeNull();
  });

  it("says nothing on too few samples to mean anything", () => {
    // One early row below the floor is noise, not a clock finding.
    expect(clockSkewHint(feed(-800, 2))).toBeNull();
    expect(clockSkewHint(feed(null))).toBeNull();
    expect(clockSkewHint(null)).toBeNull();
  });
});

describe("a launch nobody can audit is still a launch", () => {
  it("goes into the feed with everything declared rather than being dropped", () => {
    // A pool GeckoTerminal indexed that Jupiter does not carry. Dropping it
    // would hide a real new pool; defaulting its audit would grade it safe.
    const orphan: LaunchObservation = {
      mint: "8tAjU6WuS7xtPqBf9THKZzwHgFUiMk1phTU6J3R5nFbp",
      name: "JAMU / SOL",
      symbol: "JAMU",
      hue: 12,
      decimals: 9,
      poolCreatedAt: SEEN - 40_000,
      firstSeenAt: SEEN,
      event: "graduation",
      venue: "pumpswap",
      priceUsd: 0.0000031,
      liquidityUsd: 2_438,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      authorityKnown: false,
      source: "geckoterminal",
    };
    const m = new Map<string, TokenLaunch>();
    mergeLaunch(m, orphan);
    const row = m.get(orphan.mint)!;
    expect(row.triage.verdict).toBe("avoid");
    expect(row.triage.checks.find((c) => c.key === "mint_authority")!.assumed).toBe(true);
    expect(row.triage.checks.find((c) => c.key === "creator_history")!.state).toBe("unchecked");
    // Not on a launchpad curve, so LP lock is a real question — just an
    // unanswered one.
    expect(row.triage.checks.find((c) => c.key === "lp_locked")!.state).toBe("unchecked");
  });
});
