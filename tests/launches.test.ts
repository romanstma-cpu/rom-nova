// The launch feed's two jobs are to see a launch and to remember when it saw
// it. The first is the adapter's; the second is the merge's, and it is the one
// that is easy to break invisibly — a first-seen timestamp that refreshes on
// every poll reports a latency of zero while the feed runs minutes behind.
//
// FIXTURES ARE REAL PAYLOADS. Both rows below were captured from
// lite-api.jup.ag/tokens/v2/recent, including the empty name and symbol on the
// freshest one, which is not a mistake in the fixture.

import { describe, it, expect } from "vitest";
import { toLaunch } from "@/lib/providers/jupiter";
import { mergeLaunch } from "@/lib/api/launches";
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
      source: "coingecko",
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
