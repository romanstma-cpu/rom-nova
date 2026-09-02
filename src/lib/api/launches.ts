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
//   jupiter recent      1 call / 3s = 1,200/hr. 60 consecutive calls at that
//                                     cadence returned 60x200, zero 429s,
//                                     p50 82ms.
//
//                                     A previous version of this comment claimed
//                                     "45 consecutive calls at 1/s returned zero
//                                     429s", and inferred 3,600/hr of headroom
//                                     from it. That inference was wrong and the
//                                     measurement was too short to see it: 150
//                                     calls at 1/s return 88x200 then 62x429,
//                                     with the first failure at request 89. The
//                                     45-call run simply stopped before the wall.
//                                     There is no headroom to raise the poll rate
//                                     into; do not read one out of this block.
//   jupiter datapi gems 1 call / 3s = 1,200/hr, one POST carrying both the
//                                     `graduated` and `recent` buckets. 106
//                                     consecutive requests returned zero 429s —
//                                     6 with no gap, 60 at 1/s, 40 at 1/3s —
//                                     p50 117ms. Read that as "3s is a third of
//                                     the fastest rate measured clean", not as
//                                     a budget: the paragraph below is what
//                                     happens when a short clean run is treated
//                                     as headroom.
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
// Around 2,700 requests an hour with a tab open, spread across three vendors,
// each at a rate that was measured clean past the point where it should break.

import { FLAGS, getProviders } from "../providers/registry";
import { JupiterTokenProvider, jupHue } from "../providers/jupiter";
import { noteLaunchMerged, setLaunchLookup } from "../launch-record/store";
import { GeckoTerminalTokenProvider, GRADUATION_DEXES } from "../providers/geckoterminal";
import { triageLaunch } from "../engine/triage";
import type { LaunchObservation, TokenLaunch } from "../types";
import type { TokenRisk } from "../providers/types";
import type { Provenance } from "./source";

/**
 * How often the primary feed may hit Jupiter.
 *
 * The poll interval is half the feed's own latency: a launch waits on average
 * half of it before anyone asks. The source's own indexing delay is the rest of
 * it and is not negotiable — measured at a p50 of about 5.7s behind pool
 * creation even when polled once a second, with a floor of 2.3s on the best
 * rows. An earlier version of this comment quoted that 2.3s floor as though it
 * were the typical case; the median is what a reader actually experiences, and
 * it is more than twice as far back.
 *
 * Three seconds = 1,200 requests an hour per open tab, and 60 consecutive calls
 * at that cadence came back clean. It is NOT a third of some larger budget:
 * 150 calls at 1/s hit a wall at request 89 and 429ed 62 times after it. So
 * this is close to what the endpoint will actually give, and the remaining
 * latency is not bought back by asking more often.
 */
export const LAUNCH_POLL_MS = 3_000;
/**
 * The secondary sweep for pools Jupiter's launchpad feed never lists.
 *
 * No longer the graduation path — see `GEMS_POLL_MS` — but still the only
 * source that sees a pool opened outside a launchpad entirely. GeckoTerminal's
 * new-pool index runs 18-94s behind the chain on its own and that is a floor no
 * polling rate touches, so six seconds is about the interval and nothing else.
 * It is 10/min against a limit that 429s on the fifth no-gap request but
 * tolerates ~30/min, and it goes through the adapter's serialised 2.1s queue.
 */
export const POOL_POLL_MS = 6_000;
/**
 * The graduation path, on the primary's own cadence because it is the primary's
 * own vendor.
 *
 * Graduations were the feed's worst number by an order of magnitude — p50 about
 * two minutes, against Axiom's "Migrated" column in seconds — because the only
 * graduation source wired here was GeckoTerminal. Measured head to head over
 * seven minutes, arrival lag against each response's own HTTP `Date` so neither
 * figure carries this machine's clock:
 *
 *   datapi gems.graduated   n=11  min 1.0s  p50  3.0s  p90  4.0s  max  5.0s
 *   geckoterminal new_pools n=14  min 11.0s p50 40.0s  p90 72.0s  max 78.0s
 *
 * and on the six graduations BOTH sources saw — the only comparison not
 * confounded by them seeing different events — gems led by a median of 50s.
 *
 * Three seconds because 106 consecutive requests measured zero 429s at up to
 * 1/s including a six-request no-gap burst, so this is a third of the fastest
 * clean rate observed rather than the edge of it. That is a statement about
 * what was measured, not a headroom budget to raise the rate into: the last
 * comment in this file that inferred headroom from a short clean run was wrong,
 * and 150 calls at 1/s on the OTHER Jupiter host 429 from request 89 onward.
 */
export const GEMS_POLL_MS = 3_000;

/**
 * How long without a successful primary pass before the feed is stale.
 *
 * Two missed polls. Under it, a single transient failure does not flash a
 * warning at a reader for six seconds; over it, the rows on screen are older
 * than the feed claims and the UI has to say so.
 */
export const STALE_AFTER_MS = LAUNCH_POLL_MS * 3;
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
   * The same figures for graduations, which are a different pipeline and were
   * being silently dropped from the headline entirely.
   *
   * The pool lag filter is `poolCreatedAt > startedAt`, where `startedAt` is
   * the newest row of the first Jupiter page. A graduation arrives 60-90
   * seconds stale by construction, so that condition is essentially never true
   * for one and every graduation fell out of the statistic — the headline read
   * n=119 with 106 rows on screen, describing only the fast half of the feed
   * while appearing to describe all of it.
   *
   * Graduations get their own baseline and their own reported number, because
   * they are an order of magnitude slower and averaging the two would hide both.
   */
  gradLagP50Ms: number | null;
  gradLagP90Ms: number | null;
  gradLagSamples: number;
  /**
   * The fastest graduation seen, for the same clock check `lagMinMs` serves.
   *
   * It needs its own field because it goes NEGATIVE FIRST. Graduations arrive
   * within a few seconds of the event, so the machine's clock offset is a large
   * fraction of the figure; mints lag longer and absorb the same offset without
   * crossing zero. Watching only the mint minimum, the UI printed "grad lag -0s"
   * for its first three graduations while raising no warning at all — an
   * impossible measurement rendered as a fact, which is the exact defect the
   * mint-side check exists to catch.
   */
  gradLagMinMs: number | null;
  /**
   * Seconds of Solana the last primary page actually spanned. The safety margin
   * against the thirty-row ceiling: if this approaches the poll interval,
   * launches are being missed.
   */
  windowSeconds: number | null;
  /**
   * Rows that arrived by SOCKET PUSH this session, and how the push did.
   *
   * Its own statistic, on the same rule that keeps mints and graduations
   * apart: averaging a socket's latency into the poll's would hide both. The
   * push carries no timestamp, so its lag can only be measured on rows a
   * polled source later DATED — `pushLagP50Ms` is the median of (receipt time
   * on this machine's clock) minus (the pool-creation time Jupiter or
   * GeckoTerminal published), over exactly those rows. Negative is possible
   * and means this clock runs behind the source's; the page's clock-skew
   * hint reads the poll minimum, not this one, because the two clocks differ.
   *
   * `undated` is how many pushed rows nobody has dated yet. They render an
   * age since receipt and say so.
   */
  pushed: number;
  undated: number;
  pushLagP50Ms: number | null;
  pushLagMinMs: number | null;
  pushLagSamples: number;
  /**
   * Launches added on the most recent pass, or null when that pass FAILED.
   *
   * Null rather than 0 for the reason this whole file exists. A failed pass
   * that reported "+0 last pass" would be making a claim — nothing launched —
   * on a poll that never reached the vendor, and the reader has no way to tell
   * a quiet minute from a dead feed. Null renders as a dash.
   */
  addedLastPass: number | null;
  /**
   * When the primary source last actually ANSWERED. Not when it was last asked.
   *
   * The critical distinction, and the one the first version got wrong: a failed
   * pass is swallowed so the feed can keep serving the rows it already has,
   * which means every caller gets a successful response containing stale data.
   * Without this field there is no way for the UI to tell the difference, and it
   * rendered a pulsing live-dot over a 74-second-dead feed.
   */
  lastSuccessAt: number;
  /** True when no pass has succeeded within STALE_AFTER_MS. */
  stale: boolean;
  /** Consecutive failed primary passes. */
  failures: number;
  /** Why the last pass failed, when one did. */
  lastError?: string;
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
  lastGemsAt: number;
  lastWindowSeconds: number | null;
  addedLastPass: number | null;
  /**
   * When the first pass completed. Launches older than this were backfilled
   * from the source's existing page and their apparent lag is an artifact of
   * when the tab was opened, not a property of the feed.
   */
  startedAt: number;
  /** The same baseline for the graduation pipeline, which starts later and slower. */
  sweepStartedAt: number;
  lastSuccessAt: number;
  failures: number;
  lastError?: string;
  /** Creation frames accepted from the push socket this session. */
  pushed: number;
}

const state: FeedState = {
  rows: new Map(),
  riskByMint: new Map(),
  riskAsked: new Set(),
  lastPrimaryAt: 0,
  lastPoolSweepAt: 0,
  lastGemsAt: 0,
  lastWindowSeconds: null,
  addedLastPass: null,
  startedAt: 0,
  sweepStartedAt: 0,
  lastSuccessAt: 0,
  failures: 0,
  pushed: 0,
};

/** The push socket's source name, as every pushed row and event carries it. */
export const PUSH_SOURCE = "pumpportal-ws";

// The launch record resolves its horizons through the same batched Jupiter
// lookup that already dates GeckoTerminal's pools — a hundred mints in one
// ~200ms call. Registered here so the record module never imports a provider.
setLaunchLookup(async (mints, now) => {
  const jup = new JupiterTokenProvider();
  const found = await jup.getLaunchesByMint(mints, now);
  const out = new Map<string, { priceUsd?: number; liquidityUsd?: number; graduatedAt?: number }>();
  for (const [mint, row] of found) {
    out.set(mint, { priceUsd: row.priceUsd, liquidityUsd: row.liquidityUsd, graduatedAt: row.graduatedAt });
  }
  return out;
});

/** In-flight de-duplication, so two polls landing together share one fetch. */
let inFlight: Promise<void> | null = null;

/** Testing seam. The module holds process-wide state by design; tests need it clean. */
export function resetLaunchFeed(): void {
  state.rows.clear();
  state.riskByMint.clear();
  state.riskAsked.clear();
  state.lastPrimaryAt = 0;
  state.lastPoolSweepAt = 0;
  state.lastGemsAt = 0;
  state.lastWindowSeconds = null;
  state.addedLastPass = null;
  state.startedAt = 0;
  state.sweepStartedAt = 0;
  state.lastSuccessAt = 0;
  state.failures = 0;
  state.lastError = undefined;
  state.pushed = 0;
  inFlight = null;
}

/** The earlier of two claims, where either may be absent. */
function earliest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
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
    const fresh: TokenLaunch = {
      ...obs,
      // A row that arrives dated was dated by whoever brought it.
      datedBy: obs.datedBy ?? (obs.poolCreatedAt !== undefined ? obs.source : undefined),
      triage: triageLaunch(obs, risk, risk ? 0 : undefined),
    };
    rows.set(obs.mint, fresh);
    // The launch record listens here rather than polling the feed: every row
    // the feed ever shows is written down with the verdict it was shown with.
    if (rows === state.rows) noteLaunchMerged(fresh, true, now);
    return { added: true };
  }
  // A graduation outranks a plain pool: once a curve has completed, that is
  // what the row is about.
  const wasGrad = existing.event === "graduation";
  const isGrad = obs.event === "graduation";
  const event = wasGrad || isGrad ? "graduation" : "pool";

  const merged: LaunchObservation = {
    ...existing,
    ...obs,
    // Never moved by a later sighting.
    firstSeenAt: existing.firstSeenAt,
    // The graduation's OWN sighting time, stamped once at promotion. A watched
    // curve mint keeps its original firstSeenAt when it graduates, while
    // poolCreatedAt is re-dated to the graduation — so the lag statistic read
    // firstSeenAt - poolCreatedAt and got a negative number the size of the
    // curve's lifetime (-90.2s and -158.8s observed live), which the clock-skew
    // check then reported as an impossible clock. This makes the promoted row a
    // real latency sample instead of a poisoned one.
    gradSeenAt: existing.gradSeenAt ?? (!wasGrad && isGrad ? now : undefined),
    /**
     * WHICH MOMENT THE ROW IS ABOUT, which stopped being obvious the moment a
     * second graduation source arrived.
     *
     * This was `Math.min` of the two claims, which is right for two sources
     * describing the SAME pool and wrong in both directions once a mint can be
     * seen twice — first as a fresh curve, then as a graduation:
     *
     *   promotion   the mint is already in the feed from the primary listing,
     *               its curve opened twenty minutes ago, and it now graduates.
     *               `min` keeps the CURVE time, so the row reads GRAD with an
     *               age of twenty minutes and contributes a twenty-minute
     *               graduation lag to a statistic measuring seconds.
     *
     *   regression  the row is already a graduation and the primary listing
     *               mentions the mint again with its curve time. `min` drags
     *               the row back to the curve, silently, on a later poll.
     *
     * So: a graduation row is dated by the graduation, a pool row by the
     * earliest creation claim anyone made, and a plain sighting can never move
     * a graduation's date.
     *
     * And a row nobody has dated takes the first date offered. A pushed row
     * arrives with no creation time at all; the poll that lists it a few
     * seconds later is what dates it, and `datedBy` records who.
     */
    poolCreatedAt:
      event !== "graduation" || (wasGrad && isGrad)
        ? earliest(existing.poolCreatedAt, obs.poolCreatedAt)
        : isGrad
          ? obs.poolCreatedAt
          : existing.poolCreatedAt,
    datedBy:
      existing.datedBy ??
      (existing.poolCreatedAt === undefined && obs.poolCreatedAt !== undefined ? obs.source : undefined),
    // The curve key only ever comes from the push, and a later listing must
    // not blank it — it is what the tab subscribes to.
    curveAccount: obs.curveAccount ?? existing.curveAccount,
    // Spreading `obs` over `existing` overwrites with undefined wherever the
    // newer payload simply does not carry the field — and the primary listing
    // carries neither of these. Losing `graduatedAt` would un-date a graduation
    // on the next poll; `bondingCurvePct` legitimately disappears at graduation
    // but must not blink out every time an unrelated source refreshes the row.
    graduatedAt: obs.graduatedAt ?? existing.graduatedAt,
    bondingCurvePct: obs.bondingCurvePct ?? existing.bondingCurvePct,
    event,
    source: existing.source,
  };
  // Set once, then frozen. Recomputing it on every refresh turned a verdict
  // that landed in 130ms into a reported 35.8 seconds, because the row keeps
  // being re-triaged for the next half hour and `now - firstSeenAt` keeps
  // growing. The probe caught it; nothing else would have, because the number
  // stayed plausible the whole way up.
  const completedIn = existing.triage.completedInMs ?? (risk ? now - existing.firstSeenAt : undefined);
  const refreshed: TokenLaunch = { ...merged, triage: triageLaunch(merged, risk, completedIn) };
  rows.set(obs.mint, refreshed);
  if (rows === state.rows) noteLaunchMerged(refreshed, false, now);
  return { added: false };
}

/**
 * One creation frame from the push socket, as the socket delivered it.
 *
 * Captured 2026-09-01 from `wss://pumpportal.fun/api/data` after
 * `subscribeNewToken`: signature, mint, traderPublicKey, txType "create",
 * initialBuy, solAmount, bondingCurveKey, vTokensInBondingCurve,
 * vSolInBondingCurve, marketCapSol, name, symbol, uri, is_mayhem_mode, pool.
 * No timestamp of any kind.
 */
export interface LaunchPush {
  mint: string;
  name?: string;
  symbol?: string;
  /** The creating wallet — the deployer. */
  dev?: string;
  curveAccount?: string;
  /** The launchpad as the socket names it: "pump", "bonk"… */
  pool?: string;
  signature?: string;
}

/** How the socket's `pool` field is written on the rest of this app's rows. */
const PUSH_LAUNCHPADS: Record<string, string> = { pump: "pump.fun", bonk: "bonk.fun" };

/**
 * A pushed creation, into the feed.
 *
 * `firstSeenAt` is the receipt time on this machine's clock and nothing else
 * is dated: there is no `poolCreatedAt` because the frame carries none, and
 * inventing one from the receipt would make the socket's lag measure itself.
 * When a polled source later lists the same mint, `mergeLaunch` keeps THIS
 * sighting time — that is the whole point of the push — and takes the date
 * from the poll, recording who supplied it.
 *
 * `decimals` is pump.fun's fixed six — the program mints every token at six
 * decimals, and the field is display-only on a launch row. Every other
 * numeric field the frame could fill is left absent: `marketCapSol` is in SOL
 * and this module has no SOL price to convert it honestly, and the reserves
 * are curve state, not liquidity a pool holds.
 */
export function observeLaunchPush(push: LaunchPush, receivedAt = Date.now()): { added: boolean } {
  const launchpad = push.pool ? (PUSH_LAUNCHPADS[push.pool] ?? push.pool) : "pump.fun";
  const obs: LaunchObservation = {
    mint: push.mint,
    name: push.name ?? "",
    symbol: push.symbol ?? "",
    hue: jupHue(push.mint),
    decimals: 6,
    firstSeenAt: receivedAt,
    event: "pool",
    venue: launchpad,
    launchpad,
    dev: push.dev,
    curveAccount: push.curveAccount,
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: false,
    authorityKnown: false,
    source: PUSH_SOURCE,
  };
  state.pushed++;
  return mergeLaunch(state.rows, obs, state.riskByMint.get(push.mint), receivedAt);
}

/** Rows this feed currently holds — for the socket layer to pick curves from. */
export function currentLaunches(): TokenLaunch[] {
  return [...state.rows.values()];
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

  // Every polled row is dated by its source; only pushed rows are not, and
  // none of those come through here.
  const created = observed.map((o) => o.poolCreatedAt ?? now).sort((a, b) => a - b);
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
  // Newest by whatever clock the row has: an undated push row is ordered by
  // its receipt. Ordering is not a claim about creation time, and a pushed
  // row is by construction the freshest thing in the feed.
  const targets = ungraded.sort((a, b) => rowClock(b) - rowClock(a)).slice(0, RISK_BUDGET_PER_PASS);
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
 * The tertiary sweep: pools GeckoTerminal saw that neither Jupiter feed lists.
 *
 * Filtered to the AMMs rather than the launchpads, because the `pump-fun` rows
 * here are the same bonding curves Jupiter already delivered thirty seconds
 * sooner. What is left is the pools nobody launched through a launchpad — and
 * every one of them needs an audit block GeckoTerminal does not have, which is
 * why they are batched into a single Jupiter query rather than looked up one at
 * a time.
 *
 * THIS IS NO LONGER THE GRADUATION PATH, AND THAT IS THE POINT
 *
 * It used to be the only one, and it made graduations the worst number in the
 * feed: p50 around two minutes, against seconds for a new mint. Measured head
 * to head, this source arrives at p50 40s where `gemsPass` arrives at p50 3.0s,
 * and it lost on every one of the six graduations both of them saw. So
 * graduations now come from `gemsPass` and this sweep keeps only the job
 * nothing else does — a pool opened directly on an AMM, which no launchpad feed
 * will ever mention.
 *
 * Rows are still merged rather than dropped when both see the same pool. The
 * merge stamps `firstSeenAt` once, so whichever source arrives first wins the
 * latency measurement on its own and adding a source can never slow the feed
 * down; it only removes the case where the slow one was all there was.
 *
 * WHAT IS STILL NOT REACHABLE, RE-MEASURED RATHER THAN INHERITED
 *
 * pump.fun's own API is fresher than either (its board carried a coin 2.0s old)
 * and it cannot be read from a browser. The measurement that says otherwise is
 * the easy one to run:
 *
 *   no Origin header             200   (this is the misleading result)
 *   Origin: app://rom-nova       403   {"message":"Not allowed by CORS"}
 *   Origin: https://romapps.xyz  403   same
 *   Origin: https://pump.fun     200   access-control-allow-origin: https://pump.fun
 *   OPTIONS preflight            403
 *
 * It allowlists its own origin. `Origin` is a forbidden header name, so a page
 * cannot set it and the browser always sends the real one — no arrangement of
 * client code reaches that 200. Nova is a static export running in the
 * visitor's tab, so "works from curl" is not a category of working.
 *
 * The chain itself is no better. `logsSubscribe` on the PumpSwap program — the
 * narrowest filter that catches a graduation — measured 455 frames/s and 4,020
 * MB/hr to extract roughly two pool creations a minute.
 */
async function poolSweep(jup: JupiterTokenProvider, gt: GeckoTerminalTokenProvider, now: number): Promise<void> {
  const pools = await gt.getNewPools(1);
  // Same backfill baseline as the primary pass, kept separately because this
  // pipeline starts later and runs an order of magnitude slower. Without it,
  // graduations already indexed when the tab opened would be counted as if the
  // feed had waited two minutes for them.
  if (state.sweepStartedAt === 0 && pools.length > 0) {
    state.sweepStartedAt = Math.max(...pools.map((p) => p.createdAt));
  }
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
        source: "geckoterminal+jupiter",
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
      source: "geckoterminal",
    }, undefined, now);
  }
}

/**
 * The graduation pass: launchpad curves that have just completed into a real
 * AMM pool, from the same vendor that already serves the mint feed.
 *
 * One POST returns both buckets. The `graduated` bucket is the point; the
 * `recent` bucket is asked for in the same request for one field nothing else
 * wired here carries — how far along its bonding curve a mint is — which is a
 * column Axiom ships and Nova did not.
 *
 * The curve figure is written straight onto the row rather than merged through
 * an observation, because it is not a triage input and re-triaging every row on
 * every curve tick would burn the risk cache for no change in verdict.
 */
async function gemsPass(jup: JupiterTokenProvider, now: number): Promise<void> {
  const { graduations, curves } = await jup.getGems(now);

  // The graduation baseline, shared with the GeckoTerminal sweep because there
  // is one graduation pipeline and it now has two mouths. Set once, from
  // whichever source reports first: anything newer than the freshest row that
  // was ALREADY listed when the tab opened is a graduation this feed actually
  // waited for, and everything at or before it is backfill whose apparent age
  // says when the tab opened.
  if (state.sweepStartedAt === 0 && graduations.length > 0) {
    state.sweepStartedAt = Math.max(...graduations.map((g) => g.poolCreatedAt ?? now));
  }

  for (const g of graduations) {
    mergeLaunch(state.rows, g, state.riskByMint.get(g.mint), now);
  }

  for (const [mint, pct] of curves) {
    const row = state.rows.get(mint);
    // Only rows this feed already holds. The `recent` bucket is a second
    // listing of the same mints the primary pass delivers, and adding rows from
    // it here would put launches into the feed through a path whose latency
    // nothing measures.
    if (row && row.bondingCurvePct !== pct) state.rows.set(mint, { ...row, bondingCurvePct: pct });
  }
}

/**
 * Names that are the same name.
 *
 * Case-folded and stripped of the decoration copycats reach for first — a
 * leading `$`, spaces, zero-width joiners. Not aggressive beyond that: mapping
 * `0`→`o` and `1`→`l` would fold genuinely distinct tickers together and turn a
 * warning into noise.
 */
function nameKey(l: TokenLaunch): string | null {
  // Zero-width characters spelled as \u escapes on purpose. Written literally
  // they are invisible in the source, and an invisible character sitting next
  // to a hyphen inside a class silently becomes a RANGE — unreviewable, and
  // wrong in a way no diff will show.
  const raw = (l.symbol || l.name || "").toLowerCase().replace(/[\s\u200B-\u200D\uFEFF$]/g, "");
  // Two unnamed mints are not twins. A blank key would group every metadata-less
  // launch on the page into one giant false collision.
  return raw.length >= 2 ? raw : null;
}

/**
 * Marks mints sharing a name, and re-triages only the rows whose set changed.
 *
 * Runs after both passes because it needs the whole feed: this is the one
 * finding that cannot be produced from a single token's data however carefully
 * it is audited.
 */
export function markTwins(rows: Map<string, TokenLaunch>): void {
  const groups = new Map<string, string[]>();
  for (const row of rows.values()) {
    const key = nameKey(row);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(row.mint);
    else groups.set(key, [row.mint]);
  }
  for (const row of rows.values()) {
    const key = nameKey(row);
    const group = key ? groups.get(key) : undefined;
    const twins = group && group.length > 1 ? group.filter((m) => m !== row.mint) : undefined;
    const before = row.twins ?? [];
    const after = twins ?? [];
    if (before.length === after.length && before.every((m, i) => m === after[i])) continue;
    rows.set(row.mint, {
      ...row,
      twins,
      triage: triageLaunch(row, state.riskByMint.get(row.mint), row.triage.completedInMs, twins),
    });
  }
}

async function refresh(): Promise<void> {
  const now = Date.now();
  const jup = new JupiterTokenProvider();

  if (now - state.lastPrimaryAt >= LAUNCH_POLL_MS) {
    state.lastPrimaryAt = now;
    try {
      await primaryPass(jup, now);
      state.lastSuccessAt = Date.now();
      state.failures = 0;
      state.lastError = undefined;
    } catch (err) {
      // A failed pass keeps the rows it already has, because stale real
      // launches beat an empty feed. But it must not keep the APPEARANCE of a
      // working one: this used to swallow the error entirely, so `launchFeed`
      // returned successfully with a full row set and the page had no way to
      // know. A killed network froze the feed at 122 rows while the UI carried
      // on pulsing a live-dot and asserting arrivals for 74 seconds.
      state.failures++;
      state.lastError = err instanceof Error ? err.message : String(err);
      // Not zero. Zero is a claim that nothing launched.
      state.addedLastPass = null;
    }
  }

  if (now - state.lastGemsAt >= GEMS_POLL_MS) {
    state.lastGemsAt = now;
    try {
      await gemsPass(jup, now);
    } catch {
      // Not counted as a feed failure. The primary listing is what the stale
      // marker is about, and a graduation source that misses a pass costs
      // graduations rather than the feed — the same reasoning as the sweep
      // below. Counting it here would put the page in a warning state over a
      // half of the feed that is still working.
    }
  }

  if (FLAGS.coingecko() && now - state.lastPoolSweepAt >= POOL_POLL_MS) {
    state.lastPoolSweepAt = now;
    try {
      await poolSweep(jup, new GeckoTerminalTokenProvider(), now);
    } catch {
      // The secondary source failing costs graduations, not the feed, and it
      // 429s often enough by design that counting it as a feed failure would
      // put the page in a permanent warning state.
    }
  }

  markTwins(state.rows);
  prune(state.rows, now);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * The moment a row is ORDERED by: the source's creation claim where one
 * exists, the receipt time where none does yet.
 *
 * Ordering only. Nothing that renders a time or computes a lag reads this —
 * those consult `poolCreatedAt` directly and render its absence — because a
 * receipt time standing in for a creation time is precisely the fabrication
 * the optional field exists to prevent.
 */
function rowClock(l: LaunchObservation): number {
  return l.poolCreatedAt ?? l.firstSeenAt;
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

  const launches = [...state.rows.values()].sort((a, b) => rowClock(b) - rowClock(a));
  if (launches.length === 0) return null;

  // Two pipelines, two baselines, two numbers.
  //
  // A single `poolCreatedAt > startedAt` filter looked general and was not: a
  // graduation is 60-90s stale the instant it arrives, so it never cleared the
  // Jupiter page's baseline and every one of them fell out of the statistic.
  // The headline then described the fast half of the feed while appearing to
  // describe all of it.
  /** Rows carrying a source-published creation time. The only rows a lag can be measured on. */
  type Dated = TokenLaunch & { poolCreatedAt: number };
  const dated = (l: TokenLaunch): l is Dated => l.poolCreatedAt !== undefined;
  const lagOf = (l: Dated) => l.firstSeenAt - l.poolCreatedAt;
  // A promoted row — watched as a curve mint, then graduating — keeps its
  // original firstSeenAt while poolCreatedAt is re-dated to the graduation, so
  // measuring it with `lagOf` produced a negative lag the size of the curve's
  // lifetime and fed the clock-skew check a fabricated impossibility. The
  // graduation's own sighting time is the honest sample: how long after the
  // event the feed noticed it.
  const gradLagOf = (l: Dated) => (l.gradSeenAt ?? l.firstSeenAt) - l.poolCreatedAt;
  // The POLL's lag, over rows the poll saw first. A pushed row that Jupiter
  // later dates would put the socket's latency into the poll's median and
  // flatter it — the same averaging this file already refuses between mints
  // and graduations — so pushed rows are measured on their own, below.
  const pools = launches.filter(
    (l): l is Dated => l.event === "pool" && dated(l) && l.source !== PUSH_SOURCE && l.poolCreatedAt > state.startedAt,
  );
  const grads = launches.filter(
    (l): l is Dated =>
      l.event === "graduation" && dated(l) && state.sweepStartedAt > 0 && l.poolCreatedAt > state.sweepStartedAt,
  );
  const lags = pools.map(lagOf).sort((a, b) => a - b);
  const gradLags = grads.map(gradLagOf).sort((a, b) => a - b);
  // The PUSH's lag: receipt on this clock minus the creation time a poll
  // later published. Only rows both saw can be measured, and the number
  // carries the clock offset between this machine and the source.
  const pushedRows = launches.filter((l) => l.source === PUSH_SOURCE);
  const pushLags = pushedRows.filter(dated).map(lagOf).sort((a, b) => a - b);
  const now = Date.now();
  // Counted by creation time where the source published one, and by receipt
  // where it has not yet — a pushed row received in the last minute was
  // created before it was received, so the count can only be an undercount.
  const lastMinute = launches.filter((l) => now - rowClock(l) <= 60_000).length;
  const stale = state.lastSuccessAt === 0 || now - state.lastSuccessAt > STALE_AFTER_MS;

  return {
    launches,
    lagP50Ms: percentile(lags, 0.5),
    lagP90Ms: percentile(lags, 0.9),
    lagMinMs: lags[0] ?? null,
    lagSamples: lags.length,
    gradLagP50Ms: percentile(gradLags, 0.5),
    gradLagP90Ms: percentile(gradLags, 0.9),
    gradLagSamples: gradLags.length,
    gradLagMinMs: gradLags[0] ?? null,
    pushed: state.pushed,
    undated: pushedRows.filter((l) => !dated(l)).length,
    pushLagP50Ms: percentile(pushLags, 0.5),
    pushLagMinMs: pushLags[0] ?? null,
    pushLagSamples: pushLags.length,
    windowSeconds: state.lastWindowSeconds,
    addedLastPass: state.addedLastPass,
    lastSuccessAt: state.lastSuccessAt,
    stale,
    failures: state.failures,
    lastError: state.lastError,
    perMinute: lastMinute,
    awaitingTriage: launches.filter((l) => l.triage.completedInMs === undefined).length,
    polledAt: state.lastPrimaryAt,
    provenance: {
      source: FLAGS.coingecko() ? "jupiter+geckoterminal" : "jupiter",
      real: true,
      // Provenance must say when it stopped being true. A source name with no
      // freshness attached is exactly the "LIVE" label this codebase refuses
      // elsewhere, and a frozen feed wearing a vendor's name is worse than one
      // wearing none.
      note: stale
        ? `stale — no successful poll for ${Math.round((now - state.lastSuccessAt) / 1000)}s` +
          (state.lastError ? ` (${state.lastError})` : "")
        : undefined,
    },
  };
}
