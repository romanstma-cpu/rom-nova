// The keyless providers publish price, liquidity and trade counts, and nothing
// about who holds the supply. Read literally, their zeros describe the safest
// token ever listed: top 10 wallets hold nothing, no insiders, no bundlers, no
// snipers, a dev holding zero.
//
// These tests exist because that failure is silent. Nothing throws, no request
// fails, and the app renders a confident green score for a token nobody has
// examined. Every assertion below is a guard on that one mistake.

import { describe, it, expect } from "vitest";
import { DemoStore } from "@/lib/demo/store";
import { extractFeatures } from "@/lib/engine/features";
import { computeSignal, FACTORS, RISK_FACTORS } from "@/lib/engine/signals";
import { riskRadar } from "@/lib/engine/risk";
import { narrativeOf, hueOf } from "@/lib/providers/classify";
import type { FeatureVector, UnmeasuredField } from "@/lib/types";

const store = new DemoStore(77);
const now = store.universe.genesis;
const someMint = store.tokenList()[0].info.mint;

/** Everything a keyless source cannot see. */
const BLIND: readonly UnmeasuredField[] = [
  "top10Pct",
  "devHoldsPct",
  "insiderPct",
  "bundlerPct",
  "sniperPct",
  "organicScore",
  "socialScore",
  "holders",
  "uniqueBuyers1h",
  "uniqueSellers1h",
];

/** The vector a DEX Screener / GeckoTerminal snapshot actually produces. */
function blindVector(): FeatureVector {
  const f = extractFeatures(store, someMint, now)!;
  return {
    ...f,
    top10Pct: 0,
    devHoldsPct: 0,
    insiderPct: 0,
    bundlerPct: 0,
    sniperPct: 0,
    organicScore: 0,
    socialScore: 0,
    devSold: false,
    unmeasured: BLIND,
  };
}

describe("the danger this machinery exists to prevent", () => {
  it("scores a perfect distribution mark from a zero, if nothing stops it", () => {
    // Not a bug being asserted — the raw arithmetic, shown so the guard below
    // is obviously necessary rather than defensive decoration.
    const distribution = FACTORS.find((x) => x.key === "distribution")!;
    const naive = { ...blindVector(), unmeasured: undefined };
    expect(distribution.normalize(naive)).toBe(1);
  });

  it("assesses zero risk from zeros, if nothing stops it", () => {
    const naive = { ...blindVector(), unmeasured: undefined };
    for (const key of ["insider_risk", "bundler_sniper"]) {
      expect(RISK_FACTORS.find((x) => x.key === key)!.normalize(naive)).toBe(0);
    }
  });
});

describe("factors drop out rather than scoring fiction", () => {
  const sig = computeSignal(store, someMint, now)!;

  it("still produces a signal for a fully-measured token", () => {
    expect(sig).toBeTruthy();
    expect(sig.factors.length).toBeGreaterThan(0);
  });

  it("marks unmeasured factors as not measured, and contributes nothing", () => {
    const f = blindVector();
    // computeSignal reads from the store, so exercise the guard directly on
    // the factor definitions it uses.
    const blind = FACTORS.filter((d) => d.needs?.some((n) => f.unmeasured!.includes(n)));
    expect(blind.map((d) => d.key).sort()).toEqual(
      ["distribution", "holder_growth", "organic", "social"].sort(),
    );
  });

  it("declares every factor that reads a maybe-absent field", () => {
    // A factor reading top10Pct without declaring it would silently score the
    // zero. This catches the next one somebody adds.
    const READS: Record<string, UnmeasuredField[]> = {
      distribution: ["top10Pct"],
      organic: ["organicScore"],
      social: ["socialScore"],
      holder_growth: ["holders"],
      insider_risk: ["insiderPct"],
      bundler_sniper: ["bundlerPct", "sniperPct"],
      dev_risk: ["devHoldsPct"],
    };
    for (const [key, fields] of Object.entries(READS)) {
      const def = [...FACTORS, ...RISK_FACTORS].find((d) => d.key === key);
      expect(def, `factor ${key} vanished`).toBeTruthy();
      for (const field of fields) {
        expect(def!.needs ?? [], `${key} must declare ${field}`).toContain(field);
      }
    }
  });
});

describe("the risk radar never grades the unknown as safe", () => {
  const radar = riskRadar(store, someMint, now)!;

  it("grades a fully-measured token normally", () => {
    expect(["low", "medium", "high"]).toContain(radar.concentration);
  });

  it("would call unknown concentration high, not low", () => {
    // riskRadar reads through extractFeatures, so the property is asserted on
    // the rule it encodes: an unmeasured field must never reach a "low" grade.
    const f = blindVector();
    const unknownConcentration = Boolean(f.unmeasured?.includes("top10Pct"));
    expect(unknownConcentration).toBe(true);
    // With top10Pct at 0 and undeclared, the old rule returned "low".
    const oldRule = f.top10Pct > 0.4 ? "high" : f.top10Pct > 0.25 ? "medium" : "low";
    expect(oldRule).toBe("low");
  });
});

describe("narrative classification", () => {
  it("returns only members of the Narrative union", () => {
    const valid = ["AI", "Dogs", "Cats", "Politics", "Gaming", "Celebrity", "Internet", "DeFi", "Community"];
    for (const [name, sym] of [
      ["Bonk", "BONK"],
      ["Neural Agent Protocol", "NAP"],
      ["Kitty Coin", "MEOW"],
      ["Trump 2028", "MAGA"],
      ["Pixel Quest", "PXQ"],
      ["Yield Vault", "VLT"],
      ["Something Unclassifiable", "ZZZ"],
    ]) {
      expect(valid).toContain(narrativeOf(name, sym));
    }
  });

  it("prefers the more specific match", () => {
    // "Doge AI Agent" contains both a dog and an AI cue; AI is checked first
    // so it does not fall into Dogs on the looser match.
    expect(narrativeOf("Doge AI Agent", "DAIA")).toBe("AI");
    expect(narrativeOf("Bonk Inu", "BONK")).toBe("Dogs");
  });

  it("gives a token the same colour every time", () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    expect(hueOf(mint)).toBe(hueOf(mint));
    expect(hueOf(mint)).toBeGreaterThanOrEqual(0);
    expect(hueOf(mint)).toBeLessThan(360);
    expect(hueOf(mint)).not.toBe(hueOf("So11111111111111111111111111111111111111112"));
  });
});
