// The flow provider's two jobs beyond fetching: count only real movement, and
// never present a truncated window as a full one.
//
// Both failures are silent. A row where preAmount equals postAmount is an
// account merely touched by a transaction, and counting those would overstate
// participation by four to fourteen times depending on the mint — worst on
// exactly the small tokens this app is about. And a read that stops at its byte
// budget produces a perfectly plausible number for a window it never covered.

import { describe, it, expect } from "vitest";
import { foldBalance, summarise, coveragePct, toUnits, BLOCKS_PER_MINUTE } from "@/lib/providers/sqd";
import type { TokenFlow } from "@/lib/providers/types";

const ledger = () => new Map<string, bigint>();

describe("foldBalance — only real movement counts", () => {
  it("counts a balance that increased", () => {
    const m = ledger();
    expect(foldBalance({ postOwner: "alice", preAmount: "100", postAmount: "150" }, m)).toBe("counted");
    expect(m.get("alice")).toBe(BigInt(50));
  });

  it("counts a balance that decreased", () => {
    const m = ledger();
    foldBalance({ postOwner: "bob", preAmount: "200", postAmount: "50" }, m);
    expect(m.get("bob")).toBe(BigInt(-150));
  });

  // The big one: most rows look like this.
  it("ignores an account merely touched by the transaction", () => {
    const m = ledger();
    expect(foldBalance({ postOwner: "carol", preAmount: "999", postAmount: "999" }, m)).toBe("unchanged");
    expect(m.size).toBe(0);
  });

  // postOwner is null when the token account is closed. The movement is real
  // and still belongs to whoever held it a moment ago.
  it("attributes a closed account to its previous owner", () => {
    const m = ledger();
    expect(foldBalance({ preOwner: "dave", postOwner: null, preAmount: "500", postAmount: null }, m)).toBe("counted");
    expect(m.get("dave")).toBe(BigInt(-500));
  });

  it("refuses a row with no owner at all", () => {
    const m = ledger();
    expect(foldBalance({ preAmount: "1", postAmount: "2" }, m)).toBe("unattributable");
    expect(m.size).toBe(0);
  });

  it("survives a malformed amount without poisoning the ledger", () => {
    const m = ledger();
    expect(foldBalance({ postOwner: "eve", preAmount: "abc", postAmount: "5" }, m)).toBe("unattributable");
    expect(m.size).toBe(0);
  });

  // SPL supplies routinely exceed 2^53 — wSOL's is 8.8e18. Number would round.
  it("keeps precision past Number.MAX_SAFE_INTEGER", () => {
    const m = ledger();
    foldBalance({ postOwner: "whale", preAmount: "8799457825361551324", postAmount: "8799457825361551325" }, m);
    expect(m.get("whale")).toBe(BigInt(1));
  });

  it("accumulates a wallet appearing in several rows", () => {
    const m = ledger();
    foldBalance({ postOwner: "frank", preAmount: "0", postAmount: "100" }, m);
    foldBalance({ postOwner: "frank", preAmount: "100", postAmount: "40" }, m);
    expect(m.get("frank")).toBe(BigInt(40));
  });
});

describe("summarise", () => {
  // Synthetic names are not valid addresses, so these pass an explicit
  // everyone-is-a-wallet predicate; the production default (curve + known
  // addresses) has its own test below with real ones.
  const anyOwner = () => true;
  const built = () => {
    const m = ledger();
    m.set("buyerBig", BigInt(1000));
    m.set("buyerSmall", BigInt(10));
    m.set("sellerBig", BigInt(-800));
    m.set("flat", BigInt(0));
    return summarise(m, 2, anyOwner);
  };

  it("splits buyers from sellers", () => {
    const s = built();
    expect(s.buyers).toBe(2);
    expect(s.sellers).toBe(1);
  });

  it("nets inflow against outflow", () => {
    const s = built();
    expect(s.inflowUnits).toBe("1010");
    expect(s.outflowUnits).toBe("800");
    expect(s.netUnits).toBe("210");
  });

  // A top-N taken off a descending sort would list accumulators and never the
  // wallet quietly unloading, which is the one a reader most wants to see.
  it("reports the biggest seller as well as the biggest buyer", () => {
    const owners = built().largest.map((l) => l.owner);
    expect(owners).toContain("buyerBig");
    expect(owners).toContain("sellerBig");
  });

  it("does not list a wallet twice when the ranges overlap", () => {
    const m = ledger();
    m.set("only", BigInt(5));
    const s = summarise(m, 5, anyOwner);
    expect(s.largest).toHaveLength(1);
  });

  it("counts a net-zero wallet as neither side", () => {
    const s = built();
    expect(s.wallets).toBe(4);
    expect(s.buyers + s.sellers).toBe(3);
  });

  // Round 3: 15 of 39 rows on a live token's flow table were off-curve pool
  // vaults sided BUY/SELL under a column headed "Wallet", and the burn address
  // would have passed through too. People counts exclude them; the unit
  // totals keep the whole ledger, because token flow is symmetric and
  // removing one side of every swap would change what netflow measures.
  it("excludes pool authorities and the burn address from the people counts, not the units", () => {
    const RAYDIUM_AUTHORITY_V4 = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"; // off-curve
    const TRADER = "AN47o2eFxxMakqU1SNjLCE4YCPwoDJ83tzumk8Ec2wQ7"; // real keypair
    const BURN = "1nc1nerator11111111111111111111111111111111";
    const m = ledger();
    m.set(RAYDIUM_AUTHORITY_V4, BigInt(-800));
    m.set(TRADER, BigInt(800));
    m.set(BURN, BigInt(50));
    const s = summarise(m, 5); // the production default predicate
    expect(s.wallets).toBe(1);
    expect(s.buyers).toBe(1);
    expect(s.sellers).toBe(0);
    expect(s.largest.map((l) => l.owner)).toEqual([TRADER]);
    expect(s.inflowUnits).toBe("850");
    expect(s.outflowUnits).toBe("800");
    expect(s.netUnits).toBe("50");
  });
});

describe("coveragePct — a partial window must not read as a full one", () => {
  const flow = (over: Partial<TokenFlow>): TokenFlow =>
    ({ blocksRequested: 1500, blocksCovered: 1500, complete: true, ...over }) as TokenFlow;

  it("is 100 for a complete read", () => {
    expect(coveragePct(flow({}))).toBe(100);
  });

  // Measured against wSOL: asked for ten minutes, the byte budget delivered 4%.
  it("reports the real fraction when a budget cut the read", () => {
    expect(coveragePct(flow({ blocksCovered: 57, complete: false }))).toBeCloseTo(3.8, 1);
  });

  it("never exceeds 100 even if the head moved mid-read", () => {
    expect(coveragePct(flow({ blocksCovered: 3000 }))).toBe(100);
  });

  it("is zero rather than NaN for an empty request", () => {
    expect(coveragePct(flow({ blocksRequested: 0, blocksCovered: 0 }))).toBe(0);
  });
});

describe("toUnits", () => {
  it("applies the mint's decimals", () => {
    expect(toUnits("1500000000", 9)).toBe(1.5);
    expect(toUnits("100000", 5)).toBe(1);
  });

  it("returns 0 rather than NaN on junk", () => {
    expect(toUnits("not-a-number", 9)).toBe(0);
  });
});

describe("block arithmetic", () => {
  it("uses Solana's ~400ms block time", () => {
    // 150 blocks/minute is 2.5/second. Getting this wrong silently changes what
    // window every caller thinks it asked for.
    expect(BLOCKS_PER_MINUTE).toBe(150);
  });
});
