// The whole-build review's first HIGH: one whale-flow reading rendered as "—"
// on the scanner and as "$0 — a quiet window, not a verdict" on three other
// pages, from the same 30-second list batch, seconds apart. The engine had
// declared the field UNMEASURED; three renderers never asked. The scanner,
// which did ask, gave one false reason for every dash.
//
// The fix lives in one helper every page calls, so this file tests the helper
// and the CSV the screener exports — the one surface that had dropped the
// distinction entirely.

import { describe, it, expect } from "vitest";
import { whaleFlowCell, absent } from "@/lib/client";
import { screenCsv } from "@/app/screener/page";
import type { TokenRow } from "@/lib/api/rows";

const row = (over: Partial<TokenRow>): TokenRow =>
  ({
    mint: "M".repeat(43),
    symbol: "TST",
    name: "Test",
    hue: 0,
    priceUsd: 1,
    marketCapUsd: 1e6,
    liquidityUsd: 1e5,
    volume24hUsd: 5e4,
    m5: 0,
    h1: 0,
    h6: 0,
    h24: 0,
    holders: 0,
    holderGrowthPct: 0,
    top10Pct: 0,
    organicScore: 0,
    whaleFlowUsd: 0,
    smFlow6hUsd: 0,
    signalScore: 50,
    signalLabel: "NEUTRAL",
    confidence: 0.5,
    riskLevel: "medium",
    ageHours: 12,
    ...over,
  }) as TokenRow;

describe("whaleFlowCell — absence before arithmetic", () => {
  it("dashes an unmeasured whale flow and names every cause, not one", () => {
    const c = whaleFlowCell(row({ whaleFlowUsd: 0, unmeasured: ["whaleFlow"] }));
    expect(c.text).toBe("—");
    expect(c.text).not.toMatch(/\$0/);
    expect(c.title).not.toMatch(/quiet window/);
    // The three ways the engine declares it, all present.
    expect(c.title).toMatch(/no single \$20,000\+ move/);
    expect(c.title).toMatch(/returned nothing/);
    expect(c.title).toMatch(/no flow source/);
    expect(c.title).not.toMatch(/no wallet-flow source configured/);
  });

  it("still prints a MEASURED zero as a quiet window", () => {
    // A simulated row, or a live row where the engine chose to keep the
    // reading — the field is not declared absent, so the number is real.
    const c = whaleFlowCell(row({ whaleFlowUsd: 0, flowMinutes: 10 }));
    expect(c.text).toBe("$0");
    expect(c.title).toMatch(/quiet window, not a verdict/);
  });

  it("prints a real reading with its window", () => {
    const c = whaleFlowCell(row({ whaleFlowUsd: 249_426, flowMinutes: 4 }));
    expect(c.text).toBe("$249.4K");
    expect(c.cls).toBe("pos");
    expect(c.title).toMatch(/last 4 min of chain/);
  });
});

describe("absent — shared, not copied", () => {
  it("reads the row's declaration", () => {
    expect(absent(row({ unmeasured: ["momentum", "whaleFlow"] }), "momentum")).toBe(true);
    expect(absent(row({ unmeasured: ["momentum"] }), "whaleFlow")).toBe(false);
    expect(absent(row({}), "whaleFlow")).toBe(false);
  });
});

describe("screenCsv — an export must not launder a placeholder into a figure", () => {
  it("leaves unmeasured cells empty and lists what was absent", () => {
    const csv = screenCsv([
      row({ whaleFlowUsd: 0, h1: 0, top10Pct: 0, unmeasured: ["whaleFlow", "momentum", "top10Pct"] }),
    ]);
    const [header, line] = csv.split("\n");
    const cols = header.split(",");
    const vals = line.split(",");
    const at = (name: string) => vals[cols.indexOf(name)];
    expect(at("whaleFlowUsd")).toBe('""');
    expect(at("h1")).toBe('""');
    expect(at("top10Pct")).toBe('""');
    // A measured field beside them keeps its value.
    expect(at("marketCapUsd")).toBe("1000000");
    expect(cols).toContain("unmeasured");
    expect(at("unmeasured")).toBe('"whaleFlow;momentum;top10Pct"');
  });

  it("writes a measured zero as 0, not as blank", () => {
    const csv = screenCsv([row({ whaleFlowUsd: 0 })]);
    const [header, line] = csv.split("\n");
    expect(line.split(",")[header.split(",").indexOf("whaleFlowUsd")]).toBe("0");
  });
});
