// The chrome used to hardcode "SIMULATED DATA", with a tooltip claiming every
// token, wallet and trade in the terminal was synthetic and the SOL reference
// price was the one live number. Half of that is now false: the token list is
// DEX Screener, mint and freeze authority come from the chain, and whale flow
// comes from SQD.
//
// A blanket claim is wrong in whichever direction it points. Told the whole
// screen is simulated, a reader discounts a real number; shown one real panel,
// they extend that trust to a synthetic one beside it. `dataMode` is what stops
// the chip drifting away from the providers a second time.
//
// Deliberately its own file: source.test.ts mocks the whole registry module to
// drive a fake adapter, so these assertions would be testing the mock.

import { describe, it, expect, afterEach } from "vitest";
import { dataMode, FLAGS } from "@/lib/providers/registry";
import { noteOutcome, resetOutcomes } from "@/lib/providers/health-log";

/** Every capability the chip is responsible for describing. */
const CAPABILITIES = [
  "tokens",
  "signals",
  "prices & candles",
  "mint & freeze authority",
  "whale flow",
  "wallet activity",
  "wallet positions",
  "holder distribution",
  "rug & LP-lock risk",
  "new-pool launch feed",
  "smart-money scoring",
] as const;

describe("dataMode — the chip cannot outlive the truth", () => {
  it("classifies every capability, leaving none unstated", () => {
    const m = dataMode();
    const all = [...m.live, ...m.simulated];
    for (const c of CAPABILITIES) expect(all).toContain(c);
  });

  it("never lists a capability as both live and simulated", () => {
    const m = dataMode();
    for (const c of m.live) expect(m.simulated).not.toContain(c);
  });

  it("adds nothing beyond the capabilities it promises to cover", () => {
    const m = dataMode();
    for (const c of [...m.live, ...m.simulated]) {
      expect(CAPABILITIES as readonly string[]).toContain(c);
    }
  });

  // Wallet reputation is not published by anything in this stack, so smart
  // money can never be claimed live however many providers are configured.
  it("keeps smart-money scoring simulated unconditionally", () => {
    expect(dataMode().simulated).toContain("smart-money scoring");
  });

  // This assertion used to read "does not claim holder distribution without a
  // KEYED provider", on the reasoning that it needs getTokenLargestAccounts and
  // the free RPC answers that with "Request blocked". That was true of the RPC
  // and false of the whole stack: Jupiter publishes holderCount, its 24h change
  // and the top-holder share, keylessly, in the same payload as the price.
  //
  // So the invariant is not "keyed or nothing" — it is that the claim tracks
  // whoever can actually answer, and collapses the moment nobody can.
  it("claims holder distribution only when a provider supplies it", () => {
    const m = dataMode();
    const supplied = FLAGS.birdeye() || FLAGS.jupiter();
    expect(supplied ? m.live : m.simulated).toContain("holder distribution");
  });

  // Same contract for the risk overlay: present only while a grader is wired.
  it("claims rug & LP-lock risk only when a risk provider is configured", () => {
    const m = dataMode();
    expect(FLAGS.rugcheck() ? m.live : m.simulated).toContain("rug & LP-lock risk");
  });

  // The launch feed is the one capability that never falls back — handleLaunches
  // returns nothing rather than a simulated launch, because a synthetic feed
  // would look identical to a real one while being fiction about the only thing
  // it measures. So this line tracks whether the page can exist at all.
  it("claims the launch feed only when its source is enabled", () => {
    const m = dataMode();
    expect(FLAGS.jupiter() ? m.live : m.simulated).toContain("new-pool launch feed");
  });

  it("reserves 'demo' for nothing being live, and 'live' for nothing qualified", () => {
    const m = dataMode();
    if (m.overall === "demo") expect(m.live).toHaveLength(0);
    if (m.overall === "live") {
      expect(m.simulated).toHaveLength(0);
      // A bound is a qualification, and "LIVE" beside a qualified number is the
      // more damaging half-truth — a reader sees LIVE next to a PnL figure and
      // reads it as the wallet's record rather than as two days of it.
      expect(m.bounded).toHaveLength(0);
    }
    if (m.overall === "mixed") {
      expect(m.live.length).toBeGreaterThan(0);
      expect(m.simulated.length + m.bounded.length).toBeGreaterThan(0);
    }
  });

  // Real wallet history is the capability that needs a third column, and it
  // needs TWO entries in it: the fills reach ~2 days in every runtime, while
  // the wallet's age reaches the whole index — but only where no Origin header
  // is sent. One bound covering both would be false for one of them.
  it("qualifies wallet history rather than calling it flatly live", () => {
    const m = dataMode();
    if (!FLAGS.walletChain() || FLAGS.helius()) return;
    expect(m.live).toContain("wallet activity");
    const joined = m.bounded.join(" ");
    expect(joined).toMatch(/fills/i);
    // The bound must name the limit, not merely gesture at one.
    expect(joined).toMatch(/2 days|retention/i);
    // And it must separate the two depths rather than averaging them.
    expect(joined).toMatch(/age/i);
    expect(joined).toMatch(/browser|Origin/i);
  });

  it("never lists the same claim as both live and bounded", () => {
    const m = dataMode();
    for (const b of m.bounded) expect(m.live).not.toContain(b);
  });

  // The state this app is actually in, and the one the old flat chip described
  // worst.
  it("reports mixed on the default keyless configuration", () => {
    expect(dataMode().overall).toBe("mixed");
  });
});

// Signals descend from the token list. They were never listed at all, so the
// chip could not say whether the thirty cards on /signals were real — and
// the review found they were not, under no marker.
describe("dataMode — signals follow the token list, and the last outcome wins", () => {
  afterEach(resetOutcomes);

  it("lists signals with the token list's own answer", () => {
    const m = dataMode();
    expect(FLAGS.jupiter() || FLAGS.dexscreener() || FLAGS.coingecko() ? m.live : m.simulated).toContain("signals");
  });

  it("stays live after a pass that answered", () => {
    noteOutcome("signals", true);
    expect(dataMode().live).toContain("signals");
  });

  it("moves to bounded, with the reason, after a pass that failed", () => {
    if (!(FLAGS.jupiter() || FLAGS.dexscreener() || FLAGS.coingecko())) return;
    noteOutcome("signals", false, "no live token source answered");
    const m = dataMode();
    expect(m.live).not.toContain("signals");
    expect(m.simulated).not.toContain("signals");
    const bound = m.bounded.find((b) => b.startsWith("signals"));
    expect(bound).toBeTruthy();
    expect(bound).toMatch(/FAILED/);
    expect(bound).toMatch(/no live token source answered/);
    expect(bound).toMatch(/simulator/);
  });
});
