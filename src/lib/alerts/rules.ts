// Live alert rules: the pure half.
//
// Everything here is a function of (rule, previous state, one data payload,
// the clock) — no fetching, no storage, no browser globals — so the edge cases
// that decide whether an alerting system is honest are unit-testable: a
// threshold crossed while nobody was evaluating, a rule created after the
// event it would have matched, the same launch arriving on ten consecutive
// polls.
//
// THE CONTRACT EVERY EVALUATOR KEEPS
//
// 1. An alert records the MEASUREMENT that tripped it and WHEN it was
//    evaluated. When the on-chain moment is actually known — a fill's block
//    time, a pool-creation claim — it travels in `eventAt` with a note naming
//    whose claim it is. When it is not known, `eventAt` stays empty rather
//    than being filled with the evaluation clock wearing a chain costume.
//
// 2. "Could not evaluate" is a distinct outcome from "evaluated, nothing
//    fired". A skipped pass writes `lastSkipReason` and does NOT advance
//    `lastEvaluatedAt`, which is what lets the page render NOT EVALUATED
//    instead of a silence that reads as all-clear.
//
// 3. Crossings found after an evaluation gap say so. "Price crossed $2" and
//    "price was found above $2 after 190 seconds nobody was looking" are
//    different claims, and Cielo/Photon render both as the first one.

import type { LaunchVerdict, TokenLaunch, TradeClassification } from "../types";
import { movementLabel } from "../engine/fill-label";

/** Base58, 32-44 chars — same shape gate the API handlers apply. Local copy
 *  so the rule form can validate without dragging the handler graph along. */
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ------------------------------------------------------------------ rules

export type LiveAlertCondition =
  | {
      kind: "launch";
      /** Matches the row's launchpad, falling back to its venue. Absent = any. */
      launchpad?: string;
      /**
       * A row whose liquidity is not yet measured CANNOT match a liquidity
       * threshold — absence is not a small number. Same rule the launch page's
       * own filter follows, in the opposite direction: the filter keeps
       * unmeasured rows because dropping them would hide the freshest
       * launches, and this alert skips them because firing on them would
       * assert a measurement nobody made.
       */
      minLiquidityUsd?: number;
      /**
       * Worst triage verdict that still fires. "unverified" = only rows where
       * nothing failed; "caution" = unverified or caution. Absent = any,
       * including AVOID.
       */
      maxVerdict?: "unverified" | "caution";
      /** "pool" or "graduation". Absent = both. */
      event?: "pool" | "graduation";
    }
  | { kind: "graduation"; mint: string; symbol?: string }
  | { kind: "price_cross"; mint: string; symbol?: string; direction: "above" | "below"; thresholdUsd: number }
  /** Fires when measured liquidity is at or below the threshold. */
  | { kind: "liquidity_floor"; mint: string; symbol?: string; thresholdUsd: number }
  /** Fires when a scanned token's signal score crosses INTO the band from below. */
  | { kind: "signal_band"; band: number }
  | { kind: "wallet_fills"; wallet: string };

export type LiveRuleKind = LiveAlertCondition["kind"];

export interface LiveAlertRule {
  id: string;
  name: string;
  condition: LiveAlertCondition;
  enabled: boolean;
  /** Deliver through the system Notification API as well as the inbox. */
  notify: boolean;
  createdAt: number;
}

// ------------------------------------------------------------------ events

export interface LiveAlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  kind: LiveRuleKind;
  /** When the evaluator produced this — the evaluation clock, always known. */
  firedAt: number;
  /** The timestamp the data payload claims for itself (row dataTs, feed poll). */
  dataAsOf: number;
  /**
   * When the underlying event happened on chain, ONLY when a source actually
   * claims it. Never synthesized from the evaluation clock.
   */
  eventAt?: number;
  /** Whose claim `eventAt` is — "block time", "source claim (jupiter)". */
  eventAtNote?: string;
  /** Exactly what measurement tripped the rule, with its threshold. */
  measurement: string;
  /** Present when the trip was found after a window nobody evaluated. */
  gapNote?: string;
  headline: string;
  detail: string;
  mint?: string;
  symbol?: string;
  wallet?: string;
  read: boolean;
}

export type FiredAlert = Omit<LiveAlertEvent, "id" | "read">;

// ------------------------------------------------------------------ state

/**
 * Per-rule evaluation bookkeeping, persisted so a reload does not turn "last
 * evaluated two hours ago" into amnesia.
 */
export interface RuleEvalState {
  ruleId: string;
  /** First successful evaluation — the moment the rule started meaning anything. */
  armedAt?: number;
  /** Last evaluation that actually had usable data. */
  lastEvaluatedAt?: number;
  /** Last time the monitor tried, successful or not. */
  lastAttemptAt?: number;
  /** Why the last attempt could NOT evaluate. Cleared by a successful pass. */
  lastSkipReason?: string;
  /** Recent successful evaluation times — the achieved cadence, measured. */
  recentEvalTs?: number[];
  /** Crossing rules: last measured value and whether the condition held. */
  lastValue?: number;
  conditionTrue?: boolean;
  /** Event rules: bounded dedupe keys (mints, fill signatures). */
  seenKeys?: string[];
  /** Event rules: newest event timestamp already consumed, in the DATA's clock. */
  watermarkTs?: number;
  /** signal_band: previous score per mint, so a crossing is two observations. */
  prevScores?: Record<string, number>;
}

export interface EvalResult {
  state: RuleEvalState;
  fires: FiredAlert[];
}

// ---------------------------------------------------------------- cadences
//
// How often the monitor evaluates each source, stated here so the page can
// print the same numbers the loop actually uses. These are gates on top of
// the app's own caches (token list 30s, token detail 20s, wallet 45s), so a
// monitor pass mostly rides data another page already paid for.

/** Monitor tick while the tab is visible. */
export const TICK_VISIBLE_MS = 10_000;
/**
 * Monitor tick while the tab is hidden AND background watch is on. Chrome
 * throttles hidden-tab timers to roughly one wake a minute (harder after five
 * minutes), so this is a request, not a promise — which is why the page shows
 * the cadence actually achieved instead of this constant.
 */
export const TICK_HIDDEN_MS = 60_000;
export const SCANNER_EVERY_MS = 20_000;
/**
 * The launch pass's gate, equal to the visible tick ON PURPOSE.
 *
 * It was 5s, which the 10s tick can never satisfy: the gate opened every
 * other tick at best, so the page printed a target of ~5s beside an achieved
 * cadence of ~11s that was in fact the fastest the loop can go. A target no
 * amount of healthy operation can reach is not a target, it is a permanent
 * accusation against a working monitor — and it teaches a reader to ignore the
 * one number on the page that says whether coverage is keeping up.
 *
 * Nothing is lost by aligning them. The feed module refuses to poll its own
 * vendors faster than its measured ceilings regardless of how often it is
 * asked, so asking twice as often was never buying fresher launches.
 */
export const LAUNCHES_EVERY_MS = TICK_VISIBLE_MS;
export const DETAIL_EVERY_MS = 60_000;
/** A full wallet read is up to ~400 RPC calls; four minutes keeps one watched
 *  wallet an order of magnitude cheaper than an open wallet page. */
export const WALLET_EVERY_MS = 240_000;

export type SourceKey = "scanner" | "launches" | `detail:${string}` | `wallet:${string}`;

export function ruleSource(c: LiveAlertCondition): SourceKey {
  switch (c.kind) {
    case "launch":
    case "graduation":
      return "launches";
    case "signal_band":
      return "scanner";
    case "price_cross":
    case "liquidity_floor":
      return `detail:${c.mint}`;
    case "wallet_fills":
      return `wallet:${c.wallet}`;
  }
}

/** The cadence the monitor AIMS at for a rule's source, tab visible. */
export function expectedCadenceMs(c: LiveAlertCondition): number {
  switch (c.kind) {
    case "launch":
    case "graduation":
      return LAUNCHES_EVERY_MS;
    case "signal_band":
      return SCANNER_EVERY_MS;
    case "price_cross":
    case "liquidity_floor":
      return DETAIL_EVERY_MS;
    case "wallet_fills":
      return WALLET_EVERY_MS;
  }
}

// ------------------------------------------------------------- bookkeeping

const EVAL_RING = 20;

/**
 * How many dedupe keys one rule remembers.
 *
 * THIS NUMBER IS AN INVARIANT, NOT A PREFERENCE, and getting it wrong shipped
 * the worst defect in this feature's first review: 41 duplicate launch alerts
 * proven in five minutes, with the median fired alert describing a row it had
 * already fired on 176 seconds earlier — over half the alert stream was
 * re-fires.
 *
 * The mechanism was 400 keys evicted in insertion order against a feed that
 * keeps rows for THIRTY MINUTES. On a busy pump.fun afternoon (15-25 matches a
 * minute) 400 keys churn in well under thirty minutes, so eviction started
 * dropping keys whose rows were still sitting in the feed. Each dropped key's
 * row re-matched on the very next pass, re-fired, and its re-added key evicted
 * another — a rolling duplicate loop that gets worse the busier the feed is,
 * which is precisely when a launch alert matters.
 *
 * So the cap must exceed what the FEED can hold, because "still in the feed"
 * is exactly the condition under which a key must never be forgotten. The feed
 * caps itself at FEED_MAX_ROWS = 400 rows, and one mint can legitimately
 * occupy two keys (its pool and its later graduation), so 800 keys is the
 * ceiling of what live rows can possibly claim. 1,000 leaves headroom above
 * that ceiling and still costs about 45KB of the origin's quota per launch
 * rule at ~45 bytes a key.
 *
 * `pruneSeen` below enforces the invariant a second way, so a future change to
 * the feed's own limits cannot silently reintroduce this.
 */
export const SEEN_CAP = 1_000;

/**
 * Drop dedupe keys the feed no longer holds, before any that it does.
 *
 * Insertion order is the wrong axis entirely: what makes a key safe to forget
 * is that its ROW IS GONE, not that the key is old. A key whose row is still in
 * the feed will re-match on the next pass the instant it is forgotten, so those
 * are evicted last and only if the absent ones did not free enough — which,
 * with SEEN_CAP set above the feed's own capacity, cannot happen in practice.
 *
 * Pruning only fires ABOVE the cap, and that bound is load-bearing for a
 * different failure: after a page reload the feed's in-memory state resets and
 * rebuilds from a thirty-row page, so almost every remembered key is briefly
 * "absent". Pruning eagerly there would forget hundreds of rows that are about
 * to be re-listed by the graduation and pool sweeps with freshly stamped
 * sighting times, and every one of them would re-fire — the reload duplicates
 * the review also caught.
 */
export function pruneSeen(seen: Iterable<string>, liveKeys: ReadonlySet<string>): string[] {
  const keys = [...seen];
  if (keys.length <= SEEN_CAP) return keys;
  const excess = keys.length - SEEN_CAP;
  const doomed = new Set<string>();
  for (const k of keys) {
    if (doomed.size >= excess) break;
    if (!liveKeys.has(k)) doomed.add(k);
  }
  const kept = keys.filter((k) => !doomed.has(k));
  // Still over only if the live feed itself exceeds the cap, which the cap is
  // chosen to prevent. Oldest-first is the least-bad answer if it ever happens.
  return kept.length > SEEN_CAP ? kept.slice(kept.length - SEEN_CAP) : kept;
}

/** How many events one rule may emit in one pass before the rest collapse
 *  into a single summary row. A busy launch minute matching a broad filter is
 *  real, but forty separate notifications about it help nobody. */
export const MAX_FIRES_PER_PASS = 8;

export function markEvaluated(s: RuleEvalState, now: number): RuleEvalState {
  return {
    ...s,
    armedAt: s.armedAt ?? now,
    lastAttemptAt: now,
    lastEvaluatedAt: now,
    lastSkipReason: undefined,
    recentEvalTs: [...(s.recentEvalTs ?? []), now].slice(-EVAL_RING),
  };
}

/**
 * Record that a pass could not evaluate this rule, and why.
 *
 * `settled` marks an answer that will never change — a rule whose subject was
 * identified and can never be a token. Those keep the attempt time they
 * actually had: the monitor has stopped asking, so advancing the clock would
 * date a request nobody made. Nothing renders it for a settled rule today, but
 * a stored value that is wrong is a defect waiting for its first reader.
 */
export function markSkipped(s: RuleEvalState, now: number, reason: string, settled = false): RuleEvalState {
  if (settled) return { ...s, lastAttemptAt: s.lastAttemptAt ?? now, lastSkipReason: reason };
  return { ...s, lastAttemptAt: now, lastSkipReason: reason };
}

/** Median gap between recent successful evaluations, or null under 3 samples. */
export function achievedCadenceMs(s: RuleEvalState): number | null {
  const ts = s.recentEvalTs ?? [];
  if (ts.length < 3) return null;
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * The sentence that keeps a late discovery from impersonating a live catch.
 *
 * Only produced when the gap since the previous evaluation is well past the
 * cadence the rule runs at — a crossing found 12s after the previous scan on a
 * 10s cadence is normal operation, not a coverage failure.
 */
export function gapNoteFor(prevEvaluatedAt: number | undefined, now: number, expectedMs: number): string | undefined {
  if (prevEvaluatedAt === undefined) return undefined;
  const gap = now - prevEvaluatedAt;
  if (gap <= Math.max(2.5 * expectedMs, 45_000)) return undefined;
  return `found after a ${Math.round(gap / 1000)}s evaluation gap — the moment it happened was not observed`;
}

// -------------------------------------------------------------- formatting
//
// Local rather than imported from lib/client: that module pulls in React and
// the whole static dispatcher, and this file must stay loadable in a bare
// node test. Two tiny formatters are cheaper than that dependency.

function usd(x: number): string {
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs === 0) return "$0";
  const exp = Math.floor(Math.log10(abs));
  return `${sign}$${abs.toFixed(Math.min(12, 3 - exp))}`;
}

function shortMint(m: string): string {
  return m.length <= 10 ? m : `${m.slice(0, 4)}…${m.slice(-4)}`;
}

// ------------------------------------------------------------- launch rule

export interface LaunchFeedObs {
  rows: TokenLaunch[];
  /** When the feed last actually heard from its source. */
  dataAsOf: number;
  sourceName: string;
}

const VERDICT_RANK: Record<LaunchVerdict, number> = { unverified: 0, caution: 1, avoid: 2 };

function launchMatches(c: Extract<LiveAlertCondition, { kind: "launch" }>, row: TokenLaunch): boolean {
  if (c.event && row.event !== c.event) return false;
  if (c.launchpad) {
    const where = (row.launchpad ?? row.venue ?? "").toLowerCase();
    if (where !== c.launchpad.toLowerCase()) return false;
  }
  if (c.minLiquidityUsd !== undefined && c.minLiquidityUsd > 0) {
    // Unmeasured liquidity fails the filter. See the field's comment.
    if (row.liquidityUsd === undefined || row.liquidityUsd < c.minLiquidityUsd) return false;
  }
  if (c.maxVerdict && VERDICT_RANK[row.triage.verdict] > VERDICT_RANK[c.maxVerdict]) return false;
  return true;
}

const launchKey = (row: TokenLaunch) => `${row.mint}:${row.event}`;
/** When THIS FEED first saw the row in its current role — the observation time. */
const observedAt = (row: TokenLaunch) =>
  row.event === "graduation" ? (row.gradSeenAt ?? row.firstSeenAt) : row.firstSeenAt;

function describeLaunch(row: TokenLaunch): string {
  const where = row.launchpad ?? row.venue;
  return (
    `${row.event === "graduation" ? "graduated" : "new pool"}${where ? ` on ${where}` : ""}, ` +
    `liquidity ${row.liquidityUsd === undefined ? "not yet measured" : usd(row.liquidityUsd)}, ` +
    `triage ${row.triage.verdict.toUpperCase()} (${row.triage.measured}/${row.triage.total} checks ran)`
  );
}

export function evaluateLaunchRule(rule: LiveAlertRule, state: RuleEvalState, obs: LaunchFeedObs, now: number): EvalResult {
  const c = rule.condition;
  if (c.kind !== "launch") throw new Error("wrong evaluator");

  const armedBefore = state.armedAt !== undefined;
  const seen = new Set(state.seenKeys ?? []);
  const fires: FiredAlert[] = [];
  // The keys the feed can still produce a match from. Everything the dedupe
  // memory must not forget while it is being trimmed.
  const liveKeys = new Set(obs.rows.map(launchKey));

  if (!armedBefore) {
    // Arming consumes the backfill. Every row already in the feed happened
    // before this rule existed, and a rule created after an event must not
    // claim to have caught it — so the first pass records what is on screen
    // and fires on nothing.
    for (const row of obs.rows) seen.add(launchKey(row));
    return {
      state: { ...markEvaluated(state, now), seenKeys: pruneSeen(seen, liveKeys) },
      fires: [],
    };
  }

  const armedAt = state.armedAt!;
  const gap = gapNoteFor(state.lastEvaluatedAt, now, LAUNCHES_EVERY_MS);
  const matched = obs.rows
    .filter((row) => !seen.has(launchKey(row)) && observedAt(row) >= armedAt && launchMatches(c, row))
    .sort((a, b) => observedAt(a) - observedAt(b));

  for (const row of matched.slice(0, MAX_FIRES_PER_PASS)) {
    seen.add(launchKey(row));
    fires.push({
      ruleId: rule.id,
      ruleName: rule.name,
      kind: "launch",
      firedAt: now,
      dataAsOf: obs.dataAsOf,
      eventAt: row.poolCreatedAt,
      // Named for what the row's OWN event is. `poolCreatedAt` is re-dated to
      // the migrated pool when a curve graduates (see types.ts), so calling it
      // "the pool-creation time" on a graduation row put the right timestamp
      // under the wrong claim — the dedicated graduation rule got this right
      // and the filter rule did not.
      eventAtNote:
        row.event === "graduation"
          ? `source claim — the graduation time ${row.source} published, not a chain read by this app`
          : `source claim — the pool-creation time ${row.source} published, not a chain read by this app`,
      measurement: describeLaunch(row),
      gapNote: gap,
      headline: `LAUNCH MATCH · ${row.symbol || shortMint(row.mint)}`,
      detail: `${row.name || row.symbol || shortMint(row.mint)}: ${describeLaunch(row)}. First seen by this tab ${((now - row.firstSeenAt) / 1000).toFixed(0)}s ago.`,
      mint: row.mint,
      symbol: row.symbol || undefined,
    });
  }
  // The overflow is stated, not dropped silently: a pass that matched more
  // than the cap says how many more there were.
  if (matched.length > MAX_FIRES_PER_PASS) {
    const extra = matched.slice(MAX_FIRES_PER_PASS);
    for (const row of extra) seen.add(launchKey(row));
    fires.push({
      ruleId: rule.id,
      ruleName: rule.name,
      kind: "launch",
      firedAt: now,
      dataAsOf: obs.dataAsOf,
      measurement: `${extra.length} further launches matched in the same pass`,
      gapNote: gap,
      headline: `LAUNCH MATCH · +${extra.length} more`,
      detail:
        `${extra.length} further launches matched this rule in the same evaluation pass and were not recorded ` +
        `individually (cap ${MAX_FIRES_PER_PASS} per pass). The launch feed page has all of them.`,
    });
  }

  return {
    state: { ...markEvaluated(state, now), seenKeys: pruneSeen(seen, liveKeys) },
    fires,
  };
}

// --------------------------------------------------------- graduation rule

export function evaluateGraduationRule(rule: LiveAlertRule, state: RuleEvalState, obs: LaunchFeedObs, now: number): EvalResult {
  const c = rule.condition;
  if (c.kind !== "graduation") throw new Error("wrong evaluator");

  const armedBefore = state.armedAt !== undefined;
  const key = `grad:${c.mint}`;
  const seen = new Set(state.seenKeys ?? []);
  const row = obs.rows.find((r) => r.mint === c.mint);
  const next = { ...markEvaluated(state, now) };

  // No row is still an evaluation: the feed was read and the mint is not in
  // its 30-minute window. That is a measured absence, not a skipped pass.
  if (!row || row.event !== "graduation" || seen.has(key)) {
    return { state: next, fires: [] };
  }

  seen.add(key);
  const alreadyGraduated = !armedBefore || observedAt(row) < state.armedAt!;
  const liq = row.liquidityUsd === undefined ? "liquidity not yet measured" : `liquidity ${usd(row.liquidityUsd)}`;
  const measurement = alreadyGraduated
    ? `already graduated when this rule was first evaluated — ${liq}. The graduation itself was not caught live.`
    : `graduation observed — ${liq}${row.venue ? `, pool on ${row.venue}` : ""}`;

  return {
    // Exactly one key for the life of the rule, so there is nothing to prune.
    state: { ...next, seenKeys: [...seen] },
    fires: [
      {
        ruleId: rule.id,
        ruleName: rule.name,
        kind: "graduation",
        firedAt: now,
        dataAsOf: obs.dataAsOf,
        eventAt: row.graduatedAt ?? row.poolCreatedAt,
        eventAtNote: `source claim — graduation time per ${row.source}`,
        measurement,
        gapNote: alreadyGraduated ? undefined : gapNoteFor(state.lastEvaluatedAt, now, LAUNCHES_EVERY_MS),
        headline: `GRADUATED · ${row.symbol || c.symbol || shortMint(c.mint)}`,
        detail: `${row.name || row.symbol || shortMint(c.mint)}: ${measurement}`,
        mint: c.mint,
        symbol: row.symbol || c.symbol,
      },
    ],
  };
}

// ------------------------------------------------- price / liquidity rules

export interface DetailObs {
  priceUsd: number;
  liquidityUsd: number;
  /** Fields the source declared absent — an entry here is not a zero. */
  unmeasured?: readonly string[];
  /** When the snapshot was taken, per the payload itself. */
  dataAsOf: number;
  sourceName: string;
}

interface Crossing {
  fired: boolean;
  firstEval: boolean;
  measurement?: string;
  gapNote?: string;
  state: RuleEvalState;
}

/**
 * Shared crossing semantics for threshold rules.
 *
 * Fires when the condition is observed true and was not already firing;
 * re-arms when observed false. The first evaluation after arming fires too,
 * when the condition already holds — silence there would leave "tell me when
 * price is above $2" unanswered forever on a token already at $3 — but the
 * measurement SAYS the crossing moment was never observed, because it wasn't.
 */
function crossingEval(
  state: RuleEvalState,
  now: number,
  condTrue: boolean,
  value: number,
  describe: (nowV: number, prevV: number | undefined, prevAt: number | undefined) => string,
  expectedMs: number,
): Crossing {
  const armedBefore = state.armedAt !== undefined;
  const prevValue = state.lastValue;
  const prevAt = state.lastEvaluatedAt;
  const next: RuleEvalState = { ...markEvaluated(state, now), lastValue: value, conditionTrue: condTrue };

  if (!armedBefore) {
    return {
      fired: condTrue,
      firstEval: true,
      measurement: condTrue
        ? `${describe(value, undefined, undefined)} — already true at the first evaluation after this rule was armed; the moment it crossed was never observed`
        : undefined,
      state: next,
    };
  }
  if (condTrue && !state.conditionTrue) {
    return {
      fired: true,
      firstEval: false,
      measurement: describe(value, prevValue, prevAt),
      gapNote: gapNoteFor(prevAt, now, expectedMs),
      state: next,
    };
  }
  return { fired: false, firstEval: false, state: next };
}

export function evaluatePriceRule(rule: LiveAlertRule, state: RuleEvalState, obs: DetailObs, now: number): EvalResult {
  const c = rule.condition;
  if (c.kind !== "price_cross") throw new Error("wrong evaluator");

  // A zero or missing price is an absence, not a price — a "below $X" rule
  // firing on it would be an alert about our data, dressed as one about the
  // token.
  if (!Number.isFinite(obs.priceUsd) || obs.priceUsd <= 0) {
    return { state: markSkipped(state, now, `${obs.sourceName} published no price this pass`), fires: [] };
  }

  const condTrue = c.direction === "above" ? obs.priceUsd >= c.thresholdUsd : obs.priceUsd <= c.thresholdUsd;
  const word = c.direction === "above" ? "at or above" : "at or below";
  const cross = crossingEval(
    state,
    now,
    condTrue,
    obs.priceUsd,
    (nowV, prevV, prevAt) =>
      `price ${usd(nowV)} ${word} ${usd(c.thresholdUsd)}` +
      (prevV !== undefined && prevAt !== undefined
        ? ` — previous scan saw ${usd(prevV)}, ${Math.round((now - prevAt) / 1000)}s earlier; it crossed somewhere in that window`
        : ""),
    DETAIL_EVERY_MS,
  );
  if (!cross.fired) return { state: cross.state, fires: [] };

  const sym = c.symbol || shortMint(c.mint);
  return {
    state: cross.state,
    fires: [
      {
        ruleId: rule.id,
        ruleName: rule.name,
        kind: "price_cross",
        firedAt: now,
        dataAsOf: obs.dataAsOf,
        // No eventAt on purpose: a price crossing has no on-chain timestamp
        // this app read. What is known is the scan that saw it, and that is
        // what the record claims.
        measurement: cross.measurement!,
        gapNote: cross.gapNote,
        headline: `PRICE ${c.direction === "above" ? "ABOVE" : "BELOW"} · ${sym}`,
        detail: `${sym}: ${cross.measurement} (source: ${obs.sourceName})`,
        mint: c.mint,
        symbol: c.symbol,
      },
    ],
  };
}

export function evaluateLiquidityRule(rule: LiveAlertRule, state: RuleEvalState, obs: DetailObs, now: number): EvalResult {
  const c = rule.condition;
  if (c.kind !== "liquidity_floor") throw new Error("wrong evaluator");

  // Unmeasured liquidity must not fire a floor alert. Measured ZERO must:
  // a drained pool is exactly what this rule exists to catch.
  if ((obs.unmeasured ?? []).includes("liquidity")) {
    return { state: markSkipped(state, now, `${obs.sourceName} did not measure liquidity this pass`), fires: [] };
  }

  const condTrue = obs.liquidityUsd <= c.thresholdUsd;
  const cross = crossingEval(
    state,
    now,
    condTrue,
    obs.liquidityUsd,
    (nowV, prevV, prevAt) =>
      `liquidity ${usd(nowV)} at or below ${usd(c.thresholdUsd)}` +
      (prevV !== undefined && prevAt !== undefined
        ? ` — previous scan saw ${usd(prevV)}, ${Math.round((now - prevAt) / 1000)}s earlier; it fell somewhere in that window`
        : ""),
    DETAIL_EVERY_MS,
  );
  if (!cross.fired) return { state: cross.state, fires: [] };

  const sym = c.symbol || shortMint(c.mint);
  return {
    state: cross.state,
    fires: [
      {
        ruleId: rule.id,
        ruleName: rule.name,
        kind: "liquidity_floor",
        firedAt: now,
        dataAsOf: obs.dataAsOf,
        measurement: cross.measurement!,
        gapNote: cross.gapNote,
        headline: `LIQUIDITY FLOOR · ${sym}`,
        detail: `${sym}: ${cross.measurement} (source: ${obs.sourceName})`,
        mint: c.mint,
        symbol: c.symbol,
      },
    ],
  };
}

// --------------------------------------------------------- signal band rule

export interface ScanRowObs {
  mint: string;
  symbol: string;
  signalScore: number;
  scored: boolean;
  /** When the row's price/score inputs were observed. */
  dataTs: number;
}

export function evaluateSignalBandRule(
  rule: LiveAlertRule,
  state: RuleEvalState,
  rows: ScanRowObs[],
  dataAsOf: number,
  now: number,
): EvalResult {
  const c = rule.condition;
  if (c.kind !== "signal_band") throw new Error("wrong evaluator");

  // Unscored rows carry a placeholder 0, not a score. A pass where nothing is
  // scored has nothing for this rule to read.
  const scoredRows = rows.filter((r) => r.scored);
  if (scoredRows.length === 0) {
    return { state: markSkipped(state, now, "no scored rows this pass — live rows arrive unscored when the flow/security reads fail"), fires: [] };
  }

  const armedBefore = state.armedAt !== undefined;
  const prev = state.prevScores ?? {};
  const nextPrev: Record<string, number> = {};
  const fires: FiredAlert[] = [];
  const gap = gapNoteFor(state.lastEvaluatedAt, now, SCANNER_EVERY_MS);

  for (const r of scoredRows) {
    nextPrev[r.mint] = r.signalScore;
    const p = prev[r.mint];
    // A crossing is TWO observations. A token first sighted already inside
    // the band gets no alert — one reading cannot claim a crossing, and a
    // token that entered the trending list at 80 did its climbing where this
    // scanner could not see it.
    if (!armedBefore || p === undefined) continue;
    if (p < c.band && r.signalScore >= c.band) {
      fires.push({
        ruleId: rule.id,
        ruleName: rule.name,
        kind: "signal_band",
        firedAt: now,
        dataAsOf: r.dataTs || dataAsOf,
        // Deliberately no eventAt: the signal score is Nova's own derived
        // number, computed at scan time. There is no on-chain moment for it.
        measurement: `signal score ${p} → ${r.signalScore}, crossing the ${c.band} band`,
        gapNote: gap,
        headline: `SIGNAL ≥ ${c.band} · ${r.symbol}`,
        detail:
          `${r.symbol}: signal score moved ${p} → ${r.signalScore} between scans. ` +
          `The score is Nova's own composite, computed at scan time — this records when it was computed, not an on-chain event.`,
        mint: r.mint,
        symbol: r.symbol,
      });
    }
  }

  return { state: { ...markEvaluated(state, now), prevScores: nextPrev }, fires };
}

// --------------------------------------------------------- wallet fills rule

export interface WalletFillObs {
  signature: string;
  /** ms epoch, from the block. */
  ts: number;
  mint: string;
  symbol?: string;
  side: "buy" | "sell";
  tokens: number;
  valueUsd?: number;
  unpricedReason?: string;
  /**
   * What the movement WAS, as the chain read classified it.
   *
   * `side` alone is a direction, not a trade: tokens arriving by airdrop or by
   * someone else's purchase have `side: "buy"` and `classification: "transfer"`,
   * and the wallet page has always printed those as IN/OUT for exactly that
   * reason. The alert path dropped this field on the way in and then asserted
   * "sold" into a headline, a toast and an OS notification title — the app's
   * loudest surface making the one claim its own pipeline had already refused.
   */
  classification?: TradeClassification;
}

export interface WalletObs {
  fills: WalletFillObs[];
  /** Newest transaction the read actually covered, block clock. */
  newestTs: number;
  windowHours: number;
  dataAsOf: number;
  sourceName: string;
}

const MAX_FILL_FIRES = 6;

export function evaluateWalletRule(rule: LiveAlertRule, state: RuleEvalState, obs: WalletObs, now: number): EvalResult {
  const c = rule.condition;
  if (c.kind !== "wallet_fills") throw new Error("wrong evaluator");

  const armedBefore = state.armedAt !== undefined;
  const seen = new Set(state.seenKeys ?? []);

  if (!armedBefore) {
    // The arming read is the baseline. Everything it can see predates the
    // rule, so it all counts as consumed — the watermark is kept in the
    // BLOCK clock, not this machine's, so a skewed local clock cannot shift
    // which fills count as new.
    let watermark = obs.newestTs;
    for (const f of obs.fills) {
      seen.add(f.signature);
      if (f.ts > watermark) watermark = f.ts;
    }
    return {
      // Plain truncation is safe HERE and nowhere else in this file: the
      // block-clock watermark below rejects anything at or before the newest
      // consumed fill, so a forgotten signature cannot re-fire the way a
      // forgotten launch key could. That asymmetry is what the launch rule's
      // `pruneSeen` exists to close.
      state: { ...markEvaluated(state, now), seenKeys: [...seen].slice(-SEEN_CAP), watermarkTs: watermark },
      fires: [],
    };
  }

  const watermark = state.watermarkTs ?? 0;
  const gap = gapNoteFor(state.lastEvaluatedAt, now, WALLET_EVERY_MS);
  const fresh = obs.fills
    .filter((f) => !seen.has(f.signature) && f.ts > watermark)
    .sort((a, b) => a.ts - b.ts);

  const fires: FiredAlert[] = [];
  let newWatermark = watermark;
  for (const f of fresh) {
    seen.add(f.signature);
    if (f.ts > newWatermark) newWatermark = f.ts;
  }
  const short = `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)}`;
  for (const f of fresh.slice(0, MAX_FILL_FIRES)) {
    const what = f.symbol || shortMint(f.mint);
    const value = f.valueUsd !== undefined ? usd(f.valueUsd) : `unpriced${f.unpricedReason ? ` — ${f.unpricedReason}` : ""}`;
    // One shared answer to "what should this be called", so an alert and the
    // wallet page can never describe the same fill differently again.
    const { short: label, verb: word, note: kindNote } = movementLabel(f);
    fires.push({
      ruleId: rule.id,
      ruleName: rule.name,
      kind: "wallet_fills",
      firedAt: now,
      dataAsOf: obs.dataAsOf,
      eventAt: f.ts,
      eventAtNote: "block time — when the fill actually landed on chain",
      measurement: `${label} ${what} ${value}`,
      gapNote: gap,
      headline: `WALLET ${label} · ${short}`,
      detail:
        `${short} ${word} ${what} (${value})${kindNote || "."} ` +
        `Fill landed at block time; this tab noticed it ${Math.max(0, Math.round((now - f.ts) / 1000))}s later by its own clock.`,
      mint: f.mint,
      symbol: f.symbol,
      wallet: c.wallet,
    });
  }
  if (fresh.length > MAX_FILL_FIRES) {
    fires.push({
      ruleId: rule.id,
      ruleName: rule.name,
      kind: "wallet_fills",
      firedAt: now,
      dataAsOf: obs.dataAsOf,
      measurement: `${fresh.length - MAX_FILL_FIRES} further new fills in the same pass`,
      headline: `WALLET FILLS · +${fresh.length - MAX_FILL_FIRES} more`,
      detail: `${short} had ${fresh.length} new fills this pass; only the first ${MAX_FILL_FIRES} were recorded individually. The wallet page has all of them.`,
      wallet: c.wallet,
    });
  }

  return {
    state: { ...markEvaluated(state, now), seenKeys: [...seen].slice(-SEEN_CAP), watermarkTs: newWatermark },
    fires,
  };
}

// -------------------------------------------------------------- summaries

/** One line describing a condition, for the rules table. */
export function describeCondition(c: LiveAlertCondition): string {
  switch (c.kind) {
    case "launch": {
      const bits: string[] = [];
      if (c.event) bits.push(c.event === "graduation" ? "graduations" : "new pools");
      else bits.push("any launch");
      if (c.launchpad) bits.push(`on ${c.launchpad}`);
      if (c.minLiquidityUsd) bits.push(`liq ≥ ${usd(c.minLiquidityUsd)}`);
      if (c.maxVerdict) bits.push(`triage ≤ ${c.maxVerdict.toUpperCase()}`);
      return bits.join(" · ");
    }
    case "graduation":
      return `${c.symbol || shortMint(c.mint)} graduates`;
    case "price_cross":
      return `${c.symbol || shortMint(c.mint)} price ${c.direction} ${usd(c.thresholdUsd)}`;
    case "liquidity_floor":
      return `${c.symbol || shortMint(c.mint)} liquidity ≤ ${usd(c.thresholdUsd)}`;
    case "signal_band":
      return `any scanned token crosses signal ${c.band}`;
    case "wallet_fills":
      return `new fills by ${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)}`;
  }
}
