// The rules that stop a two-day window from being reported as a career.
//
// Three specific lies this file exists to prevent, each of which every other
// wallet tracker tells by default:
//
//   1. A sell whose buy predates the window, credited at a cost of zero, so its
//      whole proceeds become "profit".
//   2. A bag acquired before the window, given a cost basis anyway, so a
//      position bought at any price shows a clean multiple.
//   3. A statistic with no sample behind it rendered as 0 — 0% win rate on a
//      wallet that has not closed a trade, $0 realized on one that has not sold.

import { describe, it, expect } from "vitest";
import { replayFills, reconcile, assembleProfile, RECONCILE_TOLERANCE } from "@/lib/engine/wallet-profile";
import type { WalletCoverage, WalletFill } from "@/lib/types";

const W = "EmNnGUq5eeVRhU175SswgkUWiVD3E6gagJKQE6aomqRK";
const A = "MintAAAA1111111111111111111111111111111111AA";
const B = "MintBBBB1111111111111111111111111111111111BB";
const H = 3_600_000;
const T0 = 1_700_000_000_000;

let seq = 0;
function fill(over: Partial<WalletFill>): WalletFill {
  seq++;
  const tokens = over.tokens ?? 100;
  const priceUsd = over.priceUsd;
  return {
    signature: `sig${seq}`,
    slot: seq,
    ts: over.ts ?? T0,
    wallet: W,
    mint: A,
    decimals: 6,
    side: "buy",
    tokens,
    pricing: priceUsd === undefined ? "unpriced" : "stable",
    classification: priceUsd === undefined ? "transfer" : "open",
    ...over,
    ...(priceUsd !== undefined ? { priceUsd, valueUsd: priceUsd * tokens } : {}),
  };
}

const COVERAGE: WalletCoverage = {
  source: "solana-rpc",
  runtime: "node",
  newestTs: T0 + 4 * H,
  oldestTs: T0,
  windowHours: 4,
  signaturesListed: 10,
  transactionsRead: 10,
  transactionsFailed: 0,
  transactionsRefused: 0,
  transactionsUnavailable: 0,
  cappedByBudget: false,
  reachedEndpointLimit: true,
  lifetime: false,
  indexArchival: false,
  indexComplete: true,
  firstSeenTs: T0,
  historyDays: 0,
  note: "test window",
};

describe("replayFills — FIFO over what was actually seen", () => {
  it("closes a round trip and books the difference", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "sell", tokens: 100, priceUsd: 1.5, ts: T0 + 2 * H }),
    ]);
    expect(r.ledger.roundTrips).toHaveLength(1);
    expect(r.ledger.realizedPnlUsd).toBeCloseTo(50, 9);
    expect(r.ledger.roundTrips[0].holdHours).toBeCloseTo(2, 9);
    expect(r.unmatched.size).toBe(0);
  });

  it("matches lots oldest first, not cheapest first", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "buy", tokens: 100, priceUsd: 3, ts: T0 + H }),
      fill({ side: "sell", tokens: 100, priceUsd: 2, ts: T0 + 2 * H }),
    ]);
    // FIFO sells the $1 lot: +$100. LIFO would have booked a $100 loss, and
    // "average cost" would have booked nothing. The three disagree by $200 on
    // two hundred dollars of trading.
    expect(r.ledger.realizedPnlUsd).toBeCloseTo(100, 9);
  });

  // The big one. A sell with no observed buy is proceeds without a cost, and
  // matching it at zero would report the entire sale as profit.
  it("excludes a sell with no observed buy instead of costing it at zero", () => {
    const r = replayFills(W, [fill({ side: "sell", tokens: 400, priceUsd: 2, ts: T0 })]);
    expect(r.ledger.realizedPnlUsd).toBe(0);
    expect(r.ledger.roundTrips).toHaveLength(0);
    expect(r.unmatched.get(A)).toBeCloseTo(400, 9);
  });

  it("splits a sell that only partly matches", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "sell", tokens: 250, priceUsd: 2, ts: T0 + H }),
    ]);
    // The 100 we saw bought: cost $100, sold for $200, +$100. The other 150 are
    // unattributable and contribute nothing rather than another $300 of "gain".
    expect(r.ledger.realizedPnlUsd).toBeCloseTo(100, 9);
    expect(r.unmatched.get(A)).toBeCloseTo(150, 9);
  });

  // An unpriced movement changes the position and contributes no cost. Skipping
  // it entirely would make the reconciliation report a divergence this read can
  // actually explain.
  it("counts an unpriced movement in the token balance but not in the lots", () => {
    const r = replayFills(W, [
      fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ side: "buy", tokens: 900, ts: T0 + H }),
    ]);
    expect(r.derivedTokens.get(A)).toBeCloseTo(1000, 9);
    expect(r.ledger.positions[0].tokens).toBeCloseTo(100, 9);
    expect(r.ledger.positions[0].costBasisUsd).toBeCloseTo(100, 9);
    expect(r.unpricedMints.has(A)).toBe(true);
  });

  it("keeps each mint's lots to itself", () => {
    const r = replayFills(W, [
      fill({ mint: A, side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
      fill({ mint: B, side: "sell", tokens: 100, priceUsd: 5, ts: T0 + H }),
    ]);
    expect(r.ledger.realizedPnlUsd).toBe(0);
    expect(r.unmatched.get(B)).toBeCloseTo(100, 9);
    expect(r.derivedTokens.get(A)).toBeCloseTo(100, 9);
  });

  it("replays in time order regardless of input order", () => {
    const buy = fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 });
    const sell = fill({ side: "sell", tokens: 100, priceUsd: 4, ts: T0 + H });
    const forwards = replayFills(W, [buy, sell]).ledger.realizedPnlUsd;
    const backwards = replayFills(W, [sell, buy]).ledger.realizedPnlUsd;
    expect(backwards).toBeCloseTo(forwards, 9);
    expect(backwards).toBeCloseTo(300, 9);
  });
});

describe("reconcile — does the history explain the balance?", () => {
  it("accepts a position the fills fully account for", () => {
    expect(reconcile(1000, 1000, false).costBasisKnown).toBe(true);
  });

  it("tolerates dust-level drift from transfer taxes and rounding", () => {
    expect(reconcile(1000, 1000 * (1 - RECONCILE_TOLERANCE / 2), false).costBasisKnown).toBe(true);
  });

  it("refuses when the wallet holds materially more than it was seen buying", () => {
    const v = reconcile(10_000, 400, false);
    expect(v.costBasisKnown).toBe(false);
    expect(v.reason).toMatch(/acquired outside this window/i);
  });

  it("refuses a position with no observed entry at all", () => {
    const v = reconcile(10_000, 0, false);
    expect(v.costBasisKnown).toBe(false);
    expect(v.reason).toMatch(/held before the readable window/i);
  });

  // Token counts can reconcile perfectly while the cost is still unknown,
  // because an unpriced arrival supplies tokens and no price.
  it("refuses when part of the position arrived without a price", () => {
    const v = reconcile(1000, 1000, true);
    expect(v.costBasisKnown).toBe(false);
    expect(v.reason).toMatch(/no price attached/i);
  });
});

describe("assembleProfile — what reaches the screen", () => {
  const holdings = (tokens: { mint: string; tokens: number }[]) => ({
    source: "jupiter",
    solBalance: 1.5,
    tokens: tokens.map((t) => ({ ...t, decimals: 6, frozen: false, excludeFromNetWorth: false })),
  });

  it("prices a reconciled position and gives it an unrealized PnL", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 1000, priceUsd: 1, ts: T0 })],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 1000 }]),
      prices: new Map([[A, 1.5]]),
    });
    const pos = p.positions.find((x) => x.mint === A)!;
    expect(pos.costBasisKnown).toBe(true);
    expect(pos.costBasisUsd).toBeCloseTo(1000, 9);
    expect(pos.valueUsd).toBeCloseTo(1500, 9);
    expect(pos.unrealizedPnlUsd).toBeCloseTo(500, 9);
    expect(p.stats.unrealizedPnlUsd).toBeCloseTo(500, 9);
  });

  // The lie this whole design exists to refuse. The wallet holds 10,000 tokens
  // and we watched it buy 400; a tracker that assumed would report a 25x.
  it("gives an unreconciled position a value and NO unrealized PnL", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 400, priceUsd: 0.01, ts: T0 })],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 10_000 }]),
      prices: new Map([[A, 1]]),
    });
    const pos = p.positions.find((x) => x.mint === A)!;
    expect(pos.valueUsd).toBeCloseTo(10_000, 9);
    expect(pos.costBasisUsd).toBeUndefined();
    expect(pos.unrealizedPnlUsd).toBeUndefined();
    expect(pos.costBasisKnown).toBe(false);
    expect(p.stats.unrealizedPnlUsd).toBeUndefined();
    expect(p.unmeasured).toContain("costBasis");
  });

  // A zero here would say "traded and broke even". The truth is "has not
  // closed a trade where we could see it".
  it("leaves realized PnL and win rate absent when no round trip closed", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 })],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 100 }]),
      prices: new Map([[A, 1]]),
    });
    expect(p.stats.realizedPnlUsd).toBeUndefined();
    expect(p.stats.winRate).toBeUndefined();
    expect(p.stats.profitFactor).toBeUndefined();
    expect(p.stats.medianHoldHours).toBeUndefined();
    expect(p.stats.roundTrips).toBe(0);
  });

  it("declares realizedPnl unmeasured when sells outran the observed buys", () => {
    const p = assembleProfile({
      address: W,
      fills: [
        fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
        fill({ side: "sell", tokens: 500, priceUsd: 2, ts: T0 + H }),
      ],
      coverage: COVERAGE,
      holdings: holdings([]),
      prices: new Map(),
    });
    expect(p.unmeasured).toContain("realizedPnl");
    expect(p.stats.unmatchedSellTokens).toBeCloseTo(400, 9);
    expect(p.stats.unmatchedSellMints).toBe(1);
    // Only the matched hundred is profit: cost $100, proceeds $200.
    expect(p.stats.realizedPnlUsd).toBeCloseTo(100, 9);
  });

  // Set on every keyless read, unconditionally, so nothing downstream can read
  // a two-day figure as a lifetime one.
  it("always declares lifetime history and reputation unmeasured", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: holdings([]),
      prices: new Map(),
    });
    expect(p.unmeasured).toContain("lifetimeHistory");
    expect(p.unmeasured).toContain("reputation");
    expect(p.coverage.lifetime).toBe(false);
  });

  it("counts a mint held but never priced instead of valuing it at zero", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: holdings([
        { mint: A, tokens: 10 },
        { mint: B, tokens: 20 },
      ]),
      prices: new Map([[A, 3]]),
    });
    expect(p.holdings?.pricedMints).toBe(1);
    expect(p.holdings?.unpricedMints).toBe(1);
    expect(p.holdings?.valuedUsd).toBeCloseTo(30, 9);
    expect(p.positions.find((x) => x.mint === B)?.valueUsd).toBeUndefined();
  });

  // The 52% understatement. Binance's hot wallet showed $162.20M of tokens
  // while holding 1,661,879 SOL — $174.9M more — that the headline omitted
  // because native SOL is not a token account.
  it("counts native SOL in the portfolio value", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: { source: "jupiter", solBalance: 1000, tokens: [{ mint: A, tokens: 10, decimals: 6, frozen: false, excludeFromNetWorth: false }] },
      prices: new Map([[A, 5]]),
      solPriceUsd: 100,
    });
    expect(p.holdings?.tokenValueUsd).toBeCloseTo(50, 9);
    expect(p.holdings?.solValueUsd).toBeCloseTo(100_000, 9);
    expect(p.holdings?.valuedUsd).toBeCloseTo(100_050, 9);
  });

  // No SOL price means no SOL value — it must stay OUT of the sum rather than
  // joining it as zero, which would understate the wallet all over again while
  // looking like a measurement.
  it("leaves SOL out of the total when no SOL price is available", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: { source: "jupiter", solBalance: 1000, tokens: [{ mint: A, tokens: 10, decimals: 6, frozen: false, excludeFromNetWorth: false }] },
      prices: new Map([[A, 5]]),
    });
    expect(p.holdings?.solValueUsd).toBeUndefined();
    expect(p.holdings?.valuedUsd).toBeCloseTo(50, 9);
    expect(p.holdings?.solBalance).toBe(1000);
  });

  // Realized PnL accumulates on every priced sell; a round trip is only
  // recorded on a full close. The blind review saw −$4.24 above a table
  // summing to −$0.45 and could not reconcile them.
  it("separates partial exits from full closes so the two figures reconcile", () => {
    const p = assembleProfile({
      address: W,
      fills: [
        fill({ side: "buy", tokens: 100, priceUsd: 1, ts: T0 }),
        // Trims half at a loss: booked, but closes nothing.
        fill({ side: "sell", tokens: 50, priceUsd: 0.5, ts: T0 + H }),
      ],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 50 }]),
      prices: new Map([[A, 0.5]]),
    });
    expect(p.stats.roundTrips).toBe(0);
    expect(p.stats.partialExits).toBe(1);
    expect(p.stats.partialExitPnlUsd).toBeCloseTo(-25, 9);
    // Present despite no round trip closing — it is real money.
    expect(p.stats.realizedPnlUsd).toBeCloseTo(-25, 9);
    expect(p.provenance.join(" ")).toMatch(/PARTIAL exit/i);
  });

  it("reports a non-wallet address as unprofilable rather than as a trader", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: null,
      prices: new Map(),
      identity: { kind: "mint", detail: "this is a TOKEN MINT", profilable: false },
    });
    expect(p.identity.profilable).toBe(false);
    expect(p.identity.kind).toBe("mint");
  });

  // The balances-only first paint. Its empty fill list means "not read yet",
  // which is the opposite of "this wallet has never traded".
  it("carries the stage so a first paint is not read as an empty wallet", () => {
    const p = assembleProfile({
      address: W,
      fills: [],
      coverage: COVERAGE,
      holdings: holdings([{ mint: A, tokens: 10 }]),
      prices: new Map([[A, 1]]),
      stage: "balances",
    });
    expect(p.stage).toBe("balances");
    expect(p.stats.realizedPnlUsd).toBeUndefined();
    expect(p.stats.pricedFills).toBe(0);
  });

  it("names the window and the sources in its provenance", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 100 })],
      coverage: { ...COVERAGE, transactionsRefused: 3, transactionsFailed: 3 },
      holdings: holdings([{ mint: A, tokens: 100 }]),
      prices: new Map(),
    });
    const joined = p.provenance.join(" | ");
    expect(joined).toMatch(/solana-rpc/);
    expect(joined).toMatch(/jupiter/);
    expect(joined).toMatch(/rate limit/i);
    expect(joined).toMatch(/smart-money score: NOT COMPUTED/);
  });

  it("says so when the balance read failed rather than showing a partial bag as complete", () => {
    const p = assembleProfile({
      address: W,
      fills: [fill({ side: "buy", tokens: 100, priceUsd: 1 })],
      coverage: COVERAGE,
      holdings: null,
      prices: new Map([[A, 2]]),
    });
    expect(p.holdings).toBeNull();
    expect(p.provenance.join(" ")).toMatch(/positions: UNAVAILABLE/);
    // The fill-derived position survives — it is evidence, and dropping it
    // would lose a trade we watched happen.
    expect(p.positions.find((x) => x.mint === A)?.tokens).toBeCloseTo(100, 9);
  });
});

// A claim about the unpriced set was corrected where it had been quoted and
// left standing on the surfaces beside it, three rounds running. This guard is
// the third attempt at stopping that, and the first two failed in instructive
// ways: version one read three files from a hand-written array while the
// phrase sat in a fourth, and version two searched raw source — which cannot
// see a sentence written the way every sentence here is written.
describe("nothing over-claims about the unpriced set", () => {
  /* guard-fixture:start — the guard's machinery: the normaliser (whose own
     documentation has to QUOTE the offending phrase to explain it), the
     pattern lists, and the strings that prove they fire. All three would
     otherwise be reported as offences by the check they define. Everything
     outside this pair is scanned like any other surface, this file's prose
     included — version two of the guard could not read itself, and its
     preamble was closing a four-cause list while forbidding exactly that. */
  /**
   * Source as a READER sees it, not as a compiler does.
   *
   * Every long string in this codebase is wrapped: `"…" + "…"` across lines,
   * JSDoc with a leading asterisk per line, `//` comment runs. A regex over
   * raw source therefore only ever matches inside one fragment. The /status
   * note really does render "movements had no quote leg" and version two of
   * this guard passed anyway, because prettier happened to break the line
   * mid-phrase — one reflow away from failing on correct copy, and blind to a
   * false claim wrapped across two comment lines (both demonstrated).
   */
  const normalise = (src: string): string =>
    src
      // Join adjacent literals in a concatenation, the way the runtime does.
      .replace(/(["'`])\s*\+\s*\1/g, "")
      // Strip comment furniture so a wrapped sentence reads as one line.
      .replace(/^[ \t]*(\/\/+|\*\/|\/\*+|\*)/gm, " ")
      .replace(/\s+/g, " ");

  // Claims about the composition of the unpriced set. Each is FINE when
  // scoped by a measured share ("46% of token movements had no quote leg" is
  // the measurement) and wrong when left to quantify over all of them — which
  // is the difference `SCOPED` below tests for, and the difference four rounds
  // of this defect turned on.
  //
  // The verb is NOT required to follow "movements" immediately: version three
  // demanded that, so "movements measured across five real wallets had no
  // quote leg" — one of the three places the claim actually lives — matched
  // nothing, and a test named "holds across every file" held across one.
  const CLAIM = "(have|has|had|with|lack|lacks|lacked|carry|carries|carried) no quote (leg|source)";
  // Plural, or singular UNDER A UNIVERSAL QUANTIFIER — "every movement had no
  // quote leg" is the same sweeping claim in different grammar. Bare singular
  // is left alone: "refuses to price a movement with no quote leg" describes
  // one case truthfully, and a guard that flags correct copy teaches people to
  // widen its exemptions.
  const NEEDS_SCOPE = [
    new RegExp(`movements\\b[^.;]{0,80}?\\b${CLAIM}`, "i"),
    new RegExp(`(every|each|all|any)\\s+movement\\b[^.;]{0,80}?\\b${CLAIM}`, "i"),
    /movements? — tokens moved with no quote (leg|source)/i,
    /movements?[^.;]{0,40}came back unpriced/i,
  ];
  /**
   * A measured share that actually SCOPES the claim: "46% of token movements".
   *
   * At most two words may sit between "of" and the claim, because a percentage
   * merely nearby proves nothing. Version three took any digit-percent in the
   * preceding sixty characters, and "although only 3% of wallets were sampled,
   * every one of their token movements had no quote leg" walked straight
   * through — sweeping, false, and the exact class this exists to catch.
   */
  const SCOPED = /\d+%\s+of\s+(the\s+)?(\w+\s+){0,2}$/;

  // Closing a list the code keeps adding to. No scope redeems these: the count
  // is wrong the moment a new case is told apart, and it has been wrong four
  // times.
  //
  // DELIBERATELY NOT A CODEBASE-WIDE COUNT CHECK. Applied globally this
  // pattern flags honest prose — "two measured reasons" for a chart default,
  // "the three states distinct: REVOKED, LIVE, UNVERIFIED" — which enumerate
  // themselves and cannot drift. A guard that claims more coverage than it has
  // is the exact failure under review here, so the count check is scoped to
  // the pricing vocabulary this guard is actually about, and `reason strings`
  // is global because that phrasing has drifted twice on its own.
  const COUNT = "\\b(two|three|four|five|six|seven|eight)\\b (different |distinguishable |distinct )?";
  const NEVER_ANYWHERE = [new RegExp(`${COUNT}reason strings?\\b`, "i")];
  const NEVER_NEAR_PRICING = [new RegExp(`${COUNT}(reasons?|causes?|cases?|states?|kinds?|branches?)\\b`, "i")];
  /** How close a count must sit to the pricing copy to be this guard's business. */
  const NEAR = 220;
  const PRICING = /unpriced|quote leg|quote source|no price/i;

  // The normaliser is the whole guard: if it cannot reconstruct a wrapped
  // sentence, everything below is theatre.
  it("reads a wrapped sentence as one sentence", () => {
    const wrapped = `const note =\n  "46% of token movements " +\n  "had no quote leg belonging to the wallet";`;
    expect(normalise(wrapped)).toMatch(/movements had no quote leg/i);
    const jsdoc = `/**\n * Some movements\n * had no quote leg at all.\n */`;
    expect(normalise(jsdoc)).toMatch(/movements had no quote leg/i);
    const lineRun = `// 46% of token movements\n// had no quote leg belonging to this wallet.`;
    expect(normalise(lineRun)).toMatch(/movements had no quote leg/i);
  });

  // The scope exemption is the guard's one soft spot, so it is tested in both
  // directions rather than trusted — including the exploit that beat version
  // three, where a percentage merely NEARBY bought a sweeping false claim its
  // way past.
  /** Every offence in one normalised body of text, as `pattern` labels. */
  const offencesIn = (src: string): string[] => {
    const hits: string[] = [];
    for (const re of NEVER_ANYWHERE) if (re.test(src)) hits.push(String(re));
    for (const re of NEVER_NEAR_PRICING) {
      for (const m of src.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) {
        const around = src.slice(Math.max(0, m.index - NEAR), m.index + NEAR);
        if (PRICING.test(around)) hits.push(String(re));
      }
    }
    for (const re of NEEDS_SCOPE) {
      for (const m of src.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) {
        if (!SCOPED.test(src.slice(Math.max(0, m.index - 60), m.index))) hits.push(`unscoped ${re}`);
      }
    }
    return hits;
  };

  const offends = (text: string): boolean => offencesIn(normalise(text)).length > 0;

  it("permits the measured claim and refuses the unquantified one", () => {
    expect(offends(`"Measured across five real wallets, 46% of token " + "movements had no quote leg"`)).toBe(false);
    expect(offends(`"the " + "movements had no quote leg belonging to this wallet"`)).toBe(true);
  });

  it("is not fooled by a percentage that scopes something else", () => {
    // Beat version three exactly as written.
    expect(
      offends(`"although only 3% of wallets were sampled, every one of their token movements had no quote leg"`),
    ).toBe(true);
  });

  it("sees a claim with words between the noun and the verb", () => {
    // The form living in types.ts, which version three could not match.
    expect(offends(`"movements measured across five real wallets had no quote leg"`)).toBe(true);
    expect(offends(`"46% of token movements measured across five real wallets had no quote leg"`)).toBe(false);
  });

  it("counts a list however the list is worded", () => {
    // "reason strings" is the phrase an earlier round de-quantified, and the
    // first version of this check could not see it. Global, because that
    // phrasing has drifted on its own twice.
    expect(offends(`"the chain reader emits six distinct reason strings"`)).toBe(true);
    expect(offends(`"emits several reason strings, each stated on the fill"`)).toBe(false);
    // Near the pricing copy, any closed count is this guard's business.
    expect(offends(`"unpriced covers four different reasons, and each movement says which"`)).toBe(true);
    expect(offends(`"Refuses in three cases: no quote leg, a rotation, an LP deposit"`)).toBe(true);
  });

  it("distinguishes a universal claim from a single true case", () => {
    expect(offends(`"every movement had no quote leg belonging to this wallet"`)).toBe(true);
    // A test name describing one case, which an over-eager singular pattern
    // flagged. True, specific, and not a claim about the set.
    expect(offends(`it("refuses to price a movement with no quote leg", () => {`)).toBe(false);
  });

  it("leaves honest prose about other things alone", () => {
    // Both were flagged by an over-broad version and both are true, closed,
    // and self-enumerating. A guard that cries wolf on correct copy teaches
    // people to widen its exemptions, which is how guards die.
    expect(offends(`"First visit defaults to 15-minute bars, not hourly, for two measured reasons."`)).toBe(false);
    expect(
      offends(`"Declaring them makes the three states distinct: REVOKED is measured good, LIVE measured bad, UNVERIFIED neither"`),
    ).toBe(false);
  });
  /* guard-fixture:end */

  it("holds across every file that describes the unpriced set", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const here = new URL("./", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    // src/ AND tests/: version two could not read itself, and its own preamble
    // was closing a four-cause list while it forbade exactly that.
    const roots = [path.join(here, "..", "src"), here];

    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (/\.tsx?$/.test(e.name)) out.push(full);
      }
      return out;
    };

    const files = (await Promise.all(roots.map(walk))).flat();
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      let raw = await fs.readFile(file, "utf8");
      // The fixture cut applies to THIS FILE ONLY. Version three ran it over
      // every scanned file, which made the marker self-serve: any source file
      // could exempt itself by pasting the comment, which is not a guard, it
      // is an honour system. Greppable was true; enforced was not.
      if (path.basename(file) === "wallet-profile.test.ts") {
        raw = raw.replace(/guard-fixture:start[\s\S]*?guard-fixture:end/g, " ");
      }
      // Deliberately loose: any file discussing pricing at all gets read, not
      // only ones that happen to use the word "unpriced".
      if (!/unpriced|no price|quote leg/i.test(raw)) continue;
      for (const hit of offencesIn(normalise(raw))) offenders.push(`${path.basename(file)} :: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});

// The display tier below what eight fraction digits can show. A real 5.2e-9
// balance rendered "0" — the same forbidden zero the 0.0016 cbBTC fix cured
// one tier up, surviving for true dust.
describe("fmtTokens below the eight-digit floor", () => {
  it("renders dust as exponential rather than zero", async () => {
    const { fmtTokens } = await import("@/components/wallet/RealWalletProfile");
    expect(fmtTokens(5.2e-9)).toBe("5.20e-9");
    expect(fmtTokens(-5.2e-9)).toBe("-5.20e-9");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(0.0016)).not.toBe("0");
  });
});
