// The launch feed: new Solana pools and launchpad graduations, triaged on
// arrival.
//
// WHAT MAKES THIS DIFFERENT FROM `source.ts`
//
// `trendingRows` answers "what is moving", and a thirty-second cache is fine
// there because a trending list does not change meaningfully in thirty seconds.
// A launch is interesting for a few minutes and then it is not, so the binding
// constraint here is the opposite one: how stale is the freshest thing we can
// see, and how fast can a verdict be attached to it.
//
// THE POLL RATE IS SET BY A MEASURED CEILING, NOT BY TASTE
//
// Jupiter's `recent` endpoint caps at THIRTY rows — `?limit=50`, `100` and
// `200` all returned exactly thirty, byte-identical. Across a two-minute run
// those thirty rows spanned between 19 and 53 seconds of Solana depending on
// how fast people were launching. There is no cursor, no page two, and nothing
// queues what falls off the back: poll slower than that window and launches are
// simply never seen, silently.
//
// Three seconds is a 6.3x margin against the WORST window observed, and
// `windowSeconds` in the response reports the span the last page covered so
// that margin can be watched rather than assumed.
//
// COST, MEASURED, PER OPEN TAB
//
//   jupiter recent      1 call / 3s   = 1,200/hr. 45 consecutive calls at 1/s
//                                       (i.e. 3,600/hr) returned zero 429s at
//                                       p50 61ms, so this is a third of a rate
//                                       already sustained clean.
//   rugcheck summary    <= 8 / pass, once per mint for its whole life. 36 calls
//                                       at 1.25/s returned zero 429s, p50
//                                       131ms, ~300B each.
//   geckoterminal       1 call / 20s  = 180/hr, through the adapter's own 2.1s
//                                       serialised queue. Four calls with no
//                                       gap returned 200,200,200,200 then four
//                                       straight 429s — the queue is not
//                                       optional, and the 429 carries no CORS
//                                       header, so a throttled browser sees a
//                                       network error rather than a status.
//   jupiter search      <= 1 / 20s, batching every new GeckoTerminal pool into
//                                       one comma-joined query (100 mints in
//                                       one 207ms call, measured).
//
// Around 1,500 requests an hour with a tab open, against limits that tolerated
// several times that.

import { FLAGS, getProviders } from "../providers/registry";
import { JupiterTokenProvider, jupHue } from "../providers/jupiter";
import { GeckoTerminalTokenProvider, GRADUATION_DEXES } from "../providers/geckoterminal";
import { triageLaunch } from "../engine/triage";
import type { LaunchObservation, TokenLaunch } from "../types";
import type { TokenRisk } from "../providers/types";
import type { Provenance } from "./source";

/**
 * How often the primary feed may hit Jupiter.
 *
 * The poll interval is half the feed's own latency: a launch waits on average
 * half of it before anyone asks. Measured end to end, source indexing costs
 * about 2.3s and is not negotiable, so this is the only dial there is.
 *
 * Three seconds = 1,200 requests an hour per open tab. The measured tolerance
 * is at least three times that — 45 consecutive requests at 1/s returned zero
 * 429s at p50 61ms — so this is a third of a rate already sustained cleanly,
 * not a limit being probed. Going lower buys progressively less: at 3s the poll
 * contributes ~1.5s to a ~3.8s total, and halving it again would shave 0.75s
 * off for double the traffic.
 */
export const LAUNCH_POLL_MS = 3_000;
/** The slower secondary sweep for pools Jupiter's launchpad feed never lists. */
export const POOL_POLL_MS = 20_000;
/** Risk summaries per pass. One per mint for its whole life, never repeated. */
export const RISK_BUDGET_PER_PASS = 8;
/** Rows kept. A launch older than this has stopped being a launch. */
export const FEED_TTL_MS = 30 * 60_000;
export const FEED_MAX_ROWS = 400;

export interface LaunchFeed {
  launches: TokenLaunch[];
  /**
   * How the feed is doing at its actual job, measured rather than asserted.
   *
   * `lagP50Ms` is the median of `firstSeenAt - poolCreatedAt`, and it is
   * computed ONLY over launches that happened after this feed started running.
   *
   * That exclusion is not tidiness, it is the difference between a measurement
   * and a lie. The first poll backfills a whole page of Solana — thirty mints
   * spanning about a minute — and every one of them is stamped "first seen
   * now". Counted, they turned a real ~3s lag into a reported 31s, which is
   * both wrong and wrong in the flattering-to-nobody direction: it would have
   * made the feed look an order of magnitude worse than it is, and the same
   * arithmetic run on a slow source would have made it look better.
   *
   * The figure still includes any difference between the source's clock and
   * this machine's, which is why `lagMinMs` travels with it: a negative minimum
   * is proof of clock skew rather than of a feed that sees the future. The
   * probe brackets that skew properly off the HTTP `Date` header; a browser
   * cannot, so it reports the raw number and says what is in it.
   */
  lagP50Ms: number | null;
  lagP90Ms: number | null;
  lagMinMs: number | null;
  /** How many launches the lag figures are computed from. Small n, weak claim. */
  lagSamples: number;
  /**
   * Seconds of Solana the last primary page actually spanned. The safety margin
   * against the thirty-row ceiling: if this approaches the poll interval,
   * launches are being missed.
   */
  windowSeconds: number | null;
  /** Launches added on the most recent pass. */
  addedLastPass: number;
  /**
   * Launches per minute, counted from the launches themselves rather than from
   * how long this feed has been running.
   *
   * The obvious version — rows divided by minutes since the first sighting —
   * reported 135/min on a freshly opened tab, because it had thirty rows and a
   * quarter of a minute of history. Counting how many pools were created in the
   * last sixty seconds needs no history at all and is the number a reader
   * actually wants: how fast is Solana launching right now.
   */
  perMinute: number;
  /** How many rows are still waiting on a risk grade. */
  awaitingTriage: number;
  polledAt: number;
  provenance: Provenance;
}

interface FeedState {
  rows: Map<string, TokenLaunch>;
  /**
   * The vendor grade behind each row's verdict, kept as the payload rather than
   * as the verdict it produced.
   *
   * Rows are re-triaged on every poll because their market numbers refresh, and
   * triage is a pure function of (observation, risk). Without this map the
   * second poll would re-triage with no risk and a token that had already been
   * flagged as a serial rugger would quietly revert to "nothing found yet" —
   * the worst possible direction for a finding to move.
   */
  riskByMint: Map<string, TokenRisk>;
  /** Mints a risk summary has been requested for, so it is never asked twice. */
  riskAsked: Set<string>;
  lastPrimaryAt: number;
  lastPoolSweepAt: number;
  lastWindowSeconds: number | null;
  addedLastPass: number;
  /**
   * When the first pass completed. Launches older than this were backfilled
   * from the source's existing page and their apparent lag is an artifact of
   * when the tab was opened, not a property of the feed.
   */
  startedAt: number;
}

const state: FeedState = {
  rows: new Map(),
  riskByMint: new Map(),
  riskAsked: new Set(),
  lastPrimaryAt: 0,
  lastPoolSweepAt: 0,
  lastWindowSeconds: null,
  addedLastPass: 0,
  startedAt: 0,
};

/** In-flight de-duplication, so two polls landing together share one fetch. */
let inFlight: Promise<void> | null = null;

/** Testing seam. The module holds process-wide state by design; tests need it clean. */
export function resetLaunchFeed(): void {
  state.rows.clear();
  state.riskByMint.clear();
  state.riskAsked.clear();
  state.lastPrimaryAt = 0;
  state.lastPoolSweepAt = 0;
  state.lastWindowSeconds = null;
  state.addedLastPass = 0;
  state.startedAt = 0;
  inFlight = null;
}

/**
 * Merge one observation into the feed.
 *
 * `firstSeenAt` is written once and never again. That is the whole reliability
 * of the lag measurement: refresh a row on every poll and its "age" would reset
 * to zero every five seconds, and the feed would report a latency of nothing at
 * all while being minutes behind.
 *
 * Market numbers DO refresh, because they have to. Roughly two of thirty rows
 * arrive before Jupiter has priced them, and a row that stayed at its
 * first-sight state would show a permanent dash for liquidity on exactly the
 * newest launches — the ones a reader most wants.
 */
export function mergeLaunch(
  rows: Map<string, TokenLaunch>,
  obs: LaunchObservation,
  risk?: TokenRisk,
  now = Date.now(),
): { added: boolean } {
  const existing = rows.get(obs.mint);
  if (!existing) {
    rows.set(obs.mint, { ...obs, triage: triageLaunch(obs, risk, risk ? 0 : undefined) });
    return { added: true };
  }
  const merged: LaunchObservation = {
    ...existing,
    ...obs,
    // Never moved by a later sighting.
    firstSeenAt: existing.firstSeenAt,
    // The earlier of the two creation claims. GeckoTerminal reports the pool it
    // indexed; Jupiter reports the mint's first pool. For a graduation those are
    // different events, and a later source reporting a LATER time for a mint
    // already in the feed is describing a second pool, not correcting the first.
    poolCreatedAt: Math.min(existing.poolCreatedAt, obs.poolCreatedAt),
    // A graduation outranks a plain pool: once a curve has completed, that is
    // what the row is about.
    event: existing.event === "graduation" || obs.event === "graduation" ? "graduation" : "pool",
    source: existing.source,
  };
  // Set once, then frozen. Recomputing it on every refresh turned a verdict
  // that landed in 130ms into a reported 35.8 seconds, because the row keeps
  // being re-triaged for the next half hour and `now - firstSeenAt` keeps
  // growing. The probe caught it; nothing else would have, because the number
  // stayed plausible the whole way up.
  const completedIn = existing.triage.completedInMs ?? (risk ? now - existing.firstSeenAt : undefined);
  rows.set(obs.mint, { ...merged, triage: triageLaunch(merged, risk, completedIn) });
  return { added: false };
}

/**
 * Drops rows that have stopped being launches, oldest first.
 *
 * The side maps go with them. A tab left open polls this twenty times a minute;
 * `riskAsked` in particular would otherwise accumulate every mint that launched
 * while the tab was open — measured at 33 to 58 a minute, so roughly 2,000 an
 * hour — and never release one.
 */
function prune(rows: Map<string, TokenLaunch>, now: number): void {
  for (const [mint, row] of rows) {
    if (now - row.firstSeenAt > FEED_TTL_MS) rows.delete(mint);
  }
  if (rows.size > FEED_MAX_ROWS) {
    const ordered = [...rows.entries()].sort((a, b) => a[1].firstSeenAt - b[1].firstSeenAt);
    for (const [mint] of ordered.slice(0, rows.size - FEED_MAX_ROWS)) rows.delete(mint);
  }
  for (const mint of state.riskByMint.keys()) if (!rows.has(mint)) state.riskByMint.delete(mint);
  for (const mint of state.riskAsked) if (!rows.has(mint)) state.riskAsked.delete(mint);
}

/** Bounded fan-out. Unbounded would be a rate limit wearing a stack trace. */
async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * One primary pass: the Jupiter listing, then risk summaries for what is new.
 *
 * Order matters. The listing lands first and rows appear immediately with the
 * triage that costs nothing extra — creator history, authorities, deployer
 * allocation all ship inside the same response. The risk grade upgrades those
 * rows a few hundred milliseconds later. A feed that waited for the second call
 * before showing anything would add RugCheck's latency to every launch to buy
 * one extra check, which is the wrong trade in a window this short.
 */
async function primaryPass(jup: JupiterTokenProvider, now: number): Promise<void> {
  const observed = await jup.getRecentLaunches(now);
  if (observed.length === 0) return;

  const created = observed.map((o) => o.poolCreatedAt).sort((a, b) => a - b);
  state.lastWindowSeconds = (created[created.length - 1] - created[0]) / 1000;
  // The newest row on the first page, not `now`. Anything already visible when
  // the feed opened is backfill, and stamping the clock here excludes exactly
  // that set from the lag statistic without excluding it from the display.
  if (state.startedAt === 0) state.startedAt = created[created.length - 1];

  let added = 0;
  for (const obs of observed) {
    // The grade already held for this mint, so a re-triage on refreshed market
    // numbers cannot lose a finding it made on an earlier pass.
    if (mergeLaunch(state.rows, obs, state.riskByMint.get(obs.mint), now).added) added++;
  }
  state.addedLastPass = added;

  const risk = getProviders().risk;
  if (!risk) return;
  // Everything ungraded, not just this pass's arrivals.
  //
  // Grading only `fresh` left the opening backfill permanently unverified: the
  // first pass surfaces a full page of about thirty rows, eight fit in the
  // budget, and the other twenty-two were never revisited because they were
  // never "fresh" again. Twenty-five rows sat at "pending" indefinitely, which
  // is honest and useless.
  //
  // Newest first regardless. A feed that grades the back of the queue first is
  // spending its budget on launches that have already stopped mattering, and
  // the backfill drains on its own once the arrival rate leaves headroom.
  const ungraded = [...state.rows.values()].filter((r) => !state.riskAsked.has(r.mint));
  const targets = ungraded.sort((a, b) => b.poolCreatedAt - a.poolCreatedAt).slice(0, RISK_BUDGET_PER_PASS);
  for (const o of targets) state.riskAsked.add(o.mint);

  await pooled(targets, 4, async (o) => {
    try {
      const r = await risk.getTokenRisk(o.mint, false);
      const row = state.rows.get(o.mint);
      if (!r || !row) return;
      state.riskByMint.set(o.mint, r);
      state.rows.set(o.mint, {
        ...row,
        triage: triageLaunch(row, r, Date.now() - row.firstSeenAt),
      });
    } catch {
      // A grade that never arrives leaves the check `unchecked`, which is what
      // the reader should see. Retrying it next pass would spend the budget on
      // a mint the vendor does not know rather than on the ones arriving now.
    }
  });
}

/**
 * The secondary sweep: pools GeckoTerminal saw that Jupiter's `recent` will
 * never list.
 *
 * Filtered to the AMMs rather than the launchpads, because the `pump-fun` rows
 * here are the same bonding curves Jupiter already delivered thirty seconds
 * sooner. What is left is the graduations and the pools nobody launched through
 * a launchpad — and every one of them needs an audit block GeckoTerminal does
 * not have, which is why they are batched into a single Jupiter query rather
 * than looked up one at a time.
 */
async function poolSweep(jup: JupiterTokenProvider, gt: GeckoTerminalTokenProvider, now: number): Promise<void> {
  const pools = await gt.getNewPools(1);
  const wanted = pools.filter((p) => GRADUATION_DEXES.test(p.dex) && !state.rows.has(p.mint));
  if (wanted.length === 0) return;

  const detail = await jup.getLaunchesByMint(wanted.map((p) => p.mint), now);
  for (const p of wanted) {
    const enriched = detail.get(p.mint);
    if (enriched) {
      mergeLaunch(state.rows, {
        ...enriched,
        // GeckoTerminal saw THIS pool; Jupiter reports the mint's first one.
        // For a graduation those differ by however long the curve took, and the
        // launch being reported is the pool that just opened.
        poolCreatedAt: p.createdAt,
        event: "graduation",
        venue: p.dex,
        source: "coingecko+jupiter",
        // GeckoTerminal prices the pool it indexed. Jupiter's aggregate can lag
        // a brand-new pool by a poll, so the pool's own figures win here.
        priceUsd: p.priceUsd || enriched.priceUsd,
        liquidityUsd: p.liquidityUsd || enriched.liquidityUsd,
      }, state.riskByMint.get(p.mint), now);
      continue;
    }
    // Jupiter does not index every mint. The pool is still real and still new,
    // so it goes in with everything unknown declared rather than dropped —
    // a launch nobody can audit is a finding, not an absence.
    mergeLaunch(state.rows, {
      mint: p.mint,
      name: p.pairName,
      symbol: p.pairName.split("/")[0]?.trim() ?? "",
      hue: jupHue(p.mint),
      decimals: 9,
      poolCreatedAt: p.createdAt,
      firstSeenAt: now,
      event: "graduation",
      venue: p.dex,
      priceUsd: p.priceUsd,
      liquidityUsd: p.liquidityUsd,
      buys5m: p.buys5m,
      sells5m: p.sells5m,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      authorityKnown: false,
      source: "coingecko",
    }, undefined, now);
  }
}

async function refresh(): Promise<void> {
  const now = Date.now();
  const jup = new JupiterTokenProvider();

  if (now - state.lastPrimaryAt >= LAUNCH_POLL_MS) {
    state.lastPrimaryAt = now;
    try {
      await primaryPass(jup, now);
    } catch {
      // A failed pass keeps the rows it already has. Stale real launches beat
      // an empty feed, and `polledAt` in the response reports the age.
    }
  }

  if (FLAGS.coingecko() && now - state.lastPoolSweepAt >= POOL_POLL_MS) {
    state.lastPoolSweepAt = now;
    try {
      await poolSweep(jup, new GeckoTerminalTokenProvider(), now);
    } catch {
      // The secondary source failing costs graduations, not the feed.
    }
  }

  prune(state.rows, now);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * The feed, refreshed at most as often as the measured ceiling allows.
 *
 * Returns null when no live token provider is configured. That is deliberately
 * NOT a fall back to the simulator: the demo universe generates tokens on a
 * schedule that has nothing to do with Solana, and a synthetic launch feed
 * would be indistinguishable from a real one at a glance while being pure
 * fiction about the one thing this page claims to measure — time.
 */
export async function launchFeed(): Promise<LaunchFeed | null> {
  if (!FLAGS.jupiter()) return null;

  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  await inFlight;

  const launches = [...state.rows.values()].sort((a, b) => b.poolCreatedAt - a.poolCreatedAt);
  if (launches.length === 0) return null;

  const lags = launches
    .filter((l) => l.poolCreatedAt > state.startedAt)
    .map((l) => l.firstSeenAt - l.poolCreatedAt)
    .sort((a, b) => a - b);
  const now = Date.now();
  const lastMinute = launches.filter((l) => now - l.poolCreatedAt <= 60_000).length;

  return {
    launches,
    lagP50Ms: percentile(lags, 0.5),
    lagP90Ms: percentile(lags, 0.9),
    lagMinMs: lags[0] ?? null,
    lagSamples: lags.length,
    windowSeconds: state.lastWindowSeconds,
    addedLastPass: state.addedLastPass,
    perMinute: lastMinute,
    awaitingTriage: launches.filter((l) => l.triage.completedInMs === undefined).length,
    polledAt: state.lastPrimaryAt,
    provenance: {
      source: FLAGS.coingecko() ? "jupiter+coingecko" : "jupiter",
      real: true,
    },
  };
}
