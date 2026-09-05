// The handoff links: plain without a code, GMGN's documented formats with
// one, and never a code that does not look like a code.

import { describe, expect, it } from "vitest";
import { cleanReferrals, tradeLinks, venueRows } from "../src/lib/handoff/venues";

const MINT = "So11111111111111111111111111111111111111112";

describe("cleanReferrals", () => {
  it("keeps a code shaped like a code and drops everything else", () => {
    expect(cleanReferrals({ gmgn: "btMwCvbB" })).toEqual({ gmgn: "btMwCvbB" });
    expect(cleanReferrals({ gmgn: "has space" })).toEqual({});
    expect(cleanReferrals({ gmgn: "x" })).toEqual({});
    expect(cleanReferrals({ gmgn: "<script>" })).toEqual({});
    expect(cleanReferrals({ unknownVenue: "abc" })).toEqual({});
    expect(cleanReferrals(null)).toEqual({});
  });
});

describe("tradeLinks", () => {
  it("builds plain links with no code, and no bot link at all", () => {
    const links = tradeLinks(MINT);
    expect(links.map((l) => l.label)).toEqual(["pump.fun", "Jupiter", "GMGN", "DexScreener"]);
    expect(links.every((l) => !l.referral)).toBe(true);
    expect(links.find((l) => l.label === "GMGN")?.href).toBe(`https://gmgn.ai/sol/token/${MINT}`);
    expect(links.find((l) => l.label === "pump.fun")?.href).toBe(`https://pump.fun/coin/${MINT}`);
  });

  it("puts the code on GMGN's web and bot links in the formats GMGN documents, and nowhere else", () => {
    const links = tradeLinks(MINT, { gmgn: "romnova" });
    expect(links.map((l) => l.label)).toEqual(["pump.fun", "Jupiter", "GMGN", "GMGN bot", "DexScreener"]);
    const web = links.find((l) => l.label === "GMGN")!;
    expect(web).toMatchObject({ href: `https://gmgn.ai/sol/token/romnova_${MINT}`, referral: true, kind: "web" });
    const bot = links.find((l) => l.label === "GMGN bot")!;
    expect(bot).toMatchObject({ href: `https://t.me/GMGN_sol_bot?start=i_romnova_c_${MINT}`, referral: true, kind: "telegram" });
    expect(links.filter((l) => l.referral)).toHaveLength(2);
    expect(links.find((l) => l.label === "Jupiter")?.href).toBe(`https://jup.ag/swap/SOL-${MINT}`);
  });

  it("labels the rows the page maps so a reader sees which links carry a code", () => {
    expect(venueRows().map((r) => r.label)).toEqual(["pump.fun", "Jupiter", "GMGN", "DexScreener"]);
    const rows = venueRows({ gmgn: "romnova" });
    expect(rows.map((r) => r.label)).toEqual(["pump.fun", "Jupiter", "GMGN · ref", "GMGN bot · ref", "DexScreener"]);
    expect(rows[2].href(MINT)).toBe(`https://gmgn.ai/sol/token/romnova_${MINT}`);
  });
});
