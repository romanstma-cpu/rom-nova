// The seams the first alert suite did not reach.
//
// Every test here corresponds to a defect a blind reviewer found by running
// the thing for forty minutes against a live feed, in conditions the original
// unit tests never created: a launch feed busy enough to overflow the dedupe
// memory, an inbox under sustained spam from one rule, two tabs contending
// for the evaluation lease, and a payload served from a cache.
//
// The original tests all passed throughout. They tested the LOGIC of one
// evaluation; these test what happens on the four-hundredth.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SEEN_CAP,
  TICK_VISIBLE_MS,
  evaluateLaunchRule,
  evaluateWalletRule,
  pruneSeen,
  type LiveAlertRule,
  type RuleEvalState,
} from "@/lib/alerts/rules";
import {
  MAX_EVENTS,
  acquireLease,
  boundEvents,
  clearEvents,
  loadAlerts,
  releaseLease,
  applyEvaluation,
  watchDecision,
  leaseAgeMs,
  LOCK_STALE_MS,
} from "@/lib/alerts/store";
import { mintSkipReason, permanentMintAnswer, toFillObs } from "@/components/chrome/AlertMonitor";
import { movementLabel } from "@/lib/engine/fill-label";
import type { LiveAlertEvent } from "@/lib/alerts/rules";
import type { TokenLaunch } from "@/lib/types";

const T0 = 1_800_000_000_000;

// A minimal in-memory localStorage, the same shape track-store's tests use.
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

function launchRule(): LiveAlertRule {
  return {
    id: "launch-1",
    name: "any launch",
    condition: { kind: "launch" },
    enabled: true,
    notify: false,
    createdAt: T0,
  };
}

/** A feed row. `n` drives a unique 44-char base58-ish mint. */
function row(n: number, observedAt: number): TokenLaunch {
  const mint = `M${String(n).padStart(6, "0")}`.padEnd(44, "x");
  return {
    mint,
    name: `Token ${n}`,
    symbol: `T${n}`,
    hue: 200,
    decimals: 9,
    event: "pool",
    poolCreatedAt: observedAt - 2_000,
    firstSeenAt: observedAt,
    liquidityUsd: 5_000,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    authorityKnown: true,
    source: "jupiter",
    triage: { verdict: "unverified", checks: [], measured: 4, readings: 2, total: 7, unchecked: 3 },
  };
}

// --------------------------------------------------------------- D1: dedupe

describe("launch dedupe under a high-velocity feed (D1)", () => {
  it("keeps every key whose row is still in the feed, past the old 400 cap", () => {
    // The exact shape of the shipped bug: a feed holding more rows than the
    // old cap remembered. At 400 keys with insertion-order eviction, the
    // oldest rows were forgotten while still live, and re-fired on the very
    // next pass.
    const rule = launchRule();
    let state: RuleEvalState = { ruleId: rule.id };
    const feed: TokenLaunch[] = [];

    // Arm on an empty feed so everything after is a genuine arrival.
    state = evaluateLaunchRule(rule, state, { rows: [], dataAsOf: T0, sourceName: "jupiter" }, T0).state;

    // 600 launches arrive over 10 minutes, all still inside the feed's
    // 30-minute window — well past the 400 keys the old code remembered.
    let fired = 0;
    for (let i = 0; i < 600; i++) {
      const at = T0 + 1_000 + i * 1_000;
      feed.push(row(i, at));
      const res = evaluateLaunchRule(rule, state, { rows: [...feed], dataAsOf: at, sourceName: "jupiter" }, at + 100);
      state = res.state;
      fired += res.fires.length;
    }

    // 600 launches, 600 alerts. Not one more.
    expect(fired).toBe(600);

    // And a re-evaluation of the whole standing feed fires nothing at all —
    // the property that actually failed in review, where re-running the feed
    // produced 41 duplicates in five minutes.
    const again = evaluateLaunchRule(
      rule,
      state,
      { rows: [...feed], dataAsOf: T0 + 700_000, sourceName: "jupiter" },
      T0 + 700_000,
    );
    expect(again.fires).toHaveLength(0);
  });

  it("evicts only keys the feed no longer holds", () => {
    const live = new Set(["live:a", "live:b"]);
    const keys = [
      ...Array.from({ length: SEEN_CAP }, (_, i) => `gone:${i}`),
      "live:a",
      "live:b",
    ];
    const kept = new Set(pruneSeen(keys, live));
    // Over cap by exactly two, and the two evicted are absent-from-feed keys,
    // never the live ones.
    expect(kept.size).toBe(SEEN_CAP);
    expect(kept.has("live:a")).toBe(true);
    expect(kept.has("live:b")).toBe(true);
    expect(kept.has("gone:0")).toBe(false);
    expect(kept.has("gone:1")).toBe(false);
  });

  it("never prunes below the cap, so a post-reload empty feed forgets nothing", () => {
    // After a reload the feed rebuilds from a thirty-row page, so nearly every
    // remembered key is briefly "absent". Pruning eagerly there would forget
    // rows that are about to be re-listed with fresh sighting times — the
    // reload duplicates the review also caught.
    const keys = Array.from({ length: 400 }, (_, i) => `k:${i}`);
    expect(pruneSeen(keys, new Set()).length).toBe(400);
  });

  it("survives a reload: persisted keys still suppress a re-listed row", () => {
    const rule = launchRule();
    const at = T0 + 5_000;
    const first = row(1, at);
    let state: RuleEvalState = { ruleId: rule.id };
    state = evaluateLaunchRule(rule, state, { rows: [], dataAsOf: T0, sourceName: "jupiter" }, T0).state;
    const fire = evaluateLaunchRule(rule, state, { rows: [first], dataAsOf: at, sourceName: "jupiter" }, at);
    expect(fire.fires).toHaveLength(1);

    // The reload: rule state survives in localStorage, but the feed's memory
    // does not, so the row returns with a freshly stamped sighting time.
    const rehydrated: RuleEvalState = JSON.parse(JSON.stringify(fire.state));
    const relisted = { ...first, firstSeenAt: at + 300_000, poolCreatedAt: at + 299_000 };
    const after = evaluateLaunchRule(
      rule,
      rehydrated,
      { rows: [relisted], dataAsOf: at + 300_000, sourceName: "jupiter" },
      at + 300_100,
    );
    expect(after.fires).toHaveLength(0);
  });

  it("still lets a genuine pool → graduation promotion through", () => {
    // The one case that must NOT be deduped: same mint, different event. The
    // fix must not buy silence by collapsing two real events into one.
    const rule = launchRule();
    let state: RuleEvalState = { ruleId: rule.id };
    state = evaluateLaunchRule(rule, state, { rows: [], dataAsOf: T0, sourceName: "jupiter" }, T0).state;

    const pool = row(7, T0 + 1_000);
    const asPool = evaluateLaunchRule(rule, state, { rows: [pool], dataAsOf: T0 + 1_000, sourceName: "jupiter" }, T0 + 1_100);
    expect(asPool.fires).toHaveLength(1);

    const graduated: TokenLaunch = { ...pool, event: "graduation", gradSeenAt: T0 + 60_000, poolCreatedAt: T0 + 59_000 };
    const asGrad = evaluateLaunchRule(
      rule,
      asPool.state,
      { rows: [graduated], dataAsOf: T0 + 60_000, sourceName: "jupiter" },
      T0 + 60_100,
    );
    expect(asGrad.fires).toHaveLength(1);
    expect(asGrad.fires[0].eventAtNote).toContain("graduation time");
  });
});

// ---------------------------------------------------------------- D2: inbox

function ev(ruleId: string, firedAt: number): LiveAlertEvent {
  return {
    id: `${ruleId}-${firedAt}`,
    ruleId,
    ruleName: ruleId,
    kind: "launch",
    firedAt,
    dataAsOf: firedAt,
    measurement: "m",
    headline: "h",
    detail: "d",
    read: false,
  };
}

describe("inbox eviction protects the quiet rule (D2)", () => {
  it("takes from the rule holding the most, not simply the oldest", () => {
    // One precious price alert, fired first and therefore oldest, against a
    // launch rule spamming the inbox. Oldest-first eviction — the policy that
    // shipped — deletes the price alert. Census-based eviction cannot.
    const precious = ev("price", T0);
    const spam = Array.from({ length: MAX_EVENTS + 50 }, (_, i) => ev("launch", T0 + 1_000 + i));
    // Newest first, the order the inbox actually stores.
    const events = [...spam.reverse(), precious];

    const { events: kept, dropped } = boundEvents(events, {});
    expect(kept.length).toBe(MAX_EVENTS);
    expect(kept.some((e) => e.id === precious.id)).toBe(true);
    expect(dropped.launch).toBe(51);
    expect(dropped.price ?? 0).toBe(0);
  });

  it("counts what it dropped so the page can print the hole", () => {
    const events = Array.from({ length: MAX_EVENTS + 10 }, (_, i) => ev("launch", T0 + i));
    const { dropped } = boundEvents(events, {});
    expect(dropped.launch).toBe(10);
  });

  it("accumulates drop counts across successive evictions", () => {
    const first = boundEvents(Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ev("launch", T0 + i)), {});
    const second = boundEvents(
      [...Array.from({ length: 5 }, (_, i) => ev("launch", T0 + 900 + i)), ...first.events],
      first.dropped,
    );
    expect(second.dropped.launch).toBe(10);
  });

  it("leaves an inbox under the cap completely alone", () => {
    const events = [ev("a", T0), ev("b", T0 + 1)];
    const out = boundEvents(events, {});
    expect(out.events).toHaveLength(2);
    expect(out.dropped).toEqual({});
  });

  it("evicts evenly when several rules are equally loud", () => {
    const a = Array.from({ length: 120 }, (_, i) => ev("a", T0 + i));
    const b = Array.from({ length: 120 }, (_, i) => ev("b", T0 + i));
    const { events: kept, dropped } = boundEvents([...a, ...b], {});
    expect(kept.length).toBe(MAX_EVENTS);
    // 240 events, 200 kept: the two rules share the 40 evictions.
    expect(dropped.a + dropped.b).toBe(40);
    expect(Math.abs(dropped.a - dropped.b)).toBeLessThanOrEqual(1);
  });
});

describe("the persisted inbox keeps the quiet rule's record (D2, end to end)", () => {
  beforeEach(() => vi.stubGlobal("window", { localStorage: new MemStorage(), addEventListener() {}, removeEventListener() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it("survives sustained launch spam with the price alert intact", () => {
    clearEvents();
    applyEvaluation({}, [ev("price", T0)]);
    // 300 launch alerts arrive in batches, as they would over a busy stretch.
    for (let batch = 0; batch < 30; batch++) {
      applyEvaluation({}, Array.from({ length: 10 }, (_, i) => ev("launch", T0 + 1_000 + batch * 10 + i)));
    }
    const blob = loadAlerts();
    expect(blob.events.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(blob.events.some((e) => e.ruleId === "price")).toBe(true);
    expect(blob.dropped.launch).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- D3: lease

describe("evaluation lease across two tabs (D3)", () => {
  beforeEach(() => vi.stubGlobal("window", { localStorage: new MemStorage(), addEventListener() {}, removeEventListener() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it("gives one tab the lease and refuses the other", () => {
    expect(acquireLease("tab-a", T0)).toBe(true);
    expect(acquireLease("tab-b", T0 + 1_000)).toBe(false);
  });

  it("lets the holder renew without losing it", () => {
    expect(acquireLease("tab-a", T0)).toBe(true);
    expect(acquireLease("tab-a", T0 + 10_000)).toBe(true);
    expect(acquireLease("tab-b", T0 + 10_100)).toBe(false);
  });

  it("hands over IMMEDIATELY when the holder releases — the starvation fix", () => {
    // The shipped behaviour: a hidden, paused tab renewed the lock every tick
    // while evaluating nothing, and a visible tab sat locked out for minutes
    // saying "another tab is monitoring". A paused tab now releases instead,
    // so the visible tab takes over on its very next tick rather than waiting
    // out the staleness window.
    expect(acquireLease("hidden-tab", T0)).toBe(true);
    expect(acquireLease("visible-tab", T0 + 5_000)).toBe(false);

    releaseLease("hidden-tab");

    expect(acquireLease("visible-tab", T0 + 10_000)).toBe(true);
    // And the paused tab does not steal it back while it stays paused.
    expect(acquireLease("hidden-tab", T0 + 20_000)).toBe(false);
  });

  it("expires a crashed leader's lease after the staleness window", () => {
    expect(acquireLease("crashed", T0)).toBe(true);
    expect(acquireLease("survivor", T0 + LOCK_STALE_MS - 1_000)).toBe(false);
    expect(acquireLease("survivor", T0 + LOCK_STALE_MS + 1_000)).toBe(true);
  });

  it("bounds the takeover window to a small multiple of the tick", () => {
    // The ghost window: after a reload the lease can be held by this tab's own
    // dead previous page, and `pagehide` is not guaranteed to run. The timeout
    // is therefore the real backstop, and it must be tight enough that a tab
    // reporting "another tab holds the lease" is wrong for seconds, not for
    // most of a minute.
    expect(LOCK_STALE_MS).toBeLessThanOrEqual(3 * TICK_VISIBLE_MS);
    // And still long enough that a live holder renewing every tick is never
    // dispossessed mid-stride.
    expect(LOCK_STALE_MS).toBeGreaterThan(2 * TICK_VISIBLE_MS);
  });

  it("reports the lease age so a stalled holder is visible, not assumed", () => {
    expect(leaseAgeMs(T0)).toBeNull();
    acquireLease("tab-a", T0);
    expect(leaseAgeMs(T0 + 4_000)).toBe(4_000);
  });

  it("only the holder can release — a non-holder cannot free someone else's lease", () => {
    expect(acquireLease("tab-a", T0)).toBe(true);
    releaseLease("tab-b");
    expect(acquireLease("tab-b", T0 + 1_000)).toBe(false);
  });

  /**
   * The starvation scenario, played out tick by tick.
   *
   * This is the test that would have caught D3, and it only works because the
   * decision was pulled out of the component: the bug was the ORDER of two
   * correct-looking lines, which no amount of poking at the lock primitives
   * can reveal.
   */
  it("does not let a paused tab starve a visible one across repeated ticks", () => {
    // One tab's tick: decide, then act on the lease exactly as the monitor does.
    const tickOf = (tabId: string, visible: boolean, backgroundWatch: boolean, now: number) => {
      const { paused, holdLease } = watchDecision(visible, backgroundWatch);
      const leader = holdLease ? acquireLease(tabId, now) : false;
      if (!holdLease) releaseLease(tabId);
      return { paused, leader };
    };

    // The hidden tab was the leader before it was hidden.
    expect(tickOf("hidden", true, false, T0).leader).toBe(true);

    let visibleEverLed = false;
    for (let i = 1; i <= 12; i++) {
      const now = T0 + i * 10_000; // two minutes of ticks
      const hidden = tickOf("hidden", false, false, now);
      const shown = tickOf("visible", true, false, now + 100);
      // The hidden tab evaluates nothing and claims nothing.
      expect(hidden.paused).toBe(true);
      expect(hidden.leader).toBe(false);
      if (shown.leader) visibleEverLed = true;
    }

    // Before the fix the visible tab never led — it spent two full minutes
    // reporting "another tab is monitoring" while nothing was monitored.
    expect(visibleEverLed).toBe(true);
  });

  it("keeps the lease while background watch is on, because it is still working", () => {
    const { paused, holdLease } = watchDecision(false, true);
    expect(paused).toBe(false);
    expect(holdLease).toBe(true);
  });
});

// -------------------------------------------------------- D4: dataAsOf stamp

describe("wallet alerts date the READING, not the pass (D4)", () => {
  it("carries the profile's build time through to the alert", () => {
    // The wallet profile seam caches for 45 seconds. Stamping the evaluation
    // clock — which is what shipped — claims a chain read that never happened
    // at that moment, on the one rule whose whole value is timing.
    const built = T0;
    const evaluated = T0 + 44_000; // served from cache, one second before expiry
    const rule: LiveAlertRule = {
      id: "w1",
      name: "wallet",
      condition: { kind: "wallet_fills", wallet: "W".repeat(40) },
      enabled: true,
      notify: false,
      createdAt: T0 - 1_000,
    };
    const armed = evaluateWalletRule(
      rule,
      { ruleId: "w1" },
      { fills: [], newestTs: T0 - 60_000, windowHours: 48, dataAsOf: T0 - 60_000, sourceName: "solana-rpc" },
      T0 - 30_000,
    ).state;

    const res = evaluateWalletRule(
      rule,
      armed,
      {
        fills: [{ signature: "sigA", ts: T0 - 5_000, mint: "M".repeat(40), side: "buy", tokens: 10, valueUsd: 100 }],
        newestTs: T0 - 5_000,
        windowHours: 48,
        // What the monitor now passes: when the profile was ASSEMBLED.
        dataAsOf: built,
        sourceName: "solana-rpc",
      },
      evaluated,
    );

    expect(res.fires).toHaveLength(1);
    // The three clocks stay three distinct claims.
    expect(res.fires[0].dataAsOf).toBe(built);
    expect(res.fires[0].firedAt).toBe(evaluated);
    expect(res.fires[0].eventAt).toBe(T0 - 5_000);
    // The reading is dated older than the evaluation, which is the whole point.
    expect(res.fires[0].dataAsOf).toBeLessThan(res.fires[0].firedAt);
  });
});

// ------------------------------------------------------------ D8: wording

describe("skip reasons are phrased for the rule that failed (D8)", () => {
  it("says a mint does not exist, in mint language", () => {
    const why = mintSkipReason("no system account exists at this address — it holds no SOL");
    expect(why).toContain("no token exists at this mint address");
    // The source's own words are kept rather than replaced.
    expect(why).toContain("no system account exists");
  });

  it("passes an ordinary failure through unchanged in meaning", () => {
    expect(mintSkipReason("HTTP 429")).toBe("token detail unreachable — HTTP 429");
  });

  // Fixing the sentence one layer down was not enough: the reader sees THIS
  // string, and it still opened "token detail unreachable" over an address the
  // chain had reached and identified.
  it("does not call an identified address unreachable", () => {
    const identified =
      "a PROGRAM-DERIVED ADDRESS — the 32 bytes are off the ed25519 curve, so no private key can exist for it. " +
      "It is not a token mint, so no token page exists for it and none ever will.";
    const why = mintSkipReason(identified);
    expect(why).not.toMatch(/unreachable/i);
    expect(why).toBe(identified);
    expect(permanentMintAnswer(why)).toBe(true);
  });

  it("still treats a transport failure as retryable", () => {
    expect(permanentMintAnswer("token detail unreachable — HTTP 429")).toBe(false);
    expect(permanentMintAnswer("network timeout")).toBe(false);
  });
});

// --------------------------------------------- the seam that caused round 2

describe("the monitor hands the evaluator everything it judges on", () => {
  // Deleting `classification` from this mapping is exactly what shipped the
  // round-2 HIGH defect, and at the time it broke no test anywhere: the
  // mapping was an inline object literal nothing could reach.
  it("carries every field the wallet evaluator reads", () => {
    const fill = {
      signature: "sigX",
      slot: 1,
      ts: T0,
      wallet: "W".repeat(43),
      mint: "M".repeat(43),
      decimals: 6,
      side: "sell" as const,
      tokens: 12.5,
      pricing: "unpriced" as const,
      unpricedReason: "no quote leg — tokens moved without this wallet paying or receiving",
      classification: "transfer" as const,
    };
    const obs = toFillObs(fill);
    expect(obs.classification).toBe("transfer");
    expect(obs.unpricedReason).toBe(fill.unpricedReason);
    expect(obs.signature).toBe("sigX");
    expect(obs.ts).toBe(T0);
    expect(obs.mint).toBe(fill.mint);
    expect(obs.side).toBe("sell");
    expect(obs.tokens).toBe(12.5);
    // What it produces must label the way the wallet page labels.
    expect(movementLabel(obs).short).toBe("OUT");
  });

  // The fixture above carries no valueUsd, so deleting THAT field from the
  // mapping left the whole suite green — every priced alert would then have
  // announced "unpriced" for a fill the pipeline priced perfectly. An optional
  // field is exactly the kind the compiler cannot miss for you.
  it("carries the value of a priced fill", () => {
    const obs = toFillObs({
      signature: "sigP",
      slot: 2,
      ts: T0,
      wallet: "W".repeat(43),
      mint: "M".repeat(43),
      decimals: 6,
      side: "buy",
      tokens: 40,
      pricing: "wsol",
      valueUsd: 812.34,
      priceUsd: 20.3085,
      classification: "open",
    });
    expect(obs.valueUsd).toBe(812.34);
    expect(obs.unpricedReason).toBeUndefined();
    expect(movementLabel(obs).short).toBe("BUY");
  });
});

// ------------------------------------------- round 2: a transfer is not a sale

describe("wallet alerts do not promote a transfer to a trade", () => {
  const WALLET = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  const MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
  const rule: LiveAlertRule = {
    id: "wt",
    name: "wallet",
    condition: { kind: "wallet_fills", wallet: WALLET },
    enabled: true,
    notify: true,
    createdAt: T0 - 1_000,
  };
  const armed = () =>
    evaluateWalletRule(
      rule,
      { ruleId: "wt" },
      { fills: [], newestTs: T0 - 60_000, windowHours: 48, dataAsOf: T0 - 60_000, sourceName: "solana-rpc" },
      T0 - 30_000,
    ).state;

  const fireWith = (classification: "transfer" | "reduce") =>
    evaluateWalletRule(
      rule,
      armed(),
      {
        fills: [
          {
            signature: "sigT",
            ts: T0 - 5_000,
            mint: MINT,
            side: "sell",
            tokens: 1_000,
            unpricedReason: "no quote leg — tokens moved without this wallet paying or receiving",
            classification,
          },
        ],
        newestTs: T0 - 5_000,
        windowHours: 48,
        dataAsOf: T0 - 1_000,
        sourceName: "solana-rpc",
      },
      T0,
    ).fires[0];

  // The exact alert the review captured: headline WALLET SELL, detail "sold",
  // for a movement wallet-chain had already tagged `transfer` and the wallet
  // page prints as OUT. The headline is also the OS notification title.
  it("never says sold for a movement nobody paid for", () => {
    const f = fireWith("transfer");
    expect(f.detail).not.toMatch(/\bsold\b/);
    expect(f.headline).not.toMatch(/SELL/);
    expect(f.headline).toContain("OUT");
    expect(f.detail).toMatch(/sent/);
    expect(f.detail).toMatch(/a transfer, not a trade/);
  });

  it("still says sold for a real priced exit", () => {
    const f = fireWith("reduce");
    expect(f.headline).toContain("SELL");
    expect(f.detail).toMatch(/\bsold\b/);
    expect(f.detail).not.toMatch(/not a trade/);
  });

  // A rotation IS a trade — one nobody could price. The first fix over-reached
  // and printed "nothing was paid or received for it" directly after the
  // reason "token-for-token rotation", contradicting itself in one sentence.
  it("does not call a token-for-token rotation a transfer", () => {
    const f = evaluateWalletRule(
      rule,
      armed(),
      {
        fills: [
          {
            signature: "sigR",
            ts: T0 - 5_000,
            mint: MINT,
            side: "sell",
            tokens: 1_000,
            unpricedReason: "token-for-token rotation — no single quote leg to price against",
            classification: "rotate",
          },
        ],
        newestTs: T0 - 5_000,
        windowHours: 48,
        dataAsOf: T0 - 1_000,
        sourceName: "solana-rpc",
      },
      T0,
    ).fires[0];
    expect(f.detail).not.toMatch(/nothing was paid or received/);
    expect(f.detail).toMatch(/swapped/);
    expect(f.headline).toContain("ROTATE");
  });

  // A pool deposit is not a trade either, and saying "nothing was paid or
  // received" about it is equally wrong — both legs moved.
  it("names a pool deposit as one", () => {
    const f = evaluateWalletRule(
      rule,
      armed(),
      {
        fills: [
          {
            signature: "sigL",
            ts: T0 - 5_000,
            mint: MINT,
            side: "sell",
            tokens: 1_000,
            unpricedReason: "base and quote moved the same way — not a swap",
            classification: "lp",
          },
        ],
        newestTs: T0 - 5_000,
        windowHours: 48,
        dataAsOf: T0 - 1_000,
        sourceName: "solana-rpc",
      },
      T0,
    ).fires[0];
    expect(f.headline).toContain("LP");
    expect(f.detail).toMatch(/deposited/);
    expect(f.detail).not.toMatch(/nothing was paid or received/);
  });

  // An older stored fill, or any producer that predates the field, must not
  // silently become a transfer — absence is not evidence of one.
  it("treats an unclassified fill as the trade it is labelled", () => {
    const f = evaluateWalletRule(
      rule,
      armed(),
      {
        fills: [{ signature: "sigU", ts: T0 - 5_000, mint: MINT, side: "buy", tokens: 5, valueUsd: 50 }],
        newestTs: T0 - 5_000,
        windowHours: 48,
        dataAsOf: T0 - 1_000,
        sourceName: "solana-rpc",
      },
      T0,
    ).fires[0];
    expect(f.headline).toContain("BUY");
    expect(f.detail).toMatch(/bought/);
  });
});
