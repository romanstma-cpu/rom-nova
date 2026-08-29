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

import { describe, it, expect } from "vitest";
import { dataMode, FLAGS } from "@/lib/providers/registry";

/** Every capability the chip is responsible for describing. */
const CAPABILITIES = [
  "tokens",
  "prices & candles",
  "mint & freeze authority",
  "whale flow",
  "wallet activity",
  "holder distribution",
  "rug & LP-lock risk",
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

  it("reserves 'demo' for nothing being live, and 'live' for nothing simulated", () => {
    const m = dataMode();
    if (m.overall === "demo") expect(m.live).toHaveLength(0);
    if (m.overall === "live") expect(m.simulated).toHaveLength(0);
    if (m.overall === "mixed") {
      expect(m.live.length).toBeGreaterThan(0);
      expect(m.simulated.length).toBeGreaterThan(0);
    }
  });

  // The state this app is actually in, and the one the old flat chip described
  // worst.
  it("reports mixed on the default keyless configuration", () => {
    expect(dataMode().overall).toBe("mixed");
  });
});
